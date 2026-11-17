import { z } from 'zod';
import { sha256Schema } from './base.js';

const previewUploadTypes: Readonly<Record<string, string>> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  json: 'application/json',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  pdf: 'application/pdf',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
};
const previewTextExtensions = new Set([
  'txt',
  'log',
  'jsonl',
  'xml',
  'yaml',
  'yml',
  'toml',
  'ini',
  'py',
  'java',
  'js',
  'ts',
  'tsx',
  'c',
  'cpp',
  'cs',
  'go',
  'rs',
  'sql',
  'sh',
  'ps1',
  'css',
  'vue',
]);
/** Native file MIME registries disagree (notably .ts and .m4a). Bytes still undergo server validation. */
export function previewUploadMediaType(
  name: string,
  nativeType: string,
): string {
  const extension = name.split('.').at(-1)?.toLowerCase() ?? '';
  if (previewTextExtensions.has(extension)) return 'text/plain';
  return (
    (Object.hasOwn(previewUploadTypes, extension)
      ? previewUploadTypes[extension]
      : nativeType) || 'application/octet-stream'
  );
}

export const filePreviewQuerySchema = z.strictObject({
  sheet: z.coerce.number().int().min(0).max(99).default(0),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type FilePreviewQuery = z.infer<typeof filePreviewQuerySchema>;
const common = {
  sourceSha256: sha256Schema,
  sourceBytes: z
    .number()
    .int()
    .min(0)
    .max(12 * 1024 * 1024),
  notices: z.array(z.string().max(2000)).max(30),
};
export const filePreviewResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...common,
    kind: z.literal('pdf'),
    mediaType: z.literal('application/pdf'),
    contentBase64: z.string().max(6 * 1024 * 1024),
  }),
  z.strictObject({
    ...common,
    kind: z.literal('workbook'),
    sheets: z
      .array(
        z.strictObject({
          index: z.number().int().min(0),
          name: z.string().max(256),
          rowCount: z.number().int().min(0),
          columnCount: z.number().int().min(0),
        }),
      )
      .max(100),
    selectedSheet: z.number().int().min(0),
    rowOffset: z.number().int().min(0),
    rows: z
      .array(
        z.strictObject({
          index: z.number().int().min(0),
          cells: z
            .array(
              z.strictObject({
                column: z.number().int().min(0),
                text: z.string().max(20_000),
                formula: z.string().max(20_000).nullable(),
                cacheState: z.enum(['notFormula', 'available', 'missing']),
              }),
            )
            .max(200),
        }),
      )
      .max(500),
    hasMoreRows: z.boolean(),
    columnsTruncated: z.boolean(),
  }),
]);
export type FilePreviewResult = z.infer<typeof filePreviewResultSchema>;
export interface FilePreviewRenderer {
  render(
    bytes: Uint8Array,
    filename: string,
    mediaType: string,
    query: FilePreviewQuery,
    signal?: AbortSignal,
  ): Promise<FilePreviewResult>;
}
