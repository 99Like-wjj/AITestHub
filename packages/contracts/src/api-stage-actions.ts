import { z } from 'zod';
import { idSchema, persistedRowVersionSchema, titleSchema } from './base.js';
import { apiSharedScriptReferenceSchema } from './api-shared-scripts.js';

const stageId = z.string().regex(/^[A-Za-z0-9_-]{1,140}$/u);
const variableName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u);
const providerId = z.string().min(1).max(200);
const actionBase = z.strictObject({
  id: stageId,
  name: titleSchema,
  enabled: z.boolean().default(true),
  overridable: z.boolean().default(false),
});

export const apiStageActionSchema = z.discriminatedUnion('type', [
  actionBase.extend({
    type: z.literal('wait'),
    milliseconds: z.number().int().min(1).max(30_000),
  }),
  actionBase.extend({
    type: z.literal('script'),
    script: z.string().min(1).max(64_000),
  }),
  actionBase.extend({
    type: z.literal('sharedScript'),
    ...apiSharedScriptReferenceSchema.shape,
  }),
  actionBase.extend({
    type: z.literal('databaseRead'),
    queryId: idSchema,
    parameters: z.record(variableName, z.string().max(8000)),
    resultVariable: variableName,
  }),
]);
const apiStageSuppressionSchema = z.strictObject({
  providerId,
  actionId: stageId,
});
export const apiStageSettingsSchema = z
  .strictObject({
    pre: z.array(apiStageActionSchema).max(30),
    post: z.array(apiStageActionSchema).max(30),
    suppress: z.array(apiStageSuppressionSchema).max(100).default([]),
  })
  .superRefine((value, ctx) => {
    const ids = [...value.pre, ...value.post].map(({ id }) => id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: 'custom',
        path: ['pre'],
        message: '同一层的动作标识在前后置中不得重复。',
      });
    const suppressed = value.suppress.map((ref) =>
      JSON.stringify([ref.providerId, ref.actionId]),
    );
    if (new Set(suppressed).size !== suppressed.length)
      ctx.addIssue({
        code: 'custom',
        path: ['suppress'],
        message: '同一个继承动作不得重复停用。',
      });
  });

export const apiCatalogStageProviderSchema = z.strictObject({
  kind: z.enum(['module', 'folder', 'interface']),
  projectId: idSchema,
  id: idSchema,
  title: titleSchema,
  rowVersion: persistedRowVersionSchema.optional(),
  revisionId: idSchema.optional(),
  settings: apiStageSettingsSchema,
});

export const apiStageSourceSchema = z.strictObject({
  phase: z.enum(['pre', 'post']),
  kind: z.enum(['module', 'folder', 'interface', 'case', 'step']),
  projectId: idSchema,
  providerId,
  title: titleSchema,
  rowVersion: persistedRowVersionSchema.optional(),
  revisionId: idSchema.optional(),
  actionId: stageId,
  requestStepId: stageId.optional(),
});

export const apiNoStages: z.infer<typeof apiStageSettingsSchema> = {
  pre: [],
  post: [],
  suppress: [],
};
export type ApiStageAction = z.infer<typeof apiStageActionSchema>;
export type ApiStageSettings = z.infer<typeof apiStageSettingsSchema>;
export type ApiStageSource = z.infer<typeof apiStageSourceSchema>;
export type ApiCatalogStageProvider = z.infer<
  typeof apiCatalogStageProviderSchema
>;
