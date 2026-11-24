import { z } from 'zod';
import {
commandIdSchema,
idSchema,
kindSchema,
persistedRowVersionSchema,
titleSchema,
timestampSchema,
sha256Schema,
} from './base.js';
import {
basisRefSchema,
caseContentSchema,
scenarioContentSchema,
reviewStateSchema,
requirementAssetBasisSchema,
preciseCommitInputSchema,
approvalSnapshotSchema,
} from './domain.js';
import { requirementMaterialLockSchema } from './requirements.js';

export const assetTargetTypeSchema = z.enum(['set', 'scenario', 'case']);
export const setContentSchema = z.strictObject({
  title: titleSchema,
  basisRefs: z.array(basisRefSchema).max(100),
});
export const assetContentSchema = z.union([
  setContentSchema,
  scenarioContentSchema,
  caseContentSchema,
]);
export const createSetInputSchema = z.strictObject({
  commandId: commandIdSchema,
  kind: kindSchema,
  requirementVersionId: idSchema.optional(),
  requirementId: idSchema.optional(),
  content: setContentSchema,
}).refine((input) => Boolean(input.requirementId || input.requirementVersionId), '请选择需求。');
export const createScenarioInputSchema = z.strictObject({
  commandId: commandIdSchema,
  setId: idSchema,
  content: scenarioContentSchema,
  basisRequirementVersionId: idSchema.optional(),
});
export const createCaseInputSchema = z.strictObject({
  commandId: commandIdSchema,
  scenarioId: idSchema,
  content: caseContentSchema,
  basisRequirementVersionId: idSchema.optional(),
});
export const caseSupplementOriginSchema = z.strictObject({
  caseId: idSchema,
  revisionId: idSchema,
  meetingId: idSchema.optional(),
  opinionId: idSchema.optional(),
  round: persistedRowVersionSchema.optional(),
  note: z.string().trim().min(1).max(4000),
}).refine(
  (origin) => origin.meetingId !== undefined || (origin.opinionId === undefined && origin.round === undefined),
  '意见或轮次需要明确的评审会话。',
);

export const caseSupplementOriginResultSchema = z.strictObject({
  origin: caseSupplementOriginSchema.nullable(),
});

export const uiSceneFieldsSchema = scenarioContentSchema.omit({
  kind: true,
  requirementVersionId: true,
  setId: true,
});
export const createScopedSceneInputSchema = z.strictObject({
  commandId: commandIdSchema,
  requirementId: idSchema,
  requirementVersionId: idSchema.optional(),
  content: uiSceneFieldsSchema,
  setId: idSchema.optional(),
});
export const createScopedCaseInputSchema = z.strictObject({
  commandId: commandIdSchema,
  kind: kindSchema,
  requirementVersionId: idSchema.optional(),
  requirementId: idSchema.optional(),
  scenario: z.union([
    z.strictObject({ scenarioId: idSchema }),
    uiSceneFieldsSchema.extend({ setId: idSchema.optional() }),
  ]),
  content: z.record(z.string(), z.json()),
  supplementOrigin: caseSupplementOriginSchema.optional(),
  checkpoint: z
    .strictObject({ id: idSchema, rowVersion: persistedRowVersionSchema })
    .optional(),
}).refine((input) => Boolean(input.requirementId || input.requirementVersionId), '请选择需求。');

export type CreateScopedCaseInput = z.infer<typeof createScopedCaseInputSchema>;

export const reviseAssetInputSchema = z.strictObject({
  commandId: commandIdSchema,
  baseRevisionId: idSchema,
  rowVersion: persistedRowVersionSchema,
  content: assetContentSchema,
  basisRequirementVersionId: idSchema.optional(),
});
export const removeAssetInputSchema = z.strictObject({
  commandId: commandIdSchema,
  baseRevisionId: idSchema,
  rowVersion: persistedRowVersionSchema,
});
export const removeScopedSceneInputSchema = removeAssetInputSchema.extend({
  caseIds: z.array(idSchema).refine(
    (ids) => new Set(ids).size === ids.length,
    '待移除用例不可重复。',
  ),
});
export const scopedSceneRemovalPreviewSchema = z.strictObject({
  sceneId: idSchema,
  baseRevisionId: idSchema,
  rowVersion: persistedRowVersionSchema,
  caseCount: z.number().int().nonnegative(),
  activePlanCount: z.number().int().nonnegative(),
  caseIds: z.array(idSchema),
});
export const assetListQuerySchema = z.strictObject({
  kind: kindSchema,
  requirementVersionId: idSchema.optional(),
  requirementId: idSchema.optional(),
  setId: idSchema.optional(),
  includeRemoved: z.boolean().default(false),
  includeArchivedRequirements: z.boolean().default(true),
}).refine((input) => !(input.requirementId && input.requirementVersionId), '请选择需求或固定历史范围。');
export const assetSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema,
  kind: kindSchema,
  requirementVersionId: idSchema,
  requirementBasis: requirementAssetBasisSchema.optional(),
  setId: idSchema,
  targetType: assetTargetTypeSchema,
  parentId: idSchema.nullable(),
  title: titleSchema,
  revisionId: idSchema,
  revisionNo: z.number().int().min(1),
  rowVersion: persistedRowVersionSchema,
  reviewState: reviewStateSchema,
  removedAt: z.string().nullable(),
  content: assetContentSchema,
});
export const addOpinionInputSchema = z.strictObject({
  commandId: commandIdSchema,
  targetRevisionId: idSchema,
  body: z.string().trim().min(1).max(10000),
});
export const approvalContentSnapshotSchema = z.strictObject({
  case: assetSchema,
  scenario: assetSchema,
  set: assetSchema,
  meetingDecisions: z.array(z.strictObject({
    meetingId:idSchema,opinionId:idSchema,round:z.number().int().positive(),revisionId:idSchema,
  })).optional(),
  opinions: z.array(
    z.strictObject({
      id: idSchema,
      assetId: idSchema,
      revisionId: idSchema,
      body: z.string(),
      rowVersion: persistedRowVersionSchema,
    }),
  ),
});
export type ApprovalContentSnapshot = z.infer<
  typeof approvalContentSnapshotSchema
>;
export const removeOpinionInputSchema = z.strictObject({
  commandId: commandIdSchema,
  rowVersion: persistedRowVersionSchema,
});
export const optimizationNotesInputSchema = z.strictObject({
  commandId: commandIdSchema,
  targetRevisionId: idSchema,
  // Required by the service for cross-revision notes; omitted legacy same-revision calls retain their original hash.
  rowVersion: persistedRowVersionSchema.optional(),
  notes: z
    .array(
      z.strictObject({
        opinionId: idSchema,
        sourceOpinionRevisionId: idSchema.optional(),
        note: z.string().trim().min(1).max(10000),
      }),
    )
    .min(1)
    .max(1000),
});
export const approvalPreviewInputSchema = z.strictObject({
  commandId: commandIdSchema,
  kind: kindSchema,
  objectIds: z
    .array(idSchema)
    .min(1)
    .max(10000)
    .refine((ids) => new Set(ids).size === ids.length, '目标不可重复'),
});
export const approveCommitInputSchema = preciseCommitInputSchema.refine(
  (input) => new Set(input.objectIds).size === input.objectIds.length,
  { path: ['objectIds'], message: '目标不可重复' },
);
export type AssetTargetType = z.infer<typeof assetTargetTypeSchema>;
export type AssetContent = z.infer<typeof assetContentSchema>;
export type Asset = z.infer<typeof assetSchema>;

export const assetListSchema = z.strictObject({ assets: z.array(assetSchema) });
export const assetReceiptSchema = z.strictObject({ asset: assetSchema });
export const optimizationNotesReceiptSchema = assetReceiptSchema.extend({
  approvalCreated: z.literal(false),
});
export const assetReceiptOperationSchema = z.enum([
  'assets.create-set',
  'assets.create-scenario',
  'assets.create-case',
  'assets.create-scoped-case',
  'assets.create-scoped-scene',
  'assets.remove-scoped-scene',
  'assets.revise',
  'assets.explicit-remove',
]);
export const assetOperationStatusSchema = z.strictObject({
  commandId: commandIdSchema,
  operation: assetReceiptOperationSchema,
  status: z.enum(['pending', 'completed', 'failed', 'unknown']),
  response: assetReceiptSchema.nullable(),
});
export const assetDetailSchema = z.strictObject({
  asset: assetSchema,
  revisions: z.array(
    z.strictObject({
      id: idSchema,
      revisionNo: z.number().int().min(1),
      content: assetContentSchema,
      requirementBasis: requirementAssetBasisSchema.optional(),
      createdAt: timestampSchema,
    }),
  ),
});
export const opinionsResponseSchema = z.strictObject({
  assetId: idSchema,
  revisionId: idSchema,
  currentRevisionId: idSchema,
  isCurrentRevision: z.boolean(),
  reviewState: reviewStateSchema,
  opinions: z.array(
    z.strictObject({
      id: idSchema,
      body: z.string(),
      createdBy: idSchema,
      createdAt: timestampSchema,
      removedAt: timestampSchema.nullable(),
      rowVersion: persistedRowVersionSchema,
    }),
  ),
  optimizationNotes: z.array(
    z.strictObject({
      id: idSchema,
      opinionId: idSchema,
      sourceOpinionRevisionId: idSchema,
      targetRevisionId: idSchema,
      note: z.string(),
      createdBy: idSchema,
      createdAt: timestampSchema,
    }),
  ),
});
export const approvalCommitReceiptSchema = z.strictObject({
  previewId: idSchema,
  scopeDigest: sha256Schema,
  results: z.array(
    z.discriminatedUnion('status', [
      z.strictObject({
        id: idSchema,
        status: z.literal('approved'),
        approvalSnapshotId: idSchema.nullable(),
      }),
      z.strictObject({
        id: idSchema,
        status: z.literal('conflict'),
        code: z.literal('STALE_BASE_REVISION'),
        statusCode: z.literal(412),
      }),
      z.strictObject({
        id: idSchema,
        status: z.literal('skipped'),
        code: z.literal('PRECONDITIONS_MISSING'),
        reasons: z.array(z.string()),
      }),
    ]),
  ),
});
export const latestApprovedResponseSchema = z.strictObject({
  approval: approvalSnapshotSchema,
  snapshot: approvalContentSnapshotSchema,
});
export const assetNavigationSchema = z.strictObject({
  requirements: z.array(
    z.strictObject({
      id: idSchema,
      title: titleSchema,
      archived: z.boolean(),
      currentVersionId: idSchema,
      materialLock: requirementMaterialLockSchema.nullable(),
      scenarioCount: z.number().int().min(0),
      caseCount: z.number().int().min(0),
      versions: z.array(
        z.strictObject({
          id: idSchema,
          versionNo: z.number().int().min(1),
          scenarioCount: z.number().int().min(0),
          caseCount: z.number().int().min(0),
        }),
      ),
    }),
  ),
});

export const assetNavigationQuerySchema = z.strictObject({
  kind: kindSchema,
  includeArchivedRequirements: z.boolean().default(true),
});
