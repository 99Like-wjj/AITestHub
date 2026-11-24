import { z } from 'zod';
import {
  commandIdSchema,
  idSchema,
  persistedRowVersionSchema,
  timestampSchema,
  titleSchema,
} from './base.js';

const writable = z.strictObject({
  title: titleSchema,
  body: z.string().min(1).max(64_000).regex(/\S/u),
  commandId: commandIdSchema,
});
const revisionNo = z.number().int().min(1).max(2_147_483_647);

export const apiSharedScriptReferenceSchema = z.strictObject({
  scriptId: idSchema,
  scriptRevisionId: idSchema,
});
export const apiSharedScriptSourceSchema = apiSharedScriptReferenceSchema.extend({
  projectId: idSchema,
  title: titleSchema,
});
export const apiSharedScriptListInputSchema = z.strictObject({
  keyword: z.string().trim().min(1).max(200).optional(),
  afterScriptId: idSchema.optional(),
});
export const apiSharedScriptGetInputSchema = z.strictObject({
  scriptId: idSchema,
  revisionId: idSchema.optional(),
  beforeRevisionNo: revisionNo.optional(),
});
export const apiSharedScriptCreateInputSchema = writable;
export const apiSharedScriptReviseInputSchema = writable.extend({
  scriptId: idSchema,
  baseRevisionId: idSchema,
  rowVersion: persistedRowVersionSchema,
});
export const apiSharedScriptSchema = z.strictObject({
  scriptId: idSchema,
  title: titleSchema,
  currentRevisionId: idSchema,
  revisionNo,
  rowVersion: persistedRowVersionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
const revisionSummary = z.strictObject({
  revisionId: idSchema,
  revisionNo,
  title: titleSchema,
  createdAt: timestampSchema,
});
const revision = revisionSummary.extend({ body: writable.shape.body });
export const apiSharedScriptListResultSchema = z.strictObject({
  scripts: z.array(apiSharedScriptSchema),
  nextAfterScriptId: idSchema.nullable(),
});
export const apiSharedScriptGetResultSchema = z.strictObject({
  script: apiSharedScriptSchema,
  revision,
  revisions: z.array(revisionSummary),
  nextBeforeRevisionNo: revisionNo.nullable(),
});
export type ApiSharedScriptReference = z.infer<typeof apiSharedScriptReferenceSchema>;
