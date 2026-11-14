import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { ActorContext } from '../../../contracts/src/identity.js';
import {
  frozenConversationReferenceSchema,
  dataScopeSchema,
} from '../../../contracts/src/conversations.js';
import { fullRequirementFindInputSchema } from '../../../contracts/src/automatic-auxiliary.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { DomainError } from '../errors.js';
import { ConversationReferences } from './references.js';
import { conversationRow } from './common.js';
import { canonicalJson } from '../operations/service.js';
import { humanConfirmationExecutionInTransaction } from '../tool-registry/human-confirmation.js';
import { requireProject } from '../access/policy.js';
export async function assertFrozenTaskSources(
  tx: SqlExecutor,
  actor: ActorContext,
  sources: unknown,
) {
  const checked = z.array(frozenConversationReferenceSchema).parse(sources);
  const references = new ConversationReferences(
    { query: tx.query.bind(tx), transaction: async (work) => work(tx) },
    {
      readText: async () => {
        throw new Error('Source authorization never reads file bodies');
      },
    },
  );
  for (const source of checked)
    if (!(await references.readable(actor, source)))
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '原任务依赖的来源已失效或失权，请从当前有权资料发起新请求。',
        422,
      );
  return checked;
}
/** Host-derived parent only; no model argument can mint an AI task origin. */
export async function captureTaskSources(
  tx: SqlExecutor,
  actor: ActorContext,
  taskId: string,
) {
  const row = (
    await tx.query<{
      conversation_id: string;
      state: string;
      cancel_requested_at: Date | null;
      message_id: string;
      explicit_refs: unknown;
      model_snapshot: unknown;
      data_scope: string;
      message_status: string;
    }>(
      `SELECT t.conversation_id,t.state,t.cancel_requested_at,t.data_scope,m.id message_id,m.explicit_refs,m.model_snapshot,m.status message_status
  FROM app.ai_tasks t JOIN app.ai_conversations c ON c.id=t.conversation_id JOIN app.ai_messages m ON m.id=t.assistant_message_id
  WHERE t.id=$1 AND t.owner_id=$2 AND c.owner_id=$2 AND c.deleted_at IS NULL AND m.deleted_at IS NULL FOR SHARE OF t,c,m`,
      [taskId, actor.userId],
    )
  ).rows[0];
  if (
    !row ||
    !['running', 'completed'].includes(row.state) ||
    row.cancel_requested_at
  )
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '辅助操作缺少当前有效的原AI任务，不会创建新的模型调用。',
      422,
    );
  const dataScope = dataScopeSchema.parse(row.data_scope);
  if (row.state === 'completed') {
    const proof = await humanConfirmationExecutionInTransaction(tx, actor);
    const args = z
      .object({ op: z.literal('find') })
      .passthrough()
      .safeParse(proof?.arguments);
    const full = args.success
      ? fullRequirementFindInputSchema.safeParse(
          'input' in args.data
            ? args.data.input
            : Object.fromEntries(
                Object.entries(args.data).filter(([key]) => key !== 'op'),
              ),
        )
      : null;
    const scope = z
      .object({
        purpose: z.literal('requirementLookup'),
        inputDigest: z.string(),
        dataScope: dataScopeSchema,
      })
      .safeParse(proof?.proposalScope);
    if (
      !proof ||
      proof.origin !== 'internal-ai' ||
      proof.taskId !== taskId ||
      actor.requestId !== taskId ||
      proof.conversationId !== row.conversation_id ||
      proof.toolName !== 'ath_requirements' ||
      proof.op !== 'find' ||
      !full?.success ||
      !scope.success ||
      full.data.projectId !== proof.projectId ||
      full.data.dataScope !== dataScope ||
      scope.data.dataScope !== dataScope ||
      scope.data.inputDigest !==
        createHash('sha256').update(canonicalJson(full.data)).digest('hex') ||
      row.message_status !== 'completed'
    )
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '已结束父任务仅能在本次精确辅助资料发送确认中使用；普通调用或其他批准不能恢复执行。',
        422,
      );
    await requireProject(tx, actor, full.data.projectId, 'project.read');
  }
  await conversationRow(tx, actor, row.conversation_id, false, true);
  const captured = z
    .object({ provenanceCaptured: z.literal(true) })
    .safeParse(row.model_snapshot).success;
  if (row.state === 'completed' && !captured)
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '已结束父任务缺少确切的已捕获资料来源，不能借确认补造。',
      422,
    );
  if (!captured && row.data_scope !== 'syntheticPublicOnly')
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '旧任务缺少匹配的已捕获资料许可/来源，不能以公开标签兜底。',
      422,
    );
  const sources = captured
    ? z.array(frozenConversationReferenceSchema).parse(row.explicit_refs)
    : [
        {
          reference: {
            kind: 'conversation' as const,
            conversationId: row.conversation_id,
            mode: 'full' as const,
            dataScope: 'syntheticPublicOnly' as const,
          },
          messageIds: [row.message_id],
        },
      ];
  await assertFrozenTaskSources(tx, actor, sources);
  return { conversationId: row.conversation_id, sources, dataScope };
}
