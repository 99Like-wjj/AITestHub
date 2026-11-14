import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  ActorContext,
  Capability,
} from '../../../contracts/src/identity.js';
import { findMcpOperation } from '../../../contracts/src/mcp.js';
import { idSchema } from '../../../contracts/src/base.js';
import {
  businessConfirmationSchema,
  resolveBusinessConfirmationInputSchema,
} from '../../../contracts/src/business-tools.js';
import { frozenConversationReferenceSchema } from '../../../contracts/src/conversations.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { currentUser, requireProject } from '../access/policy.js';
import { DomainError } from '../errors.js';
import { audit } from '../events.js';
import { canonicalJson } from '../operations/service.js';
import { assertFrozenTaskSources } from '../conversations/task-sources.js';
import type { BusinessToolRegistry, PreparedBusinessCall } from './registry.js';
import { withHumanConfirmedExecution } from './human-confirmation.js';

interface ConfirmationRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  origin: 'internal-ai' | 'official-mcp';
  key_id: string | null;
  task_id: string | null;
  conversation_id: string | null;
  tool_name: string;
  operation: string;
  arguments: unknown;
  scope_digest: string;
  argument_digest: string;
  proposal: unknown;
  state:
    | 'waitingConfirmation'
    | 'executing'
    | 'completed'
    | 'declined'
    | 'failed'
    | 'unknown';
  response: unknown;
  dispatch_claim: boolean;
  created_at: Date;
  resolved_at: Date | null;
}
export interface ConfirmationContext {
  taskId?: string;
  conversationId?: string;
}
const safe = (row: ConfirmationRow) =>
  businessConfirmationSchema.parse({
    id: row.id,
    toolName: row.tool_name,
    op: row.operation,
    projectId: row.project_id,
    taskId: row.task_id,
    conversationId: row.conversation_id,
    status: row.state,
    scopeDigest: row.scope_digest,
    proposal: row.proposal,
    response: row.response,
    createdAt: row.created_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    recovery: '未知或executing状态先查原业务command，不重放工具。',
  });
function confirmationCapability(name: string, op: string): Capability {
  if (name === 'ath_project_members') return 'project.members.manage';
  if (name === 'ath_results' && op === 'assess') return 'results.assess';
  if (name === 'ath_retests' && op === 'record-manual-result')
    return 'issues.lifecycle';
  return findMcpOperation(name, op)?.capability ?? 'project.read';
}

/** A durable proposal and UI event record, never an authentication/approval-role credential. */
export class BusinessConfirmations {
  constructor(
    readonly db: Database,
    readonly registry: BusinessToolRegistry,
  ) {}
  private async finishClaim(
    row: ConfirmationRow,
    state: 'completed' | 'failed' | 'unknown',
    response: unknown,
  ): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE app.business_confirmations SET state=$2,response=$3::jsonb WHERE id=$1 AND owner_id=$4 AND origin=$5
       AND task_id IS NOT DISTINCT FROM $6::uuid AND conversation_id IS NOT DISTINCT FROM $7::uuid AND project_id IS NOT DISTINCT FROM $8::uuid
       AND key_id IS NOT DISTINCT FROM $9::uuid AND state='executing' AND dispatch_claim
       AND scope_digest=$10 AND argument_digest=$11 AND arguments=$12::jsonb AND proposal=$13::jsonb`,
      [
        row.id,
        state,
        JSON.stringify(response),
        row.owner_id,
        row.origin,
        row.task_id,
        row.conversation_id,
        row.project_id,
        row.key_id,
        row.scope_digest,
        row.argument_digest,
        JSON.stringify(row.arguments),
        JSON.stringify(row.proposal),
      ],
    );
    return Boolean(result.rowCount);
  }
  private async assertTaskSources(
    tx: SqlExecutor,
    actor: ActorContext,
    row: ConfirmationRow,
  ): Promise<void> {
    if (row.origin !== 'internal-ai' || !row.task_id || !row.conversation_id)
      return;
    const message = (
      await tx.query<{
        id: string;
        explicit_refs: unknown;
        model_snapshot: unknown;
      }>(
        `SELECT m.id,m.explicit_refs,m.model_snapshot FROM app.ai_tasks t JOIN app.ai_messages m ON m.id=t.assistant_message_id
      WHERE t.id=$1 AND t.owner_id=$2 AND t.conversation_id=$3 AND m.deleted_at IS NULL`,
        [row.task_id, actor.userId, row.conversation_id],
      )
    ).rows[0];
    if (!message)
      throw new DomainError('NOT_FOUND', '原确认任务来源已不可访问。', 404);
    const captured = z
      .object({ provenanceCaptured: z.literal(true) })
      .safeParse(message.model_snapshot).success;
    const parsed = z
      .array(frozenConversationReferenceSchema)
      .safeParse(message.explicit_refs);
    if (!parsed.success)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '原任务来源尚未完成安全核验，未执行。',
        422,
      );
    const sources = captured
      ? parsed.data
      : [
          {
            reference: {
              kind: 'conversation',
              conversationId: row.conversation_id,
              mode: 'full',
              dataScope: 'syntheticPublicOnly',
            },
            messageIds: [message.id],
          },
        ];
    await assertFrozenTaskSources(tx, actor, sources);
  }
  private async authorize(
    tx: SqlExecutor,
    actor: ActorContext,
    row: ConfirmationRow,
  ): Promise<void> {
    await currentUser(tx, actor);
    if (row.owner_id !== actor.userId)
      throw new DomainError('NOT_FOUND', '没有此账号的确认提案。', 404);
    if (row.project_id)
      await requireProject(
        tx,
        actor,
        row.project_id,
        confirmationCapability(row.tool_name, row.operation),
      );
    if (
      row.conversation_id &&
      !(
        await tx.query(
          'SELECT 1 FROM app.ai_conversations WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL',
          [row.conversation_id, actor.userId],
        )
      ).rowCount
    )
      throw new DomainError('NOT_FOUND', '确认所属的个人会话已不可访问。', 404);
    if (
      actor.entrypoint === 'official-mcp' &&
      (row.origin !== 'official-mcp' || row.key_id !== actor.keyId)
    )
      throw new DomainError('NOT_FOUND', '此Key没有该确认提案。', 404);
  }
  async propose(
    actor: ActorContext,
    call: PreparedBusinessCall,
    context: ConfirmationContext = {},
  ) {
    if (
      !call.confirmation ||
      !['internal-ai', 'official-mcp'].includes(actor.entrypoint)
    )
      throw new DomainError('FORBIDDEN', '此操作无需提案或入口无效。', 403);
    if (
      actor.entrypoint === 'internal-ai' &&
      (!context.taskId || !context.conversationId)
    )
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '内部AI确认必须关联原持久消息任务和会话。',
        422,
      );
    if (
      actor.entrypoint === 'official-mcp' &&
      (context.taskId || context.conversationId)
    )
      throw new DomainError(
        'FORBIDDEN',
        '官方MCP不能引用个人私聊确认上下文。',
        403,
      );
    if (context.taskId) idSchema.parse(context.taskId);
    if (context.conversationId) idSchema.parse(context.conversationId);
    const proposal = call.confirmation;
    const argumentDigest = createHash('sha256')
      .update(
        canonicalJson({
          toolName: call.toolName,
          op: call.op,
          input: call.input,
        }),
      )
      .digest('hex');
    return this.db.transaction(async (tx) => {
      await currentUser(tx, actor);
      if (call.projectId)
        await requireProject(
          tx,
          actor,
          call.projectId,
          confirmationCapability(call.toolName, call.op),
        );
      if (
        context.taskId &&
        !(
          await tx.query(
            'SELECT 1 FROM app.ai_tasks t JOIN app.ai_conversations c ON c.id=t.conversation_id WHERE t.id=$1 AND t.owner_id=$2 AND c.deleted_at IS NULL AND ($3::uuid IS NULL OR t.conversation_id=$3)',
            [context.taskId, actor.userId, context.conversationId ?? null],
          )
        ).rowCount
      )
        throw new DomainError('NOT_FOUND', '此账号没有该消息任务。', 404);
      // A repeated original intent retrieves its original proposal/status even when its own successful
      // write changed the current object. A new intent needs a new command/base/explicit selection.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `confirmation:${actor.userId}:${actor.keyId ?? ''}:${context.taskId ?? ''}:${argumentDigest}`,
      ]);
      const prior = (
        await tx.query<ConfirmationRow>(
          `SELECT * FROM app.business_confirmations WHERE owner_id=$1 AND origin=$2 AND key_id IS NOT DISTINCT FROM $3::uuid AND task_id IS NOT DISTINCT FROM $4::uuid AND argument_digest=$5 ORDER BY created_at DESC LIMIT 1`,
          [
            actor.userId,
            actor.entrypoint,
            actor.keyId ?? null,
            context.taskId ?? null,
            argumentDigest,
          ],
        )
      ).rows[0];
      if (prior) {
        await this.authorize(tx, actor, prior);
        return safe(prior);
      }
      const row = (
        await tx.query<ConfirmationRow>(
          `INSERT INTO app.business_confirmations(id,owner_id,project_id,origin,key_id,task_id,conversation_id,tool_name,operation,arguments,scope_digest,proposal,argument_digest)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
          [
            randomUUID(),
            actor.userId,
            call.projectId ?? null,
            actor.entrypoint,
            actor.keyId ?? null,
            context.taskId ?? null,
            context.conversationId ?? null,
            call.toolName,
            call.op,
            JSON.stringify(call.input),
            proposal.digest,
            JSON.stringify(proposal),
            argumentDigest,
          ],
        )
      ).rows[0];
      if (!row) throw new Error('Confirmation proposal insert failed');
      await audit(
        tx,
        actor,
        'tool.waiting-confirmation',
        row.id,
        call.projectId,
        {
          toolName: call.toolName,
          op: call.op,
          scopeDigest: row.scope_digest,
          taskId: row.task_id,
        },
      );
      return safe(row);
    });
  }
  async get(actor: ActorContext, id: string) {
    idSchema.parse(id);
    return this.db.transaction(async (tx) => {
      const row = (
        await tx.query<ConfirmationRow>(
          'SELECT * FROM app.business_confirmations WHERE id=$1 AND owner_id=$2',
          [id, actor.userId],
        )
      ).rows[0];
      if (!row)
        throw new DomainError('NOT_FOUND', '没有此账号的确认提案。', 404);
      await this.authorize(tx, actor, row);
      return { confirmation: safe(row) };
    });
  }
  async list(actor: ActorContext, taskId: string) {
    if (actor.entrypoint !== 'web')
      throw new DomainError('FORBIDDEN', '确认列表仅供本人平台界面。', 403);
    idSchema.parse(taskId);
    return this.db.transaction(async (tx) => {
      await currentUser(tx, actor);
      const rows = await tx.query<ConfirmationRow>(
        'SELECT * FROM app.business_confirmations WHERE owner_id=$1 AND task_id=$2 ORDER BY created_at,id',
        [actor.userId, taskId],
      );
      const confirmations = [];
      for (const row of rows.rows) {
        await this.authorize(tx, actor, row);
        confirmations.push(safe(row));
      }
      return { confirmations };
    });
  }
  async resolve(
    actor: ActorContext,
    id: string,
    raw: unknown,
    source: 'web-user-event' | 'mcp-form-elicitation',
  ) {
    idSchema.parse(id);
    const input = resolveBusinessConfirmationInputSchema.parse(raw);
    if (
      (source === 'web-user-event' && actor.entrypoint !== 'web') ||
      (source === 'mcp-form-elicitation' && actor.entrypoint !== 'official-mcp')
    )
      throw new DomainError(
        'FORBIDDEN',
        '模型参数或个人Key不构成人工确认事件。',
        403,
      );
    const accepted = await this.db.transaction(async (tx) => {
      const found = (
        await tx.query<ConfirmationRow>(
          'SELECT * FROM app.business_confirmations WHERE id=$1 AND owner_id=$2 FOR UPDATE',
          [id, actor.userId],
        )
      ).rows[0];
      if (!found)
        throw new DomainError('NOT_FOUND', '没有此账号的确认提案。', 404);
      await this.authorize(tx, actor, found);
      if (found.scope_digest !== input.scopeDigest)
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '确认摘要与精确提案不一致。',
          409,
        );
      if (
        input.decision === 'accept' &&
        !found.dispatch_claim &&
        (found.state === 'waitingConfirmation' || found.state === 'executing')
      )
        await this.assertTaskSources(tx, actor, found);
      if (found.state !== 'waitingConfirmation')
        return { row: found, acceptedNow: false };
      const state: ConfirmationRow['state'] =
        input.decision === 'accept' ? 'executing' : 'declined';
      await tx.query(
        'UPDATE app.business_confirmations SET state=$2,resolution_source=$3,resolved_at=clock_timestamp() WHERE id=$1',
        [id, state, source],
      );
      await audit(
        tx,
        actor,
        'tool.confirmation-event',
        id,
        found.project_id ?? undefined,
        {
          decision: input.decision,
          source,
          scopeDigest: found.scope_digest,
          humanIdentityProvenByProtocol: false,
        },
      );
      return {
        row: { ...found, state },
        acceptedNow: input.decision === 'accept',
      };
    });
    const row = accepted.row;
    if (
      !accepted.acceptedNow ||
      row.state !== 'executing' ||
      input.decision !== 'accept'
    )
      return { confirmation: safe(row) };
    // Only this request that changed waiting→executing can dispatch. Concurrent/repeated resolution never replays.
    // Claim is identified by a separate locked transition above; completed/unknown records are always status-only.
    const receipt = await this.db.query<{ dispatch_claim: boolean }>(
      "UPDATE app.business_confirmations SET dispatch_claim=true WHERE id=$1 AND owner_id=$2 AND scope_digest=$3 AND argument_digest=$4 AND state='executing' AND NOT dispatch_claim RETURNING dispatch_claim",
      [id, actor.userId, row.scope_digest, row.argument_digest],
    );
    if (!receipt.rowCount) return this.get(actor, id);
    try {
      const serviceActor: ActorContext =
        row.origin === 'internal-ai'
          ? { ...actor, entrypoint: 'internal-ai', requestId: row.task_id! }
          : { ...actor };
      const response = await withHumanConfirmedExecution(
        this.db,
        actor,
        serviceActor,
        {
          confirmationId: row.id,
          ownerId: row.owner_id,
          origin: row.origin,
          taskId: row.task_id,
          conversationId: row.conversation_id,
          projectId: row.project_id,
          toolName: row.tool_name,
          op: row.operation,
          scopeDigest: row.scope_digest,
          argumentsHash: row.argument_digest,
          resolutionSource: source,
        },
        async () => {
          const prepared = await this.registry.prepare(
            serviceActor,
            row.tool_name,
            row.arguments,
          );
          if (
            !prepared.confirmation ||
            prepared.confirmation.digest !== row.scope_digest
          )
            throw new DomainError(
              'STALE_BASE_REVISION',
              '提案上下文已变化，请重新比较；没有执行。',
              412,
            );
          return prepared.execute();
        },
      );
      if (!(await this.finishClaim(row, 'completed', response)))
        throw new DomainError(
          'OPERATION_RESULT_UNKNOWN',
          '确认上下文已关闭或变化，原状态已保留；请核对原业务回执，不重发。',
          409,
        );
      return this.get(actor, id);
    } catch (error: unknown) {
      const state =
        error instanceof DomainError &&
        error.code !== 'OPERATION_RESULT_UNKNOWN'
          ? 'failed'
          : 'unknown';
      const stored = await this.finishClaim(row, state, {
        error: {
          code:
            error instanceof DomainError
              ? error.code
              : 'OPERATION_RESULT_UNKNOWN',
          message:
            error instanceof DomainError
              ? error.message
              : '结果未知，请查原command；不重放。',
        },
      });
      if (!stored)
        throw new DomainError(
          'OPERATION_RESULT_UNKNOWN',
          '确认上下文已关闭或变化，原状态与删除保护已保留；请核对原业务回执，不重发。',
          409,
        );
      throw error;
    }
  }
}
