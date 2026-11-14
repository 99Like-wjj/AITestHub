import { z } from 'zod';
import { associateRetestRunInputSchema } from '../../../contracts/src/preparation.js';
import { idSchema } from '../../../contracts/src/base.js';
import {
  createIssueInputSchema,
  issueListQuerySchema,
  issueHandlingInputSchema,
  issueEditInputSchema,
  issueSeverityInputSchema,
  manualVerificationInputSchema,
  lifecyclePreviewInputSchema,
  lifecycleCommitInputSchema,
  singleIssueLifecycleInputSchema,
  mergeIssuesInputSchema,
  unmergeIssueInputSchema,
  reportProblemInputSchema,
  problemListQuerySchema,
  confirmProblemInputSchema,
  dismissProblemInputSchema,
  previewProblemBatchInputSchema,
  commitProblemBatchInputSchema,
} from '../../../contracts/src/issues.js';
import type { Database } from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { IssueService } from '../issues/service.js';
import { IssueLifecycleService } from '../issues/lifecycle.js';
import { DomainError } from '../errors.js';
import type { BusinessToolRegistry } from './registry.js';
import type { PlanService } from '../plans/service.js';
import { RetestService } from '../retests/service.js';
import {
  prepareRetestInputSchema,
  startApiRetestInputSchema,
} from '../../../contracts/src/retests.js';
import { ProblemService } from '../issues/problems.js';

export function registerIssueTools(
  registry: BusinessToolRegistry,
  db: Database,
  plans?: PlanService,
): void {
  const issues = new IssueService(db);
  const lifecycle = new IssueLifecycleService(db);
  const project = { projectId: idSchema };
  const target = { ...project, id: idSchema };
  const add = registry.add.bind(registry);
  const problems = new ProblemService(db);
  const problemDescription =
    '失败事实与额外发现只进入待确认；tester明确确认/非缺陷，原始判断、人工最终结论与正式缺陷状态独立。';
  add(
    'ath_problems',
    problemDescription,
    'list',
    z.strictObject({
      op: z.literal('list'),
      ...project,
      input: problemListQuerySchema,
    }),
    'read',
    (a, i) => problems.list(a, i.projectId, i.input),
  );
  add(
    'ath_problems',
    problemDescription,
    'get',
    z.strictObject({ op: z.literal('get'), ...target }),
    'read',
    (a, i) => problems.detail(a, i.projectId, i.id),
  );
  add(
    'ath_problems',
    problemDescription,
    'report-extra',
    z.strictObject({
      op: z.literal('report-extra'),
      ...project,
      input: reportProblemInputSchema,
    }),
    'write',
    (a, i) => problems.report(a, i.projectId, i.input),
  );
  add(
    'ath_problems',
    problemDescription,
    'confirm',
    z.strictObject({
      op: z.literal('confirm'),
      ...target,
      input: confirmProblemInputSchema,
    }),
    'write',
    (a, i) => problems.confirm(a, i.projectId, i.id, i.input),
    async (a, i) => {
      await db.transaction((tx) =>
        requireProject(tx, a, i.projectId, 'reviews.approve'),
      );
      if (a.entrypoint !== 'internal-ai') return;
      return {
        reason: 'human-decision',
        summary:
          '将以下待确认问题明确确认为正式缺陷或关联现有缺陷；模型优化/判断不构成测试确认。',
        scope: {
          problem: (await problems.detail(a, i.projectId, i.id)).problem,
          decision: i.input,
        },
        links: [`/api/v1/projects/${i.projectId}/problems/${i.id}`],
      };
    },
  );
  add(
    'ath_problems',
    problemDescription,
    'dismiss',
    z.strictObject({
      op: z.literal('dismiss'),
      ...target,
      input: dismissProblemInputSchema,
    }),
    'write',
    (a, i) => problems.dismiss(a, i.projectId, i.id, i.input),
    async (a, i) => {
      await db.transaction((tx) =>
        requireProject(tx, a, i.projectId, 'reviews.approve'),
      );
      if (a.entrypoint !== 'internal-ai') return;
      return {
        reason: 'human-decision',
        summary: '将以下候选判为非缺陷；不会修改原始结果或人工最终结论。',
        scope: {
          problem: (await problems.detail(a, i.projectId, i.id)).problem,
          decision: i.input,
        },
        links: [`/api/v1/projects/${i.projectId}/problems/${i.id}`],
      };
    },
  );
  add(
    'ath_problems',
    problemDescription,
    'preview-confirm-batch',
    z.strictObject({
      op: z.literal('preview-confirm-batch'),
      ...project,
      input: previewProblemBatchInputSchema,
    }),
    'read',
    (a, i) => problems.previewBatch(a, i.projectId, i.input),
  );
  add(
    'ath_problems',
    problemDescription,
    'confirm-batch',
    z.strictObject({
      op: z.literal('confirm-batch'),
      ...project,
      input: commitProblemBatchInputSchema,
    }),
    'write',
    (a, i) => problems.confirmBatch(a, i.projectId, i.input),
    async (a, i) => {
      const preview = await problems.batchSelectionPreview(
        a,
        i.projectId,
        i.input,
      );
      if (preview.scopeDigest !== i.input.scopeDigest)
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '问题确认摘要与原预览不一致。',
          409,
        );
      return {
        reason: 'precise-scope',
        summary: '批量确认以下精确问题和正式缺陷目标；不按当前筛选扩大集合。',
        scope: { preview, problemIds: i.input.problemIds },
        links: preview.items.map(
          (item) =>
            `/api/v1/projects/${i.projectId}/problems/${item.problem.id}`,
        ),
      };
    },
  );
  if (plans) {
    const retests = new RetestService(db, plans);
    const retestDescription =
      '按原需求版本最新已审准备固定复测组；准备不是批准，不要求先造计划，不启动服务器UI。';
    add(
      'ath_retests',
      retestDescription,
      'list',
      z.strictObject({ op: z.literal('list'), ...project }),
      'read',
      (a, i) => retests.list(a, i.projectId),
    );
    add(
      'ath_retests',
      retestDescription,
      'get',
      z.strictObject({ op: z.literal('get'), ...target }),
      'read',
      (a, i) => retests.detail(a, i.projectId, i.id),
    );
    add(
      'ath_retests',
      retestDescription,
      'group',
      z.strictObject({ op: z.literal('group'), ...project, groupId: idSchema }),
      'read',
      (a, i) => retests.group(a, i.projectId, i.groupId),
    );
    add(
      'ath_retests',
      retestDescription,
      'start-preview',
      z.strictObject({
        op: z.literal('start-preview'),
        ...project,
        groupId: idSchema,
      }),
      'read',
      (a, i) => retests.startPreview(a, i.projectId, i.groupId),
    );
    for (const op of ['prepare', 'prepare-scope'] as const)
      add(
        'ath_retests',
        retestDescription,
        op,
        z.strictObject({
          op: z.literal(op),
          ...project,
          input: prepareRetestInputSchema,
        }),
        'write',
        (a, i) => retests.prepare(a, i.projectId, i.input),
      );
    add(
      'ath_retests',
      retestDescription,
      'associate-run',
      z.strictObject({
        op: z.literal('associate-run'),
        ...project,
        groupId: idSchema,
        input: associateRetestRunInputSchema,
      }),
      'write',
      (a, i) => retests.associateRun(a, i.projectId, i.groupId, i.input),
    );
    add(
      'ath_retests',
      retestDescription,
      'start-api',
      z.strictObject({
        op: z.literal('start-api'),
        ...project,
        groupId: idSchema,
        input: startApiRetestInputSchema,
      }),
      'write',
      (a, i) => retests.startApi(a, i.projectId, i.groupId, i.input),
      async (a, i) => {
        const preview = await retests.startPreview(a, i.projectId, i.groupId);
        if (!preview.existingRunIds.length) return;
        return {
          reason: 'manual-overlap',
          summary:
            '此固定接口复测组已有在途轮次；确认以下精确集合后才新开一轮，不重试原轮。',
          scope: { preview, requested: i.input },
          links: [`/api/v1/projects/${i.projectId}/retest-groups/${i.groupId}`],
        };
      },
    );
  }
  const description =
    '正式缺陷按当前角色创建/认领/指派/转交；管理身份不自动取得tester权限，处理不伪造复测。';
  add(
    'ath_issues',
    description,
    'list',
    z.strictObject({
      op: z.literal('list'),
      ...project,
      input: issueListQuerySchema,
    }),
    'read',
    (a, i) => issues.list(a, i.projectId, i.input),
  );
  add(
    'ath_issues',
    description,
    'get',
    z.strictObject({ op: z.literal('get'), ...target }),
    'read',
    (a, i) => issues.detail(a, i.projectId, i.id),
  );
  add(
    'ath_issues',
    description,
    'create',
    z.strictObject({
      op: z.literal('create'),
      ...project,
      input: createIssueInputSchema,
    }),
    'write',
    (a, i) => issues.create(a, i.projectId, i.input),
  );
  for (const op of [
    'assign',
    'claim',
    'transfer',
    'return',
    'takeover',
    'start-processing',
    'ready-for-retest',
  ] as const) {
    const schema = issueHandlingInputSchema.safeExtend({
      action: z.literal(op),
    });
    add(
      'ath_issues',
      description,
      op,
      z.strictObject({ op: z.literal(op), ...target, input: schema }),
      'write',
      (a, i) => issues.handle(a, i.projectId, i.id, i.input),
    );
  }
  add(
    'ath_issues',
    description,
    'edit',
    z.strictObject({
      op: z.literal('edit'),
      ...target,
      input: issueEditInputSchema,
    }),
    'write',
    (a, i) => issues.edit(a, i.projectId, i.id, i.input),
  );
  add(
    'ath_issues',
    description,
    'severity',
    z.strictObject({
      op: z.literal('severity'),
      ...target,
      input: issueSeverityInputSchema,
    }),
    'write',
    (a, i) => issues.severity(a, i.projectId, i.id, i.input),
  );
  add(
    'ath_retests',
    '人工复测记录与平台执行/缺陷状态独立；平台AI只提议，不能自称实际复测通过。',
    'record-manual-result',
    z.strictObject({
      op: z.literal('record-manual-result'),
      ...target,
      input: manualVerificationInputSchema,
    }),
    'write',
    (a, i) => issues.manualVerification(a, i.projectId, i.id, i.input),
    async (a, i) => {
      await db.transaction((tx) =>
        requireProject(tx, a, i.projectId, 'issues.lifecycle'),
      );
      return {
        reason: 'human-decision',
        summary: '记录以下人工复测结果；不会自动关闭或伪造平台执行。',
        scope: {
          issue: (await issues.detail(a, i.projectId, i.id)).issue,
          requested: i.input,
        },
        links: [`/?projectId=${i.projectId}&page=issues&objectId=${i.id}`],
      };
    },
  );
  const lifeDescription =
    '关闭/重开/合并记录与复测分开；批量关闭和关系影响须精确确认，未知先查原command。';
  add(
    'ath_issue_lifecycle',
    lifeDescription,
    'preview-close',
    z.strictObject({
      op: z.literal('preview-close'),
      ...project,
      input: lifecyclePreviewInputSchema.safeExtend({
        action: z.literal('close'),
      }),
    }),
    'read',
    (a, i) => lifecycle.preview(a, i.projectId, i.input),
  );
  add(
    'ath_issue_lifecycle',
    lifeDescription,
    'close',
    z.strictObject({
      op: z.literal('close'),
      ...project,
      input: lifecycleCommitInputSchema,
    }),
    'write',
    (a, i) => lifecycle.commit(a, i.projectId, i.input),
    async (a, i) => {
      await db.transaction((tx) =>
        requireProject(tx, a, i.projectId, 'issues.lifecycle'),
      );
      const row = (
        await db.query<{
          items: unknown;
          scope_digest: string;
          action: string;
        }>(
          'SELECT items,scope_digest,action FROM app.issue_lifecycle_previews WHERE id=$1 AND project_id=$2 AND actor_id=$3',
          [i.input.previewId, i.projectId, a.userId],
        )
      ).rows[0];
      if (
        !row ||
        row.action !== 'close' ||
        row.scope_digest !== i.input.scopeDigest
      )
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '关闭确认预览不存在或摘要不符。',
          409,
        );
      if (a.entrypoint === 'official-mcp' && i.input.objectIds.length === 1)
        return;
      return {
        reason:
          i.input.objectIds.length > 1 ? 'precise-scope' : 'human-decision',
        summary: '关闭以下精确缺陷；不会新增人工复测事实。',
        scope: { preview: row, selectedIds: i.input.objectIds },
        links: i.input.objectIds.map(
          (id) => `/?projectId=${i.projectId}&page=issues&objectId=${id}`,
        ),
      };
    },
  );
  add(
    'ath_issue_lifecycle',
    lifeDescription,
    'reopen',
    z.strictObject({
      op: z.literal('reopen'),
      ...target,
      input: singleIssueLifecycleInputSchema.safeExtend({
        action: z.literal('reopen'),
      }),
    }),
    'write',
    (a, i) => lifecycle.single(a, i.projectId, i.id, i.input),
  );
  add(
    'ath_issue_lifecycle',
    lifeDescription,
    'merge',
    z.strictObject({
      op: z.literal('merge'),
      ...project,
      input: mergeIssuesInputSchema,
    }),
    'write',
    (a, i) => lifecycle.merge(a, i.projectId, i.input),
    async (a, i) => {
      await db.transaction((tx) =>
        requireProject(tx, a, i.projectId, 'issues.lifecycle'),
      );
      const objects = await Promise.all(
        [i.input.masterId, ...i.input.sourceIds].map(
          async (id) => (await issues.detail(a, i.projectId, id)).issue,
        ),
      );
      return {
        reason: 'impact',
        summary: '合并下列精确缺陷关系；各自内容、状态、负责人和复测历史保留。',
        scope: { objects, input: i.input },
        links: objects.map(
          (object) =>
            `/?projectId=${i.projectId}&page=issues&objectId=${object.id}`,
        ),
      };
    },
  );
  add(
    'ath_issue_lifecycle',
    lifeDescription,
    'unmerge',
    z.strictObject({
      op: z.literal('unmerge'),
      ...project,
      input: unmergeIssueInputSchema,
    }),
    'write',
    (a, i) => lifecycle.unmerge(a, i.projectId, i.input),
    async (a, i) => {
      await db.transaction((tx) =>
        requireProject(tx, a, i.projectId, 'issues.lifecycle'),
      );
      const relation = (
        await db.query<{
          master_id: string;
          source_id: string;
          row_version: number;
          undone_at: Date | null;
        }>(
          'SELECT master_id,source_id,row_version,undone_at FROM app.issue_merges WHERE id=$1 AND project_id=$2',
          [i.input.mergeId, i.projectId],
        )
      ).rows[0];
      if (!relation)
        throw new DomainError('NOT_FOUND', '没有此合并关系。', 404);
      return {
        reason: 'impact',
        summary: '撤销以下精确合并关系；不覆盖后续内容和状态。',
        scope: {
          relation: {
            ...relation,
            undone_at: relation.undone_at?.toISOString() ?? null,
          },
          input: i.input,
        },
        links: [relation.master_id, relation.source_id].map(
          (id) => `/?projectId=${i.projectId}&page=issues&objectId=${id}`,
        ),
      };
    },
  );
}
