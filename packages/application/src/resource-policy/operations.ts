import { createHash, randomUUID } from 'node:crypto';
import type { ActorContext } from '../../../contracts/src/identity.js';
import {
  activateResourcePolicySchema,
  defaultResourcePolicy,
  resourcePolicyActivationReceiptSchema,
  resourcePolicyCapabilitiesSchema,
  type ResourcePolicyActivationReceipt,
  type ResourcePolicyCapabilities,
  type ResourcePolicyHeadIdentity,
} from '../../../contracts/src/resource-policy.js';
import { commandIdSchema, idSchema } from '../../../contracts/src/base.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { requirePlatformAdmin } from '../access/policy.js';
import { audit } from '../events.js';
import { DomainError } from '../errors.js';
import { canonicalJson } from '../operations/service.js';
import {
  assertResourcePolicyHead,
  assertResourcePolicySupported,
  resourcePolicyDigest,
} from './core.js';
import {
  loadActiveResourcePolicy,
  loadAcceptedResourcePolicy,
} from './loader.js';
import {
  policyFenceUnavailable,
  samePolicyHead,
  type ResourcePolicyAnchorPort,
  type ResourcePolicyAnchorReader,
} from './anchor.js';

const writerLock = 415948034;
const unknownActivation = () =>
  new DomainError(
    'OPERATION_RESULT_UNKNOWN',
    '资源策略提交或栅栏回执未知；请查询原操作，不要换标识重新激活。',
    409,
  );
interface ActivationRow {
  actor_id: string;
  request_hash: string;
  receipt: unknown;
}
const identity = (
  value: ResourcePolicyHeadIdentity,
): ResourcePolicyHeadIdentity => ({
  revisionId: value.revisionId,
  digest: value.digest,
  activationVersion: value.activationVersion,
});
export async function resourcePolicyPlatformId(
  tx: SqlExecutor,
): Promise<string> {
  try {
    const row = (
      await tx.query<{ platform_id: string }>(
        'SELECT platform_id::text FROM app.recovery_control_state WHERE singleton',
      )
    ).rows[0];
    if (!row || !idSchema.safeParse(row.platform_id).success)
      throw policyFenceUnavailable();
    return row.platform_id;
  } catch {
    throw policyFenceUnavailable();
  }
}
/** Read-only admission fence. Never initializes or resolves a prepared external record. */
export async function loadAnchoredResourcePolicy(
  tx: SqlExecutor,
  capabilities: ResourcePolicyCapabilities,
  anchor: ResourcePolicyAnchorReader,
) {
  const current = await loadActiveResourcePolicy(tx, capabilities);
  const platformId = await resourcePolicyPlatformId(tx),
    external = await anchor.read();
  if (
    !external ||
    external.pending ||
    external.platformId !== platformId ||
    !samePolicyHead(external.committed.head, current)
  )
    throw policyFenceUnavailable();
  return current;
}

/** No controller/tool binding: trusted host constructs this with binary capabilities and a fixed private anchor. */
export class ResourcePolicyOperations {
  readonly capabilities: ResourcePolicyCapabilities;
  constructor(
    readonly db: Pick<Database, 'query' | 'transaction'>,
    readonly anchor: ResourcePolicyAnchorPort,
    capabilities: ResourcePolicyCapabilities,
    private readonly bootstrap?: {
      platformId: string;
      head: ResourcePolicyHeadIdentity;
    },
  ) {
    const parsed = resourcePolicyCapabilitiesSchema.safeParse(capabilities);
    if (!parsed.success) throw policyFenceUnavailable();
    this.capabilities = Object.freeze(parsed.data);
  }
  private async authorize(tx: SqlExecutor, actor: ActorContext) {
    if (actor.entrypoint !== 'web' || actor.keyId)
      throw new DomainError(
        'FORBIDDEN',
        '仅当前平台管理员的可信运维入口可管理资源策略。',
        403,
      );
    await requirePlatformAdmin(tx, actor);
  }
  private async locked(tx: SqlExecutor, actor: ActorContext) {
    await this.authorize(tx, actor);
    await tx.query('SELECT pg_advisory_xact_lock($1)', [writerLock]);
    await tx.query(
      'SELECT singleton FROM app.resource_policy_head WHERE singleton FOR UPDATE',
    );
  }
  private async reconcile(tx: SqlExecutor) {
    let external = await this.anchor.read();
    if (!external) throw policyFenceUnavailable();
    const current = await loadActiveResourcePolicy(tx, this.capabilities),
      platformId = await resourcePolicyPlatformId(tx);
    if (external.platformId !== platformId) throw policyFenceUnavailable();
    if (external.pending) {
      const pending = external.pending;
      const stored = (
        await tx.query<ActivationRow>(
          'SELECT actor_id::text,request_hash,receipt FROM app.resource_policy_activations WHERE id=$1',
          [pending.receipt.activationId],
        )
      ).rows[0];
      if (
        !stored ||
        stored.actor_id !== pending.actorId ||
        stored.request_hash !== pending.requestHash ||
        canonicalJson(stored.receipt) !== canonicalJson(pending.receipt) ||
        !samePolicyHead(current, pending.receipt.activatedHead)
      )
        throw policyFenceUnavailable();
      external = {
        ...external,
        committed: {
          head: pending.receipt.activatedHead,
          document: pending.document,
        },
        pending: null,
      };
      await this.anchor.write(external);
    }
    if (!samePolicyHead(current, external.committed.head))
      throw policyFenceUnavailable();
    return { current, platformId, external };
  }
  /** Explicit first-install bootstrap only; restore/startup never calls this automatically. */
  async initialize(actor: ActorContext) {
    return this.db.transaction(async (tx) => {
      await this.locked(tx, actor);
      return this.anchor.withWriter(async () => {
        if (await this.anchor.read()) return (await this.reconcile(tx)).current;
        const current = await loadActiveResourcePolicy(tx, this.capabilities),
          platformId = await resourcePolicyPlatformId(tx);
        const count = (
          await tx.query<{ count: string }>(
            'SELECT count(*)::text count FROM app.resource_policy_activations',
          )
        ).rows[0]!.count;
        if (
          !this.bootstrap ||
          this.bootstrap.platformId !== platformId ||
          !samePolicyHead(this.bootstrap.head, current) ||
          current.activationVersion !== '1' ||
          current.digest !== resourcePolicyDigest(defaultResourcePolicy) ||
          count !== '0'
        )
          throw policyFenceUnavailable();
        await this.anchor.write({
          schemaVersion: 'ath.resource-policy-anchor.v1',
          platformId,
          committed: {
            head: identity(current),
            document: structuredClone(current.policy),
          },
          pending: null,
        });
        return current;
      });
    });
  }
  async current(actor: ActorContext) {
    return this.db.transaction(async (tx) => {
      await this.locked(tx, actor);
      return this.anchor.withWriter(
        async () => (await this.reconcile(tx)).current,
      );
    });
  }
  async revision(
    actor: ActorContext,
    reference: { revisionId: string; digest: string },
  ) {
    return this.db.transaction(async (tx) => {
      await this.authorize(tx, actor);
      return loadAcceptedResourcePolicy(tx, reference, this.capabilities);
    });
  }
  async receipt(actor: ActorContext, rawCommandId: string) {
    const commandId = commandIdSchema.parse(rawCommandId);
    return this.db.transaction(async (tx) => {
      await this.locked(tx, actor);
      return this.anchor.withWriter(async () => {
        await this.reconcile(tx);
        const stored = (
          await tx.query<ActivationRow>(
            'SELECT actor_id::text,request_hash,receipt FROM app.resource_policy_activations WHERE actor_id=$1 AND command_key=$2',
            [actor.userId, commandId],
          )
        ).rows[0];
        if (!stored)
          throw new DomainError(
            'NOT_FOUND',
            '未找到本人的原资源策略激活回执。',
            404,
          );
        return resourcePolicyActivationReceiptSchema.parse(stored.receipt);
      });
    });
  }
  async activate(
    actor: ActorContext,
    raw: unknown,
  ): Promise<ResourcePolicyActivationReceipt> {
    await this.db.transaction((tx) => this.authorize(tx, actor));
    const input = activateResourcePolicySchema.safeParse(raw);
    if (!input.success)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '资源策略输入或版本无效。',
        503,
      );
    const request = input.data,
      documentDigest = resourcePolicyDigest(request.document);
    if (documentDigest !== request.documentDigest)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '资源策略输入摘要不一致。',
        503,
      );
    assertResourcePolicySupported(request.document, this.capabilities);
    const requestHash = createHash('sha256')
      .update(canonicalJson(request))
      .digest('hex');
    let prepareAttempted = false;
    let receipt: ResourcePolicyActivationReceipt;
    try {
      receipt = await this.db.transaction(async (tx) => {
        await this.locked(tx, actor);
        return this.anchor.withWriter(async () => {
          const stored = (
            await tx.query<ActivationRow>(
              'SELECT actor_id::text,request_hash,receipt FROM app.resource_policy_activations WHERE actor_id=$1 AND command_key=$2',
              [actor.userId, request.commandId],
            )
          ).rows[0];
          if (stored && stored.request_hash !== requestHash)
            throw new DomainError(
              'IDEMPOTENCY_CONFLICT',
              '同一资源策略操作标识对应不同内容。',
              409,
            );
          const { current, external } = await this.reconcile(tx);
          if (stored)
            return resourcePolicyActivationReceiptSchema.parse(stored.receipt);
          assertResourcePolicyHead(current, request.expectedHead);
          const next = {
            revisionId: randomUUID(),
            digest: documentDigest,
            activationVersion: (
              BigInt(current.activationVersion) + 1n
            ).toString(),
          };
          const result = resourcePolicyActivationReceiptSchema.parse({
            activationId: randomUUID(),
            commandId: request.commandId,
            previousHead: identity(current),
            activatedHead: next,
          });
          await tx.query(
            'INSERT INTO app.resource_policy_revisions(id,document,policy_digest) VALUES($1,$2,$3)',
            [next.revisionId, JSON.stringify(request.document), documentDigest],
          );
          const changed = await tx.query(
            `UPDATE app.resource_policy_head SET revision_id=$1,activation_version=$2::bigint WHERE singleton AND revision_id=$3 AND activation_version=$4::bigint`,
            [
              next.revisionId,
              next.activationVersion,
              current.revisionId,
              current.activationVersion,
            ],
          );
          if (changed.rowCount !== 1)
            throw new DomainError(
              'STALE_BASE_REVISION',
              '资源策略生效版本已变化。',
              412,
            );
          await tx.query(
            'INSERT INTO app.resource_policy_activations(id,actor_id,command_key,request_hash,previous_revision_id,activated_revision_id,receipt) VALUES($1,$2,$3,$4,$5,$6,$7)',
            [
              result.activationId,
              actor.userId,
              request.commandId,
              requestHash,
              current.revisionId,
              next.revisionId,
              JSON.stringify(result),
            ],
          );
          await audit(
            tx,
            actor,
            'resource-policy.activated',
            result.activationId,
            null,
            {
              revisionId: next.revisionId,
              activationVersion: next.activationVersion,
              digest: next.digest,
            },
          );
          prepareAttempted = true;
          await this.anchor.write({
            ...external,
            pending: {
              actorId: actor.userId,
              requestHash,
              receipt: result,
              document: request.document,
            },
          });
          return result;
        });
      });
    } catch (error: unknown) {
      if (prepareAttempted) throw unknownActivation();
      if (error instanceof DomainError) throw error;
      throw policyFenceUnavailable();
    }
    try {
      await this.receipt(actor, request.commandId);
    } catch {
      throw unknownActivation();
    }
    return receipt;
  }
}
