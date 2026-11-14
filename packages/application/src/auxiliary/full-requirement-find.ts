import { humanConfirmationExecutionInTransaction } from '../tool-registry/human-confirmation.js';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { ActorContext } from '../../../contracts/src/identity.js';
import {
  fullRequirementFindInputSchema,
  fullRequirementFindReceiptSchema,
  type FullRequirementFindInput,
} from '../../../contracts/src/automatic-auxiliary.js';
import { auxiliaryModelSnapshotSchema } from '../../../contracts/src/auxiliary.js';
import { RequirementService } from '../requirements/service.js';
import { requireProject, currentUser } from '../access/policy.js';
import { DomainError } from '../errors.js';
import { assertSafeModelInput } from '../security/model-input.js';
import { captureTaskSources } from '../conversations/task-sources.js';
import type { ConfirmationScope } from '../tool-registry/registry.js';
import { AuxiliaryService } from './service.js';
import {
  automaticDigest,
  automaticTableReady,
  type AutomaticIntentRow,
} from './automatic-common.js';
export class FullRequirementFindService {
  constructor(readonly auxiliary: AuxiliaryService) {}
  get db() {
    return this.auxiliary.db;
  }
  private input(raw: unknown) {
    assertSafeModelInput(raw);
    return fullRequirementFindInputSchema.parse(raw);
  }
  private source(input: FullRequirementFindInput) {
    const { commandId: _, dataScope: __, ...source } = input;
    return { purpose: 'requirementLookup' as const, ...source };
  }
  private async local(actor: ActorContext, input: FullRequirementFindInput) {
    const plain = await new RequirementService(this.db).candidates(actor, {
      projectId: input.projectId,
      title: input.title,
      businessNumber: input.businessNumber,
    });
    const exact = await this.db.transaction(async (tx) => {
      await requireProject(tx, actor, input.projectId, 'project.read');
      if (input.materials.some((material) => material.sourceLink)) return [];
      await requireProject(tx, actor, input.projectId, 'files.transfer');
      const ids = [
          ...new Set(
            input.materials.map((material) => material.fileResourceId!),
          ),
        ],
        files = (
          await tx.query<{ id: string; declared_sha256: string }>(
            "SELECT id,declared_sha256 FROM app.file_resources WHERE id=ANY($1::uuid[]) AND owner_scope='project' AND project_id=$2 AND status='verified' AND deleted_at IS NULL FOR SHARE",
            [ids, input.projectId],
          )
        ).rows;
      if (files.length !== ids.length)
        throw new DomainError(
          'FILE_NOT_READY',
          '完整材料查找仅接收本项目已验证文件；未读取或越权材料不冒充匹配完成。',
          422,
        );
      const digest = createHash('sha256')
        .update(
          JSON.stringify(
            [...input.materials]
              .sort((a, b) => a.order - b.order)
              .map((material) => ({
                purpose: material.purpose,
                sha256: files.find(
                  (file) => file.id === material.fileResourceId,
                )!.declared_sha256,
                order: material.order,
              })),
          ),
        )
        .digest('hex');
      return (
        await tx.query<{
          requirement_id: string;
          id: string;
          version_no: number;
          latest_version_no: number;
        }>(
          `SELECT v.requirement_id,v.id,v.version_no,(SELECT max(n.version_no) FROM app.requirement_versions n WHERE n.requirement_id=v.requirement_id) latest_version_no FROM app.requirement_versions v WHERE v.project_id=$1 AND v.material_set_digest=$2 ORDER BY v.requirement_id,v.version_no DESC LIMIT 201`,
          [input.projectId, digest],
        )
      ).rows;
    });
    const ids = [
      ...new Set([
        ...plain.candidates.map((item) => item.id),
        ...exact.map((item) => item.requirement_id),
      ]),
    ];
    return {
      ids,
      exact: exact.slice(0, 200).map((item) => ({
        requirementId: item.requirement_id,
        requirementVersionId: item.id,
        versionNo: item.version_no,
        latestVersionNo: item.latest_version_no,
      })),
      exactComplete: exact.length <= 200,
    };
  }
  private async row(actor: ActorContext, input: FullRequirementFindInput) {
    return this.db.transaction(async (tx) => {
      await currentUser(tx, actor);
      await requireProject(tx, actor, input.projectId, 'project.read');
      if (!(await automaticTableReady(tx)))
        throw new DomainError(
          'DEPENDENCY_UNAVAILABLE',
          '完整材料自动查找入口尚未迁移；可继续人工查找。',
          503,
        );
      const row = (
        await tx.query<AutomaticIntentRow>(
          "SELECT * FROM app.automatic_auxiliary_intents WHERE owner_id=$1 AND command_key=$2 AND purpose='requirementLookup'",
          [actor.userId, input.commandId],
        )
      ).rows[0];
      if (row && row.request_hash !== automaticDigest(input))
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          '同查找command不能改用另一份资料。',
          409,
        );
      if (row && actor.entrypoint === 'official-mcp' && row.conversation_id)
        throw new DomainError(
          'NOT_FOUND',
          '此Key不读取平台私聊派生的查找意图。',
          404,
        );
      if (
        row &&
        actor.entrypoint === 'internal-ai' &&
        row.parent_task_id !== actor.requestId
      )
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          '原查找属于另一消息任务，请查询原回执；不借新任务替换原来源许可。',
          409,
        );
      return row;
    });
  }
  private async prepare(actor: ActorContext, input: FullRequirementFindInput) {
    let intent = await this.row(actor, input);
    if (
      intent &&
      (intent.state !== 'pendingPermission' || intent.disclosure_id)
    )
      return intent;
    const local = await this.local(actor, input),
      id = randomUUID(),
      parent =
        actor.entrypoint === 'internal-ai'
          ? await this.db.transaction((tx) =>
              captureTaskSources(tx, actor, actor.requestId),
            )
          : null;
    if (!intent) {
      intent = await this.db.transaction(async (tx) => {
        await requireProject(tx, actor, input.projectId, 'project.read');
        await tx.query(
          `INSERT INTO app.automatic_auxiliary_intents(id,owner_id,purpose,project_id,command_key,request_hash,state,auxiliary_command_id,conversation_id,parent_task_id,local_matches) VALUES($1,$2,'requirementLookup',$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(owner_id,command_key) DO NOTHING`,
          [
            id,
            actor.userId,
            input.projectId,
            input.commandId,
            automaticDigest(input),
            local.ids.length ? 'localMatched' : 'pendingPermission',
            'auto-find:' + id,
            parent?.conversationId ?? null,
            parent ? actor.requestId : null,
            JSON.stringify(local),
          ],
        );
        const row = (
          await tx.query<AutomaticIntentRow>(
            'SELECT * FROM app.automatic_auxiliary_intents WHERE owner_id=$1 AND command_key=$2 FOR UPDATE',
            [actor.userId, input.commandId],
          )
        ).rows[0]!;
        if (row.request_hash !== automaticDigest(input))
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            '同查找标识已有其他资料。',
            409,
          );
        return row;
      });
    } else if (local.ids.length) {
      intent =
        (
          await this.db.query<AutomaticIntentRow>(
            "UPDATE app.automatic_auxiliary_intents SET state='localMatched',local_matches=$2,updated_at=clock_timestamp() WHERE id=$1 AND state='pendingPermission' AND disclosure_id IS NULL RETURNING *",
            [intent.id, JSON.stringify(local)],
          )
        ).rows[0] ?? intent;
    }
    if (intent.state !== 'pendingPermission' || intent.disclosure_id)
      return intent;
    try {
      const preview = await this.auxiliary.preflight(
        actor,
        { source: this.source(input) },
        true,
      );
      const payload = z
        .object({ candidates: z.array(z.object({ requirementId: z.uuid() })) })
        .parse(JSON.parse(preview.disclosure.payloadPreview) as unknown);
      return await this.db.transaction(async (tx) => {
        await currentUser(tx, actor);
        const current = (
          await tx.query<AutomaticIntentRow>(
            'SELECT * FROM app.automatic_auxiliary_intents WHERE id=$1 AND owner_id=$2 FOR UPDATE',
            [intent!.id, actor.userId],
          )
        ).rows[0]!;
        if (current.disclosure_id || current.state !== 'pendingPermission')
          return current;
        return (
          await tx.query<AutomaticIntentRow>(
            'UPDATE app.automatic_auxiliary_intents SET disclosure_id=$2,scope_digest=$3,source_digest=$4,model_snapshot=$5,local_matches=$6,updated_at=clock_timestamp() WHERE id=$1 RETURNING *',
            [
              intent!.id,
              preview.disclosure.id,
              preview.disclosure.scopeDigest,
              preview.disclosure.sourceDigest,
              JSON.stringify(preview.disclosure.model),
              JSON.stringify({
                ...local,
                semanticCandidateIds: payload.candidates.map(
                  (item) => item.requirementId,
                ),
              }),
            ],
          )
        ).rows[0]!;
      });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      if (['FORBIDDEN', 'UNAUTHENTICATED', 'NOT_FOUND'].includes(error.code))
        throw error;
      return (
        await this.db.query<AutomaticIntentRow>(
          "UPDATE app.automatic_auxiliary_intents SET state='failed',error_code=$2,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
          [intent.id, error.code],
        )
      ).rows[0]!;
    }
  }
  private auxiliaryInput(
    input: FullRequirementFindInput,
    intent: AutomaticIntentRow,
  ) {
    return {
      ...this.source(input),
      commandId: intent.auxiliary_command_id,
      dataScope: input.dataScope,
      disclosureId: intent.disclosure_id!,
      disclosureDigest: intent.scope_digest!,
      dataConsent: true as const,
    };
  }
  async confirmation(
    actor: ActorContext,
    raw: unknown,
  ): Promise<ConfirmationScope | undefined> {
    const input = this.input(raw),
      intent = await this.prepare(actor, input);
    if (intent.state !== 'pendingPermission' || !intent.disclosure_id)
      return undefined;
    const disclosure = await this.auxiliary.confirmationDisclosure(
      actor,
      this.auxiliaryInput(input, intent),
    );
    const local = z
      .object({ semanticCandidateIds: z.array(z.uuid()).optional() })
      .parse(intent.local_matches);
    return {
      reason: 'impact',
      summary: `本地编号、名称及完整文件摘要无候选，自动进行辅助语义比较：将当前草稿及明确项目内${local.semanticCandidateIds?.length ?? 0}个候选的可读材料发送至${'schemaVersion' in disclosure.model ? disclosure.model.serviceName + ' / ' + disclosure.model.modelDisplayName + ' · ' + disclosure.model.protocol : disclosure.model.provider + ' / ' + disclosure.model.modelId}（修订${'schemaVersion' in disclosure.model ? disclosure.model.serviceRevision : disclosure.model.configRevision}）。仅产生候选，不自动创建/关联需求；未读材料仍标不完整。`,
      scope: {
        intentId: intent.id,
        inputDigest: intent.request_hash,
        purpose: 'requirementLookup',
        dataScope: input.dataScope,
        ...disclosure,
        candidateRequirementIds: local.semanticCandidateIds ?? [],
      },
      links: [],
    };
  }
  private async dto(
    actor: ActorContext,
    input: FullRequirementFindInput,
    intent: AutomaticIntentRow,
    task: Awaited<ReturnType<AuxiliaryService['getBusiness']>> | null = null,
  ) {
    const local = z
      .object({
        ids: z.array(z.uuid()),
        exact: z.array(
          z.object({
            requirementId: z.uuid(),
            requirementVersionId: z.uuid(),
            versionNo: z.number(),
            latestVersionNo: z.number(),
          }),
        ),
        exactComplete: z.boolean(),
      })
      .parse(intent.local_matches);
    const candidates = [];
    for (const id of local.ids) {
      try {
        candidates.push(
          (
            await new RequirementService(this.db).detail(
              actor,
              input.projectId,
              id,
            )
          ).requirement,
        );
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'NOT_FOUND')
          throw error;
      }
    }
    const state =
      intent.state === 'localMatched'
        ? 'localMatched'
        : task
          ? 'accepted'
          : intent.error_code === 'MODEL_NOT_CONFIGURED'
            ? 'notConfigured'
            : ['accepting', 'accepted', 'unknown'].includes(intent.state)
              ? 'unknown'
              : intent.state === 'pendingPermission'
                ? 'waitingPermission'
                : 'unavailable';
    return fullRequirementFindReceiptSchema.parse({
      candidates,
      lookupIncomplete: !(local.exactComplete && local.exact.length === 1),
      lookupMessage:
        state === 'localMatched'
          ? '已找到本地候选，未调用辅助模型；关联/选版由人工决定，完整材料相同的历史版会提示已有新版。'
          : state === 'accepted'
            ? '普通规则无候选，已按本次明确许可自动受理辅助比较；以任务回执及incomplete为准。'
            : state === 'waitingPermission'
              ? '普通规则无候选，已自动准备辅助比较，等待本次资料外发许可。'
              : state === 'unknown'
                ? '原辅助受理结果待核对，仅查原command，不重新发送。'
                : '辅助比较未完成，人工主流程可继续，不能据此声称不存在重复。',
      exactMaterialMatches: local.exact,
      defaultAssociation:
        local.exactComplete && local.exact.length === 1
          ? {
              requirementId: local.exact[0]!.requirementId,
              requirementVersionId: local.exact[0]!.requirementVersionId,
            }
          : null,
      semantic: {
        state,
        intentId: intent.id,
        auxiliaryCommandId: intent.auxiliary_command_id,
        task,
        errorCode: intent.error_code,
      },
    });
  }
  async find(
    actor: ActorContext,
    raw: unknown,
  ): Promise<z.infer<typeof fullRequirementFindReceiptSchema>> {
    const input = this.input(raw),
      intent = await this.prepare(actor, input);
    if (
      intent.state === 'localMatched' ||
      intent.state === 'failed' ||
      intent.state === 'cancelled' ||
      intent.state === 'superseded'
    )
      return this.dto(actor, input, intent);
    if (intent.state !== 'pendingPermission') {
      let task = null;
      try {
        task = await this.auxiliary.byCommandBusiness(
          actor,
          intent.auxiliary_command_id,
        );
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'NOT_FOUND')
          throw error;
      }
      return this.dto(actor, input, intent, task);
    }
    if (!intent.disclosure_id) return this.dto(actor, input, intent);
    const human = await this.db.transaction(async (tx) => {
      const proof = await humanConfirmationExecutionInTransaction(tx, actor);
      if (!proof) return false;
      const scope = z
        .object({
          intentId: z.uuid(),
          inputDigest: z.string(),
          purpose: z.literal('requirementLookup'),
          dataScope: z.string(),
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
          .safeParse(proof.arguments),
        actual = args.success
          ? args.data.input
          : flat.success
            ? (() => {
                const { op: _, ...value } = flat.data;
                return value;
              })()
            : null;
      if (
        proof.toolName !== 'ath_requirements' ||
        proof.op !== 'find' ||
        proof.ownerId !== actor.userId ||
        proof.projectId !== input.projectId ||
        !scope.success ||
        scope.data.intentId !== intent.id ||
        scope.data.inputDigest !== intent.request_hash ||
        scope.data.dataScope !== input.dataScope ||
        scope.data.sourceDigest !== intent.source_digest ||
        scope.data.disclosureDigest !== intent.scope_digest ||
        automaticDigest(scope.data.model) !==
          automaticDigest(
            auxiliaryModelSnapshotSchema.parse(intent.model_snapshot),
          ) ||
        !actual ||
        automaticDigest(actual) !== automaticDigest(input)
      )
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '本次真人事件与实际自动语义比较不一致。',
          422,
        );
      return true;
    });
    if (!human) return this.dto(actor, input, intent);
    await this.auxiliary.confirmationDisclosure(
      actor,
      this.auxiliaryInput(input, intent),
    );
    const reserved = await this.db.transaction(async (tx) => {
      await requireProject(tx, actor, input.projectId, 'requirements.write');
      const row = (
        await tx.query<AutomaticIntentRow>(
          "UPDATE app.automatic_auxiliary_intents SET state='accepting',protected_history=true,consented_at=clock_timestamp(),data_scope=$3,updated_at=clock_timestamp() WHERE id=$1 AND owner_id=$2 AND state='pendingPermission' RETURNING *",
          [intent.id, actor.userId, input.dataScope],
        )
      ).rows[0];
      if (row)
        tx.noteSecurityControlChange?.({
          action: 'automatic-auxiliary.find-accepting',
          objectId: row.id,
          projectId: row.project_id,
        });
      return row;
    });
    if (!reserved) return this.find(actor, raw);
    try {
      const task = await this.auxiliary.requestBusiness(
        actor,
        this.auxiliaryInput(input, reserved),
      );
      await this.db.transaction(async (tx) => {
        await tx.query(
          "UPDATE app.automatic_auxiliary_intents SET auxiliary_task_id=$2,state=CASE WHEN state='accepting' THEN 'accepted' ELSE state END,updated_at=clock_timestamp() WHERE id=$1",
          [intent.id, task.task.id],
        );
        tx.noteSecurityControlChange?.({
          action: 'automatic-auxiliary.find-accepted',
          objectId: intent.id,
          projectId: intent.project_id,
        });
      });
      return this.dto(
        actor,
        input,
        { ...reserved, state: 'accepted', auxiliary_task_id: task.task.id },
        task,
      );
    } catch (error) {
      const known = error instanceof DomainError && error.status < 500;
      const failed = await this.db.transaction(async (tx) => {
        const row = (
          await tx.query<AutomaticIntentRow>(
            'UPDATE app.automatic_auxiliary_intents SET state=$2,protected_history=$3,error_code=$4,updated_at=clock_timestamp() WHERE id=$1 RETURNING *',
            [
              intent.id,
              known ? 'failed' : 'unknown',
              !known,
              error instanceof DomainError
                ? error.code
                : 'OPERATION_RESULT_UNKNOWN',
            ],
          )
        ).rows[0]!;
        tx.noteSecurityControlChange?.({
          action: 'automatic-auxiliary.find-failed',
          objectId: intent.id,
          projectId: intent.project_id,
        });
        return row;
      });
      return this.dto(actor, input, failed);
    }
  }
}
