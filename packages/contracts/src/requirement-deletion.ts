import { z } from 'zod';
import {
idSchema,
commandIdSchema,
persistedRowVersionSchema,
} from './base.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const requirementDeletionInputSchema = z.strictObject({
  commandId: commandIdSchema,
  previewId: idSchema,
  rowVersion: persistedRowVersionSchema,
  scopeDigest: digest,
  confirmed: z.literal(true),
});
export const requirementDeletionReceiptSchema = z.strictObject({
  commandId: commandIdSchema,
  requirementId: idSchema,
  deleted: z.literal(true),
  deletedAt: z.iso.datetime(),
  removedVersionCount: z.number().int().nonnegative(),
  exclusiveFileCount: z.number().int().nonnegative(),
  retainedFileCount: z.number().int().nonnegative(),
  fileCleanup: z.literal('queuedOrNoBytes'),
});
export const requirementDeletionPreviewSchema = z.strictObject({
  previewId: idSchema,
  requirementId: idSchema,
  rowVersion: persistedRowVersionSchema,
  scopeDigest: digest,
  expiresAt: z.iso.datetime(),
  canDelete: z.boolean(),
  recommendedAction: z.enum(['delete', 'archive']),
  protectedHistory: z.boolean(),
  versionCount: z.number().int().nonnegative(),
  files: z.array(
    z.strictObject({
      id: idSchema,
      originalName: z.string(),
      bytes: z.string(),
      sha256: digest,
      action: z.enum([
        'deleteExclusiveFile',
        'retainReferencedFile',
        'deleteResourceKeepSharedBytes',
      ]),
    }),
  ),
});
export const requirementDeletionReceiptLookupSchema = z.strictObject({
  receipt: requirementDeletionReceiptSchema,
});
