import type { SqlExecutor } from '../../../persistence/src/database.js';
import { DomainError } from '../errors.js';

/** Missing/partial/restored installation state is never evidence for a legacy default. */
export async function resourcePolicyInstallationState(
  tx: SqlExecutor,
): Promise<'ready' | 'pre34'> {
  try {
    const row = (
      await tx.query<{
        head: boolean;
        bindings: boolean;
        revisions: boolean;
        activations: boolean;
        migrations: boolean;
      }>(`SELECT
      to_regclass('app.resource_policy_head') IS NOT NULL head,
      to_regclass('app.resource_policy_acceptances') IS NOT NULL bindings,
      to_regclass('app.resource_policy_revisions') IS NOT NULL revisions,
      to_regclass('app.resource_policy_activations') IS NOT NULL activations,
      to_regclass('app.schema_migrations') IS NOT NULL migrations`)
    ).rows[0];
    if (!row?.migrations) throw Error('Unknown migration state.');
    const recorded = (
      await tx.query<{ recorded: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM app.schema_migrations WHERE version>='0034_') recorded",
      )
    ).rows[0]?.recorded;
    if (
      row.head &&
      row.bindings &&
      row.revisions &&
      row.activations &&
      recorded
    )
      return 'ready';
    if (
      !row.head &&
      !row.bindings &&
      !row.revisions &&
      !row.activations &&
      recorded === false
    )
      return 'pre34';
  } catch {
    /* A failed read is not a pre34 installation. */
  }
  throw new DomainError(
    'DEPENDENCY_UNAVAILABLE',
    '资源策略结构或迁移状态不完整，未采用旧默认。',
    503,
  );
}
