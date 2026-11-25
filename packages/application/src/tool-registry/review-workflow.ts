import { z } from 'zod';
import { commandIdSchema, idSchema } from '../../../contracts/src/base.js';
import {
  createScopedSceneInputSchema,
  removeScopedSceneInputSchema,
} from '../../../contracts/src/assets.js';
import {
  uiCaseImportInputSchema,
  uiCaseImportPreviewInputSchema,
} from '../../../contracts/src/ui-case-import.js';
import { renamePlanInputSchema } from '../../../contracts/src/plans.js';
import { supplementaryEvidenceResourceInputSchema } from '../../../contracts/src/ui-results.js';
import {
  fileReportIssueInputSchema,
  reportProblemReviewScopeSchema,
  resultRetestInputSchema,
} from '../../../contracts/src/issues.js';
import type { Database } from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { AssetService } from '../assets/service.js';
import { IssueService } from '../issues/service.js';
import { ResultService } from '../results/service.js';
import type { PlanService } from '../plans/service.js';
import type { BusinessToolRegistry } from './registry.js';

const project = { projectId: idSchema };
const target = { ...project, id: idSchema };
const input = <T extends z.ZodType>(op: string, schema: T) =>
  z.strictObject({ op: z.literal(op), ...project, input: schema });
const item = <T extends z.ZodType>(op: string, schema: T) =>
  z.strictObject({ op: z.literal(op), ...target, input: schema });

export function registerReviewWorkflowTools(
  registry: BusinessToolRegistry,
  db: Database,
  plans?: PlanService,
) {
  const assets = new AssetService(db);
  const issues = new IssueService(db);
  const results = new ResultService(db);
  const add = registry.add.bind(registry);
  const asset =
    '维护 UI 场景和用例。import-preview 预览导入，import-ui 经精确确认提交，import-receipt 查原回执。';
  add(
    'ath_assets',
    asset,
    'create-scoped-scene',
    input('create-scoped-scene', createScopedSceneInputSchema),
    'write',
    (actor, args) =>
      assets.createScopedScene(actor, args.projectId, args.input),
  );
  add(
    'ath_assets',
    asset,
    'scene-removal-preview',
    z.strictObject({ op: z.literal('scene-removal-preview'), ...target }),
    'read',
    (actor, args) =>
      assets.scopedSceneRemovalPreview(actor, args.projectId, args.id),
  );
  add(
    'ath_assets',
    asset,
    'remove-scoped-scene',
    item('remove-scoped-scene', removeScopedSceneInputSchema),
    'write',
    (actor, args) =>
      assets.removeScopedScene(actor, args.projectId, args.id, args.input),
    async (actor, args) => ({
      reason: 'impact',
      summary: '确认移除此 UI 场景及精确列出的用例。',
      scope: await assets.scopedSceneRemovalPreview(
        actor,
        args.projectId,
        args.id,
      ),
      links: [],
    }),
  );
  add(
    'ath_assets',
    asset,
    'import-preview',
    input('import-preview', uiCaseImportPreviewInputSchema),
    'read',
    (actor, args) =>
      assets.previewUiCaseImport(actor, args.projectId, args.input),
  );
  add(
    'ath_assets',
    asset,
    'import-ui',
    input('import-ui', uiCaseImportInputSchema),
    'write',
    (actor, args) => assets.importUiCases(actor, args.projectId, args.input),
    async (actor, args) => ({
      reason: 'precise-scope',
      summary: '确认导入所选 UI 用例及其场景关系。',
      scope: {
        preview: await assets.previewUiCaseImport(
          actor,
          args.projectId,
          uiCaseImportPreviewInputSchema.parse({
            requirementId: args.input.requirementId,
            sources: args.input.sources,
            mappings: args.input.mappings,
          }),
        ),
        selection: args.input.selection,
      },
      links: [],
    }),
  );
  add(
    'ath_assets',
    asset,
    'import-receipt',
    z.strictObject({
      op: z.literal('import-receipt'),
      ...project,
      commandId: commandIdSchema,
    }),
    'read',
    (actor, args) =>
      assets.uiCaseImportReceipt(actor, args.projectId, args.commandId),
  );

  const evidence = '按报告、结果修订与步骤追加证据或登记人工复测。';
  add(
    'ath_results',
    evidence,
    'human-retests',
    input('human-retests', reportProblemReviewScopeSchema),
    'read',
    (actor, args) =>
      results.readHumanRetests(actor, args.projectId, args.input),
  );
  add(
    'ath_results',
    evidence,
    'record-human-retest',
    input('record-human-retest', resultRetestInputSchema),
    'write',
    (actor, args) =>
      results.recordHumanRetest(actor, args.projectId, args.input),
    async (actor, args) => {
      await db.transaction((tx) =>
        requireProject(tx, actor, args.projectId, 'results.assess'),
      );
      return {
        reason: 'human-decision',
        summary: '确认以下人工复测结果及证据引用。',
        scope: args.input,
        links: [],
      };
    },
  );
  add(
    'ath_results',
    evidence,
    'add-evidence',
    input('add-evidence', supplementaryEvidenceResourceInputSchema),
    'write',
    (actor, args) => results.addEvidence(actor, args.projectId, args.input),
    async (actor, args) => {
      await db.transaction((tx) =>
        requireProject(tx, actor, args.projectId, 'results.submit'),
      );
      return {
        reason: 'precise-scope',
        summary: '确认将已验文件附到所选测试结果与步骤。',
        scope: args.input,
        links: [],
      };
    },
  );
  const issue =
    '从明确的报告修订和步骤关联或建立缺陷。report-assignees 仅读取本项目候选。';
  add(
    'ath_issues',
    issue,
    'report-assignees',
    z.strictObject({ op: z.literal('report-assignees'), ...project }),
    'read',
    (actor, args) => issues.reportAssignees(actor, args.projectId),
  );
  add(
    'ath_issues',
    issue,
    'file-from-report',
    input('file-from-report', fileReportIssueInputSchema),
    'write',
    (actor, args) => issues.fileFromReport(actor, args.projectId, args.input),
    async (actor, args) => {
      await db.transaction((tx) =>
        requireProject(tx, actor, args.projectId, 'reviews.approve'),
      );
      return {
        reason: 'precise-scope',
        summary: '确认按所选报告修订、步骤和真实观察提交缺陷。',
        scope: args.input,
        links: [],
      };
    },
  );
  if (plans) {
    const description = '查询批准依据或维护 UI/API 测试计划。';
    add(
      'ath_plans',
      description,
      'ui-eligibility',
      z.strictObject({ op: z.literal('ui-eligibility'), ...project }),
      'read',
      (actor, args) => plans.uiEligibility(actor, args.projectId),
    );
    add(
      'ath_plans',
      description,
      'rename',
      item('rename', renamePlanInputSchema),
      'write',
      (actor, args) => plans.rename(actor, args.projectId, args.id, args.input),
    );
  }
}
