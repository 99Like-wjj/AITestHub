import { z } from 'zod';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { errorCodeSchema } from '../../../contracts/src/base.js';
import {
  modelAttemptContextSchema,
  modelAttemptViewSchema,
  modelRetryEventSchema,
  type ModelAttemptContext,
  type ModelAttemptView,
  type ModelRetryEvent,
} from '../../../contracts/src/ai-retry.js';
import { DomainError } from '../errors.js';
import { assertSafeModelInput } from '../security/model-input.js';

interface AttemptRow {
  id: string;
  task_id: string;
  assistant_message_id: string;
  logical_call_id: string;
  ordinal: number;
  attempt_no: number;
  max_retries: number;
  prefix_length: number;
  state: ModelAttemptView['state'];
  visible_text: string;
  error_code: string | null;
  http_status: number | null;
  retry_at: Date | null;
  next_attempt_at: Date | null;
  content_redacted_at: Date | null;
  created_at: Date;
  finished_at: Date | null;
}
interface LiveRow {
  id: string;
  owner_id: string;
  assistant_message_id: string;
  content: string;
}
interface LedgerRow {
  id: string;
  task_id: string | null;
  source: string;
  initiator_user_id: string | null;
  status: string;
  logical_call_id: string | null;
  attempt_no: number | null;
  model_service_id: string;
  model_config_revision: number;
  model_entry_id: string | null;
  model_protocol: string | null;
  model_id: string;
  effort: string | null;
  execution_origin: string;
}
const safeCodes = new Set<string>([
  ...errorCodeSchema.options,
  'INVALID_CONFIGURATION',
  'MISSING_CREDENTIAL',
  'INVALID_REQUEST',
  'DISPATCH_PRECONDITIONS_FAILED',
  'UNSAFE_MODEL_INPUT',
  'CONTINUATION_UNAVAILABLE',
  'HTTP_ERROR',
  'NETWORK_ERROR',
  'TIMEOUT',
  'CANCELLED',
  'INVALID_RESPONSE',
  'STREAM_INTERRUPTED',
  'OUTPUT_REJECTED',
  'MODEL_ERROR',
  'RESTORED_NOT_REPLAYED',
  'WORKER_RECOVERY_REQUIRED',
  'CONTENT_DELETED',
  'OUTPUT_LIMIT_EXCEEDED',
]);
const code = (value: string | null | undefined) =>
  value == null ? null : safeCodes.has(value) ? value : 'MODEL_ERROR';
const status = (value: number | null | undefined) =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 100 &&
  value <= 599
    ? value
    : null;
const conflict = () =>
  new DomainError(
    'BUSINESS_CONFLICT',
    '模型尝试的身份/状态已变化，未重新发送或覆盖原片段。',
    409,
  );
function text(value: string) {
  if (value.length > 100000)
    throw new DomainError(
      'INVALID_MODEL_OUTPUT',
      '模型可见片段超过当前限制；未归档超限文本。',
      422,
    );
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new DomainError(
          'INVALID_MODEL_OUTPUT',
          '模型可见片段的Unicode无效。',
          422,
        );
    } else if (unit >= 0xdc00 && unit <= 0xdfff)
      throw new DomainError(
        'INVALID_MODEL_OUTPUT',
        '模型可见片段的Unicode无效。',
        422,
      );
  }
  try {
    assertSafeModelInput(value);
  } catch {
    throw new DomainError(
      'INVALID_MODEL_OUTPUT',
      '模型回复含受保护凭据，未归档该明文片段。',
      422,
    );
  }
  return value;
}
const view = (row: AttemptRow): ModelAttemptView =>
  modelAttemptViewSchema.parse({
    id: row.id,
    logicalCallId: row.logical_call_id,
    modelOrdinal: row.ordinal,
    attemptNo: row.attempt_no,
    prefixLength: row.prefix_length,
    state: row.state,
    visibleText: row.content_redacted_at ? '' : row.visible_text,
    errorCode: row.error_code,
    httpStatus: row.http_status,
    nextAttemptAt: row.next_attempt_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
  });
export async function modelAttemptsReady(tx: SqlExecutor) {
  return Boolean(
    (
      await tx.query<{ ready: boolean }>(
        "SELECT to_regclass('app.ai_model_attempts') IS NOT NULL ready",
      )
    ).rows[0]?.ready,
  );
}

/** Private persistence port only. Parent TaskService must check current owner/sources and claim.
 * This never resolves credentials, sends a model request, runs a tool, or requeues a task. */
export class AiModelAttemptStore {
  constructor(readonly db: Database) {}
  private async requireSchema(tx: SqlExecutor) {
    if (!(await modelAttemptsReady(tx)))
      throw new DomainError(
        'DEPENDENCY_UNAVAILABLE',
        '模型尝试持久层尚未迁移，未发送新模型请求。',
        503,
      );
  }
  private async live(
    tx: SqlExecutor,
    taskId: string,
  ): Promise<LiveRow | undefined> {
    return (
      await tx.query<LiveRow>(
        `SELECT t.id,t.owner_id,t.assistant_message_id,m.content FROM app.ai_tasks t JOIN app.ai_messages m ON m.id=t.assistant_message_id AND m.conversation_id=t.conversation_id
    JOIN app.ai_conversations c ON c.id=t.conversation_id AND c.owner_id=t.owner_id JOIN app.users u ON u.id=t.owner_id
    WHERE t.id=$1 AND t.state='running' AND t.cancel_requested_at IS NULL AND u.active AND c.deleted_at IS NULL AND m.deleted_at IS NULL AND m.status<>'deleted' FOR UPDATE OF t`,
        [taskId],
      )
    ).rows[0];
  }
  async beginInTransaction(
    tx: SqlExecutor,
    input: {
      taskId: string;
      assistantMessageId: string;
      context: ModelAttemptContext;
      prefixLength?: number;
    },
  ) {
    await this.requireSchema(tx);
    const context = modelAttemptContextSchema.parse(input.context);
    if (
      context.attemptNo > context.maxRetries ||
      context.modelOrdinal > 2147483647
    )
      throw conflict();
    const task = await this.live(tx, z.uuid().parse(input.taskId));
    if (!task || task.assistant_message_id !== input.assistantMessageId)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '原任务已停止、删除或失效，未新开模型尝试。',
        422,
      );
    const existing = (
      await tx.query<AttemptRow>(
        'SELECT * FROM app.ai_model_attempts WHERE id=$1 FOR UPDATE',
        [context.attemptId],
      )
    ).rows[0];
    if (existing) {
      if (
        existing.task_id !== task.id ||
        existing.assistant_message_id !== task.assistant_message_id ||
        existing.logical_call_id !== context.logicalCallId ||
        existing.ordinal !== context.modelOrdinal ||
        existing.attempt_no !== context.attemptNo ||
        existing.max_retries !== context.maxRetries ||
        existing.content_redacted_at ||
        (input.prefixLength !== undefined &&
          input.prefixLength !== existing.prefix_length)
      )
        throw conflict();
      return {
        attempt: view(existing),
        prefixLength: existing.prefix_length,
        replayed: true,
      };
    }
    const ledger = (
      await tx.query<LedgerRow>(
        'SELECT * FROM app.model_call_ledger WHERE id=$1 FOR UPDATE',
        [context.attemptId],
      )
    ).rows[0];
    if (
      !ledger ||
      ledger.task_id !== task.id ||
      ledger.initiator_user_id !== task.owner_id ||
      ledger.source !== 'chat' ||
      ledger.status !== 'dispatchIntent' ||
      ledger.logical_call_id !== null ||
      ledger.attempt_no !== null
    )
      throw conflict();
    const previous = (
      await tx.query<AttemptRow>(
        'SELECT * FROM app.ai_model_attempts WHERE logical_call_id=$1 ORDER BY attempt_no DESC LIMIT 1 FOR UPDATE',
        [context.logicalCallId],
      )
    ).rows[0];
    let prefixLength = input.prefixLength ?? task.content.length;
    if (context.attemptNo === 0) {
      if (previous) throw conflict();
    } else {
      if (
        !previous ||
        previous.task_id !== task.id ||
        previous.assistant_message_id !== task.assistant_message_id ||
        previous.ordinal !== context.modelOrdinal ||
        previous.attempt_no !== context.attemptNo - 1 ||
        previous.max_retries !== context.maxRetries ||
        previous.state !== 'retryWait' ||
        previous.content_redacted_at
      )
        throw conflict();
      prefixLength = previous.prefix_length;
      if (
        input.prefixLength !== undefined &&
        input.prefixLength !== prefixLength
      )
        throw conflict();
      const priorLedger = (
        await tx.query<LedgerRow>(
          'SELECT * FROM app.model_call_ledger WHERE id=$1',
          [previous.id],
        )
      ).rows[0];
      if (
        !priorLedger ||
        [
          'model_service_id',
          'model_config_revision',
          'model_entry_id',
          'model_protocol',
          'model_id',
          'effort',
          'execution_origin',
        ].some(
          (key) =>
            ledger[key as keyof LedgerRow] !==
            priorLedger[key as keyof LedgerRow],
        )
      )
        throw conflict();
      await tx.query(
        "UPDATE app.ai_model_attempts SET state='failed',next_attempt_at=NULL WHERE id=$1",
        [previous.id],
      );
    }
    if (
      !Number.isInteger(prefixLength) ||
      prefixLength < 0 ||
      prefixLength > 100000 ||
      prefixLength > task.content.length
    )
      throw conflict();
    if (
      prefixLength > 0 &&
      prefixLength < task.content.length &&
      /^[\uDC00-\uDFFF]$/.test(task.content[prefixLength]!) &&
      /^[\uD800-\uDBFF]$/.test(task.content[prefixLength - 1]!)
    )
      throw conflict();
    await tx.query(
      "UPDATE app.model_call_ledger SET logical_call_id=$2,attempt_no=$3 WHERE id=$1 AND status='dispatchIntent' AND logical_call_id IS NULL AND attempt_no IS NULL",
      [context.attemptId, context.logicalCallId, context.attemptNo],
    );
    const created = (
      await tx.query<AttemptRow>(
        `INSERT INTO app.ai_model_attempts(id,task_id,assistant_message_id,logical_call_id,ordinal,attempt_no,max_retries,prefix_length) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          context.attemptId,
          task.id,
          task.assistant_message_id,
          context.logicalCallId,
          context.modelOrdinal,
          context.attemptNo,
          context.maxRetries,
          prefixLength,
        ],
      )
    ).rows[0]!;
    return { attempt: view(created), prefixLength, replayed: false };
  }
  async appendInTransaction(
    tx: SqlExecutor,
    taskId: string,
    attemptId: string,
    delta: string,
  ) {
    await this.requireSchema(tx);
    if (!delta) return false;
    const task = await this.live(tx, taskId);
    if (!task) return false;
    const row = (
      await tx.query<AttemptRow>(
        'SELECT * FROM app.ai_model_attempts WHERE id=$1 AND task_id=$2 FOR UPDATE',
        [attemptId, taskId],
      )
    ).rows[0];
    if (!row || row.state !== 'running' || row.content_redacted_at)
      return false;
    await tx.query(
      'UPDATE app.ai_model_attempts SET visible_text=$2 WHERE id=$1',
      [attemptId, text(row.visible_text + delta)],
    );
    return true;
  }
  async finishInTransaction(
    tx: SqlExecutor,
    taskId: string,
    attemptId: string,
    input: {
      state: 'completed' | 'failed' | 'cancelled';
      errorCode?: string | null;
      httpStatus?: number | null;
    },
  ) {
    if (!(await modelAttemptsReady(tx))) return false;
    const state = z
        .enum(['completed', 'failed', 'cancelled'])
        .parse(input.state),
      row = (
        await tx.query<AttemptRow>(
          'SELECT * FROM app.ai_model_attempts WHERE id=$1 AND task_id=$2 FOR UPDATE',
          [attemptId, taskId],
        )
      ).rows[0];
    if (
      !row ||
      (row.state !== 'running' &&
        !(state === 'cancelled' && row.state === 'retryWait'))
    )
      return false;
    await tx.query(
      'UPDATE app.ai_model_attempts SET state=$2,error_code=$3,http_status=$4,next_attempt_at=NULL,finished_at=COALESCE(finished_at,clock_timestamp()) WHERE id=$1',
      [attemptId, state, code(input.errorCode), status(input.httpStatus)],
    );
    return true;
  }
  async scheduledTrimPrefixInTransaction(
    tx: SqlExecutor,
    taskId: string,
    raw: ModelRetryEvent,
  ) {
    await this.requireSchema(tx);
    const event = modelRetryEventSchema.parse(raw);
    if (
      event.phase !== 'scheduled' ||
      !event.nextAttemptAt ||
      event.retryNo !== event.attemptNo + 1
    )
      throw conflict();
    const task = await this.live(tx, taskId);
    if (!task) return { applied: false, prefixLength: 0 };
    const row = (
      await tx.query<AttemptRow>(
        'SELECT * FROM app.ai_model_attempts WHERE id=$1 AND task_id=$2 FOR UPDATE',
        [event.attemptId, taskId],
      )
    ).rows[0];
    if (
      !row ||
      row.logical_call_id !== event.logicalCallId ||
      row.ordinal !== event.modelOrdinal ||
      row.attempt_no !== event.attemptNo ||
      row.max_retries !== event.maxRetries ||
      row.content_redacted_at ||
      !['running', 'failed'].includes(row.state)
    )
      return { applied: false, prefixLength: 0 };
    const message = (
      await tx.query<{ content: string }>(
        "SELECT content FROM app.ai_messages WHERE id=$1 AND deleted_at IS NULL AND status<>'deleted' FOR UPDATE",
        [task.assistant_message_id],
      )
    ).rows[0];
    if (!message || message.content.length < row.prefix_length)
      throw conflict();
    const prefix = message.content.slice(0, row.prefix_length);
    text(prefix);
    await tx.query('UPDATE app.ai_messages SET content=$2 WHERE id=$1', [
      task.assistant_message_id,
      prefix,
    ]);
    await tx.query(
      "UPDATE app.ai_model_attempts SET state='retryWait',retry_at=clock_timestamp(),next_attempt_at=$2,finished_at=COALESCE(finished_at,clock_timestamp()) WHERE id=$1",
      [row.id, event.nextAttemptAt],
    );
    return { applied: true, prefixLength: row.prefix_length };
  }
  async closeTaskInTransaction(
    tx: SqlExecutor,
    taskId: string,
    state: 'failed' | 'cancelled',
    reason?: string,
  ) {
    if (!(await modelAttemptsReady(tx))) return 0;
    z.enum(['failed', 'cancelled']).parse(state);
    return (
      (
        await tx.query(
          "UPDATE app.ai_model_attempts SET state=$2,error_code=COALESCE(error_code,$3),next_attempt_at=NULL,finished_at=COALESCE(finished_at,clock_timestamp()) WHERE task_id=$1 AND state IN ('running','retryWait')",
          [
            taskId,
            state,
            code(
              reason ??
                (state === 'cancelled'
                  ? 'CANCELLED'
                  : 'WORKER_RECOVERY_REQUIRED'),
            ),
          ],
        )
      ).rowCount ?? 0
    );
  }
  /** Private saved-copy DTO: caller checks current owner + conversation target permission.
   * AI reuse/retry separately rechecks every frozen source; ordinary source withdrawal does not erase a saved Web copy. */
  async listForOwnerInTransaction(
    tx: SqlExecutor,
    taskId: string,
    ownerId: string,
  ): Promise<ModelAttemptView[]> {
    if (!(await modelAttemptsReady(tx))) return [];
    const readable = (
      await tx.query(
        'SELECT 1 FROM app.ai_tasks t JOIN app.ai_conversations c ON c.id=t.conversation_id WHERE t.id=$1 AND t.owner_id=$2 AND c.owner_id=$2 AND c.deleted_at IS NULL',
        [taskId, ownerId],
      )
    ).rowCount;
    if (!readable)
      throw new DomainError('NOT_FOUND', '没有此本人可读取的模型尝试。', 404);
    return (
      await tx.query<AttemptRow>(
        'SELECT * FROM app.ai_model_attempts WHERE task_id=$1 ORDER BY ordinal,attempt_no,id',
        [taskId],
      )
    ).rows.map(view);
  }
}

/** C5 uses stable structural references, never searches free-form text or touches other owners. */
export async function redactDeletedModelAttemptsInTransaction(
  tx: SqlExecutor,
  ownerId?: string,
  resourceIds: string[] = [],
) {
  if (!(await modelAttemptsReady(tx))) return 0;
  return (
    (
      await tx.query(
        `UPDATE app.ai_model_attempts a SET visible_text='',content_redacted_at=COALESCE(content_redacted_at,clock_timestamp()),next_attempt_at=NULL,
  state=CASE WHEN a.state IN ('running','retryWait') THEN 'cancelled' ELSE a.state END,finished_at=CASE WHEN a.state IN ('running','retryWait') THEN COALESCE(a.finished_at,clock_timestamp()) ELSE a.finished_at END
  FROM app.ai_tasks t JOIN app.ai_conversations c ON c.id=t.conversation_id JOIN app.ai_messages m ON m.id=t.user_message_id
  WHERE a.task_id=t.id AND ($1::uuid IS NULL OR c.owner_id=$1) AND(c.deleted_at IS NOT NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(m.explicit_refs) r WHERE
   (r#>>'{reference,kind}'='resource' AND r#>>'{reference,resourceId}'=ANY($2::text[])) OR (r->>'kind'='resource' AND r->>'resourceId'=ANY($2::text[])) OR COALESCE(r->'resourceIds','[]'::jsonb) ?| $2::text[]))`,
        [ownerId ?? null, resourceIds],
      )
    ).rowCount ?? 0
  );
}
/** Startup/restore closes old metadata only. It does not queue or grant a request. */
export async function recoverInterruptedModelAttemptsInTransaction(
  tx: SqlExecutor,
  reason = 'RESTORED_NOT_REPLAYED',
) {
  if (!(await modelAttemptsReady(tx))) return 0;
  return (
    (
      await tx.query(
        "UPDATE app.ai_model_attempts SET state='failed',error_code=COALESCE(error_code,$1),next_attempt_at=NULL,finished_at=COALESCE(finished_at,clock_timestamp()) WHERE state IN ('running','retryWait')",
        [code(reason)],
      )
    ).rowCount ?? 0
  );
}
