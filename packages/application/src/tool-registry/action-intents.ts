import {
  actionDisplayValue,
  actionIntentDisplay,
} from './action-presentation.js';
import { businessDisplayName } from '../identity/ai-projection.js';
import {
  parseActionIntentReply,
  actionIntentChatReplySchema,
  mcpActionIntentReplySchema,
} from '../../../contracts/src/action-intents.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  ActorContext,
  Capability,
} from '../../../contracts/src/identity.js';
import { findMcpOperation } from '../../../contracts/src/mcp.js';
import { idSchema } from '../../../contracts/src/base.js';
import {
  actionIntentSchema,
  actionIntentDecisionSchema,
  actionIntentPresentationSchema,
} from '../../../contracts/src/action-intents.js';
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
import { conversationRow } from '../conversations/common.js';
import { assertTaskCapability } from '../conversations/task-capabilities.js';
import { workspaceAccessModeSchema } from '../../../contracts/src/workspace-access.js';
import { withWorkspaceModelAccess } from '../security/model-input.js';

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
  proposal_revision: number;
  expires_at: Date;
  interaction_kind: 'legacy' | 'inlineCard' | 'mcpForm';
  message_id: string | null;
  presentation: unknown;
  replacement_key: string | null;
}
export interface ConfirmationContext {
  taskId?: string;
  conversationId?: string;
}
const safe = (row: ConfirmationRow) =>
  actionIntentSchema.parse({
    id: row.id,
    toolName: row.tool_name,
    op: row.operation,
    projectId: row.project_id,
    taskId: row.task_id,
    conversationId: row.conversation_id,
    status:
      row.state === 'waitingConfirmation' &&
      (row.interaction_kind === 'legacy' ||
        row.expires_at.getTime() <= Date.now())
        ? 'expired'
        : row.state,
    revision: row.proposal_revision,
    expiresAt: row.expires_at.toISOString(),
    messageId: row.message_id,
    arguments: row.arguments,
    ...actionIntentDisplay({
      tool: row.tool_name,
      op: row.operation,
      input: row.arguments,
      proposal: row.proposal,
      state: row.state,
      response: row.response,
      presentation: row.presentation,
    }),
    scopeDigest: row.scope_digest,
    proposal: row.proposal,
    response: row.response,
    createdAt: row.created_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    recovery: '未知或executing状态先查原业务command，不重放工具。',
  });
function confirmationCapability(name: string, op: string): Capability {
  if (name === 'ath_project_members') return 'project.members.manage';
  if (name === 'ath_results' && ['assess', 'record-human-retest'].includes(op))
    return 'results.assess';
  if (name === 'ath_results' && op === 'add-evidence') return 'results.submit';
  if (name === 'ath_reviews' && op === 'approve') return 'reviews.approve';
  if (name === 'ath_issues' && op === 'file-from-report')
    return 'reviews.approve';
  if (
    name === 'ath_assets' &&
    ['import-ui', 'remove-scoped-scene'].includes(op)
  )
    return 'assets.write';
  if (name === 'ath_retests' && op === 'record-manual-result')
    return 'issues.lifecycle';
  return findMcpOperation(name, op)?.capability ?? 'project.read';
}
const roleNames: Record<string, string> = {
  tester: '测试人员',
  developer: '开发人员',
  product: '产品人员',
};
function memberRoles(value: { roles: string[]; isAdmin: boolean }) {
  return (
    [
      ...value.roles.map((role) => roleNames[role] ?? role),
      ...(value.isAdmin ? ['项目管理员'] : []),
    ].join('、') || '无角色'
  );
}
const titles: Record<string, string> = {
  ath_assets: '更新测试资产',
  ath_reviews: '提交评审决定',
  ath_api_runs: '启动接口执行',
  ath_ui_executions: '更新执行进度',
  ath_results: '提交结果判定',
  ath_problems: '处理问题',
  ath_retests: '执行复测',
  ath_issue_lifecycle: '更新缺陷状态',
  ath_knowledge: '更新知识',
  ath_knowledge_changes: '提交知识变更',
  ath_project_members: '变更项目成员',
};
function replacementKey(call: PreparedBusinessCall) {
  const parsed = z
    .object({
      id: z.string().optional(),
      userId: z.string().optional(),
      entryId: z.string().optional(),
      runId: z.string().optional(),
      requirementId: z.string().optional(),
    })
    .safeParse(call.input);
  const target = parsed.success
    ? [
        parsed.data.id,
        parsed.data.userId,
        parsed.data.entryId,
        parsed.data.runId,
        parsed.data.requirementId,
      ].find((x) => x !== undefined)
    : undefined;
  return target
    ? createHash('sha256')
        .update(
          canonicalJson({
            tool: call.toolName,
            op: call.op,
            project: call.projectId ?? null,
            target,
          }),
        )
        .digest('hex')
    : null;
}
async function presentation(tx: SqlExecutor, call: PreparedBusinessCall) {
  const project = call.projectId
    ? (
        await tx.query<{ name: string }>(
          'SELECT name FROM app.projects WHERE id=$1',
          [call.projectId],
        )
      ).rows[0]
    : undefined;
  const result: z.infer<typeof actionIntentPresentationSchema> = {
    title: titles[call.toolName] ?? '执行业务变更',
    summary: call.confirmation?.summary ?? '',
    projectName: project?.name ?? null,
    changes: [],
    details: [],
  };
  if (project) result.details.push({ label: '项目', value: project.name });
  if (call.toolName === 'ath_project_members') {
    const input = z
      .object({
        userId: idSchema,
        input: z
          .object({ isAdmin: z.boolean(), roles: z.array(z.string()) })
          .optional(),
      })
      .parse(call.input);
    const user = (
      await tx.query<{
        display_name: string;
        display_account: string;
        account: string;
      }>(
        'SELECT display_name,display_account,account FROM app.users WHERE id=$1',
        [input.userId],
      )
    ).rows[0];
    if (!user)
      throw new DomainError(
        'NOT_FOUND',
        '成员对象已不存在，未创建执行卡。',
        404,
      );
    const member = z.object({
      userId: z.string(),
      roles: z.array(z.string()),
      isAdmin: z.boolean(),
    });
    const scope = z
      .object({
        current: z
          .union([member, z.object({ members: z.array(member) })])
          .nullable(),
      })
      .safeParse(call.confirmation?.scope);
    const stored = scope.data?.current;
    const current =
      stored &&
      ('members' in stored
        ? stored.members.find((m) => m.userId === input.userId)
        : stored);
    const person = businessDisplayName(
      user.display_name,
      user.display_account,
      user.account,
    );
    result.title =
      call.op === 'remove'
        ? '移除项目成员'
        : current
          ? '调整项目成员权限'
          : '添加项目成员';
    result.summary =
      call.op === 'remove'
        ? `将${person}从${project?.name ?? '当前项目'}移除。`
        : `将${person}${current ? '在' : '加入'}${project?.name ?? '当前项目'}，${input.input ? memberRoles(input.input) : '核对所选角色'}。`;
    result.details.push({ label: '成员', value: person });
    result.changes.push({
      label: '项目成员及权限',
      before: current ? memberRoles(current) : '非项目成员',
      after:
        call.op === 'remove'
          ? '移除成员'
          : input.input
            ? memberRoles(input.input)
            : null,
    });
  } else {
    const scope = z
      .record(z.string(), z.unknown())
      .safeParse(call.confirmation?.scope);
    if (scope.success) {
      for (const key of [
        'objectIds',
        'selectedIds',
        'caseIds',
        'selectedCaseIds',
        'runIds',
        'problemIds',
        'items',
      ]) {
        const value = scope.data[key];
        if (Array.isArray(value))
          result.details.push({
            label: '所选对象数量',
            value: String(value.length),
          });
      }
      const names = new Set<string>();
      const collect = (value: unknown, depth: number) => {
        if (depth > 4 || names.size >= 20) return;
        if (Array.isArray(value)) {
          for (const item of value.slice(0, 30)) collect(item, depth + 1);
          return;
        }
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) {
          if (
            ['title', 'name', 'displayName', 'businessNumber'].includes(key) &&
            typeof child === 'string' &&
            child.trim()
          )
            names.add(child.slice(0, 200));
          else if (typeof child === 'object') collect(child, depth + 1);
        }
      };
      collect(scope.data.current ?? scope.data, 0);
      for (const value of names)
        result.details.push({ label: '相关对象', value });
      const requested = z
        .record(z.string(), z.unknown())
        .safeParse(
          scope.data.requested ??
            z.object({ input: z.unknown() }).safeParse(call.input).data?.input,
        );
      const current = z
        .record(z.string(), z.unknown())
        .safeParse(scope.data.current);
      const labels: Record<string, string> = {
        title: '标题',
        status: '状态',
        lifecycle: '生命周期',
        decision: '本次决定',
        finalConclusion: '人工最终结论',
        assessment: '人工判定',
        conclusion: '结论',
        reason: '原因',
        roles: '角色',
        isAdmin: '项目管理员',
      };
      if (requested.success)
        for (const [key, label] of Object.entries(labels)) {
          if (!(key in requested.data)) continue;
          result.changes.push({
            label,
            before: current.success
              ? actionDisplayValue(current.data[key])
              : null,
            after: actionDisplayValue(requested.data[key]),
          });
        }
    }
  }
  return actionIntentPresentationSchema.parse(result);
}

/** A durable proposal and UI event record, never an authentication/approval-role credential. */
export class ActionIntents {
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
    await assertTaskCapability(
      tx,
      actor,
      { taskId: row.task_id, conversationId: row.conversation_id },
      'businessWrite',
    );
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
    const originActor: ActorContext =
      row.origin === 'official-mcp' && row.key_id
        ? {
            userId: actor.userId,
            requestId: actor.requestId,
            entrypoint: 'official-mcp',
            keyId: row.key_id,
          }
        : actor;
    if (originActor !== actor) await currentUser(tx, originActor);
    if (row.project_id)
      await requireProject(
        tx,
        originActor,
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
    await this.assertTaskSources(tx, actor, row);
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
      if (
        actor.entrypoint === 'internal-ai' &&
        context.taskId &&
        context.conversationId
      )
        await assertTaskCapability(
          tx,
          actor,
          { taskId: context.taskId, conversationId: context.conversationId },
          'businessWrite',
        );
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
      const replacement = replacementKey(call);
      if (replacement && context.conversationId)
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `action-intent-target:${actor.userId}:${context.conversationId}:${replacement}`,
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
          `INSERT INTO app.business_confirmations(id,owner_id,project_id,origin,key_id,task_id,conversation_id,tool_name,operation,arguments,scope_digest,proposal,argument_digest,interaction_kind,message_id,presentation,replacement_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
          (SELECT assistant_message_id FROM app.ai_tasks WHERE id=$6 AND owner_id=$2 AND conversation_id=$7),$15,$16) RETURNING *`,
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
            actor.entrypoint === 'internal-ai' ? 'inlineCard' : 'mcpForm',
            JSON.stringify(await presentation(tx, call)),
            replacement,
          ],
        )
      ).rows[0];
      if (!row) throw new Error('Confirmation proposal insert failed');
      await this.assertTaskSources(tx, actor, row);
      if (row.replacement_key && row.conversation_id)
        await tx.query(
          `UPDATE app.business_confirmations SET expires_at=LEAST(expires_at,clock_timestamp())
          WHERE owner_id=$1 AND conversation_id=$2 AND replacement_key=$3 AND id<>$4 AND state='waitingConfirmation'`,
          [row.owner_id, row.conversation_id, row.replacement_key, row.id],
        );
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
  async getConversation(
    actor: ActorContext,
    conversationId: string,
    id: string,
  ) {
    idSchema.parse(conversationId);
    await this.db.transaction((tx) =>
      conversationRow(tx, actor, conversationId),
    );
    const result = await this.get(actor, id);
    if (
      result.intent.conversationId !== conversationId ||
      !result.intent.taskId
    )
      throw new DomainError('NOT_FOUND', '当前对话没有此执行卡。', 404);
    return result;
  }
  async decide(
    actor: ActorContext,
    conversationId: string,
    id: string,
    raw: unknown,
  ) {
    if (actor.entrypoint !== 'web')
      throw new DomainError(
        'FORBIDDEN',
        '只接受当前本人对话界面的按钮事件。',
        403,
      );
    idSchema.parse(conversationId);
    await this.getConversation(actor, conversationId, id);
    return this.resolve(actor, id, raw, 'web-user-event', conversationId);
  }
  async replyInConversation(
    actor: ActorContext,
    conversationId: string,
    raw: unknown,
  ) {
    const input = actionIntentChatReplySchema.parse(raw);
    const reply = parseActionIntentReply(input.text);
    if (!reply)
      throw new DomainError(
        'VALIDATION_ERROR',
        '请在原对话回复“确认”或“取消”。',
        400,
      );
    const { intents } = await this.listConversation(
      actor,
      conversationId,
      !reply.locator,
    );
    const candidates = reply.locator
      ? intents.filter(
          (intent) =>
            intent.id === reply.locator ||
            intent.id.slice(0, 8) === reply.locator,
        )
      : intents;
    if (candidates.length !== 1)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '请用当前对话里的一条确认编号指定提案。',
        422,
      );
    const target = candidates[0]!;
    return this.decide(actor, conversationId, target.id, {
      revision: target.revision,
      scopeDigest: target.scopeDigest,
      decision: reply.decision,
    });
  }

  async getMcp(actor: ActorContext, id: string) {
    if (actor.entrypoint !== 'official-mcp' || !actor.keyId)
      throw new DomainError('FORBIDDEN', '此入口仅接受原 MCP 个人 Key。', 403);
    return this.get(actor, id, 'official-mcp');
  }

  async replyViaMcp(actor: ActorContext, raw: unknown) {
    const input = mcpActionIntentReplySchema.parse(raw);
    const reply = parseActionIntentReply(input.text);
    if (
      !reply ||
      (reply.locator &&
        reply.locator !== input.id &&
        reply.locator !== input.id.slice(0, 8))
    )
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '等待本地对话用户对这份提案的明确确认或取消。',
        422,
      );
    await this.getMcp(actor, input.id);
    return this.resolve(
      actor,
      input.id,
      {
        revision: input.revision,
        scopeDigest: input.scopeDigest,
        decision: reply.decision,
      },
      'mcp-chat-authorization',
      null,
    );
  }
  private async get(
    actor: ActorContext,
    id: string,
    origin?: ConfirmationRow['origin'],
  ) {
    idSchema.parse(id);
    return this.db.transaction(async (tx) => {
      const row = (
        await tx.query<ConfirmationRow>(
          'SELECT * FROM app.business_confirmations WHERE id=$1 AND owner_id=$2',
          [id, actor.userId],
        )
      ).rows[0];
      if (!row || (origin !== undefined && row.origin !== origin))
        throw new DomainError('NOT_FOUND', '没有此账号的确认提案。', 404);
      await this.authorize(tx, actor, row);
      return { intent: safe(row) };
    });
  }
  async listConversation(
    actor: ActorContext,
    conversationId: string,
    pendingOnly = true,
    filter: {
      messageId?: string | undefined;
      taskId?: string | undefined;
    } = {},
  ) {
    if (actor.entrypoint !== 'web')
      throw new DomainError('FORBIDDEN', '会话提案列表仅供本人平台界面。', 403);
    idSchema.parse(conversationId);
    return this.db.transaction(async (tx) => {
      await conversationRow(tx, actor, conversationId);
      const rows = await tx.query<ConfirmationRow>(
        `SELECT c.* FROM app.business_confirmations c WHERE c.owner_id=$1 AND c.origin='internal-ai' AND c.conversation_id=$2
         AND EXISTS(SELECT 1 FROM app.ai_tasks t WHERE t.id=c.task_id AND t.owner_id=$1 AND t.conversation_id=$2)
         AND (NOT $3 OR c.state=ANY($4::text[]))
         AND ($5::uuid IS NULL OR c.message_id=$5) AND ($6::uuid IS NULL OR c.task_id=$6)
         ORDER BY c.created_at,c.id LIMIT 1000`,
        [
          actor.userId,
          conversationId,
          pendingOnly,
          ['waitingConfirmation', 'executing', 'failed', 'unknown'],
          filter.messageId ?? null,
          filter.taskId ?? null,
        ],
      );
      const confirmations = [];
      for (const row of rows.rows) {
        try {
          await this.authorize(tx, actor, row);
        } catch (error) {
          if (
            error instanceof DomainError &&
            ['FORBIDDEN', 'NOT_FOUND', 'PRECONDITIONS_MISSING'].includes(
              error.code,
            )
          )
            continue;
          throw error;
        }
        confirmations.push(safe(row));
      }
      return { intents: confirmations };
    });
  }
  private async resolve(
    actor: ActorContext,
    id: string,
    raw: unknown,
    source: 'web-user-event' | 'mcp-chat-authorization',
    expectedConversationId?: string | null,
  ) {
    idSchema.parse(id);
    const parsed = actionIntentDecisionSchema.parse(raw);
    const input = {
      ...parsed,
      decision:
        parsed.decision === 'execute'
          ? ('accept' as const)
          : ('decline' as const),
    };
    if (
      (source === 'web-user-event' && actor.entrypoint !== 'web') ||
      (source === 'mcp-chat-authorization' &&
        actor.entrypoint !== 'official-mcp')
    )
      throw new DomainError(
        'FORBIDDEN',
        '模型参数或个人Key不构成人工确认事件。',
        403,
      );
    const accepted = await this.db.transaction(async (tx) => {
      // Privacy deletion owns the conversation before its derived confirmations.
      // Acquire that same parent lock before locking a pending confirmation.
      if (actor.entrypoint === 'web') {
        const locator = (
          await tx.query<{ conversation_id: string | null }>(
            'SELECT conversation_id FROM app.business_confirmations WHERE id=$1 AND owner_id=$2',
            [id, actor.userId],
          )
        ).rows[0];
        if (locator?.conversation_id)
          await conversationRow(
            tx,
            actor,
            locator.conversation_id,
            false,
            true,
          );
      }
      const found = (
        await tx.query<ConfirmationRow>(
          'SELECT * FROM app.business_confirmations WHERE id=$1 AND owner_id=$2 FOR UPDATE',
          [id, actor.userId],
        )
      ).rows[0];
      if (!found)
        throw new DomainError('NOT_FOUND', '没有此账号的确认提案。', 404);
      await this.authorize(tx, actor, found);
      if (
        expectedConversationId === null &&
        (found.origin !== 'official-mcp' ||
          found.interaction_kind !== 'mcpForm')
      )
        throw new DomainError('NOT_FOUND', '没有此账号的 MCP 确认提案。', 404);
      if (
        typeof expectedConversationId === 'string' &&
        (found.conversation_id !== expectedConversationId ||
          found.origin !== 'internal-ai' ||
          found.interaction_kind !== 'inlineCard')
      )
        throw new DomainError('NOT_FOUND', '当前对话没有此可执行卡。', 404);
      if (found.proposal_revision !== input.revision)
        throw new DomainError(
          'STALE_BASE_REVISION',
          '执行卡版本已变化，请核对原卡。',
          412,
        );
      if (found.scope_digest !== input.scopeDigest)
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '确认摘要与精确提案不一致。',
          409,
        );
      if (
        found.state === 'waitingConfirmation' &&
        (found.interaction_kind === 'legacy' ||
          found.expires_at.getTime() <= Date.now())
      )
        return { row: found, acceptedNow: false };
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
      const transitioned = (
        await tx.query<ConfirmationRow>(
          'UPDATE app.business_confirmations SET state=$2,resolution_source=$3,resolved_at=clock_timestamp() WHERE id=$1 RETURNING *',
          [id, state, source],
        )
      ).rows[0];
      if (!transitioned)
        throw new DomainError(
          'OPERATION_RESULT_UNKNOWN',
          '执行卡状态回执未取得，请查询原卡。',
          409,
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
        row: transitioned,
        acceptedNow: input.decision === 'accept',
      };
    });
    const row = accepted.row;
    if (
      !accepted.acceptedNow ||
      row.state !== 'executing' ||
      input.decision !== 'accept'
    )
      return { intent: safe(row) };
    // Only this request that changed waiting→executing can dispatch. Concurrent/repeated resolution never replays.
    // Claim is identified by a separate locked transition above; completed/unknown records are always status-only.
    const receipt = await this.db.query<{ dispatch_claim: boolean }>(
      "UPDATE app.business_confirmations SET dispatch_claim=true WHERE id=$1 AND owner_id=$2 AND scope_digest=$3 AND argument_digest=$4 AND state='executing' AND NOT dispatch_claim RETURNING dispatch_claim",
      [id, actor.userId, row.scope_digest, row.argument_digest],
    );
    if (!receipt.rowCount) return this.get(actor, id);
    try {
      let serviceActor: ActorContext;
      if (row.origin === 'internal-ai' && row.task_id) {
        serviceActor = {
          ...actor,
          entrypoint: 'internal-ai',
          requestId: row.task_id,
        };
      } else if (row.origin === 'official-mcp' && row.key_id) {
        // A Web accept is a human event, not a replacement for the original Key.
        // Registry/service authorization rechecks this Key and its current scope.
        serviceActor = {
          ...actor,
          entrypoint: 'official-mcp',
          keyId: row.key_id,
        };
      } else {
        throw new DomainError(
          'STALE_BASE_REVISION',
          '原提案的执行身份不完整，请重新比较；没有执行。',
          412,
        );
      }
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
          const taskId = row.task_id;
          const conversationId = row.conversation_id;
          if (row.origin === 'internal-ai' && taskId && conversationId)
            await this.db.transaction((tx) =>
              assertTaskCapability(
                tx,
                actor,
                { taskId, conversationId },
                'businessWrite',
              ),
            );
          const mode =
            row.origin === 'internal-ai' && row.task_id
              ? (
                  await this.db.query<{ mode: unknown }>(
                    `SELECT m.model_snapshot->>'workspaceAccessMode' mode FROM app.ai_tasks t
                 JOIN app.ai_messages m ON m.id=t.user_message_id
                 WHERE t.id=$1 AND t.owner_id=$2`,
                    [row.task_id, row.owner_id],
                  )
                ).rows[0]?.mode
              : undefined;
          return withWorkspaceModelAccess(
            workspaceAccessModeSchema.optional().parse(mode ?? undefined),
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
