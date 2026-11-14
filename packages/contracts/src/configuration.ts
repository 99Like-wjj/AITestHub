import { z } from 'zod';
// Legacy pre35 inputs/snapshots. E014 current HTTP uses model-configuration-v2;
// these exports remain explicit readers of original vendor/configuration history.
import {
idSchema,
persistedRowVersionSchema,
rowVersionSchema,
timestampSchema,
titleSchema,
} from './base.js';

export const modelProviderSchema = z.enum(['sensenova', 'ark']);
export const modelDataScopeSchema=z.enum(['syntheticPublicOnly','authorizedRelevantTestData']);
export const modelDataScopesSchema=z.array(modelDataScopeSchema).min(1).max(2).refine(scopes=>new Set(scopes).size===scopes.length,'资料策略不可重复');
export const modelCapabilitiesSchema = z.strictObject({
  streaming: z.boolean(),
  toolCalling: z.boolean(),
  multiTool: z.boolean(),
  toolResultContinuation: z.boolean(),
  imageInput: z.boolean(),
  fileTextInput: z.boolean(),
  structuredOutput: z.boolean(),
  usage: z.boolean(),
});
const effortSchema = z.string().min(1).max(40);
export const modelConfigurationInputSchema = z
  .strictObject({
    name: titleSchema,
    provider: modelProviderSchema,
    baseUrl: z.url().max(2048),
    modelId: z.string().min(1).max(200),
    enabled: z.boolean(),
    accessPolicy: z.enum(['restricted', 'allActive']),
    allowedUserIds: z.array(idSchema).max(1000),
    allowedDataScopes:modelDataScopesSchema.optional(),
    capabilities: modelCapabilitiesSchema,
    effortValues: z.array(effortSchema).max(20),
    defaultEffort: effortSchema.nullable(),
    contextLimit: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    maxOutput: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(),
  })
  .superRefine((input, context) => {
    if (new Set(input.allowedUserIds).size !== input.allowedUserIds.length)
      context.addIssue({
        code: 'custom',
        path: ['allowedUserIds'],
        message: '用户不可重复',
      });
    if (input.accessPolicy === 'allActive' && input.allowedUserIds.length > 0)
      context.addIssue({
        code: 'custom',
        path: ['allowedUserIds'],
        message: '全部有效账号策略不附加独立用户清单',
      });
    if (new Set(input.effortValues).size !== input.effortValues.length)
      context.addIssue({
        code: 'custom',
        path: ['effortValues'],
        message: '强度不可重复',
      });
    if (
      input.defaultEffort !== null &&
      !input.effortValues.includes(input.defaultEffort)
    )
      context.addIssue({
        code: 'custom',
        path: ['defaultEffort'],
        message: '默认强度必须受支持',
      });
  });
export const modelConfigurationUpdateSchema =
  modelConfigurationInputSchema.safeExtend({
    rowVersion: persistedRowVersionSchema,
  });
export const modelCredentialInputSchema = z.strictObject({
  credential: z
    .string()
    .min(8)
    .max(16384)
    .refine((value) => !/[\r\n\0]/.test(value)),
  rowVersion: persistedRowVersionSchema,
});
export const modelVerificationChecksSchema = z.strictObject({
  text: z.enum(['passed', 'failed', 'unverified']).optional(),
  streaming: z.enum(['passed', 'failed', 'unverified']).optional(),
  toolCalling: z.enum(['passed', 'failed', 'unverified']).optional(),
  multiTool: z.enum(['passed', 'failed', 'unverified']).optional(),
  toolResultContinuation: z.enum(['passed', 'failed', 'unverified']).optional(),
  imageInput: z.enum(['passed', 'failed', 'unverified']).optional(),
  fileTextInput: z.enum(['passed', 'failed', 'unverified']).optional(),
  structuredOutput: z.enum(['passed', 'failed', 'unverified']).optional(),
  usage: z.enum(['passed', 'failed', 'unverified']).optional(),
  cancellation: z.enum(['passed', 'failed', 'unverified']).optional(),
});
export const modelVerificationSchema = z.strictObject({
  status: z.enum(['unverified', 'partial', 'verified', 'failed']),
  checkedAt: timestampSchema.nullable(),
  checks: modelVerificationChecksSchema,
});
export const modelServiceSchema = z.strictObject({
  id: idSchema,
  name: titleSchema,
  provider: modelProviderSchema,
  baseUrl: z.url(),
  modelId: z.string(),
  enabled: z.boolean(),
  accessPolicy: z.enum(['restricted', 'allActive']),
  allowedUserIds: z.array(idSchema),
  capabilities: modelCapabilitiesSchema,
  effortValues: z.array(effortSchema),
  defaultEffort: effortSchema.nullable(),
  contextLimit: z.number().nullable(),
  maxOutput: z.number().nullable(),
  credentialRef: idSchema.nullable(),
  hasCredential: z.boolean(),
  rowVersion: persistedRowVersionSchema,
  configRevision: persistedRowVersionSchema,
  verification: modelVerificationSchema,
  allowedDataScope: z.literal('syntheticPublicOnly'),
  allowedDataScopes:modelDataScopesSchema.default(['syntheticPublicOnly']),
});
export const auxiliaryModelInputSchema = z
  .strictObject({
    modelServiceId: idSchema.nullable(),
    enabled: z.boolean(),
    effort: effortSchema.nullable(),
    rowVersion: rowVersionSchema,
  })
  .refine((input) => !input.enabled || input.modelServiceId !== null, {
    path: ['modelServiceId'],
    message: '启用辅助模型须明确服务',
  });
export const auxiliaryModelSchema = z.strictObject({
  modelServiceId: idSchema.nullable(),
  enabled: z.boolean(),
  effort: effortSchema.nullable(),
  rowVersion: rowVersionSchema,
});
export const modelSelectionInputSchema = z.strictObject({
  modelServiceId: idSchema,
  configRevision: persistedRowVersionSchema,
  effort: effortSchema.nullable().optional(),
});
export type ModelConfigurationInput = z.infer<
  typeof modelConfigurationInputSchema
>;
export type ModelService = z.infer<typeof modelServiceSchema>;
export type ModelVerificationChecks = z.infer<
  typeof modelVerificationChecksSchema
>;
export type ModelSelectionInput = z.infer<typeof modelSelectionInputSchema>;

export type ModelDataScope=z.infer<typeof modelDataScopeSchema>;
