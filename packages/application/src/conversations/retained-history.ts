import { z } from 'zod';
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { AgentContextArchiveRecord } from '../../../contracts/src/agent-context.js';
import { compactModelMessages } from '../agent-context/compaction.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { WorkspaceAccessMode } from '../../../contracts/src/workspace-access.js';
import {
  aiToolEventPayloadSchema,
  aiToolSourceReferenceSchema,
  freezeAiToolSource,
} from '../../../contracts/src/conversations.js';
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
  /** Current-authority originals; import into the new scope before dispatch. */
  archives?: AgentContextArchiveRecord[];
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
  created_at: Date;
  cursor_created_at: string;
}
const modeSchema = z.object({
  workspaceAccessMode: z.enum(['full', 'restricted']).optional(),
});
const toolFactSchema = z.object({
  invocationId: z.uuid(),
  name: z.string().max(200),
  state: aiToolEventPayloadSchema.shape.state,
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
    const rows: HistoryRow[] = [];
    let cursor: HistoryRow | undefined;
    let characters = 0;
    for (;;) {
      const page = (
        await tx.query<HistoryRow>(
          `SELECT m.id,t.id task_id,t.data_scope,m.role,m.content,m.status,m.model_snapshot,m.deleted_at,m.created_at,m.created_at::text cursor_created_at
         FROM app.ai_messages m LEFT JOIN app.ai_tasks t
         ON t.owner_id=$4 AND t.conversation_id=m.conversation_id
         AND (t.user_message_id=m.id OR t.assistant_message_id=m.id)
         WHERE m.conversation_id=$1
         AND m.id<>$2 AND m.id<>$3
         AND m.created_at<=(SELECT created_at FROM app.ai_messages WHERE id=$2)
         AND ($5::timestamptz IS NULL OR (m.created_at,m.id)>($5::timestamptz,$6::uuid))
         ORDER BY m.created_at,m.id LIMIT 100`,
          [
            input.conversationId,
            current.user_message_id,
            current.assistant_message_id,
            actor.userId,
            cursor?.cursor_created_at ?? null,
            cursor?.id ?? null,
          ],
        )
      ).rows;
      for (const row of page) characters += row.content.length + 128;
      rows.push(...page);
      if (rows.length > 2000 || characters > 20_000_000)
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '历史超过本次分页恢复安全范围（2000条/2000万字符），请缩小引用；未静默跳过或直接外发完整历史。',
          422,
        );
      cursor = page.at(-1);
      if (page.length < 100) break;
    }
    return rows;
  });
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
      if (parsed.data.state === 'notDispatched') continue;
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
      const sources: FrozenReference[] = (sourceRefs ?? []).map((source) =>
        freezeAiToolSource(source, input.dataScope),
      );
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
  // Do not join/truncate a complete conversation via resolve() before its
  // originals can be archived. Reuse the same per-message provenance checks.
  const readable: HistoryRow[] = [];
  for (const row of bodyEligible) {
    if (
      await references.readable(actor, {
        reference: {
          kind: 'conversation',
          conversationId: input.conversationId,
          mode: 'full',
          dataScope: input.dataScope,
        },
        messageIds: [row.id],
        resourceIds: [],
      })
    )
      readable.push(row);
  }
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
  // Recheck body lineage on every subsequent dispatch/read in the new scope,
  // not just the single recovery fetch. Earlier message IDs make an acyclic
  // provenance edge; no reference to this task's pending assistant is inserted.
  for (let offset = 0; offset < readable.length; offset += 100) {
    const source: FrozenReference = {
      reference: {
        kind: 'conversation',
        conversationId: input.conversationId,
        mode: 'full',
        dataScope: input.dataScope,
      },
      messageIds: readable.slice(offset, offset + 100).map((row) => row.id),
      resourceIds: [],
    };
    restoredSources.set(canonicalJson(source), source);
  }
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
  const originalMessages: BaseMessage[] = readable.map((row) => {
    const message = {
      id: row.id,
      content: `${row.role} (state=${row.status}; original-message=${row.id}${row.task_id ? '; task=' + row.task_id : ''}): ${row.content || '[无已保存正文]'}`,
    };
    return row.role === 'user'
      ? new HumanMessage(message)
      : new AIMessage(message);
  });
  const notices = [
    omitted
      ? '[Some earlier content was omitted because its current permission, access mode or deletion state could not be verified.]'
      : '',
    ...facts,
  ]
    .filter(Boolean)
    .join('\n\n');
  const fullText = [
    ...originalMessages.map((message) => String(message.content)),
    notices,
  ]
    .filter(Boolean)
    .join('\n\n');
  const sentinels: BaseMessage[] = [
    new HumanMessage('Historical recovery boundary; not a user request.'),
    new AIMessage('Historical recovery boundary.'),
  ];
  const projection =
    fullText.length > 60_000
      ? compactModelMessages(
          [
            ...originalMessages,
            ...(notices ? [new HumanMessage(notices)] : []),
            ...sentinels,
          ],
          { maxCharacters: 60_000, keepRecentMessages: 2 },
        )
      : null;
  const text = projection
    ? projection.messages
        .filter((message) => !sentinels.includes(message))
        .map((message) => String(message.content))
        .join('\n\n')
    : fullText;
  return {
    text,
    userContents: readable
      .filter((row) => row.role === 'user')
      .map((row) => row.content),
    mayReadCheckpointTools: !omitted && allToolFactsKnown,
    sources: [...restoredSources.values()],
    tools: allowedTools,
    unavailableToolSources,
    ...(projection ? { archives: projection.archives } : {}),
  };
}
