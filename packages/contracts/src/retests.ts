import { z } from 'zod';
import {
idSchema,
commandIdSchema,
titleSchema,
persistedRowVersionSchema,
} from './base.js';
import { scopeItemSchema,missingRequirementSchema,executionScopeSchema } from './domain.js';
import { testConfigurationDtoSchema } from './test-configuration.js';
const ids = z
  .array(idSchema)
  .max(1000)
  .refine((v) => new Set(v).size === v.length, '对象不可重复');
export const prepareRetestInputSchema = z.strictObject({
  commandId: commandIdSchema,
  name: titleSchema,
  selections: z
    .array(
      z.strictObject({
        issueId: idSchema,
        rowVersion: persistedRowVersionSchema,
        kind: z.enum(['UI', 'API']),
        level: z.enum(['case', 'scenario']),
        environmentId: idSchema,
        productBuild: z.string().max(200).nullable(),
        requirementVersionId: idSchema.optional(),
        caseIds: ids.optional(),
        scenarioIds: ids.optional(),
        contextLabel: z.string().max(2000).optional(),
      }),
    )
    .min(1)
    .max(1000),
});
export const retestContextSchema = z.strictObject({
  label: z.string().max(2000),
  sourceRunIds: ids,
});
export const retestGroupTemplateSchema = z.strictObject({
  groupId: idSchema,
  kind: z.enum(['UI', 'API']),
  environment: testConfigurationDtoSchema,
  productBuild: z.string().max(200).nullable(),
  context: retestContextSchema,
  items: z
    .array(scopeItemSchema.omit({ runItemId: true }))
    .min(1)
    .max(10000),
  missingRequirements: z.array(missingRequirementSchema),
});
export const retestPreparationSchema = z.strictObject({
  preparationId: idSchema,
  revisionId: idSchema,
  name: titleSchema,
  createdBy: idSchema,
  createdAt: z.string(),
  groups: z.array(retestGroupTemplateSchema),
  missingRequirements: z.array(missingRequirementSchema),
});
export const retestPreparationListSchema = z.strictObject({
  preparations: z.array(
    z.strictObject({
      id: idSchema,
      revisionId: idSchema,
      name: titleSchema,
      createdBy: idSchema,
      createdAt: z.string(),
    }),
  ),
});
export const startApiRetestInputSchema = z.strictObject({
  commandId: commandIdSchema,
  scopeDigest:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  confirmedExistingRunIds: ids.default([]),
});
export const apiRetestStartReceiptSchema=z.strictObject({runId:idSchema,state:z.literal('prepared'),scope:executionScopeSchema});
export const apiRetestStartPreviewSchema=z.strictObject({group:retestGroupTemplateSchema,scopeDigest:z.string().regex(/^[a-f0-9]{64}$/),existingRunIds:ids});
export const apiRetestStartStatusSchema=z.strictObject({commandId:commandIdSchema,status:z.enum(['pending','completed','failed','unknown']),response:apiRetestStartReceiptSchema.nullable()});
