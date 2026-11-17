import { z } from 'zod';
import { idSchema, rowVersionSchema } from './base.js';
import { workspacePathSchema } from './agent-workspace.js';

export const officeFormatSchema = z.enum(['docx', 'xlsx', 'pptx', 'pdf']);
const text = z.string().max(8000);
const color = z.string().regex(/^[a-fA-F0-9]{6}$/);
const table = z
  .array(z.array(z.string().max(2000)).min(1).max(20))
  .min(1)
  .max(200);
const coordinate = z
  .string()
  .regex(/^[A-Z]{1,3}[1-9][0-9]{0,6}$/)
  .refine((address) => {
    const match = /^([A-Z]+)([0-9]+)$/.exec(address);
    if (!match) return false;
    const column = [...match[1]!].reduce(
      (sum, char) => sum * 26 + char.charCodeAt(0) - 64,
      0,
    );
    return column <= 16384 && Number(match[2]) <= 1048576;
  });
const value = z.union([
  z.string().max(8000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const chart = z
  .strictObject({
    title: z.string().max(200),
    categories: z.array(z.string().max(200)).min(1).max(100),
    series: z
      .array(
        z.strictObject({
          name: z.string().max(100),
          values: z.array(z.number().finite()).min(1).max(100),
        }),
      )
      .min(1)
      .max(8),
    kind: z.enum(['bar', 'line']).default('bar'),
  })
  .superRefine((input, ctx) => {
    if (
      input.series.some(
        (series) => series.values.length !== input.categories.length,
      )
    )
      ctx.addIssue({ code: 'custom', message: '图表数据与分类数量必须相等。' });
  });
const paragraph = z.strictObject({
  text,
  style: z
    .enum(['title', 'heading1', 'heading2', 'normal', 'bullet'])
    .default('normal'),
  bold: z.boolean().default(false),
  color: color.optional(),
});
export const officeDocumentSpecSchema = z.strictObject({
  title: z.string().max(200).default(''),
  paragraphs: z.array(paragraph).max(300).default([]),
  tables: z.array(table).max(10).default([]),
});
export const officeWorkbookSpecSchema = z.strictObject({
  sheets: z
    .array(
      z.strictObject({
        name: z
          .string()
          .min(1)
          .max(31)
          .refine(
            (name) =>
              !/[\\/*?:\[\]]/.test(name) &&
              !name.toLowerCase().startsWith('_ath_chart_'),
          ),
        rows: z.array(z.array(value).max(100)).max(1000).default([]),
        cells: z
          .array(
            z.strictObject({
              address: coordinate,
              value,
              bold: z.boolean().default(false),
              numberFormat: z.string().max(100).optional(),
              fill: color.optional(),
            }),
          )
          .max(1000)
          .default([]),
        charts: z.array(chart).max(4).default([]),
      }),
    )
    .min(1)
    .max(20),
});
export const officePresentationSpecSchema = z.strictObject({
  slides: z
    .array(
      z.strictObject({
        title: z.string().max(200),
        paragraphs: z.array(z.string().max(2000)).max(30).default([]),
        table: table.optional(),
        chart: chart.optional(),
      }),
    )
    .min(1)
    .max(50),
});
const pdfPage = z.strictObject({
  title: z.string().max(200).default(''),
  paragraphs: z.array(z.string().max(8000)).max(100).default([]),
  table: table.optional(),
});
export const officePdfSpecSchema = z.strictObject({
  pages: z.array(pdfPage).min(1).max(50),
});
const output = z.strictObject({
  path: workspacePathSchema.describe(
    '产物在会话工作区的完整相对路径，保留用户指定的全部目录前缀；不是沙箱内部的artifact路径。',
  ),
  expectedRowVersion: rowVersionSchema,
});
const source = z.strictObject({
  entryId: idSchema,
  revision: z.number().int().positive(),
});
const create = z.discriminatedUnion('format', [
  z.strictObject({ format: z.literal('docx'), spec: officeDocumentSpecSchema }),
  z.strictObject({ format: z.literal('xlsx'), spec: officeWorkbookSpecSchema }),
  z.strictObject({
    format: z.literal('pptx'),
    spec: officePresentationSpecSchema,
  }),
  z.strictObject({ format: z.literal('pdf'), spec: officePdfSpecSchema }),
]);
export const officeCreateSchema = z.strictObject({
  commandId: idSchema,
  output,
  document: create,
});
const replacement = z.strictObject({
  find: z.string().min(1).max(2000),
  replace: z.string().max(8000),
  expectedOccurrences: z.number().int().min(1).max(1000),
  part: z.string().max(200).optional(),
});
export const officeEditSchema = z.strictObject({
  commandId: idSchema,
  source,
  output,
  edit: z.discriminatedUnion('format', [
    z.strictObject({
      format: z.literal('docx'),
      replacements: z.array(replacement).min(1).max(100),
    }),
    z.strictObject({
      format: z.literal('pptx'),
      replacements: z.array(replacement).min(1).max(100),
    }),
    z.strictObject({
      format: z.literal('xlsx'),
      cells: z
        .array(
          z.strictObject({
            sheet: z.string().min(1).max(31),
            address: coordinate,
            value,
          }),
        )
        .min(1)
        .max(1000),
    }),
    z.strictObject({
      format: z.literal('pdf'),
      overlays: z
        .array(
          z.strictObject({
            page: z.number().int().min(1).max(1000),
            text,
            x: z.number().min(0).max(3000),
            y: z.number().min(0).max(3000),
            width: z.number().min(20).max(2000).default(400),
            fontSize: z.number().min(6).max(72).default(12),
          }),
        )
        .max(100)
        .default([]),
      appendPages: z.array(pdfPage).max(50).default([]),
    }),
  ]),
});
export const officeInspectSchema = z.strictObject({
  commandId: idSchema,
  source,
  format: officeFormatSchema,
});
export const agentOfficeToolInputSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('files'),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  officeCreateSchema.extend({ action: z.literal('create') }),
  officeEditSchema.extend({ action: z.literal('edit') }),
  officeInspectSchema.extend({ action: z.literal('inspect') }),
  z.strictObject({ action: z.literal('status'), runId: idSchema }),
  z.strictObject({ action: z.literal('cancel'), runId: idSchema }),
]);
export type OfficeCreate = z.infer<typeof officeCreateSchema>;
export type OfficeEdit = z.infer<typeof officeEditSchema>;
export type OfficeInspect = z.infer<typeof officeInspectSchema>;
export type OfficeFormat = z.infer<typeof officeFormatSchema>;
