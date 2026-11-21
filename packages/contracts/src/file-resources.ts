import { z } from 'zod';
import { idSchema,commandIdSchema,sha256Schema } from './base.js';
import { resourceByteCountSchema } from './resource-policy.js';

/** Read selectors only. Neither a policy reference nor numeric overrides are accepted. */
export const fileCapabilityQuerySchema = z.discriminatedUnion('target', [
  z.strictObject({ target: z.literal('active'), projectId: idSchema }),
  z.strictObject({ target: z.literal('personal') }),
  z.strictObject({ target: z.literal('file'), fileId: idSchema }),
]);
export const submissionCapabilityQuerySchema = z.discriminatedUnion('target', [
  z.strictObject({ target: z.literal('newSubmission'), projectId: idSchema }),
  z.strictObject({
    target: z.literal('uiBatch'),
    projectId: idSchema,
    runId: idSchema,
    batchId: commandIdSchema,
  }),
  z.strictObject({
    target: z.literal('uiDescriptor'),
    projectId: idSchema,
    runId: idSchema,
    descriptorId: commandIdSchema,
  }),
  z.strictObject({
    target: z.literal('v1Submission'),
    projectId: idSchema,
    runId: idSchema,
    submissionId: commandIdSchema,
  }),
]);
export const resourceCapabilityQuerySchema = z.union([
  fileCapabilityQuerySchema,
  submissionCapabilityQuerySchema,
]);
export const fileResourceLimitsSchema = z.strictObject({
  maxFileBytes: resourceByteCountSchema,
  maxSubmissionBytes: resourceByteCountSchema,
  maxFilesPerBatch: z.number().int().min(1).max(100_000),
});
export const fileResourceCapabilitiesSchema = z.strictObject({
  schemaVersion: z.literal('ath.file-capabilities.v1'),
  subject: resourceCapabilityQuerySchema,
  policy: z.strictObject({
    source: z.enum(['active', 'accepted']),
    revisionId: idSchema.nullable(),
    digest: sha256Schema,
  }),
  limits: fileResourceLimitsSchema,
  binary: fileResourceLimitsSchema,
  sourceJsonMaxBytes: z.literal('16777216'),
  maxEvidenceRefsPerCase: z.literal(1000),
  sourceJsonConsumesEvidenceSlot: z.literal(false),
  readOnly: z.literal(true),
  policyOverrideAccepted: z.literal(false),
});
export type ResourceCapabilityQuery = z.infer<
  typeof resourceCapabilityQuerySchema
>;
