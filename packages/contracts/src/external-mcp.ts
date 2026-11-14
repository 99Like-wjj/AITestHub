import { z } from 'zod';
import { operationTargetSchema } from './conversations.js';
import { publicSearchBindingSchema } from './public-search.js';
import {
commandIdSchema,
idSchema,
persistedRowVersionSchema,
sha256Schema,
timestampSchema,
titleSchema,
} from './base.js';

export const externalToolNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{1,64}$/);
export const externalProjectActionSchema = z.enum([
  'project.read',
  'requirements.write',
  'assets.write',
  'plans.write',
  'issues.create',
  'issues.handle',
  'issues.lifecycle',
  'knowledge.write',
]);
const jsonObject = z.record(z.string(), z.json());
export const externalToolDefinitionSchema = z.strictObject({
  name: externalToolNameSchema,
  description: z.string().max(4000),
  inputSchema: jsonObject,
  outputSchema: jsonObject.optional(),
  metadata: jsonObject.default({}),
});
export const externalApprovedToolSchema = externalToolDefinitionSchema
  .safeExtend({
    effect: z.enum(['read', 'write']),
    projectAction: externalProjectActionSchema.nullable(),
    publicSearch: publicSearchBindingSchema.optional(),
  })
  .superRefine((tool, ctx) => {
    if (
      tool.publicSearch &&
      (tool.effect !== 'read' || tool.projectAction !== 'project.read')
    )
      ctx.addIssue({
        code: 'custom',
        path: ['publicSearch'],
        message:
          '公开搜索绑定须为read且项目权限为project.read，不能配置为业务写。',
      });
    if (
      tool.effect === 'write' &&
      (!tool.projectAction || tool.projectAction === 'project.read')
    )
      ctx.addIssue({
        code: 'custom',
        path: ['projectAction'],
        message: '外部写工具须明确当前项目业务权限，不能只靠连接Key。',
      });
  });
export const externalServiceInputSchema = z.strictObject({
  commandId: commandIdSchema,
  name: titleSchema,
  endpoint: z.url().max(2000),
  enabled: z.boolean(),
  accessPolicy: z.enum(['restricted', 'allActive']),
  allowedUserIds: z
    .array(idSchema)
    .max(1000)
    .refine((ids) => new Set(ids).size === ids.length, '用户不可重复'),
  protocolMode: z.enum(['auto', 'modern', 'legacy']),
  tools: z
    .array(externalApprovedToolSchema)
    .max(64)
    .refine(
      (items) => new Set(items.map((item) => item.name)).size === items.length,
      '工具名不可重复',
    ),
});
export const externalServiceUpdateSchema =
  externalServiceInputSchema.safeExtend({
    rowVersion: persistedRowVersionSchema,
  });
export const externalServiceSchema = z.strictObject({
  id: idSchema,
  name: titleSchema,
  endpoint: z.string(),
  enabled: z.boolean(),
  accessPolicy: z.enum(['restricted', 'allActive']),
  allowedUserIds: z.array(idSchema),
  protocolMode: z.enum(['auto', 'modern', 'legacy']),
  tools: z.array(externalApprovedToolSchema),
  configRevision: z.number().int().positive(),
  rowVersion: persistedRowVersionSchema,
  createdBy: idSchema,
  updatedAt: timestampSchema,
});
export const externalServiceReceiptSchema = z.strictObject({
  service: externalServiceSchema,
});
export const externalServiceListSchema = z.strictObject({
  services: z.array(externalServiceSchema),
});
export const externalPersonalKeyInputSchema = z.strictObject({
  commandId: commandIdSchema,
  rowVersion: z.number().int().nonnegative(),
  key: z
    .string()
    .min(8)
    .max(16384)
    .regex(/^[!-~]+$/, 'Key须为可安全用于Bearer认证的ASCII字符')
    .refine(
      (value) => !/^ath_(?:key|session|reset)(?:_|=)/i.test(value),
      '外部凭据不能使用本平台Key、浏览器会话或重置标识',
    ),
});
export const externalPersonalKeyRevokeSchema = z.strictObject({
  commandId: commandIdSchema,
  rowVersion: persistedRowVersionSchema,
});
export const externalConnectionSchema = z.strictObject({
  id: idSchema,
  serviceId: idSchema,
  name: z.string(),
  endpoint: z.string(),
  enabled: z.boolean(),
  accessGranted: z.boolean(),
  hasCredential: z.boolean(),
  credentialVersion: z.number().int().positive(),
  rowVersion: persistedRowVersionSchema,
  status: z.enum(['unverified', 'ready', 'authRequired', 'revoked']),
  configRevision: z.number().int().positive(),
  catalogId: idSchema.nullable(),
  catalogDigest: sha256Schema.nullable(),
  checkedAt: timestampSchema.nullable(),
});
export const externalConnectionReceiptSchema = z.strictObject({
  connection: externalConnectionSchema,
});
export const externalConnectionsSchema = z.strictObject({
  connections: z.array(externalConnectionSchema),
});
export const externalPersonalServicesSchema = z.strictObject({
  services: z.array(
    z.strictObject({
      id: idSchema,
      name: z.string(),
      endpoint: z.string(),
      enabled: z.boolean(),
      connection: externalConnectionSchema.nullable(),
    }),
  ),
});
export const externalCatalogToolSchema =
  externalToolDefinitionSchema.safeExtend({
    schemaDigest: sha256Schema,
    approved: z.boolean(),
    effect: z.enum(['read', 'write']).nullable(),
    projectAction: externalProjectActionSchema.nullable(),
    publicSearch: publicSearchBindingSchema.optional(),
  });
export const externalCatalogSchema = z.strictObject({
  catalogId: idSchema,
  connectionId: idSchema,
  configRevision: z.number().int().positive(),
  credentialVersion: z.number().int().positive(),
  catalogDigest: sha256Schema,
  tools: z.array(externalCatalogToolSchema),
  observedAt: timestampSchema,
});
export const externalAvailableToolsSchema = z.strictObject({
  connections: z.array(
    z.strictObject({
      connectionId: idSchema,
      name: z.string(),
      configRevision: z.number().int().positive(),
      credentialVersion: z.number().int().positive(),
      catalogId: idSchema,
      catalogDigest: sha256Schema,
      tools: z.array(externalCatalogToolSchema),
    }),
  ),
});
export const externalManagementLookupSchema = z.strictObject({
  operation: z.enum([
    'external-mcp.service.create',
    'external-mcp.service.revise',
    'external-mcp.personal-key.replace',
    'external-mcp.personal-key.revoke',
  ]),
  key: commandIdSchema,
});
export const externalManagementStatusSchema = z.strictObject({
  command: z.strictObject({
    id: idSchema,
    operation: z.string(),
    status: z.enum(['pending', 'completed', 'failed', 'unknown']),
    projectId: idSchema.nullable(),
    response: z.json(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  }),
});
export const externalCallInputSchema = z.strictObject({
  commandId: commandIdSchema,
  connectionId: idSchema,
  toolName: externalToolNameSchema,
  arguments: jsonObject,
  purpose: z.string().trim().min(1).max(2000),
});
export const externalManualCallInputSchema = externalCallInputSchema.safeExtend(
  {
    projectId: idSchema.nullable(),
    expectedSnapshot: z.strictObject({
      configRevision: z.number().int().positive(),
      credentialVersion: z.number().int().positive(),
      catalogDigest: sha256Schema,
    }),
    publicQueryConfirmed: z.boolean().optional(),
  },
);
export const externalDecisionInputSchema = z.strictObject({
  scopeDigest: sha256Schema,
  decision: z.enum(['accept', 'decline']),
  publicQueryConfirmed: z.boolean().optional(),
});
export const externalInvocationStateSchema = z.enum([
  'waitingConsent',
  'dispatching',
  'completed',
  'declined',
  'cancelled',
  'failed',
  'unknown',
]);
export const externalInvocationSchema = z.strictObject({
  id: idSchema,
  connectionId: idSchema,
  serviceId: idSchema,
  projectId: idSchema.nullable(),
  operationTarget: operationTargetSchema.nullable(),
  taskId: idSchema.nullable(),
  conversationId: idSchema.nullable(),
  destinationName: z.string(),
  endpoint: z.string(),
  toolName: externalToolNameSchema,
  arguments: jsonObject.nullable(),
  purpose: z.string(),
  scopeDigest: sha256Schema,
  state: externalInvocationStateSchema,
  result: z.json().nullable(),
  errorCode: z.string().nullable(),
  toolSends: z.number().int().min(0).max(1),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  decidedAt: timestampSchema.nullable(),
  isPublicSearch: z.boolean().optional(),
  publicQuery: z.string().max(500).optional(),
});
export const externalInvocationReceiptSchema = z.strictObject({
  invocation: externalInvocationSchema,
});
export const externalInvocationListSchema = z.strictObject({
  invocations: z.array(externalInvocationSchema),
});
export type ExternalApprovedTool = z.infer<typeof externalApprovedToolSchema>;
export type ExternalToolDefinition = z.infer<
  typeof externalToolDefinitionSchema
>;
export type ExternalInvocation = z.infer<typeof externalInvocationSchema>;
