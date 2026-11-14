import type { Database } from '../../../persistence/src/database.js';
import { DomainError } from '../errors.js';
import { ProductBackupService } from './backup.js';
import { FileGarbageCollector } from './garbage.js';
import { CapacityMonitor } from './capacity.js';
import { randomUUID } from 'node:crypto';

/** Trusted operations process. Never use this in the unprivileged API request worker. */
export class OperationsRuntime {
  readonly instanceId = randomUUID();
  private busy = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private active: Promise<unknown> | undefined;
  private heartbeatWork: Promise<unknown> | undefined;
  private heartbeatBusy = false;
  constructor(
    readonly db: Database,
    readonly backups: ProductBackupService,
    readonly garbage: FileGarbageCollector,
    readonly capacity: CapacityMonitor,
  ) {}
  async recoverInterrupted() {
    const abandoned = await this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(415948025)');
      const rows = await tx.query<{
        id: string;
      }>(`SELECT b.id FROM app.product_backups b LEFT JOIN app.operations_worker_instances w ON w.id=b.claimed_by
        WHERE b.state='preparing' AND (w.id IS NULL OR w.stopped_at IS NOT NULL OR w.heartbeat_at<clock_timestamp()-interval '30 seconds') FOR UPDATE OF b`);
      for (const row of rows.rows)
        await tx.query(
          "UPDATE app.product_backups SET state='failed',error_code='BACKUP_WORKER_LOST_NO_AUTOMATIC_REPLAY' WHERE id=$1",
          [row.id],
        );
      return rows.rows;
    });
    for (const row of abandoned) {
      const mode = await this.backups.maintenance.status();
      if (
        mode.operation_id === row.id &&
        ['draining', 'snapshot'].includes(mode.phase)
      )
        await this.backups.maintenance.release(row.id);
    }
    await this.garbage.recoverInterrupted();
    return { abandonedBackups: abandoned.length };
  }
  async enqueueDailyIfDue() {
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(415948027)');
      const mode = (
        await tx.query<{ phase: string }>(
          'SELECT phase FROM app.maintenance_state WHERE singleton FOR SHARE',
        )
      ).rows[0];
      if (mode?.phase !== 'idle') return null;
      if ((await this.backups.maintenance.activeWork(tx)).total) return null;
      const due = (
        await tx.query<{
          due: boolean;
        }>(`SELECT NOT EXISTS(SELECT 1 FROM app.product_backups WHERE state='complete' AND completed_at>clock_timestamp()-interval '24 hours')
        AND NOT EXISTS(SELECT 1 FROM app.product_backups WHERE state IN ('queued','preparing'))
        AND NOT EXISTS(SELECT 1 FROM app.product_backups WHERE requested_source='daily' AND created_at>clock_timestamp()-interval '24 hours') due`)
      ).rows[0]?.due;
      if (!due) return null;
      const row = (
        await tx.query<{ id: string }>(
          "INSERT INTO app.product_backups(id,state,requested_source) VALUES(gen_random_uuid(),'queued','daily') RETURNING id",
        )
      ).rows[0]!;
      return row.id;
    });
  }
  async tick() {
    if (this.busy) return { state: 'busy' as const };
    this.busy = true;
    try {
      await this.backups.controls.assertCurrentSource();
      await this.recoverInterrupted();
      const mode = await this.backups.maintenance.status();
      if (mode.phase !== 'idle')
        return { state: 'paused' as const, phase: mode.phase };
      await this.capacity.sample();
      await this.garbage.plan();
      await this.garbage.collect();
      await this.backups.files.removeExpired();
      await this.db.query(
        "UPDATE app.product_backups SET state='expired' WHERE state='complete' AND expires_at<=clock_timestamp()",
      );
      const partial = (
        await this.db.query<{ id: string }>(
          "SELECT id FROM app.product_backups WHERE state IN ('failed','expired') AND created_at<clock_timestamp()-interval '30 days'",
        )
      ).rows;
      for (const row of partial)
        await this.backups.files.removeIncomplete(row.id);
      await this.db.query(
        "DELETE FROM app.operations_request_leases WHERE expires_at<clock_timestamp()-interval '1 day'",
      );
      await this.db.query(
        "DELETE FROM app.operations_capacity_samples WHERE captured_at<clock_timestamp()-interval '1 day'",
      );
      await this.backups.controls.prune();
      await this.enqueueDailyIfDue();
      const queued = (
        await this.db.query<{ id: string }>(
          "SELECT id FROM app.product_backups WHERE state='queued' ORDER BY created_at,id LIMIT 1",
        )
      ).rows[0];
      if (!queued) return { state: 'idle' as const };
      const result = await this.backups.run(queued.id);
      return { state: 'processed' as const, backupId: result.id };
    } finally {
      this.busy = false;
    }
  }
  start(intervalMs = 60000) {
    if (this.timer) return;
    if (
      !Number.isInteger(intervalMs) ||
      intervalMs < 100 ||
      intervalMs > 3600000
    )
      throw new DomainError('VALIDATION_ERROR', '运维轮询间隔无效。', 400);
    const launch = () => {
      if (this.busy) return;
      this.active = this.tick().catch((error) => {
        process.stderr.write(
          `${error instanceof DomainError ? error.code : 'OPERATIONS_TICK_FAILED'}\n`,
        );
      });
    };
    launch();
    this.timer = setInterval(launch, intervalMs);
    const pulse = () => {
      if (this.heartbeatBusy) return;
      this.heartbeatBusy = true;
      this.heartbeatWork = this.db
        .query(
          'INSERT INTO app.operations_worker_instances(id) VALUES($1) ON CONFLICT(id) DO UPDATE SET heartbeat_at=clock_timestamp(),stopped_at=NULL',
          [this.instanceId],
        )
        .catch(() => {})
        .finally(() => {
          this.heartbeatBusy = false;
        });
    };
    pulse();
    this.heartbeat = setInterval(pulse, 5000);
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    await this.heartbeatWork;
    await this.db.query(
      'UPDATE app.operations_worker_instances SET stopped_at=clock_timestamp() WHERE id=$1',
      [this.instanceId],
    );
  }
}
