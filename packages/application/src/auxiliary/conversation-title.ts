import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ActorContext } from '../../../contracts/src/identity.js';
import {
  auxiliaryRequestInputSchema,
  auxiliaryResultSchema,
} from '../../../contracts/src/auxiliary.js';
import {
  frozenConversationReferenceSchema,
  dataScopeSchema,
} from '../../../contracts/src/conversations.js';
import { workspaceAccessModeSchema } from '../../../contracts/src/workspace-access.js';
import { modelSelectionV2Schema } from '../../../contracts/src/model-configuration-v2.js';
import type {
  SqlExecutor,
  Database,
} from '../../../persistence/src/database.js';
import type { ConfigurationService } from '../configuration/service.js';
import type { AuxiliaryTaskRow } from './service.js';
import { auxiliarySourceSnapshotSchema } from './sources.js';
import {
  auxiliaryModelSnapshot,
  resolveAcceptedAuxiliaryModel,
} from './model-snapshot.js';
import { conversationRow, personalActor } from '../conversations/common.js';
import { assertFrozenTaskSources } from '../conversations/task-sources.js';
import {
  truncateConversationText,
  isPlaceholderConversationTitle,
} from '../conversations/title.js';
import { assertConversationDataScope } from '../security/model-data-scope.js';
import { assertSafeModelInput } from '../security/model-input.js';
import { assertNewWorkAllowed } from '../recovery/maintenance.js';
import { assertTaskCapacity } from '../recovery/capacity.js';
import { canonicalJson } from '../operations/service.js';
import { audit } from '../events.js';
import { DomainError } from '../errors.js';

const commandKey = (conversationId: string) =>
  `conversation-title:v1:${conversationId}`;
const titleSourceSchema = z.strictObject({
  schemaVersion: z.literal('ath.conversation-title-source.v1'),
  parentTaskId: z.uuid(),
  userMessageId: z.uuid(),
  assistantMessageId: z.uuid(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  baseRowVersion: z.number().int().positive(),
  expectedDefaultTitle: z.string().min(1).max(200),
  accessMode: workspaceAccessModeSchema.nullable(),
  dataScope: dataScopeSchema,
  text: z.string().min(1).max(16000),
});
type TitleSource = z.infer<typeof titleSourceSchema>;
type TitleRow = Pick<
  AuxiliaryTaskRow,
  | 'id'
  | 'owner_id'
  | 'conversation_id'
  | 'parent_task_id'
  | 'origin'
  | 'purpose'
  | 'command_id'
  | 'request'
  | 'source_snapshot'
  | 'model_snapshot'
>;

export function isAutomaticConversationTitle(row: TitleRow): boolean {
  return (
    row.purpose === 'alias' &&
    row.origin === 'internal-ai' &&
    row.parent_task_id !== null &&
    row.conversation_id !== null &&
    row.command_id === commandKey(row.conversation_id)
  );
}
const invalidSource = () =>
  new DomainError(
    'PRECONDITIONS_MISSING',
    '自动会话标题缺少匹配的原首轮来源；未重新发送。',
    422,
  );

export function automaticConversationTitleSource(
  row: TitleRow,
): TitleSource | null {
  if (!isAutomaticConversationTitle(row)) return null;
  const source = auxiliarySourceSnapshotSchema.safeParse(row.source_snapshot);
  const input = auxiliaryRequestInputSchema.safeParse(row.request);
  const payload = titleSourceSchema.safeParse(
    source.success ? source.data.payload : null,
  );
  if (
    !source.success ||
    !input.success ||
    input.data.purpose !== 'alias' ||
    !payload.success ||
    source.data.meta.kind !== 'conversation' ||
    source.data.meta.conversationId !== row.conversation_id ||
    source.data.meta.objectId !== row.conversation_id ||
    source.data.meta.rowVersion !== payload.data.baseRowVersion ||
    input.data.conversationId !== row.conversation_id ||
    input.data.commandId !== row.command_id ||
    input.data.baseRowVersion !== payload.data.baseRowVersion ||
    input.data.text !== payload.data.text ||
    input.data.dataScope !== payload.data.dataScope ||
    payload.data.parentTaskId !== row.parent_task_id
  )
    throw invalidSource();
  return payload.data;
}

interface ParentRow {
  id: string;
  owner_id: string;
  conversation_id: string;
  user_message_id: string;
  assistant_message_id: string;
  model_selection: unknown;
  data_scope: string;
  state: string;
  cancel_requested_at: Date | null;
}
interface FirstRound {
  user_content: string;
  assistant_content: string;
  assistant_snapshot: unknown;
  assistant_refs: unknown;
  first_user_message_id: string;
}
const firstRoundTitleText = (first: FirstRound) =>
  `用户首轮：\n${truncateConversationText(first.user_content, 4000)}\n\n助手公开答复：\n${truncateConversationText(first.assistant_content, 10000)}`.trim();
async function parentFirstRound(
  tx: SqlExecutor,
  ownerId: string,
  taskId: string,
  lock = false,
) {
  const parent = (
    await tx.query<ParentRow>(
      'SELECT * FROM app.ai_tasks WHERE id=$1 AND owner_id=$2',
      [taskId, ownerId],
    )
  ).rows[0];
  if (!parent || parent.state !== 'completed' || parent.cancel_requested_at)
    return null;
  const actor: ActorContext = {
    userId: ownerId,
    entrypoint: 'internal-ai',
    requestId: taskId,
  };
  if (lock) {
    await personalActor(tx, actor, true);
    // The main finish already owns its task row. An optional title must never
    // wait for a conversation locked by deletion (which next needs that task).
    // Own the row before proceeding: the auxiliary INSERT also needs its FK lock.
    const owned = await tx.query(
      'SELECT id FROM app.ai_conversations WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE SKIP LOCKED',
      [parent.conversation_id, ownerId],
    );
    if (!owned.rowCount) return null;
  }
  const conversation = await conversationRow(
    tx,
    actor,
    parent.conversation_id,
    false,
    true,
  );
  const first = (
    await tx.query<FirstRound>(
      `SELECT u.content user_content,a.content assistant_content,a.model_snapshot assistant_snapshot,a.explicit_refs assistant_refs,
     (SELECT id FROM app.ai_messages m WHERE m.conversation_id=$1 AND m.role='user' AND m.deleted_at IS NULL ORDER BY m.created_at,m.id LIMIT 1) first_user_message_id
     FROM app.ai_messages u JOIN app.ai_messages a ON a.id=$3 AND a.conversation_id=u.conversation_id
     WHERE u.id=$2 AND u.conversation_id=$1 AND u.role='user' AND a.role='assistant' AND a.status='completed' AND u.deleted_at IS NULL AND a.deleted_at IS NULL`,
      [
        parent.conversation_id,
        parent.user_message_id,
        parent.assistant_message_id,
      ],
    )
  ).rows[0];
  if (
    !first ||
    first.first_user_message_id !== parent.user_message_id ||
    !first.assistant_content.trim()
  )
    return null;
  const captured = z
    .object({
      provenanceCaptured: z.literal(true),
      workspaceAccessMode: workspaceAccessModeSchema.optional(),
    })
    .passthrough()
    .safeParse(first.assistant_snapshot);
  if (!captured.success) throw invalidSource();
  const references = z
    .array(frozenConversationReferenceSchema)
    .parse(first.assistant_refs);
  await assertFrozenTaskSources(tx, actor, references);
  const sourceHash = createHash('sha256')
    .update(
      canonicalJson({
        userMessageId: parent.user_message_id,
        assistantMessageId: parent.assistant_message_id,
        user: first.user_content,
        assistant: first.assistant_content,
      }),
    )
    .digest('hex');
  return {
    parent,
    first,
    conversation,
    references,
    sourceHash,
    actor,
    accessMode: captured.data.workspaceAccessMode ?? null,
  };
}
async function currentTitleModel(
  tx: SqlExecutor,
  configuration: ConfigurationService,
  context: NonNullable<Awaited<ReturnType<typeof parentFirstRound>>>,
) {
  const enabled = (
    await tx.query<{ enabled: boolean }>(
      'SELECT enabled FROM app.auxiliary_model_configuration WHERE singleton FOR SHARE',
    )
  ).rows[0]?.enabled;
  if (!enabled)
    throw new DomainError(
      'MODEL_NOT_CONFIGURED',
      '系统辅助已停用，自动标题保留本地名称。',
      422,
    );
  // The global auxiliary selector is never substituted for the already-permitted
  // chat recipient. Its enabled switch still stops all new auxiliary requests.
  const selection = modelSelectionV2Schema.safeParse(
    context.parent.model_selection,
  );
  if (!selection.success) throw invalidSource();
  await configuration.v2.resolveInTransaction(
    tx,
    context.actor,
    selection.data,
  );
  const entry = (
    await tx.query<{ effort_values: string[] }>(
      'SELECT effort_values FROM app.model_entries WHERE id=$1 AND model_service_id=$2',
      [selection.data.modelEntryId, selection.data.modelServiceId],
    )
  ).rows[0];
  const selected = await configuration.v2.resolveInTransaction(
    tx,
    context.actor,
    {
      ...selection.data,
      effort: entry?.effort_values.includes('none') ? 'none' : null,
    },
  );
  assertConversationDataScope(
    selected,
    dataScopeSchema.parse(context.parent.data_scope),
    context.accessMode ?? undefined,
  );
  return selected;
}

/** Called only by the chat worker in the first completed turn's transaction.
 * The existing owner/command uniqueness is the durable once-only admission. */
export async function enqueueConversationTitle(
  tx: SqlExecutor,
  configuration: ConfigurationService,
  ownerId: string,
  parentTaskId: string,
  credentialAbsent: (
    selected: { credentialRef: string; modelServiceId: string },
    value: unknown,
    tx: SqlExecutor,
  ) => Promise<void>,
): Promise<string | null> {
  const context = await parentFirstRound(tx, ownerId, parentTaskId, true);
  if (
    !context ||
    context.conversation.alias !== null ||
    context.conversation.archived_at
  )
    return null;
  const { parent, first, conversation } = context;
  const key = commandKey(conversation.id);
  const existing = (
    await tx.query<AuxiliaryTaskRow>(
      'SELECT * FROM app.auxiliary_tasks WHERE owner_id=$1 AND command_id=$2',
      [ownerId, key],
    )
  ).rows[0];
  if (existing) {
    const source = automaticConversationTitleSource(existing);
    return source?.parentTaskId === parent.id ? existing.id : null;
  }
  await assertNewWorkAllowed(tx, true);
  await assertTaskCapacity(tx);
  const selected = await currentTitleModel(tx, configuration, context);
  const text = firstRoundTitleText(first);
  const payload = titleSourceSchema.parse({
    schemaVersion: 'ath.conversation-title-source.v1',
    parentTaskId: parent.id,
    userMessageId: parent.user_message_id,
    assistantMessageId: parent.assistant_message_id,
    sourceHash: context.sourceHash,
    baseRowVersion: conversation.row_version,
    expectedDefaultTitle: conversation.default_title,
    accessMode: context.accessMode,
    dataScope: parent.data_scope,
    text,
  });
  const request = auxiliaryRequestInputSchema.parse({
    commandId: key,
    purpose: 'alias',
    conversationId: conversation.id,
    baseRowVersion: conversation.row_version,
    text,
    dataScope: parent.data_scope,
  });
  const source = auxiliarySourceSnapshotSchema.parse({
    meta: {
      kind: 'conversation',
      projectId: null,
      objectId: conversation.id,
      conversationId: conversation.id,
      revisionId: null,
      rowVersion: conversation.row_version,
      truncated:
        first.user_content.length > 4000 ||
        first.assistant_content.length > 10000,
    },
    payload,
    candidateIds: [],
    parentSources: context.references,
  });
  await credentialAbsent(selected, { request, source }, tx);
  const id = randomUUID();
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO app.auxiliary_tasks(id,owner_id,project_id,conversation_id,command_id,purpose,request,source_snapshot,model_snapshot,origin,parent_task_id)
     VALUES($1,$2,NULL,$3,$4,'alias',$5,$6,$7,'internal-ai',$8) ON CONFLICT(owner_id,command_id) DO NOTHING RETURNING id`,
    [
      id,
      ownerId,
      conversation.id,
      key,
      request,
      source,
      auxiliaryModelSnapshot(selected),
      parent.id,
    ],
  );
  if (!inserted.rowCount) return null;
  await audit(
    tx,
    context.actor,
    'conversation.title-accepted',
    conversation.id,
    conversation.project_id,
    { auxiliaryTaskId: id, parentTaskId: parent.id },
  );
  return id;
}

async function conversationTitleContext(tx: SqlExecutor, row: TitleRow) {
  const payload = automaticConversationTitleSource(row);
  if (!payload) throw invalidSource();
  const context = await parentFirstRound(
    tx,
    row.owner_id,
    payload.parentTaskId,
  );
  if (
    !context ||
    context.parent.conversation_id !== row.conversation_id ||
    context.parent.user_message_id !== payload.userMessageId ||
    context.parent.assistant_message_id !== payload.assistantMessageId ||
    context.sourceHash !== payload.sourceHash ||
    firstRoundTitleText(context.first) !== payload.text ||
    context.accessMode !== payload.accessMode ||
    context.parent.data_scope !== payload.dataScope
  )
    throw invalidSource();
  const source = auxiliarySourceSnapshotSchema.parse(row.source_snapshot);
  if (
    canonicalJson(source.parentSources ?? []) !==
    canonicalJson(context.references)
  )
    throw invalidSource();
  return context;
}

/** Reading a stored receipt rechecks source access, not today's model settings. */
export async function assertConversationTitleSource(
  tx: SqlExecutor,
  row: TitleRow,
) {
  await conversationTitleContext(tx, row);
}

export async function validateConversationTitleTask(
  tx: SqlExecutor,
  configuration: ConfigurationService,
  row: TitleRow,
) {
  const context = await conversationTitleContext(tx, row);
  const selected = await currentTitleModel(tx, configuration, context);
  if (
    canonicalJson(auxiliaryModelSnapshot(selected)) !==
    canonicalJson(row.model_snapshot)
  )
    throw new DomainError(
      'STALE_BASE_REVISION',
      '原会话标题模型或许可已变化，不切换接收方。',
      412,
    );
  return selected;
}

/** No public request flag reaches this branch: the authoritative internal task,
 * its original parent, and its versioned source must all agree before use. */
export async function resolveAuxiliaryModelForTask(
  db: Database,
  configuration: ConfigurationService,
  actor: ActorContext,
  model: unknown,
) {
  const id = z.uuid().safeParse(actor.requestId);
  if (actor.entrypoint === 'internal-ai' && id.success) {
    const special = await db.transaction(async (tx) => {
      const row = (
        await tx.query<AuxiliaryTaskRow>(
          'SELECT * FROM app.auxiliary_tasks WHERE id=$1 AND owner_id=$2',
          [id.data, actor.userId],
        )
      ).rows[0];
      if (!row || !isAutomaticConversationTitle(row)) return null;
      if (canonicalJson(row.model_snapshot) !== canonicalJson(model))
        throw invalidSource();
      return validateConversationTitleTask(tx, configuration, row);
    });
    if (special) return { selected: special, automaticTitle: true };
  }
  return {
    selected: await resolveAcceptedAuxiliaryModel(configuration, actor, model),
    automaticTitle: false,
  };
}

export function assertGeneratedConversationTitle(name: string) {
  if (
    !name.trim() ||
    name.length > 80 ||
    /[\p{Cc}\p{Cf}]/u.test(name) ||
    isPlaceholderConversationTitle(name) ||
    name === '对话讨论' ||
    /^\//u.test(name)
  )
    throw new DomainError(
      'INVALID_MODEL_OUTPUT',
      '自动标题不是有界的单行概括，保留原名称。',
      422,
    );
  assertSafeModelInput(name);
}

export async function lockConversationTitleTarget(
  tx: SqlExecutor,
  row: TitleRow,
) {
  if (isAutomaticConversationTitle(row))
    await tx.query(
      'SELECT id FROM app.ai_conversations WHERE id=$1 AND owner_id=$2 FOR UPDATE',
      [row.conversation_id, row.owner_id],
    );
}

/** Apply the stored result only. A stale name/version or any manual action is
 * not permission to regenerate; the original completed result remains intact. */
export async function applyConversationTitleResult(
  tx: SqlExecutor,
  configuration: ConfigurationService,
  id: string,
) {
  const row = (
    await tx.query<AuxiliaryTaskRow>(
      'SELECT * FROM app.auxiliary_tasks WHERE id=$1',
      [id],
    )
  ).rows[0];
  if (!row || row.state !== 'completed' || !isAutomaticConversationTitle(row))
    return;
  const conversationId = row.conversation_id;
  if (!conversationId) return;
  const actor: ActorContext = {
    userId: row.owner_id,
    entrypoint: 'internal-ai',
    requestId: row.id,
  };
  try {
    const payload = automaticConversationTitleSource(row);
    const result = auxiliaryResultSchema.parse(row.result);
    if (!payload || result.purpose !== 'alias') throw invalidSource();
    assertGeneratedConversationTitle(result.suggestedName);
    await validateConversationTitleTask(tx, configuration, row);
    const updated = await tx.query(
      `UPDATE app.ai_conversations SET default_title=$3,row_version=row_version+1 WHERE id=$1 AND owner_id=$2 AND alias IS NULL AND deleted_at IS NULL AND archived_at IS NULL AND row_version=$4 AND default_title=$5`,
      [
        row.conversation_id,
        row.owner_id,
        result.suggestedName,
        payload.baseRowVersion,
        payload.expectedDefaultTitle,
      ],
    );
    await audit(
      tx,
      actor,
      updated.rowCount
        ? 'conversation.title-generated'
        : 'conversation.title-source-changed',
      conversationId,
      null,
      { auxiliaryTaskId: row.id },
    );
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    await audit(
      tx,
      actor,
      'conversation.title-not-applied',
      conversationId,
      null,
      { auxiliaryTaskId: row.id, errorCode: error.code },
    );
  }
}
