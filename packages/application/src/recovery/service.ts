import { z } from 'zod';
import type { Database } from '../../../persistence/src/database.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import {
  backupRequestSchema,
  backupListSchema,
  backupDetailSchema,
  operationsStatusSchema,
} from '../../../contracts/src/recovery.js';
import { requirePlatformAdmin } from '../access/policy.js';
import { DomainError } from '../errors.js';
import { capacityStatus } from './capacity.js';
import { BackupJobService } from './jobs.js';
import { maintenanceMode } from './maintenance.js';
import { ControlJournal } from './control-journal.js';

export class OperationsService {
  readonly jobs: BackupJobService;
  constructor(
    readonly db: Database,
    readonly controls: ControlJournal,
  ) {
    this.jobs = new BackupJobService(db);
  }
  private async authorize(actor: ActorContext) {
    if (actor.entrypoint !== 'web')
      throw new DomainError('FORBIDDEN', '运维设置仅限管理员Web。', 403);
    await this.db.transaction((tx) => requirePlatformAdmin(tx, actor));
  }
  async requestBackup(actor: ActorContext, raw: unknown) {
    await this.authorize(actor);
    return this.jobs.request(actor, backupRequestSchema.parse(raw));
  }
  private async rows(id?: string) {
    return (
      await this.db.query(
        `SELECT id,state,requested_source "requestedSource",control_sequence::int "controlSequence",object_count "objectCount",total_bytes::text "totalBytes",error_code "errorCode",created_at "createdAt",completed_at "completedAt",expires_at "expiresAt" FROM app.product_backups ${id ? 'WHERE id=$1' : ''} ORDER BY created_at DESC,id DESC LIMIT 100`,
        id ? [z.uuid().parse(id)] : [],
      )
    ).rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
    }));
  }
  async list(actor: ActorContext) {
    await this.authorize(actor);
    return backupListSchema.parse({ backups: await this.rows() });
  }
  async detail(actor: ActorContext, id: string) {
    await this.authorize(actor);
    const row = (await this.rows(id))[0];
    if (!row) throw new DomainError('NOT_FOUND', '没有该产品备份记录。', 404);
    return backupDetailSchema.parse({ backup: row });
  }
  async status(actor: ActorContext) {
    await this.authorize(actor);
    const mode = await maintenanceMode(this.db),
      capacity = await capacityStatus(this.db),
      worker = (
        await this.db.query<{ heartbeat_at: Date; active: boolean }>(
          "SELECT heartbeat_at,stopped_at IS NULL AND heartbeat_at>clock_timestamp()-interval '30 seconds' active FROM app.operations_worker_instances ORDER BY active DESC,heartbeat_at DESC LIMIT 1",
        )
      ).rows[0];
    return operationsStatusSchema.parse({
      maintenance: {
        phase: mode.phase,
        operationId: mode.operation_id,
        reason: mode.reason,
      },
      controls: await this.controls.status(),
      capacity: {
        state: capacity.state,
        availableBytes: capacity.availableBytes,
        locations: capacity.locations.map((row) => ({
          location: row.location,
          availableBytes: row.available_bytes,
          totalBytes: row.total_bytes,
          capturedAt: row.captured_at.toISOString(),
          errorCode: row.error_code,
        })),
      },
      worker: {
        active: worker?.active ?? false,
        lastHeartbeatAt: worker?.heartbeat_at.toISOString() ?? null,
      },
    });
  }
}
