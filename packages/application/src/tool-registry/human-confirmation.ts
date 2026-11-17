import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ActorContext } from '../../../contracts/src/identity.js';
import { humanConfirmationProposalSchema } from '../../../contracts/src/human-confirmation.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { currentUser } from '../access/policy.js';
import { canonicalJson } from '../operations/service.js';
import { DomainError } from '../errors.js';

export interface HumanConfirmationExecutionProof {
  readonly confirmationId: string;
  readonly ownerId: string;
  readonly origin: 'internal-ai' | 'official-mcp';
  readonly taskId: string | null;
  readonly conversationId: string | null;
  readonly projectId: string | null;
  readonly toolName: string;
  readonly op: string;
  readonly scopeDigest: string;
  readonly argumentsHash: string;
  readonly arguments: unknown;
  readonly proposalScope: unknown;
  readonly resolutionSource: 'web-user-event' | 'mcp-form-elicitation';
}
export interface HumanConfirmationClaim {
  confirmationId: string;
  ownerId: string;
  origin: HumanConfirmationExecutionProof['origin'];
  taskId: string | null;
  conversationId: string | null;
  projectId: string | null;
  toolName: string;
  op: string;
  scopeDigest: string;
  argumentsHash: string;
  resolutionSource: HumanConfirmationExecutionProof['resolutionSource'];
}
interface StoredConfirmation {
  id: string;
  owner_id: string;
  origin: HumanConfirmationExecutionProof['origin'];
  task_id: string | null;
  conversation_id: string | null;
  project_id: string | null;
  key_id: string | null;
  tool_name: string;
  operation: string;
  scope_digest: string;
  argument_digest: string;
  arguments: unknown;
  proposal: unknown;
  state: string;
  dispatch_claim: boolean;
  resolution_source: HumanConfirmationExecutionProof['resolutionSource'] | null;
  resolved_at: Date | null;
}
const active = new WeakMap<
  ActorContext,
  {
    claim: Readonly<HumanConfirmationClaim>;
    proof: HumanConfirmationExecutionProof;
  }
>();
const hash = (input: unknown) =>
  createHash('sha256').update(canonicalJson(input)).digest('hex');
const invalid = () =>
  new DomainError(
    'STALE_BASE_REVISION',
    '本次人工确认的身份、精确参数或发送范围已变化，未重新执行。',
    412,
  );
function deepFreeze(value: unknown): unknown {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
async function verified(
  tx: SqlExecutor,
  actor: ActorContext,
  claim: Readonly<HumanConfirmationClaim>,
) {
  await currentUser(tx, actor);
  const row = (
    await tx.query<StoredConfirmation>(
      'SELECT * FROM app.business_confirmations WHERE id=$1 AND owner_id=$2 FOR SHARE',
      [claim.confirmationId, actor.userId],
    )
  ).rows[0];
  if (
    !row ||
    row.owner_id !== claim.ownerId ||
    row.origin !== claim.origin ||
    row.task_id !== claim.taskId ||
    row.conversation_id !== claim.conversationId ||
    row.project_id !== claim.projectId ||
    row.tool_name !== claim.toolName ||
    row.operation !== claim.op ||
    row.scope_digest !== claim.scopeDigest ||
    row.argument_digest !== claim.argumentsHash ||
    row.state !== 'executing' ||
    !row.dispatch_claim ||
    row.resolution_source !== claim.resolutionSource ||
    !row.resolved_at ||
    (row.origin === 'internal-ai' &&
      (actor.entrypoint !== 'internal-ai' ||
        !row.task_id ||
        actor.requestId !== row.task_id)) ||
    (row.origin === 'official-mcp' &&
      (actor.entrypoint !== 'official-mcp' ||
        !actor.keyId ||
        actor.keyId !== row.key_id))
  )
    throw invalid();
  const proposal = humanConfirmationProposalSchema.safeParse(row.proposal);
  if (!proposal.success) throw invalid();
  const { digest, ...scope } = proposal.data;
  if (
    digest !== row.scope_digest ||
    hash({
      toolName: row.tool_name,
      op: row.operation,
      input: row.arguments,
    }) !== row.argument_digest ||
    hash({
      name: row.tool_name,
      op: row.operation,
      input: row.arguments,
      scope,
    }) !== row.scope_digest
  )
    throw invalid();
  return { row, proposal: proposal.data };
}

/** Server-only dynamic authority. No actor field, model input, command UUID or
 * durable confirmation locator can reconstruct this WeakMap identity. */
export async function humanConfirmationExecutionInTransaction(
  tx: SqlExecutor,
  actor: ActorContext,
): Promise<HumanConfirmationExecutionProof | null> {
  const binding = active.get(actor);
  if (!binding) return null;
  const current = await verified(tx, actor, binding.claim);
  if (
    canonicalJson(current.row.arguments) !==
      canonicalJson(binding.proof.arguments) ||
    canonicalJson(current.proposal.scope) !==
      canonicalJson(binding.proof.proposalScope)
  )
    throw invalid();
  return binding.proof;
}

/** Only ActionIntents calls this after a fresh authenticated
 * human accept and its unique successful dispatch claim. Always revoke locally. */
export async function withHumanConfirmedExecution<T>(
  db: Pick<Database, 'transaction'>,
  humanActor: ActorContext,
  serviceActor: ActorContext,
  claim: HumanConfirmationClaim,
  work: () => Promise<T>,
): Promise<T> {
  if (
    active.has(serviceActor) ||
    humanActor.userId !== serviceActor.userId ||
    (claim.resolutionSource === 'web-user-event' &&
      humanActor.entrypoint !== 'web') ||
    (claim.resolutionSource === 'mcp-form-elicitation' &&
      humanActor.entrypoint !== 'official-mcp')
  )
    throw new DomainError(
      'FORBIDDEN',
      '只有本次真实本人确认执行能够绑定服务端授权上下文。',
      403,
    );
  const current = await db.transaction((tx) =>
    verified(tx, serviceActor, claim),
  );
  const proof: HumanConfirmationExecutionProof = Object.freeze({
    ...{
      confirmationId: claim.confirmationId,
      ownerId: claim.ownerId,
      origin: claim.origin,
      taskId: claim.taskId,
      conversationId: claim.conversationId,
      projectId: claim.projectId,
      toolName: claim.toolName,
      op: claim.op,
      scopeDigest: claim.scopeDigest,
      argumentsHash: claim.argumentsHash,
      resolutionSource: claim.resolutionSource,
    },
    arguments: deepFreeze(z.json().parse(current.row.arguments)),
    proposalScope: deepFreeze(z.json().parse(current.proposal.scope)),
  });
  active.set(serviceActor, { claim: Object.freeze({ ...claim }), proof });
  try {
    return await work();
  } finally {
    active.delete(serviceActor);
  }
}
