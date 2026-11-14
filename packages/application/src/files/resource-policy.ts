import { createHash } from 'node:crypto';
import {
  defaultResourcePolicy,
  type ResourcePolicyCapabilities,
  type ResourcePolicySnapshot,
} from '../../../contracts/src/resource-policy.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { DomainError } from '../errors.js';
import { canonicalJson } from '../operations/service.js';
import { resourcePolicyReaderFromEnvironment } from '../resource-policy/environment.js';
import type { ResourcePolicyAnchorReader } from '../resource-policy/anchor.js';
import { loadAnchoredResourcePolicy } from '../resource-policy/operations.js';
import { loadAcceptedResourcePolicy } from '../resource-policy/loader.js';
import { resourcePolicyDigest } from '../resource-policy/core.js';
import { runtimeResourceCapabilities } from '../resource-policy/capabilities.js';
import { resourcePolicyInstallationState } from '../resource-policy/installation.js';

/** Binary/structural capability, not an active deployment default or model override. */
export const fileResourceCapabilities = runtimeResourceCapabilities;
export const fileIntentDigest = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
export type FilePolicySnapshot = ResourcePolicySnapshot & {
  readonly source: 'active' | 'accepted' | 'legacyDefault';
};
export type FilePolicyIntent = {
  ownerId: string;
  projectId: string | null;
  namespace:
    | 'file'
    | 'requirements.create'
    | 'requirements.add-version'
    | 'results.submit'
    | 'results.amend'
    | 'results.evidence-addition'
    | 'ui.batch'
    | 'ui.descriptor';
  key: string;
  payloadDigest: string;
  existing: boolean;
};
export interface RegisteredFilePolicyIdentity {
  id: string;
  owner_scope: string;
  owner_user_id: string;
  project_id: string | null;
  run_id: string | null;
  local_file_id: string;
  original_name: string;
  media_type: string;
  declared_bytes: string;
  declared_sha256: string;
}
export function registeredFilePolicyIntent(
  file: RegisteredFilePolicyIdentity,
  existing = true,
): FilePolicyIntent {
  return {
    ownerId: file.owner_user_id,
    projectId: file.project_id,
    namespace: 'file',
    key: file.id,
    existing,
    payloadDigest: fileIntentDigest({
      ownerScope: file.owner_scope,
      ownerId: file.owner_user_id,
      projectId: file.project_id,
      runId: file.run_id,
      localFileId: file.local_file_id,
      originalName: file.original_name,
      mediaType: file.media_type,
      bytes: file.declared_bytes,
      sha256: file.declared_sha256,
    }),
  };
}
interface Acceptance {
  policy_revision_id: string;
  policy_digest: string;
  payload_digest: string;
}
const legacy: FilePolicySnapshot = Object.freeze({
  revisionId: '34dbe2ea-c9c9-48d9-9318-06b20fba8e92',
  digest: resourcePolicyDigest(defaultResourcePolicy),
  policy: defaultResourcePolicy,
  source: 'legacyDefault',
});

/** Only trusted caller identities and SQL facts enter this port; never expose intent/policy parameters to a tool. */
export class FileResourcePolicies {
  constructor(
    private readonly openReader: () => Promise<ResourcePolicyAnchorReader> = resourcePolicyReaderFromEnvironment,
    private readonly capabilities: ResourcePolicyCapabilities = fileResourceCapabilities,
  ) {}
  private async state(tx: SqlExecutor): Promise<'ready' | 'pre34'> {
    return resourcePolicyInstallationState(tx);
  }
  private async pre34NewIntent(): Promise<FilePolicySnapshot> {
    try {
      // Only an authenticated, readable absence is an installation before policy
      // existed. A newer/old/corrupt external control is a restore fence, not a default.
      if ((await (await this.openReader()).read()) === null) return legacy;
    } catch {
      /* Missing key, unreadable/corrupt anchor, and undefined are not null. */
    }
    throw new DomainError(
      'DEPENDENCY_UNAVAILABLE',
      '旧数据库缺少最新文件资源策略；新意图保持关闭，不能采用旧默认。',
      503,
    );
  }
  private async stored(
    tx: SqlExecutor,
    intent: FilePolicyIntent,
  ): Promise<FilePolicySnapshot | null> {
    const row = (
      await tx.query<Acceptance>(
        `SELECT policy_revision_id,policy_digest,payload_digest FROM app.resource_policy_acceptances
      WHERE owner_id=$1 AND project_id IS NOT DISTINCT FROM $2::uuid AND namespace=$3 AND intent_key=$4`,
        [intent.ownerId, intent.projectId, intent.namespace, intent.key],
      )
    ).rows[0];
    if (!row) return null;
    if (row.payload_digest !== intent.payloadDigest)
      throw new DomainError(
        'IDEMPOTENCY_CONFLICT',
        '原受理资源策略已绑定不同载荷；未替换。',
        409,
      );
    return {
      ...(await loadAcceptedResourcePolicy(
        tx,
        { revisionId: row.policy_revision_id, digest: row.policy_digest },
        this.capabilities,
      )),
      source: 'accepted',
    };
  }
  /** Read-only preview, or an authorized existing identity. Never inserts/backfills a binding. */
  async read(
    tx: SqlExecutor,
    intent?: FilePolicyIntent,
  ): Promise<FilePolicySnapshot> {
    if ((await this.state(tx)) === 'pre34')
      return intent?.existing ? legacy : this.pre34NewIntent();
    if (intent) {
      const saved = await this.stored(tx, intent);
      if (saved) return saved;
      if (intent.existing) return legacy;
    }
    return {
      ...(await loadAnchoredResourcePolicy(
        tx,
        this.capabilities,
        await this.openReader(),
      )),
      source: 'active',
    };
  }
  /** In the same authorized business-acceptance transaction. Existing history without a sidecar remains legacy. */
  async accept(
    tx: SqlExecutor,
    intent: FilePolicyIntent,
  ): Promise<FilePolicySnapshot> {
    const selected = await this.read(tx, intent);
    if (selected.source !== 'active') return selected;
    await tx.query(
      `INSERT INTO app.resource_policy_acceptances(owner_id,project_id,namespace,intent_key,payload_digest,policy_revision_id,policy_digest,file_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [
        intent.ownerId,
        intent.projectId,
        intent.namespace,
        intent.key,
        intent.payloadDigest,
        selected.revisionId,
        selected.digest,
        intent.namespace === 'file' ? intent.key : null,
      ],
    );
    const saved = await this.stored(tx, intent);
    if (!saved)
      throw new DomainError(
        'DEPENDENCY_UNAVAILABLE',
        '资源策略受理绑定未完成。',
        503,
      );
    return saved;
  }
}
export const fileResourcePolicies = new FileResourcePolicies();

export function assertFilePolicyCounts(
  policy: FilePolicySnapshot,
  count: number,
) {
  if (count > policy.policy.files.maxFilesPerBatch)
    throw new DomainError(
      'FILE_TOO_LARGE',
      '本次文件/证据身份数量超过原受理资源策略。',
      413,
      {
        limitFiles: policy.policy.files.maxFilesPerBatch,
        declaredFiles: count,
      },
    );
}
