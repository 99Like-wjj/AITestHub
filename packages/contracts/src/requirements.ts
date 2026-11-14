import { z } from 'zod';
import {
idSchema,
titleSchema,
commandIdSchema,
persistedRowVersionSchema,
} from './base.js';
import {
materialInputSchema,
requirementLifecycleSchema,
requirementSchema,
requirementVersionSchema,
} from './domain.js';

const materialInputs = z
  .array(materialInputSchema)
  .min(1)
  .max(100)
  .refine(
    (items) => new Set(items.map((item) => item.order)).size === items.length,
    '材料顺序不可重复',
  );
const resourceMaterialInputs = z
  .array(materialInputSchema)
  .min(1)
  .max(200)
  .refine(
    (items) => new Set(items.map((item) => item.order)).size === items.length,
    '材料顺序不可重复',
  );
export const createRequirementInputSchema = z.strictObject({
  projectId: idSchema,
  title: titleSchema,
  businessNumber: z.string().trim().min(1).max(100).nullable(),
  submissionId: commandIdSchema,
  summary: z.string().max(10_000),
  materials: materialInputs,
});
export const addRequirementVersionInputSchema = z.strictObject({
  submissionId: commandIdSchema,
  rowVersion: persistedRowVersionSchema,
  summary: z.string().max(10_000),
  materials: materialInputs,
});
/** Server structural envelope; current/pinned ResourcePolicy remains authoritative. */
export const createRequirementResourceInputSchema =
  createRequirementInputSchema.safeExtend({
    materials: resourceMaterialInputs,
  });
export const addRequirementVersionResourceInputSchema =
  addRequirementVersionInputSchema.safeExtend({
    materials: resourceMaterialInputs,
  });
export const requirementParticipantsInputSchema = z.strictObject({
  commandId: commandIdSchema,
  rowVersion: persistedRowVersionSchema,
  userIds: z
    .array(idSchema)
    .max(1000)
    .refine((ids) => new Set(ids).size === ids.length, '参与人不可重复'),
});
export const requirementStateInputSchema = z.strictObject({
  commandId: commandIdSchema,
  rowVersion: persistedRowVersionSchema,
  lifecycle: requirementLifecycleSchema,
});
export const requirementCollaborationInputSchema =
  requirementParticipantsInputSchema.safeExtend({
    lifecycle: requirementLifecycleSchema,
  });
export const requirementCollaborationStatusSchema = z.strictObject({
  commandId: commandIdSchema,
  status: z.enum(['pending', 'completed', 'failed', 'unknown']),
  response: z
    .strictObject({
      completed: z.literal(true),
      rowVersion: persistedRowVersionSchema,
    })
    .nullable(),
});
export const requirementArchiveInputSchema = z.strictObject({
  commandId: commandIdSchema,
  rowVersion: persistedRowVersionSchema,
  archived: z.boolean(),
});
export const requirementCandidatesInputSchema = z.strictObject({
  projectId: idSchema,
  title: titleSchema,
  businessNumber: z.string().trim().max(100).nullable(),
});
export type CreateRequirementInput = z.infer<
  typeof createRequirementInputSchema
>;
export type RequirementMaterialInput =
  CreateRequirementInput['materials'][number];

export const requirementParticipantSchema = z.strictObject({
  id: idSchema,
  account: z.string(),
  displayName: z.string(),
});
export const requirementListItemSchema = requirementSchema.extend({
  inactive: z.boolean(),
  latestVersionId: idSchema,
  latestVersionNo: z.number().int().positive(),
  participantCount: z.number().int().nonnegative(),
  participantPreview: z.array(requirementParticipantSchema).max(3),
  isParticipant: z.boolean(),
  uiCaseCount: z.number().int().nonnegative(),
  apiCaseCount: z.number().int().nonnegative(),
});
export const requirementListSchema = z.strictObject({
  requirements: z.array(requirementListItemSchema),
  hasMore: z.boolean().optional(),
  nextPage: z.number().int().positive().optional(),
});
export const requirementPageQuerySchema = z.strictObject({
  page: z.number().int().min(1).max(1000000).default(1),
  pageSize: z.number().int().min(1).max(200).default(20),
  archived: z.boolean().default(false),
  participation: z.enum(['all', 'mine']).default('all'),
  status: z
    .enum(['all', 'inactive', ...requirementLifecycleSchema.options])
    .default('all'),
  search: z.string().trim().max(200).default(''),
});
export const requirementPageSchema = z.strictObject({
  requirements: z.array(requirementListItemSchema),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});
export const requirementEligibleParticipantsSchema = z.strictObject({
  users: z.array(requirementParticipantSchema),
});
export const requirementDetailSchema = z.strictObject({
  requirement: requirementSchema,
  versions: z.array(requirementVersionSchema),
  participants: z.array(requirementParticipantSchema),
});
export const requirementCandidatesSchema = z.strictObject({
  candidates: z.array(requirementSchema),
  lookupIncomplete: z.boolean(),
  lookupMessage: z.string(),
});
export const requirementVersionCreatedSchema = z.strictObject({
  requirement: requirementSchema,
  version: requirementVersionSchema,
});
export const requirementMutationReceiptSchema = z.strictObject({
  completed: z.literal(true),
  rowVersion: persistedRowVersionSchema,
});
export type RequirementListItem = z.infer<typeof requirementListItemSchema>;
export type RequirementDetail = z.infer<typeof requirementDetailSchema>;
