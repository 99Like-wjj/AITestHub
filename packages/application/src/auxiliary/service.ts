import { finishAutomaticAuxiliaryTask } from './automatic-common.js';
import {
  auxiliaryModelSnapshot,
  auxiliarySnapshotRevision,
  resolveNewAuxiliarySelection,
} from './model-snapshot.js';
import { humanConfirmationExecutionInTransaction } from '../tool-registry/human-confirmation.js';
import { fullRequirementFindInputSchema } from '../../../contracts/src/automatic-auxiliary.js';
import { taskSourceProjectIds } from '../conversations/source-projects.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ActorContext } from '../../../contracts/src/identity.js';
import {
  auxiliaryRequestInputSchema,
  auxiliarySourceInputSchema,
  auxiliaryPreflightInputSchema,
  auxiliaryPreflightReceiptSchema,
  auxiliaryModelSnapshotSchema,
  auxiliaryTaskReceiptSchema,
  cancelAuxiliaryInputSchema,
  type AuxiliaryRequestInput,
} from '../../../contracts/src/auxiliary.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import type { ConfigurationService } from '../configuration/service.js';
import type { SecretBroker } from '../configuration/secrets.js';
import { canonicalJson } from '../operations/service.js';
import type { PersonalFileReader } from '../conversations/references.js';
import { OperationService } from '../operations/service.js';
import { currentUser } from '../access/policy.js';
import { DomainError } from '../errors.js';
import { rejectMissingAcceptedReceipt } from '../recovery/receipts.js';
import { assertSafeModelInput } from '../security/model-input.js';
import { audit } from '../events.js';
import {
  authorizeAuxiliarySource,
  freezeAuxiliarySource,
  hydrateAuxiliarySource,
  assertAuxiliaryMaterialAccess,
  auxiliarySourceSnapshotSchema,
} from './sources.js';
import {
  auxiliaryResultSchema,
  auxiliaryErrorDetailsSchema,
} from '../../../contracts/src/auxiliary.js';
import { conversationRow } from '../conversations/common.js';
import { assertNewWorkAllowed } from '../recovery/maintenance.js';
import {
  enqueueConversationTitle,
  isAutomaticConversationTitle,
  assertConversationTitleSource,
  resolveAuxiliaryModelForTask,
} from './conversation-title.js';
import {
  captureTaskSources,
  assertFrozenTaskSources,
} from '../conversations/task-sources.js';
export { auxiliaryModelSnapshot } from './model-snapshot.js';

export interface AuxiliaryTaskRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  conversation_id: string | null;
  purpose: string;
  command_id: string;
  origin: 'web' | 'internal-ai' | 'official-mcp';
  origin_key_id: string | null;
  parent_task_id: string | null;
  request: unknown;
  source_snapshot: unknown;
  model_snapshot: unknown;
  state: string;
  execution_origin: 'fixture' | 'liveProvider' | 'legacyUnknown';
  worker_id: string | null;
  lease_expires_at: Date | null;
  call_id: string | null;
  result: unknown;
  error_code: string | null;
  error_details: unknown;
  cancel_requested_at: Date | null;
  created_at: Date;
  started_at?: Date | null;
  finished_at: Date | null;
}
export class AuxiliaryService {
  readonly operations: OperationService;
  constructor(
    readonly db: Database,
    readonly configuration: ConfigurationService,
    private readonly broker: SecretBroker,
    private readonly fileReader?: PersonalFileReader,
  ) {
    this.operations = new OperationService(db);
  }
  private digest(value: unknown) {
    return createHash('sha256').update(canonicalJson(value)).digest('hex');
  }
  private sourceInput(input: AuxiliaryRequestInput) {
    const {
      commandId: _,
      dataScope: __,
      disclosureId: ___,
      disclosureDigest: ____,
      dataConsent: _____,
      ...source
    } = input;
    return auxiliarySourceInputSchema.parse(source);
  }
  private async assertParentProject(
    tx: SqlExecutor,
    actor: ActorContext,
    input: z.infer<typeof auxiliarySourceInputSchema>,
    parentTaskId?: string,
  ) {
    if (!parentTaskId || !('projectId' in input) || !input.projectId) return;
    const parent = (
      await tx.query<{ data_scope: string }>(
        'SELECT data_scope FROM app.ai_tasks WHERE id=$1 AND owner_id=$2',
        [parentTaskId, actor.userId],
      )
    ).rows[0];
    if (!parent)
      throw new DomainError('PRECONDITIONS_MISSING', '原AI任务已不可用。', 422);
    if (
      parent.data_scope === 'syntheticPublicOnly' &&
      !(await taskSourceProjectIds(tx, actor, parentTaskId)).includes(
        input.projectId,
      )
    )
      throw new DomainError(
        'FORBIDDEN',
        '该项目不在原对话明确许可的资料范围；不能借辅助分析扩大外发来源。',
        403,
      );
  }
  private async prepare(
    actor: ActorContext,
    input: z.infer<typeof auxiliarySourceInputSchema>,
  ) {
    const source = await this.db.transaction(async (tx) => {
      await currentUser(tx, actor);
      if (actor.entrypoint === 'internal-ai')
        await this.assertParentProject(tx, actor, input, actor.requestId);
      const result = await freezeAuxiliarySource(tx, actor, input);
      await assertAuxiliaryMaterialAccess(tx, actor, input, result);
      return result;
    });
    const baseDigest = this.digest(source);
    await hydrateAuxiliarySource(actor, input, source, this.fileReader);
    return { source, baseDigest, sourceDigest: this.digest(source) };
  }
  async preflight(actor: ActorContext, raw: unknown, business = false) {
    assertSafeModelInput(raw);
    const { source: input } = auxiliaryPreflightInputSchema.parse(raw);
    await this.db.transaction(async (tx) => {
      if (business) await this.business(tx, actor);
      else await this.personal(tx, actor);
    });
    if (business && input.purpose === 'alias')
      throw new DomainError('FORBIDDEN', '个人精简名不开放项目工具。', 403);
    const prepared = await this.prepare(actor, input);
    return this.db.transaction(async (tx) => {
      if (business) await this.business(tx, actor);
      else await this.personal(tx, actor);
      const ready = (
        await tx.query<{ ready: boolean }>(
          "SELECT to_regclass('app.auxiliary_disclosures') IS NOT NULL ready",
        )
      ).rows[0]?.ready;
      if (!ready)
        throw new DomainError(
          'DEPENDENCY_UNAVAILABLE',
          '辅助资料确认迁移尚未部署；不会发送模型。',
          503,
        );
      if (actor.entrypoint === 'internal-ai')
        await this.assertParentProject(tx, actor, input, actor.requestId);
      const current = await freezeAuxiliarySource(tx, actor, input);
      await assertAuxiliaryMaterialAccess(tx, actor, input, current);
      if (this.digest(current) !== prepared.baseDigest)
        throw new DomainError(
          'STALE_BASE_REVISION',
          '辅助资料已变化，请重新查看发送范围。',
          412,
        );
      const selected = await resolveNewAuxiliarySelection(
          this.configuration,
          tx,
          actor,
        ),
        model = auxiliaryModelSnapshot(selected);
      await this.credentialAbsent(selected, prepared.source, tx);
      const id = randomUUID(),
        expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        allowedDataScopes = selected.allowedDataScopes;
      const scopeDigest = this.digest({
        sourceDigest: prepared.sourceDigest,
        model,
        allowedDataScopes,
      });
      await tx.query(
        `INSERT INTO app.auxiliary_disclosures(id,owner_id,purpose,request_hash,scope_digest,source_digest,model_snapshot,source_meta,allowed_data_scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          actor.userId,
          input.purpose,
          this.digest(input),
          scopeDigest,
          prepared.sourceDigest,
          JSON.stringify(model),
          JSON.stringify(prepared.source.meta),
          allowedDataScopes,
          expiresAt,
        ],
      );
      return auxiliaryPreflightReceiptSchema.parse({
        disclosure: {
          id,
          scopeDigest,
          sourceDigest: prepared.sourceDigest,
          expiresAt,
          source: prepared.source.meta,
          model,
          allowedDataScopes,
          payloadPreview: JSON.stringify(prepared.source.payload, null, 2),
          payloadSummary: `发送当前${input.purpose === 'requirementLookup' ? '需求草稿及' + prepared.source.candidateIds.length + '条项目候选的摘要和可读正文' : input.purpose === 'sqlReview' ? '已保存用例修订及指定SQL清理步骤' : input.purpose === 'alias' ? '所选个人对象名称' : '缺陷标题、描述及严重程度'}；${prepared.source.meta.truncated ? '存在未读或截断资料，不能视为完整比较' : '本次读取范围完整'}。`,
        },
      });
    });
  }
  async confirmationDisclosure(actor: ActorContext, raw: unknown) {
    const input = auxiliaryRequestInputSchema.parse(raw);
    if (!input.disclosureId || !input.disclosureDigest)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '请先只读预检本次辅助资料和模型，再请求明确外发许可。',
        422,
      );
    const prepared = await this.prepare(actor, this.sourceInput(input));
    return this.db.transaction(async (tx) => {
      await this.business(tx, actor);
      if (actor.entrypoint === 'internal-ai')
        await this.assertParentProject(tx, actor, input, actor.requestId);
      await authorizeAuxiliarySource(tx, actor, input);
      await assertAuxiliaryMaterialAccess(tx, actor, input, prepared.source);
      const model = auxiliaryModelSnapshot(
        await resolveNewAuxiliarySelection(this.configuration, tx, actor),
      );
      const row = (
        await tx.query<{
          request_hash: string;
          scope_digest: string;
          source_digest: string;
          model_snapshot: unknown;
          source_meta: unknown;
          expires_at: Date;
          invalidated_at: Date | null;
          consumed_command_id: string | null;
        }>(
          'SELECT request_hash,scope_digest,source_digest,model_snapshot,source_meta,expires_at,invalidated_at,consumed_command_id FROM app.auxiliary_disclosures WHERE id=$1 AND owner_id=$2',
          [input.disclosureId, actor.userId],
        )
      ).rows[0];
      if (
        !row ||
        row.invalidated_at ||
        row.expires_at.getTime() <= Date.now() ||
        row.request_hash !== this.digest(this.sourceInput(input)) ||
        row.scope_digest !== input.disclosureDigest ||
        row.source_digest !== prepared.sourceDigest ||
        canonicalJson(row.model_snapshot) !== canonicalJson(model) ||
        !model.allowedDataScopes.includes(input.dataScope) ||
        (row.consumed_command_id && row.consumed_command_id !== input.commandId)
      )
        throw new DomainError(
          'STALE_BASE_REVISION',
          '原资料或模型预检已变化/失效，请重新预检再确认。',
          412,
        );
      return {
        model,
        source: prepared.source.meta,
        sourceDigest: row.source_digest,
        disclosureDigest: row.scope_digest,
      };
    });
  }
  private async assertConfirmedAuxiliaryInput(
    tx: SqlExecutor,
    actor: ActorContext,
    input: AuxiliaryRequestInput,
    model: unknown,
  ) {
    if (actor.entrypoint !== 'internal-ai') return;
    const proof = await humanConfirmationExecutionInTransaction(tx, actor);
    if (!proof) return;
    const proposed = z
      .object({
        intentId: z.uuid(),
        inputDigest: z.string(),
        purpose: z.literal('requirementLookup'),
        dataScope: z.enum([
          'syntheticPublicOnly',
          'authorizedRelevantTestData',
        ]),
        sourceDigest: z.string(),
        disclosureDigest: z.string(),
        model: auxiliaryModelSnapshotSchema,
      })
      .safeParse(proof.proposalScope);
    const args = z
        .object({
          op: z.literal('find'),
          input: fullRequirementFindInputSchema,
        })
        .safeParse(proof.arguments),
      flat = fullRequirementFindInputSchema
        .safeExtend({ op: z.literal('find') })
        .safeParse(proof.arguments);
    const full = args.success
      ? args.data.input
      : flat.success
        ? (() => {
            const { op: _, ...value } = flat.data;
            return value;
          })()
        : null;
    if (
      proof.origin !== 'internal-ai' ||
      proof.toolName !== 'ath_requirements' ||
      proof.op !== 'find' ||
      !proposed.success ||
      !full ||
      input.purpose !== 'requirementLookup' ||
      proof.taskId !== actor.requestId ||
      proof.projectId !== input.projectId ||
      proposed.data.dataScope !== input.dataScope ||
      proposed.data.disclosureDigest !== input.disclosureDigest ||
      proposed.data.inputDigest !== this.digest(full) ||
      canonicalJson(proposed.data.model) !== canonicalJson(model)
    )
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '本次人工确认不匹配实际辅助用途、模型或资料范围。',
        422,
      );
    const intent = (
      await tx.query<{
        owner_id: string;
        project_id: string;
        parent_task_id: string | null;
        conversation_id: string | null;
        command_key: string;
        request_hash: string;
        auxiliary_command_id: string;
        disclosure_id: string;
        scope_digest: string;
        source_digest: string;
        data_scope: string;
        model_snapshot: unknown;
        state: string;
      }>(
        'SELECT owner_id,project_id,parent_task_id,conversation_id,command_key,request_hash,auxiliary_command_id,disclosure_id,scope_digest,source_digest,data_scope,model_snapshot,state FROM app.automatic_auxiliary_intents WHERE id=$1 AND owner_id=$2 FOR SHARE',
        [proposed.data.intentId, actor.userId],
      )
    ).rows[0];
    const { commandId: _, dataScope: __, ...fullSource } = full;
    if (
      !intent ||
      intent.project_id !== input.projectId ||
      intent.parent_task_id !== proof.taskId ||
      intent.conversation_id !== proof.conversationId ||
      intent.command_key !== full.commandId ||
      intent.request_hash !== proposed.data.inputDigest ||
      intent.auxiliary_command_id !== input.commandId ||
      intent.disclosure_id !== input.disclosureId ||
      intent.scope_digest !== input.disclosureDigest ||
      intent.source_digest !== proposed.data.sourceDigest ||
      intent.data_scope !== input.dataScope ||
      intent.state !== 'accepting' ||
      canonicalJson(intent.model_snapshot) !== canonicalJson(model) ||
      this.digest(this.sourceInput(input)) !==
        this.digest({ purpose: 'requirementLookup', ...fullSource })
    )
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '原确认与自动辅助实际意图或披露不一致，未受理。',
        422,
      );
  }
  private async verifyConsent(
    tx: SqlExecutor,
    actor: ActorContext,
    input: AuxiliaryRequestInput,
    sourceDigest: string,
    model: unknown,
  ) {
    const policy = auxiliaryModelSnapshotSchema.parse(model).allowedDataScopes;
    if (!policy.includes(input.dataScope))
      throw new DomainError('FORBIDDEN', '辅助模型未允许本次资料范围。', 403);
    if (
      input.dataScope === 'syntheticPublicOnly' &&
      !input.disclosureId &&
      actor.entrypoint !== 'official-mcp'
    )
      return;
    if (actor.entrypoint === 'internal-ai') {
      const parent = await captureTaskSources(tx, actor, actor.requestId);
      if (parent.dataScope !== input.dataScope)
        throw new DomainError(
          'FORBIDDEN',
          '辅助资料范围不能超出当前对话已许可范围。',
          403,
        );
      return;
    }
    if (
      !input.disclosureId ||
      !input.disclosureDigest ||
      input.dataConsent !== true
    )
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '请先查看本次资料和模型，再明确允许发送。',
        422,
      );
    const row = (
      await tx.query<{
        request_hash: string;
        scope_digest: string;
        source_digest: string;
        model_snapshot: unknown;
        expires_at: Date;
        invalidated_at: Date | null;
        consumed_command_id: string | null;
      }>(
        'SELECT request_hash,scope_digest,source_digest,model_snapshot,expires_at,invalidated_at,consumed_command_id FROM app.auxiliary_disclosures WHERE id=$1 AND owner_id=$2 FOR UPDATE',
        [input.disclosureId, actor.userId],
      )
    ).rows[0];
    if (
      !row ||
      (row.consumed_command_id !== null &&
        row.consumed_command_id !== input.commandId) ||
      row.invalidated_at ||
      row.expires_at.getTime() <= Date.now() ||
      row.request_hash !== this.digest(this.sourceInput(input)) ||
      row.scope_digest !== input.disclosureDigest ||
      row.source_digest !== sourceDigest ||
      canonicalJson(row.model_snapshot) !== canonicalJson(model)
    )
      throw new DomainError(
        'STALE_BASE_REVISION',
        '资料许可已失效或来源/模型变化，请重新确认。',
        412,
      );
    await tx.query(
      'UPDATE app.auxiliary_disclosures SET consumed_at=COALESCE(consumed_at,clock_timestamp()),consented_scope=$2,consumed_command_id=$3 WHERE id=$1',
      [input.disclosureId, input.dataScope, input.commandId],
    );
  }
  private async credentialAbsent(
    selected: { credentialRef: string; modelServiceId: string },
    value: unknown,
    tx: SqlExecutor = this.db,
  ) {
    const credential = await this.broker.resolveInTransaction(
      tx,
      selected.credentialRef,
      {
        ownerScope: 'platform',
        ownerId: selected.modelServiceId,
        purpose: 'model-api-key',
      },
    );
    const serialized = JSON.stringify(value);
    if (
      serialized.includes(credential) ||
      serialized.includes(JSON.stringify(credential).slice(1, -1))
    )
      throw new DomainError(
        'VALIDATION_ERROR',
        '辅助资料或输出含已配置凭据，不能进入任务资料或建议。',
        400,
      );
  }
  async assertSafeOutput(actor: ActorContext, model: unknown, value: unknown) {
    try {
      assertSafeModelInput(value);
    } catch {
      throw new DomainError(
        'INVALID_MODEL_OUTPUT',
        '辅助输出含疑似凭据，未作为建议保存。',
        422,
      );
    }
    const { selected } = await resolveAuxiliaryModelForTask(
      this.db,
      this.configuration,
      actor,
      model,
    );
    try {
      await this.credentialAbsent(selected, value);
    } catch (error: unknown) {
      if (error instanceof DomainError && error.code === 'VALIDATION_ERROR')
        throw new DomainError(
          'INVALID_MODEL_OUTPUT',
          '辅助输出含已配置凭据，未作为建议保存。',
          422,
        );
      throw error;
    }
  }
  private async personal(tx: SqlExecutor, actor: ActorContext) {
    await currentUser(tx, actor);
    if (actor.entrypoint !== 'web')
      throw new DomainError(
        'FORBIDDEN',
        '系统辅助任务由本人平台操作发起和读取。',
        403,
      );
    await this.requireSchema(tx);
  }
  private async requireSchema(tx: SqlExecutor) {
    const row = (
      await tx.query<{ ready: boolean }>(
        "SELECT to_regclass('app.auxiliary_tasks') IS NOT NULL AND EXISTS(SELECT 1 FROM app.schema_migrations WHERE version='0023_auxiliary_tasks.sql') ready",
      )
    ).rows[0];
    if (!row?.ready)
      throw new DomainError(
        'DEPENDENCY_UNAVAILABLE',
        '系统辅助任务迁移尚未部署；人工主流程可继续，当前不会调用模型。',
        503,
      );
  }
  async row(
    tx: SqlExecutor,
    actor: ActorContext,
    id: string,
    lock = false,
  ): Promise<AuxiliaryTaskRow> {
    const row = (
      await tx.query<AuxiliaryTaskRow>(
        `SELECT * FROM app.auxiliary_tasks WHERE id=$1 AND owner_id=$2${lock ? ' FOR UPDATE' : ''}`,
        [id, actor.userId],
      )
    ).rows[0];
    if (!row) throw new DomainError('NOT_FOUND', '没有此本人辅助任务。', 404);
    if (row.conversation_id)
      await conversationRow(
        tx,
        actor,
        row.conversation_id,
        false,
        actor.entrypoint === 'internal-ai',
      );
    let input: AuxiliaryRequestInput;
    try {
      input = auxiliaryRequestInputSchema.parse(row.request);
    } catch {
      throw new DomainError('NOT_FOUND', '辅助任务来源已删除或不可访问。', 404);
    }
    await authorizeAuxiliarySource(tx, actor, input);
    const source = auxiliarySourceSnapshotSchema.parse(row.source_snapshot);
    await assertAuxiliaryMaterialAccess(tx, actor, input, source);
    if (row.parent_task_id) {
      await this.assertParentProject(tx, actor, input, row.parent_task_id);
      if (!source.parentSources)
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '原AI任务来源记录缺失，辅助资料保持不可读。',
          422,
        );
      await assertFrozenTaskSources(tx, actor, source.parentSources);
    }
    if (isAutomaticConversationTitle(row))
      await assertConversationTitleSource(tx, row);
    return row;
  }
  /** Trusted worker-only composition port; no Web/MCP request route or flag. */
  async enqueueConversationTitleInTransaction(
    tx: SqlExecutor,
    ownerId: string,
    parentTaskId: string,
  ): Promise<string | null> {
    try {
      return await enqueueConversationTitle(
        tx,
        this.configuration,
        ownerId,
        parentTaskId,
        (selected, value, transaction) =>
          this.credentialAbsent(selected, value, transaction),
      );
    } catch (error) {
      // Expected permission/configuration loss cannot fail the public answer.
      // Database/commit uncertainty is never converted into a successful skip.
      if (!(error instanceof DomainError)) throw error;
      return null;
    }
  }
  async dto(row: AuxiliaryTaskRow, tx: SqlExecutor = this.db) {
    const source = auxiliarySourceSnapshotSchema.parse(row.source_snapshot);
    const call = row.call_id
      ? (
          await tx.query<{
            id: string;
            status: string;
            request_count: number | null;
            dispatch_certainty: string;
            client_request_id: string | null;
            provider_request_id: string | null;
            input_tokens: string | null;
            output_tokens: string | null;
            total_tokens: string | null;
            cached_input_tokens: string | null;
            reasoning_output_tokens: string | null;
            started_at: Date;
            finished_at: Date | null;
          }>(
            `SELECT id,status,request_count,dispatch_certainty,client_request_id,provider_request_id,input_tokens::text,output_tokens::text,total_tokens::text,cached_input_tokens::text,reasoning_output_tokens::text,started_at,finished_at FROM app.model_call_ledger WHERE id=$1 AND auxiliary_task_id=$2 AND initiator_user_id=$3`,
            [row.call_id, row.id, row.owner_id],
          )
        ).rows[0]
      : null;
    return auxiliaryTaskReceiptSchema.parse({
      task: {
        id: row.id,
        purpose: row.purpose,
        dataScope: auxiliaryRequestInputSchema.parse(row.request).dataScope,
        state: row.state,
        executionOrigin: row.execution_origin,
        source: source.meta,
        model: auxiliaryModelSnapshotSchema.parse(row.model_snapshot),
        result:
          row.result === null ? null : auxiliaryResultSchema.parse(row.result),
        errorCode: row.error_code,
        errorDetails:
          row.error_details === null
            ? null
            : auxiliaryErrorDetailsSchema.parse(row.error_details),
        callId: row.call_id,
        call: call
          ? {
              id: call.id,
              status: call.status,
              requestCount: call.request_count,
              dispatchCertainty: call.dispatch_certainty,
              clientRequestId: call.client_request_id,
              providerRequestId: call.provider_request_id,
              inputTokens: call.input_tokens,
              outputTokens: call.output_tokens,
              totalTokens: call.total_tokens,
              cachedInputTokens: call.cached_input_tokens,
              reasoningOutputTokens: call.reasoning_output_tokens,
              startedAt: call.started_at.toISOString(),
              finishedAt: call.finished_at?.toISOString() ?? null,
            }
          : null,
        createdAt: row.created_at.toISOString(),
        finishedAt: row.finished_at?.toISOString() ?? null,
      },
    });
  }
  async request(actor: ActorContext, raw: unknown) {
    return this.submit(actor, raw, false);
  }
  async requestBusiness(actor: ActorContext, raw: unknown) {
    return this.submit(actor, raw, true);
  }
  private async business(tx: SqlExecutor, actor: ActorContext) {
    await currentUser(tx, actor);
    if (
      !(actor.entrypoint === 'internal-ai' && !actor.keyId) &&
      !(actor.entrypoint === 'official-mcp' && actor.keyId)
    )
      throw new DomainError(
        'FORBIDDEN',
        '业务辅助仅供当前受控应用工具或官方MCP。',
        403,
      );
    await this.requireSchema(tx);
  }
  private async submit(actor: ActorContext, raw: unknown, business: boolean) {
    assertSafeModelInput(raw);
    const input = auxiliaryRequestInputSchema.parse(raw),
      projectId =
        input.purpose === 'alias'
          ? null
          : 'projectId' in input
            ? input.projectId
            : null;
    if (business && input.purpose === 'alias')
      throw new DomainError(
        'FORBIDDEN',
        '个人会话命名不通过项目MCP辅助通道开放。',
        403,
      );
    const prepared = await this.prepare(actor, this.sourceInput(input));
    return this.operations.execute(
      actor,
      'auxiliary.submit',
      input.commandId,
      input,
      async (tx) => {
        if (business) await this.business(tx, actor);
        else await this.personal(tx, actor);
        await assertNewWorkAllowed(
          tx,
          true,
          actor.entrypoint === 'internal-ai'
            ? { taskId: actor.requestId, ownerId: actor.userId }
            : undefined,
        );
        await authorizeAuxiliarySource(tx, actor, input);
      },
      async (tx) => {
        const currentSource = await freezeAuxiliarySource(tx, actor, input);
        await assertAuxiliaryMaterialAccess(tx, actor, input, currentSource);
        if (this.digest(currentSource) !== prepared.baseDigest)
          throw new DomainError(
            'STALE_BASE_REVISION',
            '辅助资料已变化，请重新确认。',
            412,
          );
        const source = prepared.source,
          selected = await resolveNewAuxiliarySelection(
            this.configuration,
            tx,
            actor,
          ),
          model = auxiliaryModelSnapshot(selected),
          id = randomUUID();
        await this.assertConfirmedAuxiliaryInput(tx, actor, input, model);
        const parent =
          actor.entrypoint === 'internal-ai'
            ? await captureTaskSources(tx, actor, actor.requestId)
            : null;
        if (parent)
          await this.assertParentProject(tx, actor, input, actor.requestId);
        await this.verifyConsent(
          tx,
          actor,
          input,
          prepared.sourceDigest,
          model,
        );
        if (parent && parent.dataScope !== input.dataScope)
          throw new DomainError(
            'FORBIDDEN',
            '辅助资料范围须与当前父任务相同。',
            403,
          );
        if (parent) source.parentSources = parent.sources;
        await this.credentialAbsent(selected, { input, source }, tx);
        await tx.query(
          `INSERT INTO app.auxiliary_tasks(id,owner_id,project_id,conversation_id,command_id,purpose,request,source_snapshot,model_snapshot,origin,origin_key_id,parent_task_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            id,
            actor.userId,
            projectId,
            parent?.conversationId ?? source.meta.conversationId,
            input.commandId,
            input.purpose,
            JSON.stringify(input),
            JSON.stringify(source),
            JSON.stringify(model),
            actor.entrypoint,
            actor.keyId ?? null,
            parent ? actor.requestId : null,
          ],
        );
        await audit(tx, actor, 'auxiliary.accepted', id, projectId, {
          purpose: input.purpose,
          modelServiceId: model.modelServiceId,
          modelConfigRevision: auxiliarySnapshotRevision(model),
        });
        return this.dto(await this.row(tx, actor, id), tx);
      },
      projectId ?? undefined,
    );
  }
  async get(actor: ActorContext, id: string) {
    return this.db.transaction(async (tx) => {
      await this.personal(tx, actor);
      return this.dto(await this.row(tx, actor, id), tx);
    });
  }
  async getBusiness(actor: ActorContext, id: string) {
    return this.serviceBusinessRow(actor, id);
  }
  private async serviceBusinessRow(actor: ActorContext, id: string) {
    return this.db.transaction(async (tx) => {
      await this.business(tx, actor);
      const kind = (
        await tx.query<{ purpose: string }>(
          'SELECT purpose FROM app.auxiliary_tasks WHERE id=$1 AND owner_id=$2',
          [id, actor.userId],
        )
      ).rows[0];
      if (!kind || kind.purpose === 'alias')
        throw new DomainError(
          'NOT_FOUND',
          '没有此本人可访问的项目辅助任务。',
          404,
        );
      return this.dto(await this.row(tx, actor, id), tx);
    });
  }
  async byCommandBusiness(actor: ActorContext, key: string) {
    const id = await this.db.transaction(async (tx) => {
      await this.business(tx, actor);
      const row = (
        await tx.query<{ id: string }>(
          "SELECT id FROM app.auxiliary_tasks WHERE owner_id=$1 AND command_id=$2 AND purpose<>'alias'",
          [actor.userId, z.string().min(1).max(200).parse(key)],
        )
      ).rows[0];
      if (!row) {
        await rejectMissingAcceptedReceipt(
          tx,
          actor,
          'auxiliary.submit',
          key,
          true,
        );
        throw new DomainError('NOT_FOUND', '没有此本人项目辅助任务回执。', 404);
      }
      return row.id;
    });
    return this.serviceBusinessRow(actor, id);
  }
  async byCommand(actor: ActorContext, key: string) {
    return this.db.transaction(async (tx) => {
      await this.personal(tx, actor);
      const row = (
        await tx.query<{ id: string }>(
          'SELECT id FROM app.auxiliary_tasks WHERE owner_id=$1 AND command_id=$2',
          [actor.userId, z.string().min(1).max(200).parse(key)],
        )
      ).rows[0];
      if (!row) {
        await rejectMissingAcceptedReceipt(tx, actor, 'auxiliary.submit', key);
        throw new DomainError('NOT_FOUND', '没有此本人辅助任务回执。', 404);
      }
      return this.dto(await this.row(tx, actor, row.id), tx);
    });
  }
  async cancel(actor: ActorContext, id: string, raw: unknown) {
    const input = cancelAuxiliaryInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'auxiliary.cancel',
      input.commandId,
      { id },
      async (tx) => {
        await this.personal(tx, actor);
        await this.row(tx, actor, id);
      },
      async (tx) => {
        const row = await this.row(tx, actor, id, true);
        if (
          row.state === 'accepted' ||
          row.state === 'running' ||
          row.state === 'cancelling'
        )
          await tx.query(
            `UPDATE app.auxiliary_tasks SET state=CASE WHEN state='accepted' THEN 'cancelled' ELSE 'cancelling' END,cancel_requested_at=COALESCE(cancel_requested_at,clock_timestamp()),finished_at=CASE WHEN state='accepted' THEN clock_timestamp() ELSE finished_at END WHERE id=$1`,
            [id],
          );
        await finishAutomaticAuxiliaryTask(tx, id);
        return this.dto(await this.row(tx, actor, id), tx);
      },
    );
  }
}
