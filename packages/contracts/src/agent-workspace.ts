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
export const workspaceFileKindSchema = z.enum([
  'original',
  'artifact',
  'legacy',
]);
export const workspaceSourceSchema = z.strictObject({
  entryId: idSchema,
  revision: persistedRowVersionSchema,
  resourceId: idSchema,
  path: z.string().min(1).max(512),
});
export const workspaceProvenanceSchema = z.strictObject({
  createdBy: idSchema.nullable().default(null),
  createdByName: z.string().max(128).nullable().default(null),
  messageId: idSchema.nullable().default(null),
  taskId: idSchema.nullable().default(null),
  baseRevision: persistedRowVersionSchema.nullable().default(null),
  sources: z.array(workspaceSourceSchema).max(32).default([]),
});

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
  kind: workspaceFileKindSchema.default('legacy'),
  originalName: z.string().max(512).nullable().default(null),
  originMessageId: idSchema.nullable().default(null),
  createdAt: timestampSchema.nullable().default(null),
  provenance: workspaceProvenanceSchema.default({
    createdBy: null,
    createdByName: null,
    messageId: null,
    taskId: null,
    baseRevision: null,
    sources: [],
  }),
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
  provenance: workspaceProvenanceSchema.default({
    createdBy: null,
    createdByName: null,
    messageId: null,
    taskId: null,
    baseRevision: null,
    sources: [],
  }),
});
export const workspaceHistorySchema = z.strictObject({
  entry: workspaceEntrySchema,
  versions: z.array(workspaceVersionSchema),
});
export const workspaceCommandReceiptSchema = z.strictObject({
  found: z.boolean(),
  receipt: workspaceReceiptSchema.nullable(),
});

export const fileCenterEntrySchema = workspaceEntrySchema.extend({
  conversationId: idSchema,
  conversationTitle: z.string().max(200),
  projectId: idSchema.nullable(),
  projectName: z.string().max(200).nullable(),
  requirementId: idSchema.nullable(),
  requirementTitle: z.string().max(200).nullable(),
});
export type FileCenterEntry = z.infer<typeof fileCenterEntrySchema>;
export const fileCenterQuerySchema = z.strictObject({
  query: z.string().max(200).default(''),
  projectId: idSchema.optional(),
  requirementId: idSchema.optional(),
  conversationId: idSchema.optional(),
  kind: workspaceFileKindSchema.optional(),
  personal: z.boolean().default(false),
  includeDeleted: z.boolean().default(false),
  from: timestampSchema.optional(),
  to: timestampSchema.optional(),
  dateField: z.enum(['created', 'updated']).default('created'),
  cursor: z.string().max(300).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export const fileCenterListSchema = z.strictObject({
  entries: z.array(fileCenterEntrySchema).max(100),
  nextCursor: z.string().max(300).nullable(),
});
export const fileCenterDetailSchema = z.strictObject({
  entry: fileCenterEntrySchema,
});
export const fileCenterAssociationsSchema = z.strictObject({
  associations: z
    .array(
      z.strictObject({
        entryId: idSchema,
        conversationId: idSchema,
        conversationTitle: z.string().max(200),
        projectId: idSchema.nullable(),
        projectName: z.string().max(200).nullable(),
        requirementId: idSchema.nullable(),
        requirementTitle: z.string().max(200).nullable(),
        messageId: idSchema.nullable(),
        relationType: z.enum(['attachment', 'artifact', 'workspace']),
      }),
    )
    .max(100),
  nextCursor: z.string().max(20).nullable(),
});
export const fileCenterTreeSchema = z.strictObject({
  conversations: z
    .array(
      z.strictObject({
        conversationId: idSchema,
        conversationTitle: z.string().max(200),
        projectId: idSchema.nullable(),
        projectName: z.string().max(200).nullable(),
        requirementId: idSchema.nullable(),
        requirementTitle: z.string().max(200).nullable(),
        createdAt: timestampSchema,
        fileCount: z.number().int().nonnegative(),
      }),
    )
    .max(1000),
  nextCursor: idSchema.nullable(),
});
