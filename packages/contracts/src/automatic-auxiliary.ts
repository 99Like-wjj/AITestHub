import { z } from 'zod';
import { idSchema,commandIdSchema } from './base.js';
import {
auxiliaryPreflightReceiptSchema,
auxiliaryTaskReceiptSchema,
auxiliaryMaterialStructuralLimit,
} from './auxiliary.js';
import { modelDataScopeSchema } from './configuration.js';
import { requirementSchema,materialInputSchema } from './domain.js';
export const automaticAuxiliaryStateSchema = z.enum([
  'pendingPermission',
  'accepting',
  'accepted',
  'completed',
  'failed',
  'unknown',
  'superseded',
  'cancelled',
  'localMatched',
]);
export const automaticAuxiliaryIntentSchema = z.strictObject({
  id: idSchema,
  purpose: z.enum(['groupAlias', 'requirementLookup']),
  projectId: idSchema,
  requirementId: idSchema.nullable(),
  title: z.string(),
  state: automaticAuxiliaryStateSchema,
  auxiliaryTaskId: idSchema.nullable(),
  scopeDigest: z.string().nullable(),
  errorCode: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const automaticAuxiliaryListSchema = z.strictObject({
  intents: z.array(automaticAuxiliaryIntentSchema),
  hasMore: z.boolean(),
  nextCursor: idSchema.nullable(),
  modelAvailable: z.boolean(),
  modelUnavailableReason: z.string().nullable(),
});
export const automaticAliasPreviewSchema = z.strictObject({
  intent: automaticAuxiliaryIntentSchema,
  preflight: auxiliaryPreflightReceiptSchema,
});
export const acceptAutomaticAliasInputSchema = z.strictObject({
  commandId: commandIdSchema,
  scopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  dataScope: modelDataScopeSchema,
  confirmed: z.literal(true),
});
export const automaticAliasReceiptSchema = z.strictObject({
  intent: automaticAuxiliaryIntentSchema,
  task: auxiliaryTaskReceiptSchema.nullable(),
});
export const fullRequirementFindInputSchema = z.strictObject({
  commandId: commandIdSchema,
  projectId: idSchema,
  title: z.string().trim().min(1).max(200),
  businessNumber: z.string().trim().max(100).nullable(),
  summary: z.string().max(10000),
  materials: z
    .array(materialInputSchema)
    .min(1)
    .max(auxiliaryMaterialStructuralLimit)
    .refine(
      (items) => new Set(items.map((item) => item.order)).size === items.length,
      '材料顺序不可重复',
    ),
  dataScope: modelDataScopeSchema,
});
export type FullRequirementFindInput = z.infer<
  typeof fullRequirementFindInputSchema
>;
export const fullRequirementFindReceiptSchema = z.strictObject({
  candidates: z.array(requirementSchema),
  lookupIncomplete: z.boolean(),
  lookupMessage: z.string(),
  exactMaterialMatches: z
    .array(
      z.strictObject({
        requirementId: idSchema,
        requirementVersionId: idSchema,
        versionNo: z.number().int().positive(),
        latestVersionNo: z.number().int().positive(),
      }),
    )
    .default([]),
  defaultAssociation: z
    .strictObject({ requirementId: idSchema, requirementVersionId: idSchema })
    .nullable()
    .default(null),
  semantic: z.strictObject({
    state: z.enum([
      'localMatched',
      'waitingPermission',
      'accepted',
      'notConfigured',
      'unavailable',
      'unknown',
    ]),
    intentId: idSchema.nullable(),
    auxiliaryCommandId: z.string().nullable(),
    task: auxiliaryTaskReceiptSchema.nullable(),
    errorCode: z.string().nullable(),
  }),
});

export const automaticAuxiliaryListQuerySchema = z.strictObject({
  projectId: idSchema.optional(),
  afterId: idSchema.optional(),
});
