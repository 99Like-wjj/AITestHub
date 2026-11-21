import type { ActiveResourcePolicy } from '../../../contracts/src/resource-policy.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { DomainError } from '../errors.js';
import { resourcePolicyInstallationState } from '../resource-policy/installation.js';

/** Supplied by trusted host code; never read from a task/model/tool input. */
export type ActiveClaimPolicyReader = (
  transaction: SqlExecutor,
) => Promise<ActiveResourcePolicy>;
export type ClaimPolicy = {
  readonly source: 'central';
  readonly limits: Readonly<{ maxApiRuns: number; maxAiTasks: number }>;
  readonly identity: Readonly<{
    revisionId: string;
    digest: string;
    activationVersion: string;
  }>;
};

/**
 * The central reader owns anchor/version/capability
 * validation and takes the head SHARE lock inside this same claim transaction.
 */
export async function loadClaimPolicy(
  transaction: SqlExecutor,
  readActive: ActiveClaimPolicyReader,
): Promise<ClaimPolicy> {
  if ((await resourcePolicyInstallationState(transaction)) !== 'ready')
    throw unavailable();
  const current = await readActive(transaction);
  for (const value of [
    current.policy.tasks.maxApiRuns,
    current.policy.tasks.maxAiTasks,
  ])
    if (!Number.isSafeInteger(value) || value < 1 || value > 1024)
      throw unavailable();
  return Object.freeze({
    source: 'central',
    limits: current.policy.tasks,
    identity: Object.freeze({
      revisionId: current.revisionId,
      digest: current.digest,
      activationVersion: current.activationVersion,
    }),
  });
}

function unavailable() {
  return new DomainError(
    'DEPENDENCY_UNAVAILABLE',
    '无法确认中央并发策略版本；未采用本进程默认值或领取新任务。',
    503,
  );
}
