import { z } from 'zod';
import { commandIdSchema, idSchema, titleSchema, timestampSchema } from './base.js';

const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/);
export const apiDatabaseReadDefinitionSchema = z
  .strictObject({
    name: titleSchema,
    connectionId: idSchema,
    namespace: identifier.optional(),
    table: identifier,
    columns: z.array(identifier).min(1).max(24),
    filters: z.array(z.strictObject({column: identifier, parameter: identifier})).min(1).max(16),
    limit: z.number().int().min(1).max(50),
  })
  .superRefine((definition, ctx) => {
    if (new Set(definition.columns).size !== definition.columns.length)
      ctx.addIssue({ code: 'custom', path: ['columns'], message: '观测列不可重复。' });
    if (new Set(definition.filters.map(filter => filter.parameter)).size !== definition.filters.length)
      ctx.addIssue({ code: 'custom', path: ['filters'], message: '参数名不可重复。' });
  });
export const apiDatabaseReadRegisterSchema = z.strictObject({
  commandId: commandIdSchema,
  definition: apiDatabaseReadDefinitionSchema,
});
export const apiDatabaseReadSchema = z.strictObject({
  id: idSchema,
  definition: apiDatabaseReadDefinitionSchema,
  createdAt: timestampSchema,
});
export type ApiDatabaseReadDefinition = z.infer<typeof apiDatabaseReadDefinitionSchema>;
