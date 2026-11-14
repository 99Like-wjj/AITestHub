import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { z } from 'zod';
import {
  externalCallInputSchema,
  externalManualCallInputSchema,
  externalDecisionInputSchema,
  externalInvocationSchema,
  externalCatalogSchema,
  externalProjectActionSchema,
  externalApprovedToolSchema,
  type ExternalInvocation,
} from '../../../contracts/src/external-mcp.js';
import {
  frozenConversationReferenceSchema,
  operationTargetSchema,
} from '../../../contracts/src/conversations.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { currentUser, requireProject } from '../access/policy.js';
import { DomainError, forbidden, stale } from '../errors.js';
import { audit } from '../events.js';
import { assertFrozenTaskSources } from '../conversations/task-sources.js';
import { conversationRow } from '../conversations/common.js';
import { ExternalMcpService } from './service.js';
import { ExternalMcpTransportError } from './transport.js';
import {
  boundedExternalJson,
  externalDigest,
  SafeExternalSchemaValidator,
} from './safety.js';
import {
  assertPublicSearchInput,
  publicQueryArguments,
  publicSearchSources,
} from './public-search.js';
import type { PublicSearchBinding } from '../../../contracts/src/public-search.js';

interface InvocationRow extends QueryResultRow {
  id: string;
  actor_id: string;
  connection_id: string;
  service_id: string;
  project_id: string | null;
  operation_target: unknown;
  task_id: string | null;
  conversation_id: string | null;
  command_id: string;
  request_hash: string;
  catalog_id: string;
  config_revision: number;
  credential_version: number;
  destination_name: string;
  endpoint: string;
  tool_name: string;
  tool_digest: string;
  project_action: string | null;
  arguments: Record<string, unknown> | null;
  purpose: string;
  source_refs: unknown;
  scope_digest: string;
  state: ExternalInvocation['state'];
  result: unknown;
  error_code: string | null;
  decided_at: Date | null;
  dispatch_claim: string | null;
  dispatch_deadline: Date | null;
  tool_sends: number;
  created_at: Date;
  updated_at: Date;
}
export class ExternalMcpInvocations {
  private readonly active = new Map<string, AbortController>();
  private readonly jobs = new Set<Promise<void>>();
  constructor(
    readonly db: Database,
    readonly services: ExternalMcpService,
  ) {}
  private async row(
    tx: SqlExecutor,
    actor: ActorContext,
    id: string,
    lock = false,
  ) {
    const row = (
      await tx.query<InvocationRow>(
        `SELECT * FROM app.external_mcp_invocations WHERE id=$1 AND actor_id=$2${lock ? ' FOR UPDATE' : ''}`,
        [id, actor.userId],
      )
    ).rows[0];
    if (!row) throw new DomainError('NOT_FOUND', '没有本人的该外部调用。', 404);
    return row;
  }
  private dto(
    row: InvocationRow,
    content = true,
    search?: PublicSearchBinding,
  ) {
    return externalInvocationSchema.parse({
      id: row.id,
      connectionId: row.connection_id,
      serviceId: row.service_id,
      projectId: row.project_id,
      operationTarget: row.operation_target,
      taskId: row.task_id,
      conversationId: row.conversation_id,
      destinationName: row.destination_name,
      endpoint: row.endpoint,
      toolName: row.tool_name,
      arguments: content ? row.arguments : null,
      purpose: content ? row.purpose : '原资料当前不可访问',
      scopeDigest: row.scope_digest,
      state: row.state,
      result: content ? row.result : null,
      errorCode: row.error_code,
      toolSends: row.tool_sends,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      decidedAt: row.decided_at?.toISOString() ?? null,
      ...(search
        ? {
            isPublicSearch: true,
            ...(content && row.arguments
              ? { publicQuery: publicQueryArguments(search, row.arguments) }
              : {}),
          }
        : {}),
    });
  }
  private async definition(tx: SqlExecutor, row: InvocationRow) {
    const snapshot = (
      await tx.query<{ tools: unknown }>(
        "SELECT snapshot->'tools' tools FROM app.external_mcp_service_revisions WHERE service_id=$1 AND revision=$2",
        [row.service_id, row.config_revision],
      )
    ).rows[0];
    return snapshot
      ? z
          .array(externalApprovedToolSchema)
          .parse(snapshot.tools)
          .find((tool) => tool.name === row.tool_name)
      : undefined;
  }
  private async visible(
    tx: SqlExecutor,
    actor: ActorContext,
    row: InvocationRow,
  ) {
    const content = await this.currentContent(tx, actor, row),
      definition = await this.definition(tx, row);
    return this.dto(row, content, definition?.publicSearch);
  }
  private async taskContext(
    tx: SqlExecutor,
    actor: ActorContext,
    taskId: string,
    allowFinished = true,
  ) {
    const locator = (
      await tx.query<{ conversation_id: string }>(
        'SELECT conversation_id FROM app.ai_tasks WHERE id=$1 AND owner_id=$2',
        [taskId, actor.userId],
      )
    ).rows[0];
    if (!locator)
      throw new DomainError('NOT_FOUND', '原外部调用任务不可访问。', 404);
    await conversationRow(tx, actor, locator.conversation_id, false, true);
    const task = (
      await tx.query<{
        conversation_id: string;
        operation_target: unknown;
        explicit_refs: unknown;
        model_snapshot: unknown;
        message_id: string;
        status: string;
        cancel_requested_at: Date | null;
      }>(
        `SELECT t.conversation_id,t.operation_target,t.state status,t.cancel_requested_at,m.explicit_refs,m.model_snapshot,m.id message_id FROM app.ai_tasks t JOIN app.ai_messages m ON m.id=t.assistant_message_id WHERE t.id=$1 AND t.owner_id=$2 AND m.deleted_at IS NULL FOR SHARE OF t,m`,
        [taskId, actor.userId],
      )
    ).rows[0];
    if (
      !task ||
      task.cancel_requested_at ||
      ['cancelled', 'cancelling'].includes(task.status) ||
      (!allowFinished && task.status !== 'running')
    )
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '原任务已取消、删除或不可访问，未发送外部工具。',
        422,
      );
    await conversationRow(tx, actor, task.conversation_id, false, true);
    const target =
      task.operation_target === null
        ? null
        : operationTargetSchema.parse(task.operation_target);
    const captured = z
      .object({ provenanceCaptured: z.literal(true) })
      .safeParse(task.model_snapshot).success;
    const references = z
      .array(frozenConversationReferenceSchema)
      .parse(task.explicit_refs);
    const sourceRefs = captured
      ? references
      : [
          {
            reference: {
              kind: 'conversation' as const,
              conversationId: task.conversation_id,
              mode: 'full' as const,
              dataScope: 'syntheticPublicOnly' as const,
            },
            messageIds: [task.message_id],
          },
        ];
    return { task, sourceRefs, target };
  }
  private async assertSources(
    tx: SqlExecutor,
    actor: ActorContext,
    row: Pick<
      InvocationRow,
      | 'task_id'
      | 'conversation_id'
      | 'source_refs'
      | 'project_id'
      | 'project_action'
      | 'operation_target'
    >,
  ) {
    if (row.project_id)
      await requireProject(
        tx,
        actor,
        row.project_id,
        row.project_action
          ? externalProjectActionSchema.parse(row.project_action)
          : 'project.read',
      );
    if (row.task_id) {
      const context = await this.taskContext(tx, actor, row.task_id);
      if (
        context.task.conversation_id !== row.conversation_id ||
        (context.target?.projectId ?? null) !== row.project_id ||
        externalDigest(context.target) !== externalDigest(row.operation_target)
      )
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '原任务固定目标已不一致，未发送。',
          409,
        );
    }
    await assertFrozenTaskSources(tx, actor, row.source_refs);
  }
  private async guard(
    tx: SqlExecutor,
    actor: ActorContext,
    row: InvocationRow,
    forDispatch = true,
  ) {
    await currentUser(tx, actor);
    const selected = await this.services.authorizedConnection(
      tx,
      actor,
      row.connection_id,
      {
        connectionId: row.connection_id,
        configRevision: row.config_revision,
        credentialVersion: row.credential_version,
      },
    );
    if (selected.connection.status !== 'ready')
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '本人当前外部连接未通过检查或已被对方拒绝，不能沿用旧输出或发送。',
        422,
      );
    const definition = selected.tools.find(
      (tool) => tool.name === row.tool_name,
    );
    if (
      !definition ||
      definition.projectAction !== row.project_action ||
      externalDigest({
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
        ...(definition.outputSchema
          ? { outputSchema: definition.outputSchema }
          : {}),
        metadata: definition.metadata,
      }) !== row.tool_digest
    )
      stale();
    await this.assertSources(tx, actor, row);
    if (row.arguments === null)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '原调用内容已删除，不会重新发送。',
        422,
      );
    if (forDispatch)
      await assertPublicSearchInput(tx, actor, definition, row.arguments, {
        projectId: row.project_id,
        sourceRefs: row.source_refs,
      });
    return selected;
  }
  private async event(
    tx: SqlExecutor,
    actor: ActorContext,
    row: InvocationRow,
    code: string | null = null,
  ) {
    await tx.query(
      'INSERT INTO app.external_mcp_invocation_events(invocation_id,state,code,tool_sends,actor_id) VALUES($1,$2,$3,$4,$5)',
      [row.id, row.state, code, row.tool_sends, actor.userId],
    );
  }
  private async prepare(
    actor: ActorContext,
    raw: unknown,
    context:
      | { taskId: string }
      | {
          projectId: string | null;
          expectedSnapshot: {
            configRevision: number;
            credentialVersion: number;
            catalogDigest: string;
          };
        },
  ) {
    if (actor.entrypoint === 'official-mcp') forbidden();
    const input = externalCallInputSchema.parse(raw);
    boundedExternalJson(input, 64 * 1024);
    return this.db.transaction(async (tx) => {
      await currentUser(tx, actor);
      const task =
        'taskId' in context
          ? await this.taskContext(tx, actor, context.taskId, false)
          : null;
      const projectId =
          task?.target?.projectId ??
          ('projectId' in context ? context.projectId : null),
        taskId = 'taskId' in context ? context.taskId : null,
        conversationId = task?.task.conversation_id ?? null;
      const hash = externalDigest({
        ...input,
        projectId,
        taskId,
        conversationId,
        ...('expectedSnapshot' in context
          ? { expectedSnapshot: context.expectedSnapshot }
          : {}),
      });
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `external-invocation:${actor.userId}:${input.commandId}`,
      ]);
      const prior = (
        await tx.query<InvocationRow>(
          'SELECT * FROM app.external_mcp_invocations WHERE actor_id=$1 AND command_id=$2',
          [actor.userId, input.commandId],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== hash)
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            '同一外部调用标识已用于不同内容。',
            409,
          );
        return prior;
      }
      const fence = (
        await tx.query<{ request_hash: string }>(
          'SELECT request_hash FROM app.external_mcp_dispatch_fences WHERE actor_id=$1 AND command_id=$2',
          [actor.userId, input.commandId],
        )
      ).rows[0];
      if (fence)
        throw new DomainError(
          fence.request_hash === hash
            ? 'OPERATION_RESULT_UNKNOWN'
            : 'IDEMPOTENCY_CONFLICT',
          '原外部调用已有发送记录，恢复缺失回执时也不会重新发送。',
          409,
        );
      const selected = await this.services.authorizedConnection(
        tx,
        actor,
        input.connectionId,
      );
      if (
        'expectedSnapshot' in context &&
        (context.expectedSnapshot.configRevision !==
          selected.service.config_revision ||
          context.expectedSnapshot.credentialVersion !==
            selected.connection.credential_version)
      )
        stale();
      const catalogRow = (
        await tx.query<{
          tools: unknown;
          config_revision: number;
          credential_version: number;
          id: string;
          catalog_digest: string;
          observed_at: Date;
        }>(
          'SELECT * FROM app.external_mcp_catalogs WHERE id=$1 AND connection_id=$2',
          [selected.connection.current_catalog_id, input.connectionId],
        )
      ).rows[0];
      if (
        !catalogRow ||
        selected.connection.status !== 'ready' ||
        catalogRow.config_revision !== selected.service.config_revision ||
        catalogRow.credential_version !== selected.connection.credential_version
      )
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '本人当前连接尚未检查或已变化，请先检查连接。',
          422,
        );
      if (
        'expectedSnapshot' in context &&
        context.expectedSnapshot.catalogDigest !== catalogRow.catalog_digest
      )
        stale();
      const catalog = externalCatalogSchema.parse({
        catalogId: catalogRow.id,
        connectionId: input.connectionId,
        configRevision: catalogRow.config_revision,
        credentialVersion: catalogRow.credential_version,
        catalogDigest: catalogRow.catalog_digest,
        tools: catalogRow.tools,
        observedAt: catalogRow.observed_at.toISOString(),
      });
      const tool = selected.tools.find((item) => item.name === input.toolName),
        observed = catalog.tools.find(
          (item) => item.name === input.toolName && item.approved,
        );
      if (!tool || !observed)
        throw new DomainError(
          'FORBIDDEN',
          '该工具不在管理员当前批准且远端已核对的上限内。',
          403,
        );
      const checked = new SafeExternalSchemaValidator().getValidator(
        tool.inputSchema,
      )(input.arguments);
      if (!checked.valid)
        throw new DomainError(
          'VALIDATION_ERROR',
          '实际外发参数不符合已批准工具Schema。',
          400,
        );
      if (tool.effect === 'write' && !projectId)
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '外部业务写须有本条消息明确固定的项目目标。',
          422,
        );
      if (task) {
        const chosen = task.sourceRefs.some((source) => {
          const ref = source.reference as {
            kind: string;
            connectionId?: string;
          };
          return (
            ref.kind === 'externalMcpConnection' &&
            ref.connectionId === input.connectionId
          );
        });
        if (!chosen)
          throw new DomainError(
            'FORBIDDEN',
            '外部连接必须是本条消息明确选择且当前有权的连接。',
            403,
          );
        if (tool.effect === 'write' && task.target?.objectIds?.length) {
          const ids: string[] = [];
          const walk = (item: unknown): void => {
            if (typeof item === 'string' && z.uuid().safeParse(item).success)
              ids.push(item);
            else if (Array.isArray(item)) item.forEach(walk);
            else if (item && typeof item === 'object')
              Object.values(item).forEach(walk);
          };
          walk(input.arguments);
          const allowed = new Set([projectId, ...task.target.objectIds]);
          if (!ids.length || ids.some((id) => !allowed.has(id)))
            throw new DomainError(
              'BUSINESS_CONFLICT',
              '外部写参数超出本条消息固定的对象范围。',
              409,
            );
        }
      }
      await this.services.assertDataSafe(tx, actor, input.connectionId, input);
      const sourceRefs = task?.sourceRefs ?? [];
      const sourceContext = {
        task_id: taskId,
        conversation_id: conversationId,
        project_id: projectId,
        project_action: tool.projectAction,
        operation_target: task?.target ?? (projectId ? { projectId } : null),
        source_refs: sourceRefs,
      };
      await this.assertSources(tx, actor, sourceContext);
      await assertPublicSearchInput(tx, actor, tool, input.arguments, {
        projectId,
        sourceRefs,
      });
      const scopeDigest = externalDigest({
        endpoint: selected.service.endpoint,
        toolName: input.toolName,
        arguments: input.arguments,
        purpose: input.purpose,
        projectId,
        operationTarget: sourceContext.operation_target,
        taskId,
        sourceRefs,
        catalogId: catalog.catalogId,
        toolDigest: observed.schemaDigest,
        configRevision: selected.service.config_revision,
        credentialVersion: selected.connection.credential_version,
        projectAction: tool.projectAction,
      });
      const id = randomUUID();
      await tx.query(
        `INSERT INTO app.external_mcp_invocations(id,actor_id,connection_id,service_id,project_id,operation_target,task_id,conversation_id,command_id,request_hash,catalog_id,config_revision,credential_version,destination_name,endpoint,tool_name,tool_digest,project_action,arguments,purpose,source_refs,scope_digest,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'waitingConsent')`,
        [
          id,
          actor.userId,
          input.connectionId,
          selected.service.id,
          projectId,
          sourceContext.operation_target
            ? JSON.stringify(sourceContext.operation_target)
            : null,
          taskId,
          conversationId,
          input.commandId,
          hash,
          catalog.catalogId,
          selected.service.config_revision,
          selected.connection.credential_version,
          selected.service.name,
          selected.service.endpoint,
          input.toolName,
          observed.schemaDigest,
          tool.projectAction,
          JSON.stringify(input.arguments),
          input.purpose,
          JSON.stringify(sourceRefs),
          scopeDigest,
        ],
      );
      const row = await this.row(tx, actor, id);
      await this.event(tx, actor, row);
      return row;
    });
  }
  async propose(actor: ActorContext, raw: unknown, taskId: string) {
    if (actor.entrypoint !== 'internal-ai') forbidden();
    const row = await this.prepare(actor, raw, { taskId });
    return this.get(actor, row.id);
  }
  async manual(actor: ActorContext, raw: unknown) {
    if (actor.entrypoint !== 'web') forbidden();
    const input = externalManualCallInputSchema.parse(raw);
    const { projectId, expectedSnapshot, publicQueryConfirmed, ...call } =
      input;
    const row = await this.prepare(actor, call, {
      projectId,
      expectedSnapshot,
    });
    return this.resolve(actor, row.id, {
      scopeDigest: row.scope_digest,
      decision: 'accept',
      ...(publicQueryConfirmed !== undefined ? { publicQueryConfirmed } : {}),
    });
  }
  async resolve(actor: ActorContext, id: string, raw: unknown) {
    if (actor.entrypoint !== 'web') forbidden();
    const input = externalDecisionInputSchema.parse(raw);
    const result = await this.db.transaction(async (tx) => {
      await currentUser(tx, actor);
      let row = await this.row(tx, actor, id);
      if (row.scope_digest !== input.scopeDigest)
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '外发提案摘要已变化，请重新核对精确内容。',
          409,
        );
      if (row.state !== 'waitingConsent') return { row, launch: false };
      let publicQuery = false;
      if (input.decision === 'accept') {
        const selected = await this.guard(tx, actor, row);
        publicQuery = Boolean(
          selected.tools.find((tool) => tool.name === row.tool_name)
            ?.publicSearch,
        );
        if (publicQuery && input.publicQueryConfirmed !== true)
          throw new DomainError(
            'VALIDATION_ERROR',
            '请本人核对实际搜索词并确认仅含通用公开信息；模型标记不能代替该Web决定。',
            400,
          );
      }
      row = await this.row(tx, actor, id, true);
      if (row.state !== 'waitingConsent') return { row, launch: false };
      if (input.decision === 'decline') {
        await tx.query(
          "UPDATE app.external_mcp_invocations SET state='declined',decided_by=$2,decided_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1",
          [id, actor.userId],
        );
        row = await this.row(tx, actor, id);
        await this.event(tx, actor, row);
        return { row, launch: false };
      }
      if (
        (
          await tx.query(
            'SELECT 1 FROM app.external_mcp_dispatch_fences WHERE actor_id=$1 AND command_id=$2',
            [actor.userId, row.command_id],
          )
        ).rowCount
      ) {
        await tx.query(
          "UPDATE app.external_mcp_invocations SET state='unknown',error_code='RESTORED_DISPATCH_FENCE',updated_at=clock_timestamp() WHERE id=$1",
          [id],
        );
        row = await this.row(tx, actor, id);
        await this.event(tx, actor, row, 'RESTORED_DISPATCH_FENCE');
        return { row, launch: false };
      }
      const claim = randomUUID();
      await tx.query(
        'INSERT INTO app.external_mcp_dispatch_fences(actor_id,command_id,invocation_id,request_hash) VALUES($1,$2,$3,$4)',
        [actor.userId, row.command_id, id, row.request_hash],
      );
      await tx.query(
        "UPDATE app.external_mcp_invocations SET state='dispatching',decided_by=$2,decided_at=clock_timestamp(),dispatch_claim=$3,dispatch_deadline=clock_timestamp()+interval '45 seconds',updated_at=clock_timestamp() WHERE id=$1",
        [id, actor.userId, claim],
      );
      tx.noteSecurityControlChange?.({
        action: 'external-mcp.dispatch-fenced',
        objectId: id,
        projectId: row.project_id,
      });
      row = await this.row(tx, actor, id);
      await this.event(tx, actor, row);
      if (publicQuery)
        await audit(
          tx,
          actor,
          'external-mcp.public-query-confirmed',
          row.id,
          row.project_id,
          {
            scopeDigest: row.scope_digest,
            queryDigest: externalDigest(row.arguments),
            publicQueryConfirmed: true,
          },
        );
      await audit(
        tx,
        actor,
        'external-mcp.human-accepted',
        id,
        row.project_id,
        {
          scopeDigest: row.scope_digest,
          connectionId: row.connection_id,
          toolName: row.tool_name,
        },
      );
      return { row, launch: true };
    });
    if (result.launch) {
      const job = this.dispatch(actor, result.row).catch(() => {});
      this.jobs.add(job);
      void job.finally(() => this.jobs.delete(job));
    }
    return this.get(actor, result.row.id);
  }
  private async dispatch(actor: ActorContext, original: InvocationRow) {
    const controller = new AbortController();
    this.active.set(original.id, controller);
    let polling = false;
    const current = async (tx: SqlExecutor) => {
      const row = await this.row(tx, actor, original.id);
      if (
        row.state !== 'dispatching' ||
        row.dispatch_claim !== original.dispatch_claim
      )
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '原调用已取消或失去唯一发送资格。',
          409,
        );
      await this.guard(tx, actor, row);
      return row;
    };
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void this.db
        .transaction(current)
        .catch(() => controller.abort())
        .finally(() => {
          polling = false;
        });
    }, 500);
    timer.unref();
    try {
      const definition = await this.db.transaction(async (tx) => {
        await current(tx);
        const tool = await this.definition(tx, original);
        if (!tool)
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '原服务配置修订缺失，未发送。',
            422,
          );
        return tool;
      });
      const result = await this.services.withSession(
        actor,
        original.connection_id,
        {
          connectionId: original.connection_id,
          configRevision: original.config_revision,
          credentialVersion: original.credential_version,
        },
        async (session) => {
          const catalog = (
            await this.db.query<{ catalog_digest: string }>(
              'SELECT catalog_digest FROM app.external_mcp_catalogs WHERE id=$1 AND connection_id=$2',
              [original.catalog_id, original.connection_id],
            )
          ).rows[0];
          if (
            !catalog ||
            externalDigest(session.tools) !== catalog.catalog_digest
          ) {
            await this.services.invalidateCatalog(
              actor,
              original.connection_id,
              {
                connectionId: original.connection_id,
                configRevision: original.config_revision,
                credentialVersion: original.credential_version,
              },
              externalDigest(session.tools),
            );
            throw new DomainError(
              'STALE_BASE_REVISION',
              '远端工具目录已变化，需本人重新检查并由管理员审查差异；未发送工具调用。',
              412,
            );
          }
          const actual = session.tools.find(
            (tool) => tool.name === original.tool_name,
          );
          if (!actual || externalDigest(actual) !== original.tool_digest)
            throw new DomainError(
              'STALE_BASE_REVISION',
              '远端当前工具定义已变化，未发送工具调用。',
              412,
            );
          if (original.arguments === null)
            throw new DomainError(
              'PRECONDITIONS_MISSING',
              '原外发内容已删除。',
              422,
            );
          const response = await session.call(
            original.tool_name,
            original.arguments,
          );
          await this.db.transaction((tx) =>
            this.services.assertDataSafe(
              tx,
              actor,
              original.connection_id,
              response,
              1024 * 1024,
            ),
          );
          return definition.publicSearch
            ? {
                publicSearch: publicSearchSources(
                  original.id,
                  publicQueryArguments(
                    definition.publicSearch,
                    original.arguments,
                  ),
                  definition.publicSearch,
                  response,
                ),
              }
            : response;
        },
        {
          signal: controller.signal,
          beforeToolDispatch: async () => {
            await this.db.transaction(async (tx) => {
              const row = await current(tx);
              const changed = await tx.query(
                "UPDATE app.external_mcp_invocations SET tool_sends=1,updated_at=clock_timestamp() WHERE id=$1 AND dispatch_claim=$2 AND state='dispatching' AND tool_sends=0 RETURNING id",
                [row.id, row.dispatch_claim],
              );
              if (!changed.rowCount)
                throw new DomainError(
                  'OPERATION_RESULT_UNKNOWN',
                  '该外部调用已有发送意图，不会重发。',
                  409,
                );
            });
          },
        },
      );
      await this.db.transaction(async (tx) => {
        let row = await this.row(tx, actor, original.id);
        if (
          row.state !== 'dispatching' ||
          row.dispatch_claim !== original.dispatch_claim
        )
          return;
        await this.guard(tx, actor, row, false);
        row = await this.row(tx, actor, original.id, true);
        if (
          row.state !== 'dispatching' ||
          row.dispatch_claim !== original.dispatch_claim
        )
          return;
        await tx.query(
          "UPDATE app.external_mcp_invocations SET state='completed',result=$2,error_code=NULL,updated_at=clock_timestamp() WHERE id=$1",
          [row.id, JSON.stringify(result)],
        );
        await this.event(tx, actor, await this.row(tx, actor, row.id));
      });
    } catch (error) {
      await this.db
        .transaction(async (tx) => {
          const row = await this.row(tx, actor, original.id, true);
          if (
            row.state !== 'dispatching' ||
            row.dispatch_claim !== original.dispatch_claim
          )
            return;
          const code =
            error instanceof ExternalMcpTransportError
              ? error.code
              : error instanceof DomainError
                ? error.code
                : 'EXTERNAL_UNAVAILABLE';
          await tx.query(
            "UPDATE app.external_mcp_invocations SET state=CASE WHEN tool_sends=0 THEN 'failed' ELSE 'unknown' END,error_code=$2,result=NULL,updated_at=clock_timestamp() WHERE id=$1",
            [row.id, code],
          );
          await this.event(tx, actor, await this.row(tx, actor, row.id), code);
        })
        .catch(() => {});
    } finally {
      clearInterval(timer);
      this.active.delete(original.id);
    }
  }
  private async currentContent(
    tx: SqlExecutor,
    actor: ActorContext,
    row: InvocationRow,
  ) {
    try {
      await this.guard(tx, actor, row, false);
      return true;
    } catch (error) {
      if (error instanceof DomainError || error instanceof z.ZodError)
        return false;
      throw error;
    }
  }
  async get(actor: ActorContext, id: string) {
    if (actor.entrypoint === 'official-mcp') forbidden();
    await this.expire(actor, id);
    return this.db.transaction(async (tx) => {
      await currentUser(tx, actor);
      const row = await this.row(tx, actor, id);
      return {
        invocation: await this.visible(tx, actor, row),
      };
    });
  }
  async byCommand(actor: ActorContext, commandId: string) {
    if (actor.entrypoint === 'official-mcp') forbidden();
    const id = await this.db.transaction(async (tx) => {
      await currentUser(tx, actor);
      const row = (
        await tx.query<{ id: string }>(
          'SELECT id FROM app.external_mcp_invocations WHERE actor_id=$1 AND command_id=$2',
          [actor.userId, commandId],
        )
      ).rows[0];
      if (
        !row &&
        (
          await tx.query(
            'SELECT 1 FROM app.external_mcp_dispatch_fences WHERE actor_id=$1 AND command_id=$2',
            [actor.userId, commandId],
          )
        ).rowCount
      )
        throw new DomainError(
          'OPERATION_RESULT_UNKNOWN',
          '原调用有发送保护记录，但原回执未恢复；未知状态不能重发。',
          409,
        );
      if (!row)
        throw new DomainError(
          'NOT_FOUND',
          '暂未取得本人该原调用回执；没有重发。',
          404,
        );
      return row.id;
    });
    return this.get(actor, id);
  }
  async list(actor: ActorContext, taskId?: string) {
    if (actor.entrypoint === 'official-mcp') forbidden();
    await this.expire(actor);
    return this.db.transaction(async (tx) => {
      await currentUser(tx, actor);
      const rows = await tx.query<InvocationRow>(
        'SELECT * FROM app.external_mcp_invocations WHERE actor_id=$1 AND ($2::uuid IS NULL OR task_id=$2) ORDER BY created_at DESC,id DESC LIMIT 100',
        [actor.userId, taskId ?? null],
      );
      const invocations = [];
      for (const row of rows.rows)
        invocations.push(await this.visible(tx, actor, row));
      return { invocations };
    });
  }
  async cancel(actor: ActorContext, id: string) {
    if (actor.entrypoint !== 'web') forbidden();
    await this.db.transaction(async (tx) => {
      await currentUser(tx, actor);
      let row = await this.row(tx, actor, id, true);
      if (['waitingConsent', 'dispatching'].includes(row.state)) {
        await tx.query(
          "UPDATE app.external_mcp_invocations SET state=CASE WHEN tool_sends=0 THEN 'cancelled' ELSE 'unknown' END,error_code=CASE WHEN tool_sends=0 THEN 'CANCELLED_BEFORE_TOOL_SEND' ELSE 'CANCELLED_AFTER_SEND_INTENT' END,updated_at=clock_timestamp() WHERE id=$1",
          [id],
        );
        row = await this.row(tx, actor, id);
        await this.event(tx, actor, row, row.error_code);
      }
    });
    this.active.get(id)?.abort();
    return this.get(actor, id);
  }
  private async expire(actor: ActorContext, id?: string) {
    const expired = await this.db.transaction(async (tx) => {
      await currentUser(tx, actor);
      const rows = await tx.query<InvocationRow>(
        "UPDATE app.external_mcp_invocations SET state='unknown',error_code='DISPATCH_EXPIRED',updated_at=clock_timestamp() WHERE actor_id=$1 AND ($2::uuid IS NULL OR id=$2) AND state='dispatching' AND dispatch_deadline<clock_timestamp() RETURNING *",
        [actor.userId, id ?? null],
      );
      for (const row of rows.rows)
        await this.event(tx, actor, row, 'DISPATCH_EXPIRED');
      return rows.rows.map((row) => row.id);
    });
    for (const id of expired) this.active.get(id)?.abort();
  }
  async close() {
    for (const controller of this.active.values()) controller.abort();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...this.jobs]),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 5000);
        timeout.unref();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
  }
}
