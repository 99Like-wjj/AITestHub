import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../../../persistence/src/database.js';
import type { StoragePort } from '../../../storage/src/port.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import { requirePlatformAdmin } from '../access/policy.js';
import { DomainError } from '../errors.js';
import { ControlJournal } from './control-journal.js';
import {
  BackupFiles,
  backupManifestSchema,
  type BackupManifest,
} from './backup-files.js';
import { MaintenanceService } from './maintenance.js';
import type { PostgresDumpPort } from './postgres-tools.js';
import { BackupJobService } from './jobs.js';

interface ResourceRow {
  id: string;
  owner_scope: 'personal' | 'project';
  owner_user_id: string;
  project_id: string | null;
  run_id: string | null;
  storage_key: string;
  media_type: string;
  bytes: string;
  sha256: string;
}
const failed = () =>
  new DomainError(
    'DEPENDENCY_UNAVAILABLE',
    '本次产品备份没有完成，不可用于恢复；现有业务数据未被重置。',
    503,
  );
export class ProductBackupService {
  readonly instanceId = randomUUID();
  readonly jobs: BackupJobService;
  constructor(
    readonly db: Database,
    readonly storage: StoragePort,
    readonly dump: PostgresDumpPort,
    readonly controls: ControlJournal,
    readonly maintenance: MaintenanceService,
    readonly files: BackupFiles,
    readonly options: {
      retentionDays?: number;
      drainTimeoutMs?: number;
      beforeBackup?: () => Promise<void>;
    } = {},
  ) {
    this.jobs = new BackupJobService(db);
    if (
      !Number.isInteger(options.retentionDays ?? 30) ||
      (options.retentionDays ?? 30) < 1 ||
      (options.retentionDays ?? 30) > 30
    )
      throw failed();
  }
  async request(actor: ActorContext, raw: unknown) {
    return this.jobs.request(actor, raw);
  }
  async requestInternal(source: 'daily' | 'upgrade') {
    return this.jobs.requestInternal(source);
  }
  async status(actor: ActorContext, id: string) {
    return this.db.transaction(async (tx) => {
      await requirePlatformAdmin(tx, actor);
      const row = (
        await tx.query(
          'SELECT id,state,requested_source,control_sequence,object_count,total_bytes,error_code,created_at,completed_at,expires_at FROM app.product_backups WHERE id=$1',
          [z.uuid().parse(id)],
        )
      ).rows[0];
      if (!row) throw new DomainError('NOT_FOUND', '没有该产品备份记录。', 404);
      return { backup: row };
    });
  }
  async run(id: string) {
    z.uuid().parse(id);
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(415948025)');
      const row = (
        await tx.query<{ state: string }>(
          'SELECT state FROM app.product_backups WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (!row || row.state !== 'queued')
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '备份不是可首次处理的队列任务；不会覆盖旧归档。',
          409,
        );
      if (
        (
          await tx.query(
            "SELECT 1 FROM app.product_backups WHERE state='preparing' LIMIT 1",
          )
        ).rowCount
      )
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '已有产品备份在处理，请先核对原任务。',
          409,
        );
      await tx.query(
        'INSERT INTO app.operations_worker_instances(id) VALUES($1) ON CONFLICT(id) DO UPDATE SET heartbeat_at=clock_timestamp(),stopped_at=NULL',
        [this.instanceId],
      );
      await tx.query(
        "UPDATE app.product_backups SET state='preparing',claimed_by=$2 WHERE id=$1",
        [id, this.instanceId],
      );
    });
    const heartbeat = setInterval(() => {
      void this.db
        .query(
          'UPDATE app.operations_worker_instances SET heartbeat_at=clock_timestamp() WHERE id=$1',
          [this.instanceId],
        )
        .catch(() => {});
    }, 5000);
    heartbeat.unref();
    let entered = false,
      complete = false;
    try {
      await this.maintenance.begin(id, 'PRODUCT_BACKUP');
      entered = true;
      await this.maintenance.waitUntilDrained(
        id,
        this.options.drainTimeoutMs ?? 30000,
      );
      await this.options.beforeBackup?.();
      await this.controls.checkpoint();
      const latest = await this.controls.latest();
      if (!latest.head.committed) throw failed();
      await this.files.create(id);
      const postgresVersion = await this.dump.version();
      const manifest = await this.db.transaction(async (tx) => {
        await tx.query(
          'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
        );
        const watermark = (
          await tx.query<{ control_sequence: string; state_digest: string }>(
            'SELECT control_sequence,state_digest FROM app.recovery_control_state WHERE singleton',
          )
        ).rows[0]!;
        if (
          Number(watermark.control_sequence) !==
            latest.head.committed!.sequence ||
          watermark.state_digest !== latest.head.committed!.stateDigest
        )
          throw failed();
        const rows =
          await tx.query<ResourceRow>(`SELECT id,owner_scope,owner_user_id,project_id,run_id,storage_key,media_type,declared_bytes::text bytes,declared_sha256 sha256
          FROM app.file_resources WHERE status='verified' AND deleted_at IS NULL ORDER BY id`);
        const migrations = (
          await tx.query<{ version: string; checksum: string }>(
            'SELECT version,checksum FROM app.schema_migrations ORDER BY version',
          )
        ).rows;
        const snapshot = (
          await tx.query<{ id: string; now: Date }>(
            'SELECT pg_export_snapshot() id,clock_timestamp() now',
          )
        ).rows[0]!;
        const task = this.dump.start(snapshot.id);
        let database;
        try {
          database = await this.files.writeDatabase(id, task.stream);
          if (!(await task.completed).ok || database.plaintextBytes < 5)
            throw failed();
        } catch {
          task.cancel();
          throw failed();
        }
        if (
          !(await this.dump.validate(
            await this.files.databaseStream(id, database),
          ))
        )
          throw failed();
        const objects: BackupManifest['objects'] = [],
          resources: BackupManifest['resources'] = [],
          byKey = new Map<
            string,
            { id: string; bytes: string; sha256: string }
          >();
        for (const row of rows.rows) {
          let object = byKey.get(row.storage_key);
          if (
            object &&
            (object.bytes !== row.bytes || object.sha256 !== row.sha256)
          )
            throw new DomainError(
              'BUSINESS_CONFLICT',
              '同一私有对象的引用摘要不一致，备份没有取舍或伪造通过。',
              409,
            );
          if (!object) {
            const objectId = randomUUID(),
              sealed = await this.files.writeObject(
                id,
                objectId,
                await this.storage.get(row.storage_key),
              );
            if (
              sealed.plaintextBytes !== Number(row.bytes) ||
              sealed.plaintextSha256 !== row.sha256
            )
              throw failed();
            object = { id: objectId, bytes: row.bytes, sha256: row.sha256 };
            byKey.set(row.storage_key, object);
            objects.push({
              id: objectId,
              storageKey: row.storage_key,
              mediaType: row.media_type,
              sealed,
            });
          }
          resources.push({
            id: row.id,
            objectId: object.id,
            ownerScope: row.owner_scope,
            ownerId: row.owner_user_id,
            projectId: row.project_id,
            runId: row.run_id,
            bytes: Number(row.bytes),
            sha256: row.sha256,
          });
        }
        return backupManifestSchema.parse({
          schemaVersion: 'ath.product-backup.v1',
          id,
          platformId: latest.head.platformId,
          capturedAt: snapshot.now.toISOString(),
          expiresAt: new Date(
            snapshot.now.getTime() +
              (this.options.retentionDays ?? 30) * 86400000,
          ).toISOString(),
          controls: {
            sequence: latest.head.committed!.sequence,
            stateDigest: latest.head.committed!.stateDigest,
          },
          platformMasterFingerprint: latest.state.platformMasterFingerprint,
          versions: {
            application: '0.1.0',
            node: process.versions.node,
            postgres: postgresVersion,
            migrations,
          },
          database,
          objects,
          resources,
        });
      });
      await this.db.transaction(async (tx) => {
        const mode = (
          await tx.query<{ phase: string; operation_id: string }>(
            'SELECT phase,operation_id FROM app.maintenance_state WHERE singleton FOR UPDATE',
          )
        ).rows[0]!;
        if (mode.phase !== 'snapshot' || mode.operation_id !== id)
          throw failed();
        await this.files.complete(manifest);
        await tx.query(
          "UPDATE app.product_backups SET state='complete',control_sequence=$2,control_digest=$3,manifest_digest=$4,object_count=$5,total_bytes=$6,completed_at=clock_timestamp(),expires_at=$7 WHERE id=$1",
          [
            id,
            manifest.controls.sequence,
            manifest.controls.stateDigest,
            await import('./crypto.js').then((module) =>
              module.fileDigest(this.files.path(id, 'manifest.enc')),
            ),
            manifest.objects.length,
            manifest.database.encryptedBytes +
              manifest.objects.reduce(
                (sum, object) => sum + object.sealed.encryptedBytes,
                0,
              ),
            manifest.expiresAt,
          ],
        );
        await tx.query(
          'UPDATE app.schedule_runtime SET recovery_cutoff_at=greatest(recovery_cutoff_at,clock_timestamp()) WHERE singleton',
        );
        await tx.query(
          "UPDATE app.maintenance_state SET phase='idle',operation_id=NULL,reason='',started_at=NULL,updated_at=clock_timestamp() WHERE singleton",
        );
      });
      complete = true;
      return {
        id,
        state: 'complete' as const,
        objectCount: manifest.objects.length,
        controlSequence: manifest.controls.sequence,
      };
    } catch (error: unknown) {
      const current = (
        await this.db.query<{ state: string }>(
          'SELECT state FROM app.product_backups WHERE id=$1',
          [id],
        )
      ).rows[0];
      if (current?.state === 'complete') {
        complete = true;
        return { id, state: 'complete' as const };
      }
      await this.db.query(
        "UPDATE app.product_backups SET state='failed',error_code=$2 WHERE id=$1",
        [id, error instanceof DomainError ? error.code : 'BACKUP_FAILED'],
      );
      throw error instanceof DomainError ? error : failed();
    } finally {
      clearInterval(heartbeat);
      await this.db
        .query(
          'UPDATE app.operations_worker_instances SET stopped_at=clock_timestamp() WHERE id=$1',
          [this.instanceId],
        )
        .catch(() => {});
      if (entered && !complete)
        await this.maintenance.release(id).catch(() => {});
    }
  }
}
