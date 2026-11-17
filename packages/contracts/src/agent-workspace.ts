import { z } from 'zod';
import {
  commandIdSchema,
  decimalCountSchema,
  idSchema,
  persistedRowVersionSchema,
  rowVersionSchema,
  sha256Schema,
  timestampSchema,
} from './base.js';

export const workspaceMaximumFileBytes = 64 * 1024 * 1024;
export const workspaceMaximumTextBytes = 1024 * 1024;
export const workspaceMaximumEntries = 1000;

/** A logical POSIX name, never a host path or a link target. */
export const workspacePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((path) => {
    if (path !== path.normalize('NFC') || /[\\\x00-\x1f\x7f:<>"|?*]/.test(path))
      return false;
    return path
      .split('/')
      .every(
        (segment) =>
          segment.length > 0 &&
          segment.length <= 128 &&
          !['.', '..'].includes(segment) &&
          segment.trim() === segment &&
          !segment.endsWith('.') &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment),
      );
  }, '必须是安全的相对文件路径。');

export const workspaceEntrySchema = z.strictObject({
  id: idSchema,
  path: workspacePathSchema,
  rowVersion: persistedRowVersionSchema,
  revision: persistedRowVersionSchema,
  resourceId: idSchema,
  mediaType: z.string().min(1).max(256),
  bytes: decimalCountSchema,
  sha256: sha256Schema,
  deletedAt: timestampSchema.nullable(),
  updatedAt: timestampSchema,
  available: z.boolean(),
});
export type WorkspaceEntry = z.infer<typeof workspaceEntrySchema>;

export const workspaceManifestSchema = z.strictObject({
  entries: z.array(workspaceEntrySchema).max(workspaceMaximumEntries),
});
export const workspaceReceiptSchema = z.strictObject({
  entry: workspaceEntrySchema,
  replayed: z.boolean(),
});
export const workspacePutSchema = z.strictObject({
  commandId: commandIdSchema,
  path: workspacePathSchema,
  expectedRowVersion: rowVersionSchema,
  mediaType: z.string().min(1).max(256),
});
export const workspaceTextInputSchema = workspacePutSchema.safeExtend({
  text: z.string().max(workspaceMaximumTextBytes),
});
export const workspaceImportSchema = z.strictObject({
  commandId: commandIdSchema,
  path: workspacePathSchema,
  expectedRowVersion: rowVersionSchema,
  resourceId: idSchema,
});
export const workspaceMutationSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('rename'),
    commandId: commandIdSchema,
    expectedRowVersion: persistedRowVersionSchema,
    path: workspacePathSchema,
  }),
  z.strictObject({
    action: z.literal('remove'),
    commandId: commandIdSchema,
    expectedRowVersion: persistedRowVersionSchema,
  }),
  z.strictObject({
    action: z.literal('restore'),
    commandId: commandIdSchema,
    expectedRowVersion: persistedRowVersionSchema,
    revision: persistedRowVersionSchema,
  }),
]);
export const workspaceVersionSchema = z.strictObject({
  revision: persistedRowVersionSchema,
  resourceId: idSchema,
  mediaType: z.string().min(1).max(256),
  bytes: decimalCountSchema,
  sha256: sha256Schema,
  createdAt: timestampSchema,
  available: z.boolean(),
});
export const workspaceHistorySchema = z.strictObject({
  entry: workspaceEntrySchema,
  versions: z.array(workspaceVersionSchema),
});
export const workspaceCommandReceiptSchema = z.strictObject({
  found: z.boolean(),
  receipt: workspaceReceiptSchema.nullable(),
});
