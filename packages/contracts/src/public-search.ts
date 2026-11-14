import { z } from 'zod';
import { idSchema } from './base.js';
const field = z.string().min(1).max(200);
export const publicSearchBindingSchema = z.strictObject({
  queryArgument: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/),
  resultsPath: z.array(field).max(12),
  titleField: field,
  urlField: field,
  snippetField: field.optional(),
});
export const publicSearchSourceSchema = z.strictObject({
  title: z.string().max(300),
  url: z.url().max(2000),
  snippet: z.string().max(1600),
});
export const publicSearchResultSchema = z.strictObject({
  schemaVersion: z.literal('ath.public-search-result.v1'),
  invocationId: idSchema,
  query: z.string().min(1).max(500),
  sources: z.array(publicSearchSourceSchema).max(20),
  returnedCount: z.number().int().nonnegative(),
  rejectedCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  linksFetched: z.literal(false),
});
export type PublicSearchBinding = z.infer<typeof publicSearchBindingSchema>;
export type PublicSearchResult = z.infer<typeof publicSearchResultSchema>;
