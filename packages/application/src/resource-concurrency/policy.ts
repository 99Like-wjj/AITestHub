import type { ActiveResourcePolicy } from '../../../contracts/src/resource-policy.js';
import { defaultResourcePolicy } from '../../../contracts/src/resource-policy.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { DomainError } from '../errors.js';

/** Supplied by trusted host code; never read from a task/model/tool input. */
export type ActiveClaimPolicyReader = (
  transaction: SqlExecutor,
) => Promise<ActiveResourcePolicy>;
export type ClaimPolicy =
  | {
      readonly source: 'legacy-pre34';
      readonly limits: Readonly<{ maxApiRuns: number; maxAiTasks: number }>;
    }
  | {
      readonly source: 'central';
      readonly limits: Readonly<{ maxApiRuns: number; maxAiTasks: number }>;
      readonly identity: Readonly<{
        revisionId: string;
        digest: string;
        activationVersion: string;
      }>;
    };

/**
 * Explicit compatibility boundary only. A damaged/newer policy schema must never
 * look like an older deployment. The central reader owns anchor/version/capability
 * validation and takes the head SHARE lock inside this same claim transaction.
 */
export async function loadClaimPolicy(
  transaction: SqlExecutor,
  readActive: ActiveClaimPolicyReader,
  readExternalAnchor: () => Promise<unknown | null>,
): Promise<ClaimPolicy> {
  let row:
    | { head: string | null; revisions: string | null; migrated: boolean }
    | undefined;
  try {
    row = (
      await transaction.query<{
        head: string | null;
        revisions: string | null;
        migrated: boolean;
      }>(
        `SELECT to_regclass('app.resource_policy_head')::text head,
          to_regclass('app.resource_policy_revisions')::text revisions,
          EXISTS(SELECT 1 FROM app.schema_migrations WHERE left(version,5)='0034_') migrated`,
      )
    ).rows[0];
  } catch {
    throw unavailable();
  }
  if (!row) throw unavailable();
  if (row.head === null && row.revisions === null && !row.migrated) {
    // A pre34 restored DB may coexist with a newer independent anchor. That is
    // recovery quarantine, not permission to increase limits to old defaults.
    let external: unknown;
    try {
      external = await readExternalAnchor();
    } catch {
      throw unavailable();
    }
    if (external !== null) throw unavailable();
    return Object.freeze({
      source: 'legacy-pre34',
      limits: defaultResourcePolicy.tasks,
    });
  }
  if (!row.head || !row.revisions || !row.migrated) throw unavailable();
  // Intentionally do not catch a bad head/anchor/digest and fall back to defaults.
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
