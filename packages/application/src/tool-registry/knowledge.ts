import { z } from 'zod';
import { idSchema } from '../../../contracts/src/base.js';
import {
  knowledgeIndexQuerySchema,
  knowledgeExportInputSchema,
  createKnowledgeSpaceInputSchema,
  reviseKnowledgeSpaceInputSchema,
  createKnowledgeEntryInputSchema,
  reviseKnowledgeEntryInputSchema,
  deleteKnowledgeEntryInputSchema,
  restoreKnowledgeInputSchema,
  compareKnowledgeInputSchema,
  commitKnowledgeSelectionInputSchema,
  knowledgeSelectionHistoryQuerySchema,
} from '../../../contracts/src/knowledge.js';
import type { Database } from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { KnowledgeService } from '../knowledge/service.js';
import { KnowledgeComparisons } from '../knowledge/comparisons.js';
import type { BusinessToolRegistry } from './registry.js';

export function registerKnowledgeTools(
  registry: BusinessToolRegistry,
  db: Database,
): void {
  const knowledge = new KnowledgeService(db);
  const comparisons = new KnowledgeComparisons(db);
  const add = registry.add.bind(registry);
  const project = { projectId: idSchema };
  const target = { ...project, entryId: idSchema };
  const description =
    '项目知识轻索引、按需正文与不可变历史；名称/hash不当身份，不默认加载整库，结构化配置只引用UUID。';
  add(
    'ath_knowledge',
    description,
    'spaces',
    z.strictObject({ op: z.literal('spaces'), ...project }),
    'read',
    (a, i) => knowledge.spaces(a, i.projectId),
  );
  for (const op of ['list-index', 'search'] as const)
    add(
      'ath_knowledge',
      description,
      op,
      z.strictObject({
        op: z.literal(op),
        ...project,
        input: knowledgeIndexQuerySchema,
      }),
      'read',
      (a, i) => knowledge.index(a, i.projectId, i.input),
    );
  add(
    'ath_knowledge',
    description,
    'get',
    z.strictObject({
      op: z.literal('get'),
      ...target,
      revisionId: idSchema.optional(),
    }),
    'read',
    (a, i) => knowledge.get(a, i.projectId, i.entryId, i.revisionId),
  );
  add(
    'ath_knowledge',
    description,
    'history',
    z.strictObject({ op: z.literal('history'), ...target }),
    'read',
    (a, i) => knowledge.history(a, i.projectId, i.entryId),
  );
  add(
    'ath_knowledge',
    description,
    'export',
    z.strictObject({
      op: z.literal('export'),
      ...project,
      input: knowledgeExportInputSchema,
    }),
    'read',
    (a, i) => knowledge.exportReference(a, i.projectId, i.input),
  );
  const changes =
    '普通明确单项知识写不额外审批；两端差异按人工明确选择提交，缺席不删，冲突不覆盖，恢复新增修订。';
  add(
    'ath_knowledge_changes',
    changes,
    'create-space',
    z.strictObject({
      op: z.literal('create-space'),
      ...project,
      input: createKnowledgeSpaceInputSchema,
    }),
    'write',
    (a, i) => knowledge.saveSpace(a, i.projectId, undefined, i.input),
  );
  add(
    'ath_knowledge_changes',
    changes,
    'revise-space',
    z.strictObject({
      op: z.literal('revise-space'),
      ...project,
      spaceId: idSchema,
      input: reviseKnowledgeSpaceInputSchema,
    }),
    'write',
    (a, i) => knowledge.saveSpace(a, i.projectId, i.spaceId, i.input),
  );
  add(
    'ath_knowledge_changes',
    changes,
    'create',
    z.strictObject({
      op: z.literal('create'),
      ...project,
      input: createKnowledgeEntryInputSchema,
    }),
    'write',
    (a, i) => knowledge.create(a, i.projectId, i.input),
  );
  add(
    'ath_knowledge_changes',
    changes,
    'revise',
    z.strictObject({
      op: z.literal('revise'),
      ...target,
      input: reviseKnowledgeEntryInputSchema,
    }),
    'write',
    (a, i) => knowledge.revise(a, i.projectId, i.entryId, i.input),
  );
  add(
    'ath_knowledge_changes',
    changes,
    'explicit-delete',
    z.strictObject({
      op: z.literal('explicit-delete'),
      ...target,
      input: deleteKnowledgeEntryInputSchema,
    }),
    'write',
    (a, i) => knowledge.remove(a, i.projectId, i.entryId, i.input),
    async (a, i) => {
      await db.transaction((tx) =>
        requireProject(tx, a, i.projectId, 'knowledge.write'),
      );
      return {
        reason: 'impact',
        summary:
          '显式删除此知识的当前入口；保留历史可恢复，后续知识引用及其旧派生不再加入模型上下文。',
        scope: {
          current: (await knowledge.history(a, i.projectId, i.entryId)).entry,
          input: i.input,
          historyRetained: true,
        },
        links: [
          `/api/v1/projects/${i.projectId}/knowledge/entries/${i.entryId}/history`,
        ],
      };
    },
  );
  add(
    'ath_knowledge_changes',
    changes,
    'compare',
    z.strictObject({
      op: z.literal('compare'),
      ...project,
      input: compareKnowledgeInputSchema,
    }),
    'read',
    (a, i) => comparisons.compare(a, i.projectId, i.input),
  );
  add(
    'ath_knowledge_changes',
    changes,
    'get-comparison',
    z.strictObject({
      op: z.literal('get-comparison'),
      ...project,
      comparisonId: idSchema,
    }),
    'read',
    (a, i) => comparisons.get(a, i.projectId, i.comparisonId),
  );
  add(
    'ath_knowledge_changes',
    changes,
    'get-selection-receipts',
    z.strictObject({
      op: z.literal('get-selection-receipts'),
      ...project,
      comparisonId: idSchema,
      input: knowledgeSelectionHistoryQuerySchema,
    }),
    'read',
    (a, i) =>
      comparisons.selectionHistory(a, i.projectId, i.comparisonId, i.input),
  );
  add(
    'ath_knowledge_changes',
    changes,
    'commit-explicit-selection',
    z.strictObject({
      op: z.literal('commit-explicit-selection'),
      ...project,
      input: commitKnowledgeSelectionInputSchema,
    }),
    'write',
    (a, i) => comparisons.commit(a, i.projectId, i.input),
    async (a, i) => ({
      reason: 'explicit-selection',
      summary:
        '只按以下原changeId与明确本地/平台/合并选择提交；未选条目保持不变。',
      scope: await comparisons.selectionPreview(a, i.projectId, i.input),
      links: [
        `/#knowledge?projectId=${i.projectId}&comparisonId=${i.input.comparisonId}`,
      ],
    }),
  );
  add(
    'ath_knowledge_changes',
    changes,
    'restore',
    z.strictObject({
      op: z.literal('restore'),
      ...target,
      input: restoreKnowledgeInputSchema,
    }),
    'write',
    (a, i) => knowledge.restore(a, i.projectId, i.entryId, i.input),
    async (a, i) => ({
      reason: 'explicit-selection',
      summary:
        '将明确选定的历史正文恢复为新当前修订；保留后来历史，不静默覆盖。',
      scope: {
        preview: await knowledge.restorePreview(
          a,
          i.projectId,
          i.entryId,
          i.input.sourceRevisionId,
        ),
        requested: i.input,
      },
      links: [
        `/api/v1/projects/${i.projectId}/knowledge/entries/${i.entryId}/history`,
      ],
    }),
  );
}
