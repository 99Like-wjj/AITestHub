import { z } from 'zod';
import {
decimalCountSchema,
idSchema,
sha256Schema,
timestampSchema,
} from './base.js';

export const fileMetadataSchema = z.strictObject({
  id: idSchema,
  ownerScope: z.enum(['personal', 'project']),
  projectId: idSchema.nullable(),
  runId: idSchema.nullable().default(null),
  originalName: z.string().min(1).max(512),
  mediaType: z.string().min(1).max(256),
  bytes: decimalCountSchema,
  sha256: sha256Schema,
  status: z.enum(['pending', 'uploading', 'verified', 'failed']),
  attempt: z.number().int().min(0),
  createdAt: timestampSchema,
  verifiedAt: timestampSchema.nullable(),
});
export const fileReceiptSchema = z.strictObject({
  file: fileMetadataSchema,
  replayed: z.boolean().optional(),
});
export type FileMetadata = z.infer<typeof fileMetadataSchema>;
export type FileReceipt = z.infer<typeof fileReceiptSchema>;
