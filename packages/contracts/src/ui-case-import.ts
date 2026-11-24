import { z } from 'zod';
import {
  commandIdSchema,
  idSchema,
  persistedRowVersionSchema,
  sha256Schema,
  titleSchema,
} from './base.js';
import { uiSceneFieldsSchema, setContentSchema } from './assets.js';
import { uiCaseContentSchema } from './domain.js';

const draftLocalId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const existing = z.strictObject({
  id: idSchema,
  baseRevisionId: idSchema,
  action: z.enum(['reference', 'revise']),
  rowVersion: persistedRowVersionSchema,
}).optional();
const draftSet = setContentSchema.extend({ localId: draftLocalId, existing });
const draftScene = uiSceneFieldsSchema.extend({
  localId: draftLocalId,
  setLocalId: draftLocalId,
  existing,
});
const draftCase = uiCaseContentSchema.omit({ scenarioId: true }).extend({
  localId: draftLocalId,
  scenarioLocalId: draftLocalId,
  existing,
});
const draftGap = z.strictObject({
  id: draftLocalId,
  localIds: z.array(draftLocalId).max(10_000),
  description: z.string().min(1).max(4_000),
  blocksSubmission: z.boolean(),
});
const draftNotes = z.strictObject({
  localId: draftLocalId,
  assetLocalId: draftLocalId,
  target: z.enum(['writtenRevision', 'baseRevision']),
  notes: z.array(z.strictObject({
    opinionId: idSchema,
    sourceOpinionRevisionId: idSchema,
    note: z.string().trim().min(1).max(10_000),
  })).min(1).max(1_000),
});

// UI slice of the S01 draft interchange format. API proposals and private
// outboxes have separate consumers and are not read by the UI import route.
export const uiCaseDesignDraftSchema = z.strictObject({
  schemaVersion: z.literal('ath.case-design.draft.v2'),
  draftId: idSchema,
  intent: z.enum(['generate', 'organize', 'optimize']),
  projectId: idSchema,
  requirementId: idSchema.optional(),
  requirementVersionId: idSchema,
  kind: z.literal('UI'),
  mode: z.enum(['incremental', 'completeSet']),
  sets: z.array(draftSet).min(1).max(1_000),
  scenarios: z.array(draftScene).max(10_000),
  cases: z.array(draftCase).max(10_000),
  gaps: z.array(draftGap).max(1_000),
  optimizationNotes: z.array(draftNotes).max(1_000),
});
export type UiCaseDesignDraft = z.infer<typeof uiCaseDesignDraftSchema>;

const packageIndex = z.number().int().nonnegative();
const target = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('new'), title: titleSchema.optional() }),
  z.strictObject({ kind: z.literal('existing'), sceneId: idSchema }),
]);
const selector = z.strictObject({ packageIndex, caseLocalId: draftLocalId });
const sceneSelector = z.strictObject({ packageIndex, sceneLocalId: draftLocalId });
export const uiCaseImportPreviewInputSchema = z.strictObject({
  requirementId: idSchema,
  sources: z.array(z.strictObject({
    label: z.string().trim().min(1).max(512),
    text: z.string().min(1).max(1_000_000),
  })).min(1).max(50),
  mappings: z.array(sceneSelector.extend({ target })).max(10_000),
});
export const uiCaseImportInputSchema = uiCaseImportPreviewInputSchema.extend({
  commandId: commandIdSchema,
  digest: sha256Schema,
  selection: z.array(selector).min(1).max(10_000),
});
export const uiCaseImportPreviewSchema = z.strictObject({
  digest: sha256Schema,
  packages: z.array(z.strictObject({
    packageIndex,
    label: z.string(),
    draftId: idSchema.optional(),
    projectId: idSchema.optional(),
    requirementId: idSchema.optional(),
    requirementVersionId: idSchema.optional(),
    oldBasis: z.boolean().optional(),
    errors: z.array(z.string()),
    gaps: z.array(draftGap.pick({ description: true, blocksSubmission: true })),
    scenes: z.array(z.strictObject({
      sceneLocalId: draftLocalId,
      title: titleSchema,
      matchedSceneIds: z.array(idSchema),
      target: target.optional(),
      problems: z.array(z.string()),
      cases: z.array(z.strictObject({
        caseLocalId: draftLocalId,
        title: titleSchema,
        testPoint: z.string().optional(),
        expected: z.string().optional(),
        problems: z.array(z.string()),
        action: z.enum(['create', 'revise']).optional(),
      })),
    })),
  })),
});
export const uiCaseImportReceiptSchema = z.strictObject({
  items: z.array(z.discriminatedUnion('status', [
    selector.merge(sceneSelector).extend({
      status: z.literal('accepted'),
      sceneId: idSchema,
      assetId: idSchema,
      revisionId: idSchema,
    }),
    selector.merge(sceneSelector).extend({
      status: z.literal('rejected'),
      reason: z.string(),
    }),
  ])),
});
export const uiCaseImportOperationStatusSchema = z.strictObject({
  status: z.enum(['pending', 'completed', 'failed', 'unknown']),
  response: uiCaseImportReceiptSchema.nullable(),
});
export type UiCaseImportPreviewInput = z.infer<typeof uiCaseImportPreviewInputSchema>;
export type UiCaseImportPreview = z.infer<typeof uiCaseImportPreviewSchema>;
export type UiCaseImportReceipt = z.infer<typeof uiCaseImportReceiptSchema>;
