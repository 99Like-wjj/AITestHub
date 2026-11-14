import type { SqlExecutor } from '../../../persistence/src/database.js';
import { DomainError } from '../errors.js';
import type { ClaimPolicy } from './policy.js';

export type TaskSlotKind = 'apiRun' | 'aiTask';
export interface TaskSlotDecision {
  readonly allowed: boolean;
  readonly activeCount: number;
  readonly limit: number;
  readonly policy: ClaimPolicy;
}

/**
 * The caller must load its current policy first, then call this helper and perform
 * its accepted -> running/grant INSERT in the SAME transaction. This function
 * acquires a transaction-wide lock; it is not a reservation or a standalone API.
 * No executor/HTTP/model request runs while holding the lock.
 */
export async function lockTaskSlot(
  transaction: SqlExecutor,
  kind: TaskSlotKind,
  policy: ClaimPolicy,
): Promise<TaskSlotDecision> {
  if (kind === 'apiRun') {
    // Keep the existing API control mutex, rather than introducing a second pool.
    await transaction.query('SELECT pg_advisory_xact_lock(415948012)');
  } else if (kind === 'aiTask') {
    // Chat and auxiliary must use this exact key across every process/project.
    await transaction.query('SELECT pg_advisory_xact_lock(415948034,2)');
  } else throw unavailable();
  const row = (
    await transaction.query<{ count: string }>(
      kind === 'apiRun'
        ? `SELECT count(*)::text count FROM app.api_worker_grants
             WHERE revoked_at IS NULL`
        : `SELECT ((SELECT count(*) FROM app.ai_tasks WHERE state IN ('running','cancelling'))
             +(SELECT count(*) FROM app.auxiliary_tasks WHERE state IN ('running','cancelling')))::text count`,
    )
  ).rows[0];
  if (!row || !/^(0|[1-9][0-9]*)$/.test(row.count)) throw unavailable();
  const count = Number(row.count);
  const limit =
    kind === 'apiRun' ? policy.limits.maxApiRuns : policy.limits.maxAiTasks;
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1024
  )
    throw unavailable();
  return Object.freeze({
    allowed: count < limit,
    activeCount: count,
    limit,
    policy,
  });
}

function unavailable() {
  return new DomainError(
    'DEPENDENCY_UNAVAILABLE',
    '无法确认全局在途任务数量或限制；未领取新任务。',
    503,
  );
}
