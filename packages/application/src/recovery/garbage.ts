import { randomUUID } from 'node:crypto';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import type { StoragePort } from '../../../storage/src/port.js';
import { DomainError } from '../errors.js';
import { maintenanceMode } from './maintenance.js';

interface GcRow {
  id: string;
  resource_id: string;
  storage_key: string;
  reason: string;
  state: string;
  delete_intent_at: Date | null;
}
export class FileGarbageCollector {
  constructor(
    readonly db: Database,
    readonly storage: StoragePort,
    readonly options: { temporaryHours?: number; clock?: () => Date } = {},
  ) {}
  private async now(transaction: SqlExecutor) {
    return (
      this.options.clock?.() ??
      (await transaction.query<{ now: Date }>('SELECT clock_timestamp() now'))
        .rows[0]!.now
    );
  }
  async plan(allowQuarantine = false) {
    return this.db.transaction(async (tx) => {
      const mode = await maintenanceMode(tx, true);
      if (
        mode.phase !== 'idle' &&
        !(allowQuarantine && mode.phase === 'restoreQuarantine')
      )
        return { planned: 0, paused: true };
      const now = await this.now(tx),
        threshold = new Date(
          now.getTime() - (this.options.temporaryHours ?? 24) * 3600000,
        );
      let planned = 0;
      const privacy = await tx.query<{
        id: string;
        storage_key: string;
      }>(`SELECT f.id,f.storage_key FROM app.privacy_resource_gc p JOIN app.file_resources f ON f.id=p.resource_id
        WHERE f.deleted_at IS NOT NULL AND f.storage_key IS NOT NULL ORDER BY f.id FOR UPDATE OF f SKIP LOCKED`);
      for (const file of privacy.rows)
        planned +=
          (
            await tx.query(
              "INSERT INTO app.operations_file_gc(id,resource_id,storage_key,reason) VALUES($1,$2,$3,'privacyDeletion') ON CONFLICT DO NOTHING",
              [randomUUID(), file.id, file.storage_key],
            )
          ).rowCount ?? 0;
      const temporary = await tx.query<{
        id: string;
        storage_key: string | null;
      }>(
        `SELECT f.id,f.storage_key FROM app.file_resources f WHERE f.owner_scope='project' AND f.deleted_at IS NULL AND f.created_at<$1
        AND (f.status<>'uploading' OR f.upload_expires_at<=$2) AND NOT EXISTS(SELECT 1 FROM app.resource_references r WHERE r.resource_id=f.id)
        AND NOT EXISTS(SELECT 1 FROM app.operations_request_leases l WHERE l.resource_id=f.id AND l.expires_at>clock_timestamp())
        AND NOT EXISTS(SELECT 1 FROM app.runs u WHERE u.id=f.run_id AND u.delivery_status<>'complete') ORDER BY f.created_at LIMIT 100 FOR UPDATE OF f SKIP LOCKED`,
        [threshold, now],
      );
      for (const file of temporary.rows) {
        await tx.query(
          'UPDATE app.file_resources SET deleted_at=$2,row_version=row_version+1 WHERE id=$1',
          [file.id, now],
        );
        if (file.storage_key)
          planned +=
            (
              await tx.query(
                "INSERT INTO app.operations_file_gc(id,resource_id,storage_key,reason) VALUES($1,$2,$3,'temporaryUnreferenced') ON CONFLICT DO NOTHING",
                [randomUUID(), file.id, file.storage_key],
              )
            ).rowCount ?? 0;
      }
      const attempts = await tx.query<{
        resource_id: string;
        storage_key: string;
      }>(
        `SELECT a.resource_id,a.storage_key FROM app.file_upload_attempts a JOIN app.file_resources f ON f.id=a.resource_id
        WHERE a.created_at<$1 AND a.status IN ('failed','interrupted') AND a.storage_key IS DISTINCT FROM f.storage_key
        AND (f.upload_expires_at IS NULL OR f.upload_expires_at<=$2) AND NOT EXISTS(SELECT 1 FROM app.operations_request_leases l WHERE l.resource_id=f.id AND l.expires_at>clock_timestamp())
        ORDER BY a.created_at LIMIT 100`,
        [threshold, now],
      );
      for (const attempt of attempts.rows)
        planned +=
          (
            await tx.query(
              "INSERT INTO app.operations_file_gc(id,resource_id,storage_key,reason) VALUES($1,$2,$3,'uploadAttempt') ON CONFLICT DO NOTHING",
              [randomUUID(), attempt.resource_id, attempt.storage_key],
            )
          ).rowCount ?? 0;
      return { planned, paused: false };
    });
  }
  private async protected(tx: SqlExecutor, job: GcRow) {
    const file = (
      await tx.query<{ deleted_at: Date | null; storage_key: string | null }>(
        'SELECT deleted_at,storage_key FROM app.file_resources WHERE id=$1 FOR UPDATE',
        [job.resource_id],
      )
    ).rows[0];
    if (!file) return 'RESOURCE_MISSING';
    if (file.storage_key === job.storage_key && !file.deleted_at)
      return 'ACTIVE_RESOURCE';
    if (
      (
        await tx.query(
          "SELECT 1 FROM app.resource_references WHERE resource_id=$1 AND reference_type<>'conversation' LIMIT 1",
          [job.resource_id],
        )
      ).rowCount &&
      file.storage_key === job.storage_key
    )
      return 'FORMAL_REFERENCE';
    if (
      (
        await tx.query(
          'SELECT 1 FROM app.file_resources WHERE storage_key=$1 AND id<>$2 AND deleted_at IS NULL LIMIT 1',
          [job.storage_key, job.resource_id],
        )
      ).rowCount
    )
      return 'SHARED_OBJECT';
    return null;
  }
  private async finish(
    job: GcRow,
    state: 'completed' | 'failed' | 'retainedShared',
    code: string | null,
  ) {
    await this.db.transaction(async (tx) => {
      await tx.query(
        'UPDATE app.operations_file_gc SET state=$2,error_code=$3,updated_at=clock_timestamp() WHERE id=$1',
        [job.id, state, code],
      );
      if (job.reason === 'privacyDeletion')
        await tx.query(
          'UPDATE app.privacy_resource_gc SET state=$2,last_error_code=$3,updated_at=clock_timestamp() WHERE resource_id=$1',
          [job.resource_id, state === 'failed' ? 'failed' : 'completed', code],
        );
    });
  }
  async collect(limit = 100, allowQuarantine = false) {
    if (!this.storage.exists)
      throw new DomainError(
        'DEPENDENCY_UNAVAILABLE',
        '对象存储缺少受权存在性校验，未将回收入队当作完成。',
        503,
      );
    let removed = 0,
      retained = 0,
      failed = 0;
    const handled: string[] = [];
    for (let index = 0; index < limit; index++) {
      const selected = await this.db.transaction(async (tx) => {
        const mode = await maintenanceMode(tx, true);
        if (
          mode.phase !== 'idle' &&
          !(allowQuarantine && mode.phase === 'restoreQuarantine')
        )
          return null;
        await tx.query('SELECT pg_advisory_xact_lock(415948026)');
        const job = (
          await tx.query<GcRow>(
            "SELECT * FROM app.operations_file_gc WHERE (state='pending' OR state='failed' AND updated_at<clock_timestamp()-interval '5 minutes') AND NOT(id=ANY($1::uuid[])) ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED",
            [handled],
          )
        ).rows[0];
        if (!job) return null;
        const protection = await this.protected(tx, job);
        if (protection) {
          await tx.query(
            "UPDATE app.operations_file_gc SET state='retainedShared',error_code=$2,updated_at=clock_timestamp() WHERE id=$1",
            [job.id, protection],
          );
          return { job, protection };
        }
        if (
          (
            await tx.query(
              "SELECT 1 FROM app.operations_file_gc WHERE storage_key=$1 AND state='deleting' AND id<>$2 LIMIT 1",
              [job.storage_key, job.id],
            )
          ).rowCount
        )
          return null;
        await tx.query(
          "UPDATE app.operations_file_gc SET state='deleting',updated_at=clock_timestamp() WHERE id=$1",
          [job.id],
        );
        return { job, protection: null };
      });
      if (!selected) break;
      const { job, protection } = selected;
      handled.push(job.id);
      if (protection) {
        retained++;
        await this.finish(job, 'retainedShared', protection);
        continue;
      }
      try {
        if (!(await this.storage.exists(job.storage_key))) {
          await this.finish(job, 'completed', null);
          removed++;
          continue;
        }
        if (job.delete_intent_at) {
          await this.finish(
            job,
            'failed',
            'DELETE_OUTCOME_UNKNOWN_REVIEW_REQUIRED',
          );
          failed++;
          continue;
        }
        const canDelete = await this.db.transaction(async (tx) => {
          const mode = await maintenanceMode(tx, true);
          if (
            mode.phase !== 'idle' &&
            !(allowQuarantine && mode.phase === 'restoreQuarantine')
          ) {
            await tx.query(
              "UPDATE app.operations_file_gc SET state='pending',error_code='GC_PAUSED_FOR_MAINTENANCE' WHERE id=$1",
              [job.id],
            );
            return false;
          }
          const protection = await this.protected(tx, job);
          if (protection) {
            await tx.query(
              "UPDATE app.operations_file_gc SET state='retainedShared',error_code=$2 WHERE id=$1",
              [job.id, protection],
            );
            return false;
          }
          await tx.query(
            'UPDATE app.operations_file_gc SET delete_intent_at=clock_timestamp() WHERE id=$1',
            [job.id],
          );
          return true;
        });
        if (!canDelete) {
          retained++;
          continue;
        }
        await this.storage.delete(job.storage_key);
        if (await this.storage.exists(job.storage_key))
          throw new Error('Object not confirmed absent');
        await this.finish(job, 'completed', null);
        removed++;
      } catch {
        let absent = false;
        try {
          absent = !(await this.storage.exists(job.storage_key));
        } catch {}
        if (absent) {
          await this.finish(job, 'completed', null);
          removed++;
        } else {
          await this.finish(job, 'failed', 'OBJECT_GC_UNCONFIRMED');
          failed++;
        }
      }
    }
    return { confirmedAbsent: removed, retained, failed };
  }
  async recoverInterrupted() {
    return this.db.query(
      "UPDATE app.operations_file_gc SET state='failed',error_code='GC_OWNERSHIP_LOST_RECONCILE_REQUIRED' WHERE state='deleting' AND updated_at<clock_timestamp()-interval '11 minutes'",
    );
  }
}
