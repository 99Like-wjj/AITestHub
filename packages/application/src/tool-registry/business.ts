import { registerRequirementQueryTools } from './requirement-queries.js';
import { registerUiDeliveryTools } from './ui-delivery.js';
import {
  uiArchivePreviewToolSchema,
  uiArchiveCommitToolSchema,
  uiArchiveReceiptToolSchema,
  uiArchiveResultReceiptToolSchema,
  uiArchiveResultSubmitToolSchema,
} from '../../../contracts/src/ui-archives.js';
import { z } from 'zod';
import { registerRequirementStateTools } from './requirement-state.js';
import { idSchema, kindSchema } from '../../../contracts/src/base.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import {
  saveApiRegressionInputSchema,
  startDebugInputSchema,
  withdrawApiRegressionInputSchema,
} from '../../../contracts/src/api-execution.js';
import {
  assetChangeSetSchema,
  resultAmendmentSchema,
  uiProgressInputSchema,
} from '../../../contracts/src/domain.js';
import {
  assetListQuerySchema,
  reviseAssetInputSchema,
  removeAssetInputSchema,
  addOpinionInputSchema,
  removeOpinionInputSchema,
  optimizationNotesInputSchema,
  approvalPreviewInputSchema,
  approveCommitInputSchema,
  createSetInputSchema,
  createScenarioInputSchema,
  createCaseInputSchema,
  createScopedCaseInputSchema,
} from '../../../contracts/src/assets.js';
import {
  createPlanInputSchema,
  revisePlanInputSchema,
  apiStartPreviewInputSchema,
  apiQueueInputSchema,
} from '../../../contracts/src/plans.js';
import {
  claimLocalExecutionInputSchema,
  closeUiProgressInputSchema,
  previewCloseUiProgressBatchInputSchema,
  closeUiProgressBatchInputSchema,
  finalAssessmentInputSchema,
  executionRecordQuerySchema,
} from '../../../contracts/src/ui-results.js';
import type { Database } from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { AssetService } from '../assets/service.js';
import { CoverageCheckpointService } from '../assets/coverage-checkpoints.js';
import {
  coverageCheckpointScopeSchema,
  saveCoverageCheckpointInputSchema,
} from '../../../contracts/src/coverage-checkpoints.js';
import { ReviewService } from '../assets/reviews.js';
import { UiReviewService } from '../assets/ui-review.js';
import { uiReviewReplySchema } from '../../../contracts/src/ui-reviews.js';
import { PlanService } from '../plans/service.js';
import { UiExecutionService } from '../ui-executions/service.js';
import { ResultService } from '../results/service.js';
import { ReportService } from '../reports/service.js';
import { DomainError } from '../errors.js';
import { BusinessToolRegistry } from './registry.js';
import type { TestConfigurationService } from '../test-configuration/service.js';
import type { ApiExecutionControlService } from '../api-execution/control.js';
import { registerIssueTools } from './issues.js';
import { registerInternalConfigurationTools } from './configuration.js';
import { registerKnowledgeTools } from './knowledge.js';
import type { AuxiliaryService } from '../auxiliary/service.js';
import { registerAuxiliaryTools } from './auxiliary.js';
import type { FilesService } from '../files/service.js';
import {
  registerScheduleTools,
  type ScheduleBusinessService,
} from './schedules.js';

const project = { projectId: idSchema };
const target = { ...project, id: idSchema };
const shape = <S extends z.ZodType>(op: string, input: S) =>
  z.strictObject({ op: z.literal(op), ...project, input });
const link = (projectId: string, page: string, id?: string) =>
  `/api/v1/projects/${projectId}/${page}${id ? `/${id}` : ''}`;

export interface BusinessServices {
  auxiliary?: AuxiliaryService;
  files?: FilesService;
  schedules?: ScheduleBusinessService;
  testConfiguration?: TestConfigurationService;
  plans?: PlanService;
  apiExecution?: Pick<
    ApiExecutionControlService,
    'events' | 'attemptDetail' | 'stop' | 'status' | 'debug' | 'regression'
  >;
}
export function createBusinessRegistry(
  db: Database,
  services: BusinessServices = {},
): BusinessToolRegistry {
  const registry = new BusinessToolRegistry();
  registerRequirementStateTools(registry, db);
  registerRequirementQueryTools(registry, db, services.auxiliary);
  registerUiDeliveryTools(registry, db, services.files);
  const assets = new AssetService(db);
  const reviews = new ReviewService(db);
  const uiReviews = new UiReviewService(db);
  const plans =
    services.plans ??
    (services.testConfiguration
      ? new PlanService(db, services.testConfiguration)
      : undefined);
  const results = new ResultService(db);
  const reports = new ReportService(db);
  const archives = results.archives;
  registry.add(
    'ath_ui_archives',
    '核对并登记已在用户本地执行的独立记录。不会领取正式计划或启动目标。',
    'preview',
    uiArchivePreviewToolSchema,
    'read',
    (a, i) => archives.preview(a, i.projectId, i.input),
  );
  registry.add(
    'ath_ui_archives',
    '核对并登记已在用户本地执行的独立记录。不会领取正式计划或启动目标。',
    'commit',
    uiArchiveCommitToolSchema,
    'write',
    (a, i) => archives.commit(a, i.projectId, i.input),
  );
  registry.add(
    'ath_ui_archives',
    '核对、登记及查询已在用户本地执行的独立记录。',
    'receipt',
    uiArchiveReceiptToolSchema,
    'read',
    (actor, input) => archives.receipt(actor, input.projectId, input.commandId),
  );
  registry.add(
    'ath_ui_archives',
    '上报明确登记范围内的独立归档事实，保留原结论；不会启动正式执行或自动建缺陷。',
    'submit-results',
    uiArchiveResultSubmitToolSchema,
    'write',
    (a, i) => archives.submitResults(a, i.projectId, i.input),
  );
  registry.add(
    'ath_ui_archives',
    '核对本人独立归档的原结果回执和当前交付状态。',
    'result-receipt',
    uiArchiveResultReceiptToolSchema,
    'read',
    (a, i) => archives.resultReceipt(a, i.projectId, i.runId, i.submissionId),
  );
  const add = registry.add.bind(registry);
  const removalImpact = async (
    actor: ActorContext,
    projectId: string,
    id: string,
  ) => {
    const current = (await assets.detail(actor, projectId, id)).asset;
    const ids = [
      ...new Set(
        [current.parentId, current.setId].filter(
          (parentId): parentId is string =>
            parentId !== null && parentId !== current.id,
        ),
      ),
    ];
    const summarize = (asset: typeof current) => ({
      id: asset.id,
      title: asset.title,
      targetType: asset.targetType,
      kind: asset.kind,
      requirementVersionId: asset.requirementVersionId,
      revisionId: asset.revisionId,
      rowVersion: asset.rowVersion,
      reviewState: asset.reviewState,
    });
    const affectedAncestors = await Promise.all(
      ids.map(async (parentId) =>
        summarize((await assets.detail(actor, projectId, parentId)).asset),
      ),
    );
    const children = await db.query<{
      id: string;
      current_revision_id: string;
      row_version: number;
    }>(
      'SELECT id,current_revision_id,row_version FROM app.test_assets WHERE project_id=$1 AND parent_id=$2 AND removed_at IS NULL ORDER BY id',
      [projectId, id],
    );
    return {
      target: summarize(current),
      affectedAncestors,
      activeChildren: children.rows.map((child) => ({
        id: child.id,
        revisionId: child.current_revision_id,
        rowVersion: child.row_version,
      })),
      effect:
        '仅显式移除目标；父级当前评审会失效，已有批准快照/计划/执行历史保留。仍有子项时须逐项明确，不自动级联删除。',
    };
  };
  const assetDescription =
    '按项目、需求版本和 UI/API 类型维护场景与用例。setId 用于追溯资产归属。生成或优化写入待审内容，提交须保持当前基准；未提交项保留。';
  add(
    'ath_assets',
    assetDescription,
    'list',
    shape('list', assetListQuerySchema),
    'read',
    (a, i) => assets.list(a, i.projectId, i.input),
  );
  add(
    'ath_assets',
    assetDescription,
    'get',
    z.strictObject({ op: z.literal('get'), ...target }),
    'read',
    (a, i) => assets.detail(a, i.projectId, i.id),
  );
  for (const [op, schema, method] of [
    ['create-set', createSetInputSchema, assets.createSet.bind(assets)],
    [
      'create-scenario',
      createScenarioInputSchema,
      assets.createScenario.bind(assets),
    ],
    ['create-case', createCaseInputSchema, assets.createCase.bind(assets)],
    [
      'create-scoped-case',
      createScopedCaseInputSchema,
      assets.createScopedCase.bind(assets),
    ],
  ] as const)
    add(
      'ath_assets',
      assetDescription,
      op,
      shape(op, schema),
      'write',
      (a, i) => method(a, i.projectId, i.input),
    );
  const checkpoints = new CoverageCheckpointService(assets.db);
  add(
    'ath_assets',
    assetDescription,
    'list-coverage-checkpoints',
    shape('list-coverage-checkpoints', coverageCheckpointScopeSchema),
    'read',
    (actor, request) =>
      checkpoints.list(actor, request.projectId, request.input),
  );
  add(
    'ath_assets',
    assetDescription,
    'save-coverage-checkpoint',
    shape('save-coverage-checkpoint', saveCoverageCheckpointInputSchema),
    'write',
    (actor, request) =>
      checkpoints.save(actor, request.projectId, request.input),
  );
  add(
    'ath_assets',
    assetDescription,
    'submit',
    shape('submit', assetChangeSetSchema),
    'write',
    (a, i) => assets.submit(a, i.projectId, i.input),
    async (a, i) => {
      if (
        !i.input.operations.some(
          (operation) => operation.operation === 'explicitRemove',
        )
      )
        return;
      await db.transaction((tx) =>
        requireProject(tx, a, i.projectId, 'assets.write'),
      );
      return {
        reason: 'impact',
        summary: '提交包含显式移除；仅影响列出的资产，不删除既有历史。',
        scope: {
          requested: i.input,
          removalImpacts: await Promise.all(
            i.input.operations
              .filter((operation) => operation.operation === 'explicitRemove')
              .map((operation) =>
                removalImpact(a, i.projectId, operation.targetId),
              ),
          ),
        },
        links: [`${link(i.projectId, 'assets')}?kind=${i.input.kind}`],
      };
    },
  );
  add(
    'ath_assets',
    assetDescription,
    'revise',
    z.strictObject({
      op: z.literal('revise'),
      ...target,
      input: reviseAssetInputSchema,
    }),
    'write',
    (a, i) => assets.revise(a, i.projectId, i.id, i.input),
  );
  add(
    'ath_assets',
    assetDescription,
    'explicit-remove',
    z.strictObject({
      op: z.literal('explicit-remove'),
      ...target,
      input: removeAssetInputSchema,
    }),
    'write',
    (a, i) => assets.explicitRemove(a, i.projectId, i.id, i.input),
    async (a, i) => {
      await db.transaction((tx) =>
        requireProject(tx, a, i.projectId, 'assets.write'),
      );
      return {
        reason: 'impact',
        summary: '显式移除此资产；已有版本、批准和执行历史保留。',
        scope: {
          impact: await removalImpact(a, i.projectId, i.id),
          requestedBase: i.input,
        },
        links: [link(i.projectId, 'assets', i.id)],
      };
    },
  );
  const reviewDescription =
    '读取意见、记录意见和优化说明；批准是tester的人工决定，AI优化不构成批准。';
  add(
    'ath_reviews',
    reviewDescription,
    'opinions',
    z.strictObject({
      op: z.literal('opinions'),
      ...target,
      revisionId: idSchema.optional(),
    }),
    'read',
    (a, i) => reviews.opinions(a, i.projectId, i.id, i.revisionId),
  );
  add(
    'ath_reviews',
    reviewDescription,
    'add-opinion',
    z.strictObject({
      op: z.literal('add-opinion'),
      ...target,
      input: addOpinionInputSchema,
    }),
    'write',
    (a, i) => reviews.addOpinion(a, i.projectId, i.id, i.input),
  );
  add(
    'ath_reviews',
    reviewDescription,
    'remove-opinion',
    z.strictObject({
      op: z.literal('remove-opinion'),
      ...target,
      opinionId: idSchema,
      input: removeOpinionInputSchema,
    }),
    'write',
    (a, i) => reviews.removeOpinion(a, i.projectId, i.id, i.opinionId, i.input),
  );
  add(
    'ath_reviews',
    reviewDescription,
    'optimization-notes',
    z.strictObject({
      op: z.literal('optimization-notes'),
      ...target,
      input: optimizationNotesInputSchema,
    }),
    'write',
    (a, i) => reviews.optimizationNotes(a, i.projectId, i.id, i.input),
  );
  add(
    'ath_reviews',
    reviewDescription,
    'meeting-handoff',
    z.strictObject({ op: z.literal('meeting-handoff'), ...target }),
    'read',
    (a, i) => uiReviews.handoff(a, i.projectId, i.id),
  );
  add(
    'ath_reviews',
    reviewDescription,
    'meeting-reply',
    z.strictObject({
      op: z.literal('meeting-reply'),
      ...target,
      input: uiReviewReplySchema,
    }),
    'write',
    (a, i) => uiReviews.reply(a, i.projectId, i.id, i.input),
  );
  add(
    'ath_reviews',
    reviewDescription,
    'preview-approve',
    shape('preview-approve', approvalPreviewInputSchema),
    'read',
    (a, i) => reviews.preview(a, i.projectId, i.input),
  );
  add(
    'ath_reviews',
    reviewDescription,
    'approve',
    shape('approve', approveCommitInputSchema),
    'write',
    (a, i) => reviews.commit(a, i.projectId, i.input),
    async (a, i) => {
      await db.transaction((tx) =>
        requireProject(tx, a, i.projectId, 'reviews.approve'),
      );
      const preview = (
        await db.query<{ items: unknown; scope_digest: string }>(
          'SELECT items,scope_digest FROM app.approval_previews WHERE id=$1 AND project_id=$2 AND actor_id=$3',
          [i.input.previewId, i.projectId, a.userId],
        )
      ).rows[0];
      if (!preview || preview.scope_digest !== i.input.scopeDigest)
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '确认预览不存在或摘要不匹配。',
          409,
        );
      if (a.entrypoint === 'official-mcp' && i.input.objectIds.length === 1)
        return;
      return {
        reason:
          i.input.objectIds.length > 1 ? 'precise-scope' : 'human-decision',
        summary: '人工批准以下精确对象；内容或评审上下文变化会逐项冲突。',
        scope: { ...preview, selectedIds: i.input.objectIds },
        links: i.input.objectIds.map((id) => link(i.projectId, 'assets', id)),
      };
    },
  );
  if (plans) {
    const ui = new UiExecutionService(db, plans);
    const planDescription =
      'UI计划固定批准范围；API计划引用逻辑case并在真正开始解析最新已审。不会远程启动本地UI浏览器。';
    add(
      'ath_plans',
      planDescription,
      'list',
      z.strictObject({
        op: z.literal('list'),
        ...project,
        kind: kindSchema.optional(),
      }),
      'read',
      (a, i) => plans.list(a, i.projectId, i.kind),
    );
    add(
      'ath_plans',
      planDescription,
      'get',
      z.strictObject({ op: z.literal('get'), ...target }),
      'read',
      (a, i) => plans.detail(a, i.projectId, i.id),
    );
    add(
      'ath_plans',
      planDescription,
      'create',
      shape('create', createPlanInputSchema),
      'write',
      (a, i) => plans.create(a, i.projectId, i.input),
    );
    add(
      'ath_plans',
      planDescription,
      'revise',
      z.strictObject({
        op: z.literal('revise'),
        ...target,
        input: revisePlanInputSchema,
      }),
      'write',
      (a, i) => plans.revise(a, i.projectId, i.id, i.input),
    );
    const apiDescription =
      '接受平台接口执行请求；业务HTTP和清理不自动重试，未知写结果先查原command。重叠必须确认精确在途集合。';
    add(
      'ath_api_runs',
      apiDescription,
      'start-preview',
      z.strictObject({
        op: z.literal('start-preview'),
        ...target,
        input: apiStartPreviewInputSchema,
      }),
      'read',
      (a, i) => plans.startPreview(a, i.projectId, i.id, i.input),
    );
    for (const op of ['start', 'manual-new-run'] as const)
      add(
        'ath_api_runs',
        apiDescription,
        op,
        z.strictObject({
          op: z.literal(op),
          ...target,
          input: apiQueueInputSchema,
        }),
        'write',
        (a, i) => plans.queue(a, i.projectId, i.id, i.input),
        async (a, i) => {
          await db.transaction((tx) =>
            requireProject(tx, a, i.projectId, 'runs.organize'),
          );
          const row = (
            await db.query<{ payload: unknown }>(
              'SELECT payload FROM app.api_start_previews WHERE id=$1 AND project_id=$2 AND actor_id=$3 AND plan_id=$4',
              [i.input.previewId, i.projectId, a.userId, i.id],
            )
          ).rows[0];
          if (!row)
            throw new DomainError('NOT_FOUND', '当前账号没有此开始预览。', 404);
          const preview = z
            .object({
              scopeDigest: z.string(),
              existingRunIds: z.array(z.string()),
              existingRequestIds: z.array(z.string()),
            })
            .parse(row.payload);
          if (preview.scopeDigest !== i.input.scopeDigest)
            throw new DomainError(
              'BUSINESS_CONFLICT',
              '开始预览摘要不匹配。',
              409,
            );
          if (
            !preview.existingRunIds.length &&
            !preview.existingRequestIds.length
          )
            return;
          return {
            reason: 'manual-overlap',
            summary: '同一接口计划已有在途轮次；确认仍按以下固定范围新开一轮。',
            scope: {
              preview: row.payload,
              selectedCaseIds: i.input.selectedCaseIds,
              confirmedExistingRunIds: i.input.confirmedExistingRunIds,
              confirmedExistingRequestIds: i.input.confirmedExistingRequestIds,
            },
            links: [link(i.projectId, 'plans', i.id)],
          };
        },
      );
    add(
      'ath_api_runs',
      apiDescription,
      'status',
      z.strictObject({
        op: z.literal('status'),
        ...target,
        targetType: z.enum(['run', 'request']),
      }),
      'read',
      (a, i) =>
        i.targetType === 'request'
          ? plans.requestStatus(a, i.projectId, i.id)
          : services.apiExecution
            ? services.apiExecution.status(a, i.projectId, i.id)
            : plans.run(a, i.projectId, i.id),
    );
    const uiDescription =
      '本地UI固定范围协议；只准备/领取/读取真实资料，不在服务器启动浏览器或声称观察。';
    add(
      'ath_ui_executions',
      uiDescription,
      'prepare',
      z.strictObject({
        op: z.literal('prepare'),
        ...project,
        planId: idSchema,
        planRevisionId: idSchema,
      }),
      'read',
      (a, i) => plans.uiScope(a, i.projectId, i.planId, i.planRevisionId),
    );
    add(
      'ath_ui_executions',
      uiDescription,
      'claim',
      shape('claim', claimLocalExecutionInputSchema),
      'write',
      (a, i) => ui.claim(a, i.projectId, i.input),
    );
    add(
      'ath_ui_executions',
      uiDescription,
      'status',
      z.strictObject({ op: z.literal('status'), ...project, runId: idSchema }),
      'read',
      async (a, i) => {
        const status = await ui.status(a, i.projectId, i.runId);
        if (status.kind !== 'UI')
          throw new DomainError('NOT_FOUND', '没有此本地UI执行。', 404);
        return status;
      },
    );
    for (const op of ['resume', 'get-scope'] as const)
      add(
        'ath_ui_executions',
        uiDescription,
        op,
        z.strictObject({ op: z.literal(op), ...project, runId: idSchema }),
        'read',
        (a, i) => ui.scope(a, i.projectId, i.runId),
      );
    add(
      'ath_ui_executions',
      uiDescription,
      'progress',
      shape('progress', uiProgressInputSchema),
      'write',
      (a, i) => ui.progress(a, i.projectId, i.input),
    );
    add(
      'ath_ui_executions',
      uiDescription,
      'close-progress',
      z.strictObject({
        op: z.literal('close-progress'),
        ...project,
        runId: idSchema,
        input: closeUiProgressInputSchema,
      }),
      'write',
      (a, i) => ui.closeProgress(a, i.projectId, i.runId, i.input),
    );
    add(
      'ath_ui_executions',
      uiDescription,
      'preview-close-progress-batch',
      shape(
        'preview-close-progress-batch',
        previewCloseUiProgressBatchInputSchema,
      ),
      'read',
      (a, i) => ui.previewCloseProgressBatch(a, i.projectId, i.input),
    );
    add(
      'ath_ui_executions',
      uiDescription,
      'close-progress-batch',
      shape('close-progress-batch', closeUiProgressBatchInputSchema),
      'write',
      (a, i) => ui.closeProgressBatch(a, i.projectId, i.input),
      async (a, i) => {
        const preview = await ui.previewCloseProgressBatch(a, i.projectId, {
          items: i.input.items,
        });
        if (preview.scopeDigest !== i.input.scopeDigest)
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '批量进度关闭范围摘要不匹配。',
            409,
          );
        return {
          reason: 'precise-scope',
          summary:
            '只关闭以下精确执行的平台进度展示，不停止本地AI，不改执行状态或结果；版本变化逐项冲突。',
          scope: preview,
          links: i.input.items.map((item) =>
            link(i.projectId, 'ui-executions', item.runId),
          ),
        };
      },
    );
    add(
      'ath_ui_executions',
      uiDescription,
      'get-close-progress-batch',
      z.strictObject({
        op: z.literal('get-close-progress-batch'),
        ...project,
        commandId: z.string().min(8).max(128),
      }),
      'read',
      (a, i) => ui.closeProgressBatchReceipt(a, i.projectId, i.commandId),
    );
  }
  if (services.apiExecution) {
    const execution = services.apiExecution;
    const qualificationDescription =
      '读取接口可回归版本。保存资格必须关联项目认可环境中完整通过的原调试，并按当前编辑基准提交。';
    add(
      'ath_api_runs',
      qualificationDescription,
      'list-regression-qualifications',
      z.strictObject({
        op: z.literal('list-regression-qualifications'),
        ...project,
      }),
      'read',
      (a, i) => execution.regression.list(a, i.projectId),
    );
    add(
      'ath_api_runs',
      qualificationDescription,
      'save-regression-qualification',
      shape('save-regression-qualification', saveApiRegressionInputSchema),
      'write',
      (a, i) => execution.regression.save(a, i.projectId, i.input),
      (_a, i) =>
        Promise.resolve({
          reason: 'precise-scope',
          summary: '为原调试的确切候选修订保存接口回归资格。',
          scope: {
            caseId: i.input.caseId,
            debugRunId: i.input.debugRunId,
            draftHash: i.input.draftHash,
          },
          links: [link(i.projectId, 'assets', i.input.caseId)],
        }),
    );
    add(
      'ath_api_runs',
      qualificationDescription,
      'get-regression-qualification-receipt',
      z.strictObject({
        op: z.literal('get-regression-qualification-receipt'),
        ...project,
        commandId: z.string().min(8).max(128),
      }),
      'read',
      (a, i) => execution.regression.saveReceipt(a, i.projectId, i.commandId),
    );
    add(
      'ath_api_runs',
      qualificationDescription,
      'withdraw-regression-qualification',
      shape(
        'withdraw-regression-qualification',
        withdrawApiRegressionInputSchema,
      ),
      'write',
      (a, i) => execution.regression.withdraw(a, i.projectId, i.input),
      (_a, i) =>
        Promise.resolve({
          reason: 'precise-scope',
          summary: '停止使用确切的接口回归快照，保留运行与证据历史。',
          scope: i.input,
          links: [],
        }),
    );
    add(
      'ath_api_runs',
      '读取安全接口请求/响应和断言细节；不开放worker凭据或任意HTTP/SQL。',
      'attempt-detail',
      z.strictObject({
        op: z.literal('attempt-detail'),
        ...project,
        runId: idSchema,
        attemptId: idSchema,
      }),
      'read',
      (a, i) => execution.attemptDetail(a, i.projectId, i.runId, i.attemptId),
    );
    add(
      'ath_api_runs',
      '从当前明确草稿启动独立接口调试；不产生批准，不修改正式用例，不重试原请求。',
      'debug-start',
      shape('debug-start', startDebugInputSchema),
      'write',
      (a, i) => execution.debug.start(a, i.projectId, i.input),
    );
    add(
      'ath_api_runs',
      '读取已有独立调试当轮的安全轨迹；不重放请求。',
      'debug-trace',
      z.strictObject({
        op: z.literal('debug-trace'),
        ...project,
        runId: idSchema,
      }),
      'read',
      (a, i) => execution.debug.trace(a, i.projectId, i.runId),
    );
    add(
      'ath_api_runs',
      '读取实际接口事件或停止后续；不重试未知请求。',
      'events',
      z.strictObject({
        op: z.literal('events'),
        ...project,
        runId: idSchema,
        after: z.number().int().min(0).default(0),
      }),
      'read',
      (a, i) => execution.events(a, i.projectId, i.runId, i.after),
    );
    add(
      'ath_api_runs',
      '读取实际接口事件或停止后续；不重试未知请求。',
      'stop-after-current',
      z.strictObject({
        op: z.literal('stop-after-current'),
        ...project,
        runId: idSchema,
        input: closeUiProgressInputSchema,
      }),
      'write',
      (a, i) => execution.stop(a, i.projectId, i.runId, i.input),
    );
  }
  add(
    'ath_results',
    '接收实际本地UI明细；原始判断、更正、人工最终结论与缺文件独立。平台AI不得构造实际观察。',
    'receipt',
    z.strictObject({
      op: z.literal('receipt'),
      ...project,
      submissionId: z.string().min(1).max(128),
    }),
    'read',
    (a, i) => results.receipt(a, i.projectId, i.submissionId),
  );
  add(
    'ath_results',
    '接收实际本地UI明细；原始判断、更正、人工最终结论与缺文件独立。平台AI不得构造实际观察。',
    'explicit-amendment',
    shape('explicit-amendment', resultAmendmentSchema),
    'write',
    (a, i) => results.amend(a, i.projectId, i.input),
  );
  add(
    'ath_results',
    '接收实际本地UI明细；原始判断、更正、人工最终结论与缺文件独立。平台AI不得构造实际观察。',
    'get',
    z.strictObject({ op: z.literal('get'), ...target }),
    'read',
    (a, i) => results.detail(a, i.projectId, i.id),
  );
  registry.add(
    'ath_results',
    '人工最终结论独立于原始判断；须由真实宿主表单或本人Web事件决定，模型文字不授权。',
    'assess',
    z.strictObject({
      op: z.literal('assess'),
      ...target,
      input: finalAssessmentInputSchema,
    }),
    'write',
    (a, i) => results.assess(a, i.projectId, i.id, i.input),
    async (a, i) => {
      await db.transaction((tx) =>
        requireProject(tx, a, i.projectId, 'results.assess'),
      );
      return {
        reason: 'human-decision',
        summary: '设置以下人工最终结论；不覆盖原始采集事实，不改变缺陷状态。',
        scope: {
          current: await results.detail(a, i.projectId, i.id),
          requested: i.input,
        },
        links: [`/api/v1/projects/${i.projectId}/results/${i.id}`],
      };
    },
  );
  const reportDescription =
    '授权报告事实和导出引用，原件走当前鉴权HTTP通道，不匿名分享。';
  add(
    'ath_reports',
    reportDescription,
    'list',
    z.strictObject({ op: z.literal('list'), ...project }),
    'read',
    (a, i) => reports.list(a, i.projectId),
  );
  add(
    'ath_reports',
    reportDescription,
    'list-executions',
    z.strictObject({
      op: z.literal('list-executions'),
      ...project,
      query: executionRecordQuerySchema.default({
        page: 1,
        pageSize: 20,
        kind: 'all',
        source: 'formal',
        search: '',
      }),
    }),
    'read',
    (a, i) => reports.records(a, i.projectId, i.query),
  );
  add(
    'ath_reports',
    reportDescription,
    'get-revision',
    z.strictObject({
      op: z.literal('get-revision'),
      ...target,
      revisionId: idSchema,
    }),
    'read',
    (a, i) => reports.revision(a, i.projectId, i.id, i.revisionId),
  );
  add(
    'ath_reports',
    reportDescription,
    'get',
    z.strictObject({ op: z.literal('get'), ...target }),
    'read',
    (a, i) => reports.detail(a, i.projectId, i.id),
  );
  add(
    'ath_reports',
    reportDescription,
    'search-in-scope',
    z.strictObject({
      op: z.literal('search-in-scope'),
      ...project,
      reportIds: z.array(idSchema).min(1).max(50),
      search: z.string().trim().min(1).max(200),
    }),
    'read',
    async (a, i) => {
      const selected = await Promise.all(
        [...new Set(i.reportIds)].map((id) =>
          reports.detail(a, i.projectId, id),
        ),
      );
      const query = i.search.toLocaleLowerCase();
      return {
        scopeReportIds: i.reportIds,
        matches: selected.flatMap(({ report }) =>
          report.facts.items
            .filter((item) =>
              JSON.stringify({
                scenario: item.scopeItem.scenario.title,
                title: item.scopeItem.content.title,
                observations: item.result?.content.actualObservations,
              })
                .toLocaleLowerCase()
                .includes(query),
            )
            .map((item) => ({
              reportId: report.id,
              reportRevisionId: report.revisionId,
              runItemId: item.scopeItem.runItemId,
              title: item.scopeItem.content.title,
              outcome: item.result?.reportedOutcome ?? null,
              detailPath: `/api/v1/projects/${i.projectId}/reports/${report.id}`,
            })),
        ),
      };
    },
  );
  add(
    'ath_reports',
    reportDescription,
    'export-reference',
    z.strictObject({ op: z.literal('export-reference'), ...target }),
    'read',
    async (a, i) => {
      const captured = await reports.captureExport(a, i.projectId, i.id);
      return {
        reportId: i.id,
        revisionId: captured.revisionId,
        downloadPath:
          a.entrypoint === 'official-mcp'
            ? `/api/v1/mcp/report-exports/${i.projectId}/${i.id}/${captured.revisionId}`
            : `/api/v1/projects/${i.projectId}/reports/${i.id}/export?revisionId=${captured.revisionId}`,
        requiresCurrentAuthorization: true,
        binaryThroughMcp: false,
      };
    },
  );
  registerIssueTools(registry, db, plans);
  registerKnowledgeTools(registry, db);
  if (services.auxiliary) registerAuxiliaryTools(registry, services.auxiliary);
  if (services.schedules) registerScheduleTools(registry, services.schedules);
  if (services.testConfiguration)
    registerInternalConfigurationTools(registry, services.testConfiguration);
  return registry;
}
