import { z } from 'zod';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { WorkspaceAccessMode } from '../../../contracts/src/workspace-access.js';
import { aiToolSourceReferenceSchema } from '../../../contracts/src/conversations.js';
import type { Database } from '../../../persistence/src/database.js';
import type { ConversationReferences, FrozenReference } from './references.js';
import { canonicalJson } from '../operations/service.js';
import { conversationRow } from './common.js';
import { DomainError } from '../errors.js';

export interface RetainedConversationHistory {
  text: string;
  userContents: string[];
  mayReadCheckpointTools: boolean;
  sources: FrozenReference[];
  tools: {
    taskId: string;
    invocationId: string;
    name: string;
    sources: FrozenReference[];
  }[];
  unavailableToolSources: boolean;
}
interface HistoryRow {
  id: string;
  task_id: string | null;
  data_scope: string | null;
  role: string;
  content: string;
  status: string;
  model_snapshot: unknown;
  deleted_at: Date | null;
}
const modeSchema = z.object({
  workspaceAccessMode: z.enum(['full', 'restricted']).optional(),
});
const toolFactSchema = z.object({
  invocationId: z.uuid(),
  name: z.string().max(200),
  state: z.enum(['started', 'completed', 'failed', 'waitingConfirmation']),
  unknownEffect: z.boolean().optional(),
  confirmationId: z.uuid().optional(),
  externalInvocationId: z.uuid().optional(),
  sourceRefs: z.array(aiToolSourceReferenceSchema).optional(),
});

/** Current owner/source authority is reused, not inferred from model identity or
 * a saved checkpoint. No linked attachment body or remote tool is read here. */
export async function readRetainedConversationHistory(
  db: Database,
  references: ConversationReferences,
  actor: ActorContext,
  input: {
    conversationId: string;
    taskId: string;
    dataScope: 'syntheticPublicOnly' | 'authorizedRelevantTestData';
    accessMode?: WorkspaceAccessMode;
  },
): Promise<RetainedConversationHistory> {
  const rows = await db.transaction(async (tx) => {
    await conversationRow(tx, actor, input.conversationId, false, true);
    const current = (
      await tx.query<{ user_message_id: string; assistant_message_id: string }>(
        'SELECT user_message_id,assistant_message_id FROM app.ai_tasks WHERE id=$1 AND owner_id=$2 AND conversation_id=$3',
        [input.taskId, actor.userId, input.conversationId],
      )
    ).rows[0];
    if (!current)
      throw new DomainError('NOT_FOUND', '当前任务不属于此账号的会话。', 404);
    return (
      await tx.query<HistoryRow>(
        `SELECT m.id,t.id task_id,t.data_scope,m.role,m.content,m.status,m.model_snapshot,m.deleted_at
         FROM app.ai_messages m LEFT JOIN app.ai_tasks t
         ON t.owner_id=$4 AND t.conversation_id=m.conversation_id
         AND (t.user_message_id=m.id OR t.assistant_message_id=m.id)
         WHERE m.conversation_id=$1
         AND m.id<>$2 AND m.id<>$3
         AND m.created_at<=(SELECT created_at FROM app.ai_messages WHERE id=$2)
         ORDER BY m.created_at,m.id LIMIT 1001`,
        [
          input.conversationId,
          current.user_message_id,
          current.assistant_message_id,
          actor.userId,
        ],
      )
    ).rows;
  });
  if (
    rows.length > 1000 ||
    rows.reduce((size, row) => size + row.content.length + 128, 0) > 100_000
  )
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '已保存历史超过本次安全上下文范围，请明确缩小引用后继续；未将缺失历史冒称已读。',
      422,
    );
  const eligible = rows.filter((row) => {
    if (row.deleted_at || row.status === 'deleted') return false;
    if (
      row.role !== 'user' &&
      !['completed', 'failed', 'cancelled', 'interrupted'].includes(row.status)
    )
      return false;
    if (input.accessMode === 'full') return true;
    const mode = modeSchema.safeParse(row.model_snapshot ?? {});
    if (!mode.success) return false;
    if (input.accessMode === 'restricted')
      return mode.data.workspaceAccessMode === 'restricted';
    return (
      mode.data.workspaceAccessMode === undefined &&
      (row.data_scope === 'syntheticPublicOnly' ||
        row.data_scope === input.dataScope)
    );
  });
  if (!eligible.length)
    return {
      text: rows.length
        ? '[Earlier records are not readable in this access mode.]'
        : '',
      userContents: [],
      mayReadCheckpointTools: false,
      sources: [],
      tools: [],
      unavailableToolSources: false,
    };
  const taskIds = [
    ...new Set(
      eligible
        .filter((row) => row.role === 'assistant')
        .flatMap((row) => (row.task_id ? [row.task_id] : [])),
    ),
  ];
  const facts: string[] = [];
  let allToolFactsKnown = true;
  const tools = new Map<
    string,
    {
      taskId: string;
      fact: z.infer<typeof toolFactSchema>;
      everUnknown: boolean;
    }
  >();
  const deniedTasks = new Set<string>();
  const sourceProof = new Map<
    string,
    { sources: FrozenReference[]; readable: boolean }
  >();
  let unavailableToolSources = false;
  if (taskIds.length) {
    const tasks = await db.query<{
      id: string;
      state: string;
      error_code: string | null;
    }>(
      'SELECT id,state,error_code FROM app.ai_tasks WHERE owner_id=$1 AND conversation_id=$2 AND id=ANY($3::uuid[]) ORDER BY created_at,id',
      [actor.userId, input.conversationId, taskIds],
    );
    facts.push(
      ...tasks.rows.map(
        (row) =>
          `Original task ${row.id}: ${row.state}${row.error_code ? '; error=' + row.error_code : ''}. An unfinished/unknown task is not a pending instruction to replay.`,
      ),
    );
    const events = await db.query<{ task_id: string; payload: unknown }>(
      "SELECT e.task_id,e.payload FROM app.ai_task_events e JOIN app.ai_tasks t ON t.id=e.task_id WHERE t.owner_id=$1 AND t.conversation_id=$2 AND t.id=ANY($3::uuid[]) AND e.event_type='ai.tool' ORDER BY e.sequence",
      [actor.userId, input.conversationId, taskIds],
    );
    for (const event of events.rows) {
      const parsed = toolFactSchema.safeParse(event.payload);
      if (!parsed.success) {
        allToolFactsKnown = false;
        deniedTasks.add(event.task_id);
        continue;
      }
      const key = `${event.task_id}:${parsed.data.invocationId}`;
      tools.set(key, {
        taskId: event.task_id,
        fact: parsed.data,
        everUnknown:
          tools.get(key)?.everUnknown === true ||
          parsed.data.unknownEffect === true,
      });
    }
    for (const [key, tool] of tools) {
      const { sourceRefs, ...metadata } = tool.fact;
      const sources: FrozenReference[] = (sourceRefs ?? []).map((source) => ({
        reference: { ...source, dataScope: input.dataScope },
      }));
      let readable = sources.length > 0 && tool.fact.state !== 'started';
      for (const source of sources)
        if (!(await references.readable(actor, source))) {
          readable = false;
          unavailableToolSources = true;
        }
      if (!readable) deniedTasks.add(tool.taskId);
      sourceProof.set(key, { sources, readable });
      facts.push(
        `Recorded tool fact (transport only, not business success): ${JSON.stringify({ taskId: tool.taskId, ...metadata, unknownEffect: tool.everUnknown })}. Keep the original IDs; query the original receipt, never replay this archived invocation.`,
      );
    }
  }
  // Actual tool receipts are independent provenance. A cancellation can happen
  // after a ToolMessage was checkpointed but before assistant refs were stamped.
  const bodyEligible = eligible.filter(
    (row) =>
      row.role !== 'assistant' || !row.task_id || !deniedTasks.has(row.task_id),
  );
  const resolved = bodyEligible.length
    ? (
        await references.resolve(actor, [
          {
            reference: {
              kind: 'conversation',
              conversationId: input.conversationId,
              mode: 'full',
              dataScope: input.dataScope,
            },
            messageIds: bodyEligible.map((row) => row.id),
            resourceIds: [],
          },
        ])
      )[0]
    : undefined;
  const readableIds = new Set(resolved?.messageIds ?? []);
  const readable = bodyEligible.filter((row) => readableIds.has(row.id));
  const readableTasks = new Set(
    readable
      .filter((row) => row.role === 'assistant')
      .flatMap((row) => (row.task_id ? [row.task_id] : [])),
  );
  const visibleAssistantTasks = new Set(
    readable
      .filter((row) => row.role === 'assistant' && row.content.length > 0)
      .flatMap((row) => (row.task_id ? [row.task_id] : [])),
  );
  const restoredSources = new Map<string, FrozenReference>();
  const allowedTools: RetainedConversationHistory['tools'] = [];
  for (const [key, tool] of tools) {
    const proof = sourceProof.get(key);
    if (!proof?.readable || !readableTasks.has(tool.taskId)) continue;
    if (visibleAssistantTasks.has(tool.taskId))
      for (const source of proof.sources)
        restoredSources.set(canonicalJson(source), source);
    allowedTools.push({
      taskId: tool.taskId,
      invocationId: tool.fact.invocationId,
      name: tool.fact.name,
      sources: proof.sources,
    });
  }
  const omitted = readable.length !== rows.length;
  const text = [
    resolved?.text ?? '',
    omitted
      ? '[Some earlier content was omitted because its current permission, access mode or deletion state could not be verified.]'
      : '',
    ...facts,
  ]
    .filter(Boolean)
    .join('\n\n');
  if (text.length > 100_000)
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '历史与回执元数据超出上下文限额，未截断冒称完整读取。',
      422,
    );
  return {
    text,
    userContents: readable
      .filter((row) => row.role === 'user')
      .map((row) => row.content),
    mayReadCheckpointTools: !omitted && allToolFactsKnown,
    sources: [...restoredSources.values()],
    tools: allowedTools,
    unavailableToolSources,
  };
}
