import { z } from 'zod';
import {
idSchema,
commandIdSchema,
persistedRowVersionSchema,
titleSchema,
timestampSchema,
sha256Schema,
} from './base.js';

const uniqueIds = z
  .array(idSchema)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, '标识不可重复');
const sourceUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    ['http:', 'https:'].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.search
  );
}, '来源地址须无凭据和查询参数');
export const knowledgeSourceRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('requirementVersion'),
    requirementVersionId: idSchema,
    note: z.string().max(2000),
  }),
  z.strictObject({
    kind: z.literal('file'),
    fileId: idSchema,
    note: z.string().max(2000),
  }),
  z.strictObject({
    kind: z.literal('url'),
    url: sourceUrl,
    note: z.string().max(2000),
  }),
]);
export const knowledgeContentSchema = z.strictObject({
  title: titleSchema,
  summary: z.string().max(2000),
  tags: z
    .array(z.string().trim().min(1).max(60))
    .max(30)
    .refine((tags) => new Set(tags).size === tags.length, '标签不可重复'),
  body: z.string().max(100_000),
  configurationRefs: z
    .array(
      z.strictObject({
        configurationId: idSchema,
        description: z.string().max(2000),
      }),
    )
    .max(100)
    .refine(
      (refs) =>
        new Set(refs.map((ref) => ref.configurationId)).size === refs.length,
      '配置引用不可重复',
    ),
  sourceRefs: z.array(knowledgeSourceRefSchema).max(100),
});
export type KnowledgeContent = z.infer<typeof knowledgeContentSchema>;
export const createKnowledgeSpaceInputSchema = z.strictObject({
  commandId: commandIdSchema,
  name: titleSchema,
  description: z.string().max(2000),
});
export const reviseKnowledgeSpaceInputSchema =
  createKnowledgeSpaceInputSchema.safeExtend({
    rowVersion: persistedRowVersionSchema,
  });
export const createKnowledgeEntryInputSchema = z.strictObject({
  commandId: commandIdSchema,
  spaceId: idSchema,
  content: knowledgeContentSchema,
});
export const reviseKnowledgeEntryInputSchema = z.strictObject({
  commandId: commandIdSchema,
  spaceId: idSchema.optional(),
  rowVersion: persistedRowVersionSchema,
  baseRevisionId: idSchema,
  content: knowledgeContentSchema,
});
export const deleteKnowledgeEntryInputSchema = z.strictObject({
  commandId: commandIdSchema,
  rowVersion: persistedRowVersionSchema,
  baseRevisionId: idSchema,
});
export const restoreKnowledgeInputSchema =
  deleteKnowledgeEntryInputSchema.safeExtend({ sourceRevisionId: idSchema });
export const knowledgeIndexQuerySchema = z.strictObject({
  spaceId: idSchema.optional(),
  query: z.string().trim().max(200).default(''),
  tag: z.string().max(60).optional(),
  includeDeleted: z.boolean().default(false),
  afterId: idSchema.optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export const knowledgeSpaceSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema,
  name: titleSchema,
  description: z.string(),
  rowVersion: persistedRowVersionSchema,
  createdAt: timestampSchema,
});
export const knowledgeIndexItemSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema,
  spaceId: idSchema,
  title: titleSchema,
  summary: z.string(),
  tags: z.array(z.string()),
  revisionId: idSchema,
  revisionNo: z.number().int().min(1),
  rowVersion: persistedRowVersionSchema,
  contentDigest: sha256Schema,
  deleted: z.boolean(),
  updatedAt: timestampSchema,
});
export const knowledgeRevisionSchema = z.strictObject({
  id: idSchema,
  entryId: idSchema,
  revisionNo: z.number().int().min(1),
  content: knowledgeContentSchema,
  contentDigest: sha256Schema,
  deleted: z.boolean(),
  restoredFromRevisionId: idSchema.nullable(),
  createdBy: idSchema,
  createdAt: timestampSchema,
});
export const knowledgeEntryResponseSchema = z.strictObject({
  entry: knowledgeIndexItemSchema,
  revision: knowledgeRevisionSchema,
});
export const knowledgeIndexResponseSchema = z.strictObject({
  entries: z.array(knowledgeIndexItemSchema),
  nextCursor: idSchema.nullable(),
  hasMore: z.boolean(),
  searchMethod: z.literal('case-insensitive-substring'),
});

const manifestIdentity = {
  localId: z.string().min(1).max(128),
  entryId: idSchema.nullable(),
  baseRevisionId: idSchema.nullable(),
};
export const knowledgeLocalManifestItemSchema = z.discriminatedUnion(
  'operation',
  [
    z.strictObject({
      operation: z.literal('upsert'),
      ...manifestIdentity,
      content: knowledgeContentSchema,
    }),
    z.strictObject({
      operation: z.literal('explicitDelete'),
      localId: manifestIdentity.localId,
      entryId: idSchema,
      baseRevisionId: idSchema,
    }),
  ],
);
export const compareKnowledgeInputSchema = z.strictObject({
  commandId: commandIdSchema,
  spaceId: idSchema,
  remoteEntryIds: uniqueIds.optional(),
  localManifest: z
    .array(knowledgeLocalManifestItemSchema)
    .max(100)
    .refine(
      (items) =>
        new Set(items.map((item) => item.localId)).size === items.length,
      '本地标识不可重复',
    )
    .refine((items) => {
      const ids = items.flatMap((item) => (item.entryId ? [item.entryId] : []));
      return new Set(ids).size === ids.length;
    }, '每个正式知识身份只比较一次')
    .refine(
      (items) =>
        items.every(
          (item) => item.entryId !== null || item.baseRevisionId === null,
        ),
      '新条目没有旧正式基准',
    ),
});
export const knowledgeChoiceSchema = z.discriminatedUnion('choice', [
  z.strictObject({ changeId: idSchema, choice: z.literal('local') }),
  z.strictObject({ changeId: idSchema, choice: z.literal('remote') }),
  z.strictObject({
    changeId: idSchema,
    choice: z.literal('merged'),
    content: knowledgeContentSchema,
  }),
]);
export const commitKnowledgeSelectionInputSchema = z.strictObject({
  commandId: commandIdSchema,
  comparisonId: idSchema,
  scopeDigest: sha256Schema,
  selections: z
    .array(knowledgeChoiceSchema)
    .min(1)
    .max(100)
    .refine(
      (selections) =>
        new Set(selections.map((selection) => selection.changeId)).size ===
        selections.length,
      '选择不可重复',
    ),
});
export const knowledgeComparisonItemSchema = z.strictObject({
  changeId: idSchema,
  localId: z.string().nullable(),
  entryId: idSchema.nullable(),
  classification: z.enum([
    'create',
    'update',
    'explicitDelete',
    'conflict',
    'unchanged',
  ]),
  reason: z.string(),
  localOperation: z.enum(['upsert', 'explicitDelete']).nullable(),
  localBaseRevisionId: idSchema.nullable(),
  remoteRevisionId: idSchema.nullable(),
  remoteRowVersion: persistedRowVersionSchema.nullable(),
  remoteDeleted: z.boolean(),
  localContent: knowledgeContentSchema.nullable(),
  remoteContent: knowledgeContentSchema.nullable(),
  remoteIndex: knowledgeIndexItemSchema.nullable(),
  matchCandidates: z.array(knowledgeIndexItemSchema),
});
export const knowledgeComparisonSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema,
  spaceId: idSchema,
  scopeDigest: sha256Schema,
  items: z.array(knowledgeComparisonItemSchema).max(1000),
  createdAt: timestampSchema,
  omittedRemoteEntriesDeleted: z.literal(false),
});
export type KnowledgeComparisonItem = z.infer<
  typeof knowledgeComparisonItemSchema
>;
export const knowledgeComparisonResponseSchema = z.strictObject({
  comparison: knowledgeComparisonSchema,
});
export const knowledgeSelectionReceiptSchema = z.strictObject({
  comparisonId: idSchema,
  scopeDigest: sha256Schema,
  selectionId: idSchema,
  results: z.array(
    z.strictObject({
      changeId: idSchema,
      status: z.enum([
        'created',
        'updated',
        'deleted',
        'keptRemote',
        'unchanged',
        'conflict',
      ]),
      entryId: idSchema.nullable(),
      revisionId: idSchema.nullable(),
      code: z.string().nullable(),
      localContent: knowledgeContentSchema.nullable(),
      remoteCurrent: knowledgeIndexItemSchema.nullable(),
    }),
  ),
});
export const knowledgeSelectionHistoryQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  afterSelectionId: idSchema.optional(),
});
export const knowledgeSelectionHistorySchema = z.strictObject({
  comparisonId: idSchema,
  scopeDigest: sha256Schema,
  selections: z
    .array(
      z.strictObject({
        createdAt: timestampSchema,
        receipt: knowledgeSelectionReceiptSchema,
      }),
    )
    .max(50),
  hasMore: z.boolean(),
  nextCursor: idSchema.nullable(),
});
export const knowledgeExportSelectionSchema = z
  .array(z.strictObject({ entryId: idSchema, revisionId: idSchema }))
  .min(1)
  .max(20)
  .refine(
    (items) => new Set(items.map((item) => item.entryId)).size === items.length,
    '导出知识不可重复',
  );
export const knowledgeExportInputSchema = z.strictObject({
  entryIds: uniqueIds.min(1).max(20),
});
export const knowledgeSpacesResponseSchema = z.strictObject({
  spaces: z.array(knowledgeSpaceSchema),
});
export const knowledgeSpaceResponseSchema = z.strictObject({
  space: knowledgeSpaceSchema,
});
export const knowledgeHistoryResponseSchema = z.strictObject({
  entry: knowledgeIndexItemSchema,
  revisions: z.array(
    knowledgeRevisionSchema
      .omit({ entryId: true, content: true })
      .safeExtend({ title: titleSchema, summary: z.string() }),
  ),
});
export const knowledgeRestorePreviewSchema = z.strictObject({
  current: knowledgeIndexItemSchema,
  source: knowledgeRevisionSchema,
  effect: z.string(),
});
export const knowledgeExportReferenceSchema = z.strictObject({
  projectId: idSchema,
  selection: knowledgeExportSelectionSchema,
  downloadPath: z.string(),
  requiresCurrentAuthorization: z.literal(true),
});
export type KnowledgeIndexItem = z.infer<typeof knowledgeIndexItemSchema>;
export type KnowledgeComparison = z.infer<typeof knowledgeComparisonSchema>;
export const knowledgeOperationLookupSchema = z.strictObject({
  operation: z.enum([
    'knowledge.spaces.create',
    'knowledge.spaces.revise',
    'knowledge.create',
    'knowledge.revise',
    'knowledge.explicit-delete',
    'knowledge.restore',
    'knowledge.compare',
    'knowledge.commit-selection',
  ]),
  key: commandIdSchema,
});
export const knowledgeOperationStatusSchema = z.strictObject({
  command: z.strictObject({
    id: idSchema,
    operation: z.string(),
    status: z.enum(['pending', 'completed', 'failed', 'unknown']),
    projectId: idSchema.nullable(),
    response: z.json(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  }),
});
export const deleteKnowledgeEntryReceiptSchema = z.strictObject({
  entry: knowledgeIndexItemSchema,
  historyRetained: z.literal(true),
});
