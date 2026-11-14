import { idSchema, sha256Schema } from '../../../contracts/src/base.js';
import {
  resourcePolicyHeadIdentitySchema,
  type ActiveResourcePolicy,
  type ResourcePolicyCapabilities,
  type ResourcePolicyHeadIdentity,
  type ResourcePolicySnapshot,
} from '../../../contracts/src/resource-policy.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { DomainError } from '../errors.js';
import {
  assertResourcePolicyHead,
  assertResourcePolicySupported,
  freezeResourcePolicy,
  resourcePolicyDigest,
} from './core.js';

interface PolicyRow {
  revision_id: string;
  policy_digest: string;
  document: unknown;
  activation_version?: string;
}

function snapshot(
  row: PolicyRow | undefined,
  capabilities: ResourcePolicyCapabilities,
): ResourcePolicySnapshot {
  if (
    !row ||
    !idSchema.safeParse(row.revision_id).success ||
    !sha256Schema.safeParse(row.policy_digest).success
  )
    throw new DomainError(
      'DEPENDENCY_UNAVAILABLE',
      '中央资源策略不存在或元数据无效；未采用本进程默认值。',
      503,
    );
  const policy = freezeResourcePolicy(row.document);
  if (resourcePolicyDigest(policy) !== row.policy_digest)
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '中央资源策略摘要不一致；未受理新任务。',
      503,
    );
  assertResourcePolicySupported(policy, capabilities);
  return Object.freeze({
    revisionId: row.revision_id,
    digest: row.policy_digest,
    policy,
  });
}

async function selectPolicy(
  tx: SqlExecutor,
  sql: string,
  values: readonly unknown[] = [],
): Promise<PolicyRow | undefined> {
  try {
    const result = await tx.query<PolicyRow>(sql, values);
    if (result.rows.length > 1) throw new Error('Ambiguous central policy.');
    return result.rows[0];
  } catch {
    // No raw DB text, connection material, or document escapes through this boundary.
    throw new DomainError(
      'DEPENDENCY_UNAVAILABLE',
      '中央资源策略暂不可读；未采用本进程默认值。',
      503,
    );
  }
}

/**
 * Call inside the transaction that admits new work. FOR SHARE serializes policy
 * activation against admission; there is intentionally no environment fallback,
 * process cache, model-supplied override, or implicit bootstrap write.
 */
export async function loadActiveResourcePolicy(
  tx: SqlExecutor,
  capabilities: ResourcePolicyCapabilities,
  expected?: ResourcePolicyHeadIdentity,
): Promise<ActiveResourcePolicy> {
  const row = await selectPolicy(
    tx,
    `SELECT r.id revision_id,r.policy_digest,r.document,h.activation_version::text
       FROM app.resource_policy_head h
       JOIN app.resource_policy_revisions r ON r.id=h.revision_id
       WHERE h.singleton=true FOR SHARE OF h`,
  );
  const policy = snapshot(row, capabilities);
  const identity = resourcePolicyHeadIdentitySchema.safeParse({
    revisionId: policy.revisionId,
    digest: policy.digest,
    activationVersion: row?.activation_version,
  });
  if (!identity.success)
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '中央资源策略激活版本无效。',
      503,
    );
  const active = Object.freeze({
    ...policy,
    activationVersion: identity.data.activationVersion,
  });
  if (expected) assertResourcePolicyHead(active, expected);
  return active;
}

/**
 * Load a pinned policy reference obtained from an authorized, persisted accepted
 * identity, never from model/tool parameters. This reader does not itself prove
 * that business ownership, original payload or retransmission scope matches.
 * A pinned snapshot is not a permit to acquire a new task slot under an old limit.
 */
export async function loadAcceptedResourcePolicy(
  tx: SqlExecutor,
  reference: Pick<ResourcePolicySnapshot, 'revisionId' | 'digest'>,
  capabilities: ResourcePolicyCapabilities,
): Promise<ResourcePolicySnapshot> {
  const revision = idSchema.safeParse(reference.revisionId);
  if (!revision.success || !sha256Schema.safeParse(reference.digest).success)
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '原受理资源策略身份无效；不能改用当前策略重新解释。',
      503,
    );
  const loaded = snapshot(
    await selectPolicy(
      tx,
      'SELECT id revision_id,policy_digest,document FROM app.resource_policy_revisions WHERE id=$1',
      [revision.data],
    ),
    capabilities,
  );
  if (
    loaded.revisionId !== reference.revisionId ||
    loaded.digest !== reference.digest
  )
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '原受理资源策略与冻结摘要不符；未重传或重新受理。',
      503,
    );
  return loaded;
}
