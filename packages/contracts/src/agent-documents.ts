import { z } from 'zod';
import { modelImageBlockSchema } from './model-content.js';

export const documentMediaTypes = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
] as const;
export const documentMediaTypeSchema = z.enum(documentMediaTypes);
export const documentReadQuerySchema = z.strictObject({
  offset: z.number().int().min(0).max(100_000).default(0),
  limit: z.number().int().min(1).max(40).default(20),
  section: z.string().max(200).optional(),
});
export type DocumentReadQuery = z.infer<typeof documentReadQuerySchema>;
export const documentReadInputSchema = documentReadQuerySchema.extend({
  resourceId: z.uuid(),
});
export const documentBlockSchema = z.strictObject({
  location: z.string().max(1000),
  kind: z.enum([
    'paragraph',
    'table',
    'cell',
    'page',
    'slide',
    'image',
    'chart',
    'metadata',
  ]),
  text: z.string().max(60_000),
  imageIndexes: z.array(z.number().int().min(0).max(5)).max(6).default([]),
});
export const sandboxDocumentReadResultSchema = z.strictObject({
  format: z.enum(['pdf', 'docx', 'xlsx', 'pptx']),
  state: z.enum(['readable', 'partial']),
  totalUnits: z.number().int().min(0).max(100_000),
  offset: z.number().int().min(0),
  nextOffset: z.number().int().min(0).nullable(),
  sections: z.array(z.string().max(200)).max(1000),
  blocks: z.array(documentBlockSchema).max(40),
  images: z.array(modelImageBlockSchema).max(6),
  warnings: z.array(z.string().max(1000)).max(100),
});
export const documentReadResultSchema = sandboxDocumentReadResultSchema.extend({
  format: z.enum(['pdf', 'docx', 'xlsx', 'pptx', 'markdown', 'text']),
});
export type DocumentReadResult = z.infer<typeof documentReadResultSchema>;
export type DocumentParserResult = z.infer<
  typeof sandboxDocumentReadResultSchema
>;
export interface DocumentParserPort {
  read(
    bytes: Uint8Array,
    mediaType: z.infer<typeof documentMediaTypeSchema>,
    query: DocumentReadQuery,
    signal?: AbortSignal,
  ): Promise<DocumentParserResult>;
}
