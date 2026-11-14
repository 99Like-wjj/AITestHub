import { z } from 'zod';
import {
idSchema,
commandIdSchema,
sha256Schema,
persistedRowVersionSchema,
} from './base.js';
import {
createRequirementInputSchema,
addRequirementVersionInputSchema,
createRequirementResourceInputSchema,
addRequirementVersionResourceInputSchema,
} from './requirements.js';
export const prepareRequirementVersionInputSchema = z.discriminatedUnion(
  'target',
  [
    z.strictObject({
      target: z.literal('new'),
      input: createRequirementInputSchema,
    }),
    z.strictObject({
      target: z.literal('existing'),
      projectId: idSchema,
      requirementId: idSchema,
      input: addRequirementVersionInputSchema,
    }),
  ],
);
export const prepareRequirementVersionResourceInputSchema =
  z.discriminatedUnion('target', [
    z.strictObject({
      target: z.literal('new'),
      input: createRequirementResourceInputSchema,
    }),
    z.strictObject({
      target: z.literal('existing'),
      projectId: idSchema,
      requirementId: idSchema,
      input: addRequirementVersionResourceInputSchema,
    }),
  ]);
export const requirementVersionPreparationSchema = z.strictObject({
  target: z.enum(['new', 'existing']),
  projectId: idSchema,
  requirementId: idSchema.nullable(),
  submissionId: commandIdSchema,
  inputDigest: sha256Schema,
  baseRowVersion: persistedRowVersionSchema.nullable(),
  nextVersionNo: z.number().int().positive(),
  materialSetDigest: sha256Schema,
  ready: z.boolean(),
  materials: z.array(
    z.strictObject({
      order: z.number().int().nonnegative(),
      fileId: idSchema.nullable(),
      status: z.enum([
        'verified',
        'pending',
        'uploading',
        'failed',
        'deleted',
        'link',
      ]),
      readability: z.enum(['readable', 'unreadable', 'notChecked', 'partial']),
    }),
  ),
  readOnly: z.literal(true),
});
export const missingFileTransfersInputSchema = z.strictObject({
  fileIds: z
    .array(idSchema)
    .min(1)
    .max(500)
    .refine((ids) => new Set(ids).size === ids.length, '文件不可重复'),
});
export const missingFileTransfersSchema = z.strictObject({
  files: z.array(
    z.strictObject({
      fileId: idSchema,
      status: z.enum(['pending', 'uploading', 'verified', 'failed', 'deleted']),
      verified: z.boolean(),
    }),
  ),
  missingFileIds: z.array(idSchema),
  allVerified: z.boolean(),
});
export const resultPreparationSchema = z.strictObject({
  projectId: idSchema,
  runId: idSchema,
  submissionId: commandIdSchema,
  semanticDigest: sha256Schema,
  snapshotDigest: sha256Schema,
  items: z.array(
    z.strictObject({
      runItemId: idSchema,
      status: z.enum(['new', 'skipped', 'conflict']),
      code: z.string().optional(),
    }),
  ),
  missingFileIds: z.array(idSchema),
  scopeItems: z.number().int().nonnegative(),
  submittedItems: z.number().int().nonnegative(),
  readOnly: z.literal(true),
});
export const associateRetestRunInputSchema = z.strictObject({
  commandId: commandIdSchema,
  runId: idSchema,
  snapshotDigest: sha256Schema,
});
export const associateRetestRunReceiptSchema = z.strictObject({
  groupId: idSchema,
  runId: idSchema,
  snapshotDigest: sha256Schema,
  alreadyAssociated: z.boolean(),
  businessStateUnchanged: z.literal(true),
});
