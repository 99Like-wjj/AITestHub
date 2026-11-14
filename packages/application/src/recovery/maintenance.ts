import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Request, Response, NextFunction } from 'express';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { DomainError } from '../errors.js';
export type MaintenancePhase =
  'idle' | 'draining' | 'snapshot' | 'restoreQuarantine' | 'readOnly';
interface ModeRow {
  phase: MaintenancePhase;
  operation_id: string | null;
  reason: string;
}
export async function recoverySchemaReady(db: SqlExecutor) {
  return Boolean(
    (
      await db.query<{ ready: boolean }>(
        "SELECT to_regclass('app.maintenance_state') IS NOT NULL ready",
      )
    ).rows[0]?.ready,
  );
}
export async function maintenanceMode(
  db: SqlExecutor,
  lock = false,
): Promise<ModeRow> {
  if (!(await recoverySchemaReady(db)))
    return { phase: 'idle', operation_id: null, reason: '' };
  return (
    (
      await db.query<ModeRow>(
        `SELECT phase,operation_id,reason FROM app.maintenance_state WHERE singleton${lock ? ' FOR SHARE' : ''}`,
      )
    ).rows[0] ?? {
      phase: 'restoreQuarantine',
      operation_id: null,
      reason: 'CONTROL_STATE_MISSING',
    }
  );
}
const blocked = (phase: MaintenancePhase) =>
  new DomainError(
    'DEPENDENCY_UNAVAILABLE',
    phase === 'readOnly'
      ? '隔离恢复当前为只读验证，尚未开放写入。'
      : '平台正在维护/恢复核对，暂不接受新的写入或任务；现有任务按既定规则收尾。',
    503,
    { maintenancePhase: phase },
  );
export async function assertNewWorkAllowed(
  db: SqlExecutor,
  lock = false,
  existingAiTask?: { taskId: string; ownerId: string },
) {
  const mode = await maintenanceMode(db, lock);
  if (mode.phase === 'idle') return;
  if (
    mode.phase === 'draining' &&
    existingAiTask &&
    (
      await db.query(
        "SELECT 1 FROM app.ai_tasks t JOIN app.users u ON u.id=t.owner_id WHERE t.id=$1 AND t.owner_id=$2 AND t.state='running' AND t.cancel_requested_at IS NULL AND u.active",
        [existingAiTask.taskId, existingAiTask.ownerId],
      )
    ).rowCount
  )
    return;
  throw blocked(mode.phase);
}
export async function assertAcceptedAuxiliaryAllowed(
  db: SqlExecutor,
  taskId: string,
  ownerId: string,
  lock = true,
) {
  const mode = await maintenanceMode(db, lock);
  if (mode.phase === 'idle') return;
  if (
    mode.phase === 'draining' &&
    (
      await db.query(
        "SELECT 1 FROM app.auxiliary_tasks WHERE id=$1 AND owner_id=$2 AND state IN ('accepted','running','cancelling')",
        [taskId, ownerId],
      )
    ).rowCount
  )
    return;
  throw blocked(mode.phase);
}
export class MaintenanceService {
  readonly instanceId = randomUUID();
  constructor(
    readonly db: Database,
    readonly sourceFence?: () => Promise<void>,
  ) {}
  async status() {
    return maintenanceMode(this.db);
  }
  async enterRequest(
    method: string,
    path: string,
  ): Promise<{ release(): Promise<void> }> {
    if (path === '/api/v1/health/live') return { async release() {} };
    await this.sourceFence?.();
    if (!(await recoverySchemaReady(this.db))) return { async release() {} };
    const safe = ['GET', 'HEAD', 'OPTIONS'].includes(method),
      existing =
        /^\/api\/internal\/(?:api-worker|ai-worker)\//.test(path) &&
        !path.endsWith('/claim');
    const authReadOnly = /^\/api\/v1\/auth\/(?:login|logout)$/.test(path),
      id = randomUUID();
    const file = /^\/api\/v1\/files\/([^/]+)\/content$/.exec(path),
      resourceId = file && z.uuid().safeParse(file[1]).success ? file[1] : null;
    const tracked = await this.db.transaction(async (tx) => {
      const mode = (
        await tx.query<ModeRow>(
          'SELECT phase,operation_id,reason FROM app.maintenance_state WHERE singleton FOR SHARE',
        )
      ).rows[0]!;
      if (
        path === '/api/v1/health/ready' &&
        !['idle', 'readOnly'].includes(mode.phase)
      )
        throw blocked(mode.phase);
      if (
        mode.phase === 'restoreQuarantine' ||
        (mode.phase === 'snapshot' && !safe) ||
        (mode.phase === 'draining' && !safe && !existing) ||
        (mode.phase === 'readOnly' && !safe && !authReadOnly)
      )
        throw blocked(mode.phase);
      if (safe) return false;
      await tx.query(
        "INSERT INTO app.operations_request_leases(id,instance_id,resource_id,kind,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '60 seconds')",
        [
          id,
          this.instanceId,
          resourceId,
          existing ? 'existingWork' : 'request',
        ],
      );
      return true;
    });
    if (!tracked) return { async release() {} };
    let closed = false,
      busy = false;
    const renew = setInterval(() => {
      if (closed || busy) return;
      busy = true;
      void this.db
        .query(
          "UPDATE app.operations_request_leases SET expires_at=clock_timestamp()+interval '60 seconds' WHERE id=$1",
          [id],
        )
        .catch(() => {})
        .finally(() => {
          busy = false;
        });
    }, 10000);
    renew.unref();
    return {
      release: async () => {
        if (closed) return;
        closed = true;
        clearInterval(renew);
        await this.db.query(
          'DELETE FROM app.operations_request_leases WHERE id=$1',
          [id],
        );
      },
    };
  }
  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      void this.enterRequest(req.method, req.path)
        .then((lease) => {
          const release = () => {
            void lease
              .release()
              .catch(() =>
                process.stderr.write('OPERATIONS_LEASE_RELEASE_FAILED\n'),
              );
          };
          res.once('finish', release);
          res.once('close', release);
          next();
        })
        .catch((error: unknown) => {
          const domain =
            error instanceof DomainError ? error : blocked('draining');
          res.status(domain.status).json({
            error: { code: domain.code, message: domain.message },
            meta: { requestId: String(res.locals.requestId ?? randomUUID()) },
          });
        });
    };
  }
  async begin(operationId: string, reason: string) {
    z.uuid().parse(operationId);
    return this.db.transaction(async (tx) => {
      const mode = (
        await tx.query<ModeRow>(
          'SELECT phase,operation_id,reason FROM app.maintenance_state WHERE singleton FOR UPDATE',
        )
      ).rows[0]!;
      if (mode.phase !== 'idle' && mode.operation_id !== operationId)
        throw blocked(mode.phase);
      await tx.query(
        "UPDATE app.maintenance_state SET operation_id=$1,phase='draining',reason=$2,started_at=clock_timestamp(),updated_at=clock_timestamp() WHERE singleton",
        [operationId, reason],
      );
    });
  }
  async activeWork(transaction: SqlExecutor = this.db) {
    const requests = Number(
      (
        await transaction.query<{ count: string }>(
          'SELECT count(*)::text count FROM app.operations_request_leases WHERE expires_at>clock_timestamp()',
        )
      ).rows[0]!.count,
    );
    const api = Number(
      (
        await transaction.query<{ count: string }>(
          "SELECT count(*)::text count FROM app.api_worker_grants g JOIN app.runs r ON r.id=g.run_id WHERE g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND r.state IN ('prepared','running','stopping')",
        )
      ).rows[0]!.count,
    );
    const ai = Number(
      (
        await transaction.query<{ count: string }>(
          "SELECT count(*)::text count FROM app.ai_tasks WHERE state IN ('running','cancelling')",
        )
      ).rows[0]!.count,
    );
    const files = Number(
      (
        await transaction.query<{ count: string }>(
          "SELECT count(*)::text count FROM app.file_resources WHERE status='uploading' AND upload_expires_at>clock_timestamp()",
        )
      ).rows[0]!.count,
    );
    let auxiliary = 0;
    if (
      (
        await transaction.query<{ exists: boolean }>(
          "SELECT to_regclass('app.auxiliary_tasks') IS NOT NULL exists",
        )
      ).rows[0]?.exists
    )
      auxiliary = Number(
        (
          await transaction.query<{ count: string }>(
            "SELECT count(*)::text count FROM app.auxiliary_tasks WHERE state IN ('accepted','running','cancelling')",
          )
        ).rows[0]!.count,
      );
    return {
      requests,
      api,
      ai,
      files,
      auxiliary,
      total: requests + api + ai + files + auxiliary,
    };
  }
  async freezeIfDrained(operationId: string) {
    return this.db.transaction(async (tx) => {
      const mode = (
        await tx.query<ModeRow>(
          'SELECT phase,operation_id,reason FROM app.maintenance_state WHERE singleton FOR UPDATE',
        )
      ).rows[0]!;
      if (mode.operation_id !== operationId || mode.phase !== 'draining')
        throw blocked(mode.phase);
      const active = await this.activeWork(tx);
      if (active.total) return { frozen: false, active };
      await tx.query(
        "UPDATE app.maintenance_state SET phase='snapshot',updated_at=clock_timestamp() WHERE singleton",
      );
      return { frozen: true, active };
    });
  }
  async waitUntilDrained(operationId: string, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.freezeIfDrained(operationId);
      if (result.frozen) return;
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new DomainError(
      'DEPENDENCY_UNAVAILABLE',
      '在途任务/上传尚未正常收尾，本次备份未开始，未强制中断业务。',
      503,
    );
  }
  async release(operationId: string) {
    await this.db.transaction(async (tx) => {
      const mode = (
        await tx.query<ModeRow>(
          'SELECT phase,operation_id,reason FROM app.maintenance_state WHERE singleton FOR UPDATE',
        )
      ).rows[0]!;
      if (mode.operation_id !== operationId) throw blocked(mode.phase);
      if (!['draining', 'snapshot'].includes(mode.phase))
        throw blocked(mode.phase);
      await tx.query(
        'UPDATE app.schedule_runtime SET recovery_cutoff_at=greatest(recovery_cutoff_at,clock_timestamp()) WHERE singleton',
      );
      await tx.query(
        "UPDATE app.maintenance_state SET phase='idle',operation_id=NULL,reason='',started_at=NULL,updated_at=clock_timestamp() WHERE singleton",
      );
    });
  }
}
