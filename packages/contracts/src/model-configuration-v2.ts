import { z } from 'zod';
import { modelConnectionObservationSchema } from './model-connections.js';
import {
commandIdSchema,
idSchema,
persistedRowVersionSchema,
rowVersionSchema,
timestampSchema,
titleSchema,
} from './base.js';
import {
modelDataScopesSchema,
modelVerificationSchema,
} from './configuration.js';
import {
modelAuthSchemeSchema,
modelBaseUrlSchema,
modelProtocolSchema,
modelEndpointConfigurationIssue,
modelOutputContextIssue,
type ModelProtocol,
} from './model-protocol.js';

export const modelEffortSchema = z
  .string()
  .min(1)
  .max(40)
  .refine((value) => !/[\r\n\0]/.test(value));
const modelIdValue = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !/[\r\n\0]/.test(value));
const limit = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .nullable();
export const modelEntryInputV2Schema = z
  .strictObject({
    id: idSchema,
    displayName: titleSchema,
    modelId: modelIdValue,
    enabled: z.boolean(),
    contextLimit: limit,
    effortValues: z.array(modelEffortSchema).max(20),
    defaultEffort: modelEffortSchema.nullable(),
    maxOutput: limit,
  })
  .superRefine((input, ctx) => {
    if (new Set(input.effortValues).size !== input.effortValues.length)
      ctx.addIssue({
        code: 'custom',
        path: ['effortValues'],
        message: '强度不可重复',
      });
    if (
      input.defaultEffort !== null &&
      !input.effortValues.includes(input.defaultEffort)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['defaultEffort'],
        message: '默认强度须在配置清单中',
      });
  });
const editable = {
  name: titleSchema,
  note: z.string().max(2000),
  protocol: modelProtocolSchema,
  baseUrl: modelBaseUrlSchema,
  authScheme: modelAuthSchemeSchema,
  enabled: z.boolean(),
  accessPolicy: z.enum(['restricted', 'allActive']),
  allowedUserIds: z.array(idSchema).max(1000),
  allowedDataScopes: modelDataScopesSchema,
  models: z.array(modelEntryInputV2Schema).max(200),
};
const checkService = (
  input: {
    accessPolicy: string;
    allowedUserIds: string[];
    models: { id: string; maxOutput: number | null; contextLimit: number | null }[];
    protocol: ModelProtocol;
    baseUrl: string;
  },
  ctx: z.RefinementCtx,
) => {
  const endpointIssue = modelEndpointConfigurationIssue(input.baseUrl, input.protocol);
  if (endpointIssue) ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: endpointIssue });
  input.models.forEach((model, index) => {
    const issue = modelOutputContextIssue(model.maxOutput, model.contextLimit);
    if (issue) ctx.addIssue({ code: 'custom', path: ['models', index, 'maxOutput'], message: issue });
  });
  if (new Set(input.allowedUserIds).size !== input.allowedUserIds.length)
    ctx.addIssue({
      code: 'custom',
      path: ['allowedUserIds'],
      message: '用户不可重复',
    });
  if (input.accessPolicy === 'allActive' && input.allowedUserIds.length)
    ctx.addIssue({
      code: 'custom',
      path: ['allowedUserIds'],
      message: '开放全部账号不附加用户清单',
    });
  if (
    new Set(input.models.map((model) => model.id)).size !== input.models.length
  )
    ctx.addIssue({
      code: 'custom',
      path: ['models'],
      message: '稳定模型行ID不可重复',
    });
};
export const modelServiceCreateV2Schema = z
  .strictObject({
    commandId: commandIdSchema,
    id: idSchema,
    ...editable,
  })
  .superRefine(checkService);
export const modelServiceUpdateV2Schema = z
  .strictObject({
    commandId: commandIdSchema,
    rowVersion: persistedRowVersionSchema,
    ...editable,
    removedModelEntryIds: z.array(idSchema).max(200),
  })
  .superRefine((input, ctx) => {
    checkService(input, ctx);
    const ids = new Set(input.models.map((model) => model.id));
    if (
      new Set(input.removedModelEntryIds).size !==
        input.removedModelEntryIds.length ||
      input.removedModelEntryIds.some((id) => ids.has(id))
    )
      ctx.addIssue({
        code: 'custom',
        path: ['removedModelEntryIds'],
        message: '移除行须唯一且不在保留行中',
      });
  });
export const modelServiceCasV2Schema = z.strictObject({
  commandId: commandIdSchema,
  rowVersion: persistedRowVersionSchema,
});
export const modelCredentialV2Schema = modelServiceCasV2Schema.extend({
  credential: z
    .string()
    .min(8)
    .max(16384)
    .refine((value) => !/[\r\n\0]/.test(value)),
});
export const modelEntryV2Schema = modelEntryInputV2Schema.safeExtend({
  removedAt: timestampSchema.nullable(),
  verification: modelVerificationSchema,
});
export const modelServiceV2Schema = z.strictObject({
  id: idSchema,
  name: titleSchema,
  note: z.string(),
  protocol: modelProtocolSchema,
  baseUrl: modelBaseUrlSchema,
  authScheme: modelAuthSchemeSchema,
  enabled: z.boolean(),
  removedAt: timestampSchema.nullable(),
  accessPolicy: z.enum(['restricted', 'allActive']),
  allowedUserIds: z.array(idSchema),
  allowedDataScopes: modelDataScopesSchema,
  hasCredential: z.boolean(),
  rowVersion: persistedRowVersionSchema,
  serviceRevision: persistedRowVersionSchema,
  models: z.array(modelEntryV2Schema),
});
export const modelServiceV2ListSchema = z.strictObject({
  services: z.array(modelServiceV2Schema),
  connections: z.array(modelConnectionObservationSchema).optional(),
});
export const modelServiceV2ReceiptSchema = z.strictObject({
  modelService: modelServiceV2Schema,
});
const {
  id: _entryId,
  enabled: _entryEnabled,
  removedAt: _entryRemovedAt,
  ...availableEntryShape
} = modelEntryV2Schema.shape;
export const availableModelV2Schema = z.strictObject({
  ...availableEntryShape,
  modelServiceId: idSchema,
  modelEntryId: idSchema,
  serviceRevision: persistedRowVersionSchema,
  serviceName: titleSchema,
  protocol: modelProtocolSchema,
  baseUrl: modelBaseUrlSchema,
  allowedDataScopes: modelDataScopesSchema,
  available: z.boolean(),
  unavailableReason: z.enum(['credentialMissing']).nullable(),
});
export const availableModelV2ListSchema = z.strictObject({
  models: z.array(availableModelV2Schema),
});
export const modelSelectionV2Schema = z.strictObject({
  modelServiceId: idSchema,
  modelEntryId: idSchema,
  serviceRevision: persistedRowVersionSchema,
  effort: modelEffortSchema.nullable().optional(),
});
export const messageModelSnapshotV2Schema = z.strictObject({
  schemaVersion: z.literal('ath.model-snapshot.v2'),
  modelServiceId: idSchema,
  modelEntryId: idSchema,
  serviceRevision: persistedRowVersionSchema,
  serviceName: titleSchema,
  modelDisplayName: titleSchema,
  protocol: modelProtocolSchema,
  modelId: modelIdValue,
  effort: modelEffortSchema.nullable(),
});
export const auxiliaryModelInputV2Schema = z
  .strictObject({
    commandId: commandIdSchema,
    modelServiceId: idSchema.nullable(),
    modelEntryId: idSchema.nullable(),
    enabled: z.boolean(),
    effort: modelEffortSchema.nullable(),
    rowVersion: rowVersionSchema,
  })
  .superRefine((input, ctx) => {
    if (
      (input.modelServiceId === null) !== (input.modelEntryId === null) ||
      (input.enabled && !input.modelEntryId)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['modelEntryId'],
        message: '服务与模型行须同时指定；启用时不可为空',
      });
  });
export const auxiliaryModelV2Schema = z.strictObject({
  modelServiceId: idSchema.nullable(),
  modelEntryId: idSchema.nullable(),
  enabled: z.boolean(),
  effort: modelEffortSchema.nullable(),
  rowVersion: rowVersionSchema,
});
export const auxiliaryModelV2ReceiptSchema = z.strictObject({
  auxiliary: auxiliaryModelV2Schema,
});
export const modelDiscoveryV2InputSchema = z.strictObject({
  serviceRevision: persistedRowVersionSchema,
});
export const modelDiscoveryV2ReceiptSchema = z.strictObject({
  modelServiceId: idSchema,
  serviceRevision: persistedRowVersionSchema,
  observedAt: timestampSchema,
  source: z.literal('upstream'),
  models: z
    .array(
      z.strictObject({
        modelId: modelIdValue,
        displayName: titleSchema.nullable(),
      }),
    )
    .max(5000),
});
export const modelConfigurationCommandV2Schema = z.strictObject({
  commandId: commandIdSchema,
  operation: z.string(),
  status: z.enum(['succeeded', 'unknown']),
  response: z
    .union([modelServiceV2ReceiptSchema, auxiliaryModelV2ReceiptSchema])
    .nullable(),
});
export type ModelServiceV2 = z.infer<typeof modelServiceV2Schema>;
export type ModelEntryV2 = z.infer<typeof modelEntryV2Schema>;
export type AvailableModelV2 = z.infer<typeof availableModelV2Schema>;
export type ModelSelectionV2 = z.infer<typeof modelSelectionV2Schema>;
export type MessageModelSnapshotV2 = z.infer<
  typeof messageModelSnapshotV2Schema
>;
export type ModelServiceCreateV2 = z.infer<typeof modelServiceCreateV2Schema>;
export type ModelServiceUpdateV2 = z.infer<typeof modelServiceUpdateV2Schema>;
