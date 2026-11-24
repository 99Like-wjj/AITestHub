import { z } from 'zod';
import {
  commandIdSchema,
  idSchema,
  persistedRowVersionSchema,
  timestampSchema,
  titleSchema,
} from './base.js';
import {
  apiCaseContentSchema,
  apiRunScenarioSchema,
  localIdSchema,
  requirementAssetBasisSchema,
} from './domain.js';

export const apiProjectScenarioContentSchema = apiRunScenarioSchema;

const apiProjectAssetIdentitySchema = z.strictObject({
  id: idSchema,
  projectId: idSchema,
  kind: z.literal('API'),
  title: titleSchema,
  revisionId: idSchema,
  revisionNo: z.number().int().positive(),
  rowVersion: persistedRowVersionSchema,
  removedAt: timestampSchema.nullable(),
  requirementVersionId: idSchema.nullable(),
  requirementBasis: requirementAssetBasisSchema.optional(),
});
export const apiProjectScenarioSchema = apiProjectAssetIdentitySchema.extend({
  targetType: z.literal('scenario'),
  parentId: z.null(),
  content: apiProjectScenarioContentSchema,
});
export const apiProjectCaseSchema = apiProjectAssetIdentitySchema.extend({
  targetType: z.literal('case'),
  parentId: idSchema.nullable(),
  content: apiCaseContentSchema,
});
export const apiProjectAssetSchema = z.discriminatedUnion('targetType', [
  apiProjectScenarioSchema,
  apiProjectCaseSchema,
]);
export const apiAutomationListSchema = z.strictObject({
  scenarios: z.array(apiProjectScenarioSchema),
  cases: z.array(apiProjectCaseSchema),
});
export const apiAutomationListInputSchema = z.strictObject({
  includeArchived: z.boolean().optional(),
});
export const apiAutomationGetInputSchema = z.strictObject({
  assetId: idSchema,
  revisionId: idSchema.optional(),
});
export const apiAutomationRevisionsInputSchema = z.strictObject({
  assetId: idSchema,
});
export const apiAutomationRevisionsSchema = z.strictObject({
  revisions: z.array(
    z.strictObject({
      revisionId: idSchema,
      revisionNo: z.number().int().positive(),
      createdAt: timestampSchema,
    }),
  ),
});
export const apiAutomationCreateScenarioInputSchema = z.strictObject({
  commandId: commandIdSchema,
  requirementId: idSchema.optional(),
  content: apiProjectScenarioContentSchema,
});
export const apiAutomationCreateCaseInputSchema = z.strictObject({
  commandId: commandIdSchema,
  basisRequirementVersionId: idSchema.optional(),
  content: apiCaseContentSchema,
});
const editBaseSchema = z.strictObject({
  commandId: commandIdSchema,
  assetId: idSchema,
  baseRevisionId: idSchema,
  rowVersion: persistedRowVersionSchema,
});
export const apiAutomationReviseScenarioInputSchema = editBaseSchema.extend({
  requirementId: idSchema.optional(),
  content: apiProjectScenarioContentSchema,
});
export const apiAutomationReviseCaseInputSchema = editBaseSchema.extend({
  basisRequirementVersionId: idSchema.optional(),
  content: apiCaseContentSchema,
});
export const apiAutomationArchiveInputSchema = editBaseSchema;
export const apiProjectQualificationSnapshotSchema = z.strictObject({
  case: apiProjectCaseSchema,
  scenario: apiProjectScenarioSchema.nullable(),
  qualifiedDataRowIds: z.array(localIdSchema).max(100),
});

export type ApiProjectAsset = z.infer<typeof apiProjectAssetSchema>;
export type ApiProjectCase = z.infer<typeof apiProjectCaseSchema>;
export type ApiProjectScenario = z.infer<typeof apiProjectScenarioSchema>;
export type ApiProjectScenarioContent = z.infer<
  typeof apiProjectScenarioContentSchema
>;
