import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  browserActionSchema,
  browserOperationReceiptSchema,
  browserOperationListSchema,
  browserPlanSchema,
  browserSessionSchema,
  browserUrlSchema,
  type BrowserObservation,
  type BrowserRuntimePort,
  type BrowserRuntimeResult,
} from '../../../contracts/src/agent-browser.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { conversationRow } from '../conversations/common.js';
import { DomainError, stale } from '../errors.js';
import { assertSafeModelInput } from '../security/model-input.js';
import { assertFrozenTaskSources } from '../conversations/task-sources.js';
import { assertTaskCapability } from '../conversations/task-capabilities.js';

export interface AgentBrowserScope {
  conversationId: string;
  allowPrivateState?: boolean;
  taskId?: string;
  authorize?: () => Promise<void>;
  signal?: AbortSignal;
}
interface SessionRow {
  id: string;
  owner_id: string;
  conversation_id: string;
  state: 'open' | 'closed' | 'unknown';
  control: 'agent' | 'human';
  row_version: number;
  private_state: boolean;
  observation_id: string | null;
  observation_hash: string | null;
  current_url: string | null;
}
interface OperationRow {
  id: string;
  owner_id: string;
  session_id: string;
  task_id: string | null;
  kind: 'navigate' | 'plan' | 'human' | 'control';
  plan: unknown;
  request_digest: string;
  state:
    | 'waitingConfirmation'
    | 'dispatching'
    | 'completed'
    | 'failed'
    | 'unknown'
    | 'rejected'
    | 'cancelled';
  row_version: number;
  error_code: string | null;
  completed_actions: number;
  expires_at: Date;
  created_at: Date;
}
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sessionDto = (row: SessionRow) =>
  browserSessionSchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    state: row.state,
    control: row.control,
    rowVersion: row.row_version,
  });
const operationDto = (row: OperationRow) =>
  browserOperationReceiptSchema.parse({
    operation: {
      id: row.id,
      sessionId: row.session_id,
      kind: row.kind,
      state: row.state,
      plan: row.plan,
      requestDigest: row.request_digest,
      rowVersion: row.row_version,
      errorCode: row.error_code,
      completedActions: row.completed_actions,
      createdAt: row.created_at.toISOString(),
    },
  });

/** Only Web can confirm an external action; ordinary model calls can only propose it. */
export class AgentBrowserService {
  constructor(
    readonly db: Database,
    readonly runtime: BrowserRuntimePort | undefined,
  ) {}
  private port() {
    if (!this.runtime)
      throw new DomainError(
        'DEPENDENCY_UNAVAILABLE',
        '办公浏览器运行端尚未配置。',
        503,
      );
    return this.runtime;
  }
  private web(actor: ActorContext) {
    if (actor.entrypoint !== 'web' || actor.keyId)
      throw new DomainError(
        'FORBIDDEN',
        '浏览器批准和人工接管只能由本人网页发起。',
        403,
      );
  }
  private async authorize(
    tx: SqlExecutor,
    actor: ActorContext,
    scope: AgentBrowserScope,
    start = false,
  ) {
    scope.signal?.throwIfAborted();
    const conversation = await conversationRow(
      tx,
      actor,
      scope.conversationId,
      start,
      true,
    );
    if (start && conversation.archived_at)
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '会话已归档，不能启动网页操作。',
        409,
      );
    if (actor.entrypoint === 'internal-ai') {
      if (!scope.taskId)
        throw new DomainError(
          'FORBIDDEN',
          '浏览器只用于本人当前活动对话任务。',
          403,
        );
      await assertTaskCapability(
        tx,
        actor,
        { taskId: scope.taskId, conversationId: scope.conversationId },
        'office',
        { active: true },
      );
    }
  }
  private async session(
    tx: SqlExecutor,
    actor: ActorContext,
    scope: AgentBrowserScope,
    lock = false,
  ) {
    await this.authorize(tx, actor, scope);
    const row = (
      await tx.query<SessionRow>(
        `SELECT * FROM app.agent_browser_sessions WHERE owner_id=$1 AND conversation_id=$2 AND state IN ('open','unknown') ORDER BY created_at DESC LIMIT 1 ${lock ? 'FOR UPDATE' : ''}`,
        [actor.userId, scope.conversationId],
      )
    ).rows[0];
    if (!row)
      throw new DomainError('NOT_FOUND', '此会话没有活动办公浏览器。', 404);
    if (
      actor.entrypoint === 'internal-ai' &&
      row.private_state &&
      !scope.allowPrivateState
    )
      throw new DomainError(
        'FORBIDDEN',
        '当前资料模式不能读取已登录办公浏览器，请使用完全访问并明确继续。',
        403,
      );
    return row;
  }
  private async operation(
    tx: SqlExecutor,
    actor: ActorContext,
    scope: AgentBrowserScope,
    id: string,
    lock = false,
  ) {
    await this.authorize(tx, actor, scope);
    const row = (
      await tx.query<OperationRow>(
        `SELECT o.* FROM app.agent_browser_operations o JOIN app.agent_browser_sessions s ON s.id=o.session_id WHERE o.id=$1 AND o.owner_id=$2 AND s.conversation_id=$3 ${lock ? 'FOR UPDATE OF o,s' : ''}`,
        [z.uuid().parse(id), actor.userId, scope.conversationId],
      )
    ).rows[0];
    if (!row)
      throw new DomainError('NOT_FOUND', '网页操作不存在或不可访问。', 404);
    if (actor.entrypoint === 'internal-ai') {
      let readable = scope.allowPrivateState || row.task_id === scope.taskId;
      if (row.task_id) {
        const parent = (
          await tx.query<{ explicit_refs: unknown }>(
            'SELECT m.explicit_refs FROM app.ai_tasks t JOIN app.ai_messages m ON m.id=t.assistant_message_id WHERE t.id=$1 AND t.owner_id=$2 AND m.deleted_at IS NULL',
            [row.task_id, actor.userId],
          )
        ).rows[0];
        if (!parent) readable = false;
        else
          try {
            await assertFrozenTaskSources(tx, actor, parent.explicit_refs);
          } catch (error: unknown) {
            if (
              error instanceof DomainError &&
              [
                'FORBIDDEN',
                'NOT_FOUND',
                'FILE_NOT_READY',
                'PRECONDITIONS_MISSING',
              ].includes(error.code)
            )
              readable = false;
            else throw error;
          }
      }
      if (!readable)
        return { ...row, plan: null, request_digest: '0'.repeat(64) };
    }
    return row;
  }
  async current(actor: ActorContext, scope: AgentBrowserScope) {
    await scope.authorize?.();
    return this.db.transaction(async (tx) => {
      await this.authorize(tx, actor, scope);
      const row = (
        await tx.query<SessionRow>(
          "SELECT * FROM app.agent_browser_sessions WHERE owner_id=$1 AND conversation_id=$2 AND state IN ('open','unknown') ORDER BY created_at DESC LIMIT 1",
          [actor.userId, scope.conversationId],
        )
      ).rows[0];
      return { session: row ? sessionDto(row) : null };
    });
  }
  async open(actor: ActorContext, scope: AgentBrowserScope) {
    await scope.authorize?.();
    const port = this.port();
    const record = await this.db.transaction(async (tx) => {
      await this.authorize(tx, actor, scope, true);
      const existing = (
        await tx.query<SessionRow>(
          "SELECT * FROM app.agent_browser_sessions WHERE owner_id=$1 AND conversation_id=$2 AND state IN ('open','unknown')",
          [actor.userId, scope.conversationId],
        )
      ).rows[0];
      if (existing) return { row: existing, fresh: false };
      const row = (
        await tx.query<SessionRow>(
          "INSERT INTO app.agent_browser_sessions(id,owner_id,conversation_id,state) VALUES($1,$2,$3,'unknown') RETURNING *",
          [randomUUID(), actor.userId, scope.conversationId],
        )
      ).rows[0];
      if (!row) throw new Error('BROWSER_SESSION_INSERT_FAILED');
      return { row, fresh: true };
    });
    if (record.fresh) {
      try {
        await port.open(record.row.id);
        await this.db.query(
          "UPDATE app.agent_browser_sessions SET state='open',updated_at=now() WHERE id=$1 AND state='unknown'",
          [record.row.id],
        );
      } catch {
        throw new DomainError(
          'OPERATION_RESULT_UNKNOWN',
          '浏览器创建回执未知，请关闭此会话运行端后再明确新建。',
          409,
        );
      }
    }
    return this.current(actor, scope);
  }
  private async remember(
    actor: ActorContext,
    scope: AgentBrowserScope,
    row: SessionRow,
    observation: BrowserObservation,
  ) {
    await scope.authorize?.();
    await this.db.transaction(async (tx) => {
      await this.authorize(tx, actor, scope);
      const updated = await tx.query(
        "UPDATE app.agent_browser_sessions SET observation_id=$2,observation_hash=$3,document_id=$4,current_url=$5,private_state=$6,updated_at=now() WHERE id=$1 AND row_version=$7 AND state='open' RETURNING id",
        [
          row.id,
          observation.id,
          observation.hash,
          observation.documentId,
          observation.url,
          observation.privateState,
          row.row_version,
        ],
      );
      if (!updated.rowCount)
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '浏览器控制权已变化，未共享旧页面。',
          409,
        );
    });
  }
  async observe(actor: ActorContext, scope: AgentBrowserScope, human = false) {
    await scope.authorize?.();
    if (human) this.web(actor);
    const row = await this.db.transaction((tx) =>
      this.session(tx, actor, scope),
    );
    if (row.control !== (human ? 'human' : 'agent'))
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '浏览器已由另一控制端接管。',
        409,
      );
    const observation = await this.port().observe(row.id, human);
    await this.remember(actor, scope, row, observation);
    return observation;
  }
  private async createOperation(
    actor: ActorContext,
    scope: AgentBrowserScope,
    raw: {
      commandId: string;
      kind: OperationRow['kind'];
      plan: unknown;
      requestDigest: string;
      waiting: boolean;
      sessionRowVersion?: number;
    },
  ) {
    await scope.authorize?.();
    return this.db.transaction(async (tx) => {
      await this.authorize(tx, actor, scope, true);
      const session = await this.session(tx, actor, scope, true);
      if (
        raw.sessionRowVersion !== undefined &&
        session.row_version !== raw.sessionRowVersion
      )
        stale();
      const prior = (
        await tx.query<OperationRow>(
          'SELECT * FROM app.agent_browser_operations WHERE owner_id=$1 AND command_id=$2',
          [actor.userId, z.uuid().parse(raw.commandId)],
        )
      ).rows[0];
      if (prior) {
        if (
          prior.session_id !== session.id ||
          prior.request_digest !== raw.requestDigest
        )
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            '原网页操作标识已用于其他内容。',
            409,
          );
        return { row: prior, session, fresh: false };
      }
      if (
        (
          await tx.query(
            "SELECT 1 FROM app.agent_browser_operations WHERE session_id=$1 AND state='dispatching'",
            [session.id],
          )
        ).rowCount
      )
        throw new DomainError(
          'OPERATION_RESULT_UNKNOWN',
          '此浏览器已有派发未决操作，请先查原回执。',
          409,
        );
      if (
        raw.kind !== 'control' &&
        session.control !== (raw.kind === 'human' ? 'human' : 'agent')
      )
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '当前浏览器控制权不允许此操作。',
          409,
        );
      if (raw.waiting) {
        const plan = browserPlanSchema.parse(raw.plan);
        if (
          plan.observationId !== session.observation_id ||
          plan.observationHash !== session.observation_hash
        )
          throw new DomainError(
            'STALE_BASE_REVISION',
            '页面观察已变化，请重新读取后拟定动作。',
            412,
          );
      }
      const row = (
        await tx.query<OperationRow>(
          "INSERT INTO app.agent_browser_operations(id,owner_id,session_id,task_id,command_id,kind,plan,request_digest,state,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '5 minutes') RETURNING *",
          [
            randomUUID(),
            actor.userId,
            session.id,
            scope.taskId ?? null,
            raw.commandId,
            raw.kind,
            raw.plan ? JSON.stringify(raw.plan) : null,
            raw.requestDigest,
            raw.waiting ? 'waitingConfirmation' : 'dispatching',
          ],
        )
      ).rows[0];
      if (!row) throw new Error('BROWSER_OPERATION_INSERT_FAILED');
      return { row, session, fresh: true };
    });
  }
  private async finish(
    actor: ActorContext,
    scope: AgentBrowserScope,
    row: OperationRow,
    result: BrowserRuntimeResult,
  ) {
    await this.db.transaction(async (tx) => {
      await this.authorize(tx, actor, scope);
      await tx.query(
        "UPDATE app.agent_browser_operations SET state=$2,error_code=$3,completed_actions=$4,row_version=row_version+1,finished_at=now() WHERE id=$1 AND state='dispatching'",
        [row.id, result.state, result.errorCode, result.completedActions],
      );
    });
    if (result.observation) {
      const session = await this.db.transaction((tx) =>
        this.session(tx, actor, scope),
      );
      await this.remember(actor, scope, session, result.observation);
    }
    return {
      ...(await this.status(actor, scope, row.id)),
      observation: result.observation,
    };
  }
  private async execute(
    actor: ActorContext,
    scope: AgentBrowserScope,
    row: OperationRow,
    work: () => Promise<BrowserRuntimeResult>,
  ) {
    let cleanup: Promise<void> | undefined,
      cleanupFailed = false;
    const stop = () => {
      cleanup = this.port()
        .close(row.session_id)
        .then(async () => {
          await this.db.query(
            "UPDATE app.agent_browser_sessions SET state='closed',row_version=row_version+1 WHERE id=$1",
            [row.session_id],
          );
        })
        .catch(() => {
          cleanupFailed = true;
        });
    };
    scope.signal?.addEventListener('abort', stop, { once: true });
    if (scope.signal?.aborted) stop();
    try {
      return await this.finish(actor, scope, row, await work());
    } catch (error: unknown) {
      const safe =
        error instanceof Error &&
        /^BROWSER_[A-Z0-9_]{1,70}$/.test(error.message)
          ? error.message
          : 'BROWSER_ORIGINAL_RESULT_UNKNOWN';
      await this.db.query(
        "UPDATE app.agent_browser_operations SET state='unknown',error_code=$2,row_version=row_version+1 WHERE id=$1 AND state='dispatching'",
        [row.id, safe],
      );
      throw new DomainError(
        'OPERATION_RESULT_UNKNOWN',
        '网页操作没有确定完成回执，请查询原操作；不会自动重发。',
        409,
        { operationId: row.id },
      );
    } finally {
      scope.signal?.removeEventListener('abort', stop);
      await cleanup;
      if (cleanupFailed)
        await this.db.query(
          "UPDATE app.agent_browser_sessions SET cleanup_pending=true,state='unknown',row_version=row_version+1 WHERE id=$1",
          [row.session_id],
        );
    }
  }
  async navigate(actor: ActorContext, scope: AgentBrowserScope, raw: unknown) {
    const input = z
      .strictObject({ commandId: z.uuid(), url: browserUrlSchema })
      .parse(raw);
    assertSafeModelInput(input.url);
    const session = await this.db.transaction((tx) =>
      this.session(tx, actor, scope),
    );
    if (session.private_state) {
      const observation = await this.observe(actor, scope);
      return this.propose(actor, scope, {
        commandId: input.commandId,
        observationId: observation.id,
        observationHash: observation.hash,
        purpose: '在已有人工登录状态的浏览器中导航',
        actions: [{ kind: 'navigate', url: input.url }],
      });
    }
    const operation = await this.createOperation(actor, scope, {
      commandId: input.commandId,
      kind: 'navigate',
      plan: null,
      requestDigest: digest(input),
      waiting: false,
    });
    if (!operation.fresh) return operationDto(operation.row);
    return this.execute(actor, scope, operation.row, () =>
      this.port().navigate(operation.session.id, operation.row.id, input.url),
    );
  }
  async propose(actor: ActorContext, scope: AgentBrowserScope, raw: unknown) {
    const input = browserPlanSchema.extend({ commandId: z.uuid() }).parse(raw);
    assertSafeModelInput(input);
    const observed = await this.observe(actor, scope);
    if (observed.hash !== input.observationHash) stale();
    for (const action of input.actions)
      if (
        action.kind === 'fill' &&
        observed.elements.some(
          (element) => element.id === action.targetId && element.sensitive,
        )
      )
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '密码和令牌只能由本人在人工接管中安全输入。',
          422,
        );
    const { commandId, ...plan } = input;
    plan.observationId = observed.id;
    const operation = await this.createOperation(actor, scope, {
      commandId,
      kind: 'plan',
      plan,
      requestDigest: digest({
        observationHash: plan.observationHash,
        actions: plan.actions,
        purpose: plan.purpose,
      }),
      waiting: true,
    });
    return operationDto(operation.row);
  }
  async decide(
    actor: ActorContext,
    scope: AgentBrowserScope,
    id: string,
    raw: unknown,
  ) {
    this.web(actor);
    const input = z
      .strictObject({
        rowVersion: z.number().int().positive(),
        requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
        approve: z.boolean(),
      })
      .parse(raw);
    const row = await this.db.transaction(async (tx) => {
      const operation = await this.operation(tx, actor, scope, id, true);
      if (
        operation.row_version !== input.rowVersion ||
        operation.request_digest !== input.requestDigest
      )
        stale();
      if (
        operation.state !== 'waitingConfirmation' ||
        operation.expires_at < new Date()
      )
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '此批准已失效或已消费。',
          409,
        );
      const session = await this.session(tx, actor, scope, true);
      const plan = browserPlanSchema.parse(operation.plan);
      if (
        session.id !== operation.session_id ||
        session.control !== 'agent' ||
        session.state !== 'open' ||
        session.observation_hash !== plan.observationHash
      )
        stale();
      if (operation.task_id) {
        // The original A12 Web decision may follow a completed model reply.
        // A schedule does not supply that human event or expand its policy.
        await assertTaskCapability(
          tx,
          actor,
          { taskId: operation.task_id, conversationId: scope.conversationId },
          'office',
          { active: true, allowCompleted: true },
        );
        const parent = (
          await tx.query<{
            explicit_refs: unknown;
            state: string;
            cancel_requested_at: Date | null;
          }>(
            'SELECT m.explicit_refs,t.state,t.cancel_requested_at FROM app.ai_tasks t JOIN app.ai_messages m ON m.id=t.assistant_message_id WHERE t.id=$1 AND t.owner_id=$2 AND t.conversation_id=$3 AND m.deleted_at IS NULL',
            [operation.task_id, actor.userId, scope.conversationId],
          )
        ).rows[0];
        if (
          !parent ||
          !['running', 'completed'].includes(parent.state) ||
          parent.cancel_requested_at
        )
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '原任务已取消或不再有效，请重新核对后提出动作。',
            422,
          );
        await assertFrozenTaskSources(tx, actor, parent.explicit_refs);
        if (
          (
            await tx.query(
              "SELECT 1 FROM app.ai_task_events WHERE task_id=$1 AND event_type='ai.tool' AND payload->>'unknownEffect'='true' LIMIT 1",
              [operation.task_id],
            )
          ).rowCount
        )
          throw new DomainError(
            'OPERATION_RESULT_UNKNOWN',
            '原任务有未知外部效果，请先核对原记录。',
            409,
          );
      }
      await tx.query(
        'UPDATE app.agent_browser_operations SET state=$2,row_version=row_version+1 WHERE id=$1',
        [id, input.approve ? 'dispatching' : 'rejected'],
      );
      return operation;
    });
    if (!input.approve) return this.status(actor, scope, id);
    return this.execute(actor, scope, row, () =>
      this.port().plan(
        row.session_id,
        row.id,
        browserPlanSchema.parse(row.plan),
      ),
    );
  }
  async status(actor: ActorContext, scope: AgentBrowserScope, id: string) {
    await scope.authorize?.();
    const row = await this.db.transaction((tx) =>
      this.operation(tx, actor, scope, id),
    );
    if (row.state === 'dispatching' || row.state === 'unknown') {
      const result = await this.port().status(row.session_id, row.id);
      if (result && result.state !== 'unknown')
        await this.db.query(
          "UPDATE app.agent_browser_operations SET state=$2,error_code=$3,completed_actions=$4,row_version=row_version+1,finished_at=now() WHERE id=$1 AND state IN ('dispatching','unknown')",
          [row.id, result.state, result.errorCode, result.completedActions],
        );
    }
    return operationDto(
      await this.db.transaction((tx) => this.operation(tx, actor, scope, id)),
    );
  }
  async operations(actor: ActorContext, scope: AgentBrowserScope) {
    await scope.authorize?.();
    return this.db.transaction(async (tx) => {
      const session = await this.session(tx, actor, scope);
      const rows = (
        await tx.query<OperationRow>(
          'SELECT * FROM app.agent_browser_operations WHERE session_id=$1 AND owner_id=$2 ORDER BY created_at DESC LIMIT 100',
          [session.id, actor.userId],
        )
      ).rows;
      return browserOperationListSchema.parse({
        operations: rows.map((row) => operationDto(row).operation),
      });
    });
  }
  async commandReceipt(
    actor: ActorContext,
    scope: AgentBrowserScope,
    commandId: string,
  ) {
    const row = await this.db.transaction(async (tx) => {
      await this.authorize(tx, actor, scope);
      return (
        await tx.query<{ id: string }>(
          'SELECT o.id FROM app.agent_browser_operations o JOIN app.agent_browser_sessions s ON s.id=o.session_id WHERE o.owner_id=$1 AND o.command_id=$2 AND s.conversation_id=$3',
          [actor.userId, z.uuid().parse(commandId), scope.conversationId],
        )
      ).rows[0];
    });
    if (!row)
      throw new DomainError(
        'NOT_FOUND',
        '尚未读到原操作记录，请继续核对或关闭浏览器，不能据此自动重发。',
        404,
      );
    return this.status(actor, scope, row.id);
  }
  async control(actor: ActorContext, scope: AgentBrowserScope, raw: unknown) {
    this.web(actor);
    const input = z
      .strictObject({
        commandId: z.uuid(),
        mode: z.enum(['human', 'agent']),
        rowVersion: z.number().int().positive(),
      })
      .parse(raw);
    const operation = await this.createOperation(actor, scope, {
      commandId: input.commandId,
      kind: 'control',
      sessionRowVersion: input.rowVersion,
      plan: null,
      requestDigest: digest(input),
      waiting: false,
    });
    if (!operation.fresh) return this.current(actor, scope);
    try {
      await this.port().control(
        operation.session.id,
        operation.row.id,
        input.mode,
      );
      await this.db.transaction(async (tx) => {
        await this.authorize(tx, actor, scope);
        await tx.query(
          "UPDATE app.agent_browser_sessions SET control=$2,private_state=CASE WHEN $2='human' THEN true ELSE private_state END,row_version=row_version+1,observation_id=NULL,observation_hash=NULL,updated_at=now() WHERE id=$1 AND row_version=$3 AND state='open'",
          [operation.session.id, input.mode, input.rowVersion],
        );
        await tx.query(
          "UPDATE app.agent_browser_operations SET state='completed',row_version=row_version+1,finished_at=now() WHERE id=$1",
          [operation.row.id],
        );
      });
    } catch {
      await this.db.query(
        "UPDATE app.agent_browser_operations SET state='unknown',error_code='BROWSER_CONTROL_UNKNOWN',row_version=row_version+1 WHERE id=$1",
        [operation.row.id],
      );
      throw new DomainError(
        'OPERATION_RESULT_UNKNOWN',
        '浏览器控制权切换结果未知，请关闭原会话后再操作。',
        409,
      );
    }
    return this.current(actor, scope);
  }
  async humanAction(
    actor: ActorContext,
    scope: AgentBrowserScope,
    raw: unknown,
  ) {
    this.web(actor);
    const input = z
      .strictObject({
        commandId: z.uuid(),
        action: browserActionSchema,
        secret: z.boolean(),
      })
      .parse(raw);
    const metadata = {
      kind: input.action.kind,
      targetId: 'targetId' in input.action ? input.action.targetId : null,
      url:
        input.action.kind === 'navigate'
          ? input.action.url
          : input.action.atUrl,
      secret: input.secret,
    };
    const operation = await this.createOperation(actor, scope, {
      commandId: input.commandId,
      kind: 'human',
      plan: null,
      requestDigest: digest(metadata),
      waiting: false,
    });
    if (!operation.fresh) return operationDto(operation.row);
    return this.execute(actor, scope, operation.row, () =>
      this.port().humanAction(
        operation.session.id,
        operation.row.id,
        input.action,
        input.secret,
      ),
    );
  }
  async cancel(actor: ActorContext, scope: AgentBrowserScope, id: string) {
    await scope.authorize?.();
    const row = await this.db.transaction((tx) =>
      this.operation(tx, actor, scope, id, true),
    );
    if (row.state === 'waitingConfirmation') {
      await this.db.query(
        "UPDATE app.agent_browser_operations SET state='cancelled',row_version=row_version+1 WHERE id=$1 AND state='waitingConfirmation'",
        [row.id],
      );
      return this.status(actor, scope, id);
    }
    if (['dispatching', 'unknown'].includes(row.state)) {
      await this.port().close(row.session_id);
      await this.db.query(
        "UPDATE app.agent_browser_sessions SET state='closed',row_version=row_version+1 WHERE id=$1",
        [row.session_id],
      );
      await this.db.query(
        "UPDATE app.agent_browser_operations SET state='unknown',error_code='BROWSER_CLOSED_EFFECT_MAY_HAVE_OCCURRED',row_version=row_version+1 WHERE id=$1",
        [row.id],
      );
    }
    return this.status(actor, scope, id);
  }
  async close(actor: ActorContext, scope: AgentBrowserScope) {
    this.web(actor);
    const row = await this.db.transaction((tx) =>
      this.session(tx, actor, scope, true),
    );
    await this.port().close(row.id);
    await this.db.transaction(async (tx) => {
      await this.authorize(tx, actor, scope);
      await tx.query(
        "UPDATE app.agent_browser_sessions SET state='closed',cleanup_pending=false,row_version=row_version+1,current_url=NULL,observation_id=NULL,observation_hash=NULL,document_id=NULL,updated_at=now() WHERE id=$1",
        [row.id],
      );
      await tx.query(
        "UPDATE app.agent_browser_operations SET state=CASE WHEN state='dispatching' THEN 'unknown' ELSE 'cancelled' END,row_version=row_version+1 WHERE session_id=$1 AND state IN ('waitingConfirmation','dispatching')",
        [row.id],
      );
    });
    return { session: null };
  }
  async reconcile() {
    if (!this.runtime) return;
    const pending = (
      await this.db.query<{ id: string; session_id: string }>(
        "SELECT id,session_id FROM app.agent_browser_operations WHERE state='dispatching' AND created_at<now()-interval '30 seconds' ORDER BY created_at LIMIT 20",
      )
    ).rows;
    for (const operation of pending) {
      const result = await this.runtime.status(
        operation.session_id,
        operation.id,
      );
      if (result && result.state !== 'unknown')
        await this.db.query(
          "UPDATE app.agent_browser_operations SET state=$2,error_code=$3,completed_actions=$4,row_version=row_version+1,finished_at=now() WHERE id=$1 AND session_id=$5 AND state='dispatching'",
          [
            operation.id,
            result.state,
            result.errorCode,
            result.completedActions,
            operation.session_id,
          ],
        );
    }
    const rows = (
      await this.db.query<{ id: string }>(
        "SELECT s.id FROM app.agent_browser_sessions s JOIN app.ai_conversations c ON c.id=s.conversation_id JOIN app.users u ON u.id=s.owner_id WHERE s.cleanup_pending OR (s.state IN ('open','unknown') AND (c.deleted_at IS NOT NULL OR NOT u.active OR s.updated_at<now()-interval '30 minutes')) LIMIT 20",
      )
    ).rows;
    for (const row of rows) {
      await this.runtime.close(row.id);
      await this.db.query(
        "UPDATE app.agent_browser_operations SET state=CASE WHEN state='dispatching' THEN 'unknown' ELSE 'cancelled' END,error_code='BROWSER_EXPIRED_CONTEXT_CLOSED',row_version=row_version+1 WHERE session_id=$1 AND state IN ('dispatching','waitingConfirmation')",
        [row.id],
      );
      await this.db.query(
        "UPDATE app.agent_browser_sessions SET state='closed',cleanup_pending=false,current_url=NULL,observation_id=NULL,observation_hash=NULL,document_id=NULL,row_version=row_version+1 WHERE id=$1",
        [row.id],
      );
    }
  }
}
