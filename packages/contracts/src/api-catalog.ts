import { z } from 'zod';
import {
  commandIdSchema,
  idSchema,
  persistedRowVersionSchema,
  sha256Schema,
  timestampSchema,
  titleSchema,
} from './base.js';
import {
  apiCatalogStageProviderSchema,
  apiStageSettingsSchema,
} from './api-stage-actions.js';

export const apiCatalogKindSchema = z.enum(['module', 'folder', 'interface']);
export const apiInterfaceStatusSchema = z.enum([
  'draft',
  'active',
  'deprecated',
]);
export const apiInterfaceMethodSchema = z.enum([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);
const keySchema = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]{0,99}$/u);
const boundedText = z.string().max(4000);
const orderSchema = z.number().int().min(0).max(1_000_000);
const descriptionSchema = z.string().max(30_000);
const headerNameSchema = z
  .string()
  .max(256)
  .regex(/^[!#$%&'*+.^_a-zA-Z0-9|~\x60-]+$/u);
const mediaTypeSchema = z
  .string()
  .max(128)
  .regex(/^[a-zA-Z0-9!#$%&'*+.^_~-]+\/[a-zA-Z0-9!#$%&'*+.^_~-]+$/u);
const contentCodeSchema = z
  .string()
  .regex(/^(?:[1-5][0-9]{2}|[1-5]XX|default)$/u);
const httpStatusSchema = z.number().int().min(100).max(599);
const parameterLocationSchema = z.enum(['path', 'query', 'header', 'cookie']);
const schemaDocument = z.union([z.record(z.string(), z.json()), z.boolean()]);
const forbiddenHeaderValueNames =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)$/iu;

export const apiInterfacePathSchema = z
  .string()
  .min(1)
  .max(1200)
  .refine((path) => {
    if (
      !path.startsWith('/') ||
      path.startsWith('//') ||
      /[?#\\\s]/u.test(path)
    )
      return false;
    const plain = path.replace(
      /\{[a-zA-Z_][a-zA-Z0-9_.-]{0,127}\}/gu,
      'parameter',
    );
    if (/[{}]/u.test(plain)) return false;
    return plain.split('/').every((segment) => {
      try {
        const decoded = decodeURIComponent(segment);
        return (
          decoded !== '.' &&
          decoded !== '..' &&
          !/[\\/\u0000-\u0020\u007f]/u.test(decoded)
        );
      } catch {
        return false;
      }
    });
  }, '应为无主机、查询或片段的相对路由，路径变量用 {name} 声明。');

const basisSummary = {
  locator: boundedText.optional(),
  description: z.string().min(1).max(4000),
};
const materialBasisSchema = z.strictObject({
  ...basisSummary,
  kind: z.literal('material'),
  requirementVersionId: idSchema,
  materialId: idSchema,
  contentSha256: sha256Schema.optional(),
});
const statementBasisSchema = z.strictObject({
  ...basisSummary,
  kind: z.literal('explicitStatement'),
});
const diagnosticBasisSchema = z.strictObject({
  ...basisSummary,
  kind: z.literal('diagnostic'),
  runId: idSchema,
  attemptId: idSchema,
});
const revisionBasisSchema = z.strictObject({
  ...basisSummary,
  kind: z.literal('interfaceRevision'),
  interfaceId: idSchema,
  revisionId: idSchema,
});
export const apiCatalogBasisSchema = z.discriminatedUnion('kind', [
  materialBasisSchema,
  statementBasisSchema,
  diagnosticBasisSchema,
  revisionBasisSchema,
]);

export const apiInterfaceExampleSchema = z.strictObject({
  name: titleSchema,
  description: boundedText.default(''),
  value: z.json(),
});

export const apiInterfaceParameterSchema = z.strictObject({
  location: parameterLocationSchema,
  name: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .refine((name) => !/[\p{Cc}\s]/u.test(name)),
  required: z.boolean().default(false),
  description: boundedText.default(''),
  schema: schemaDocument.optional(),
  examples: z.array(apiInterfaceExampleSchema).max(25).default([]),
});

const headerSchema = z.strictObject({
  name: headerNameSchema,
  required: z.boolean().default(false),
  description: boundedText.default(''),
  schema: schemaDocument.optional(),
  examples: z.array(apiInterfaceExampleSchema).max(25).default([]),
});

export const apiInterfaceBodySchema = z.strictObject({
  mediaType: mediaTypeSchema,
  description: boundedText.default(''),
  required: z.boolean().default(false),
  schema: schemaDocument.optional(),
  examples: z.array(apiInterfaceExampleSchema).max(25).default([]),
});

export const apiInterfaceResponseSchema = z.strictObject({
  code: contentCodeSchema,
  description: boundedText.default(''),
  headers: z.array(headerSchema).max(100).default([]),
  content: z.array(apiInterfaceBodySchema).max(25).default([]),
});

export const apiInterfaceMockConditionSchema = z
  .strictObject({
    source: z.enum(['method', 'path', 'pathParam', 'query', 'header', 'body']),
    name: z.string().max(512).optional(),
    operator: z.enum(['equals', 'contains', 'exists']),
    value: z.json().optional(),
  })
  .superRefine((condition, ctx) => {
    const named = !['method', 'path'].includes(condition.source);
    if (named !== Boolean(condition.name))
      ctx.addIssue({
        code: 'custom',
        path: ['name'],
        message: named ? '应指定要匹配的字段。' : '此条件不使用字段名。',
      });
    if (
      condition.source === 'header' &&
      condition.name &&
      forbiddenHeaderValueNames.test(condition.name)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['name'],
        message: 'Mock 规则不得匹配凭据头。',
      });
    if ((condition.operator === 'exists') === (condition.value !== undefined))
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: '比较条件应明确填写值；存在性条件只检查字段。',
      });
  });

export const apiInterfaceMockRuleSchema = z.strictObject({
  name: titleSchema,
  enabled: z.boolean().default(true),
  priority: orderSchema,
  conditions: z.array(apiInterfaceMockConditionSchema).max(30),
  status: httpStatusSchema,
  mediaType: mediaTypeSchema,
  response: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('schema') }),
    z.strictObject({ kind: z.literal('example'), name: titleSchema }),
    z.strictObject({ kind: z.literal('fixed'), value: z.json() }),
  ]),
});

const apiInterfaceDefinitionFields = z.strictObject({
  serviceKey: keySchema,
  method: apiInterfaceMethodSchema,
  path: apiInterfacePathSchema,
  status: apiInterfaceStatusSchema.default('draft'),
  description: descriptionSchema.default(''),
  tags: z.array(titleSchema).max(20).default([]),
  ownerId: idSchema.nullable().default(null),
  requirementVersionId: idSchema.nullable().default(null),
  auth: z
    .discriminatedUnion('mode', [
      z.strictObject({ mode: z.literal('inherit') }),
      z.strictObject({ mode: z.literal('none') }),
      z.strictObject({ mode: z.literal('purpose'), purposeId: idSchema }),
    ])
    .default({ mode: 'none' }),
  parameters: z.array(apiInterfaceParameterSchema).max(200).default([]),
  requestBodies: z.array(apiInterfaceBodySchema).max(25).default([]),
  responses: z.array(apiInterfaceResponseSchema).max(100).default([]),
  models: z.record(keySchema, schemaDocument).default({}),
  mocks: z.array(apiInterfaceMockRuleSchema).max(50).default([]),
  basisRefs: z.array(apiCatalogBasisSchema).max(40).default([]),
  stageSettings: apiStageSettingsSchema.optional(),
});

export const apiInterfaceDefinitionSchema =
  apiInterfaceDefinitionFields.superRefine((definition, ctx) => {
    const pathNames = new Set(
      [...definition.path.matchAll(/\{([^{}]+)\}/gu)].map(
        (capture) => capture[1],
      ),
    );
    const parameterNames = new Set<string>();
    for (const [index, item] of definition.parameters.entries()) {
      const parameterKey =
        item.location +
        ':' +
        (item.location === 'header' ? item.name.toLowerCase() : item.name);
      if (parameterNames.has(parameterKey))
        ctx.addIssue({
          code: 'custom',
          path: ['parameters', index, 'name'],
          message: '同位置的参数不得重名。',
        });
      parameterNames.add(parameterKey);
      if (
        item.location === 'path' &&
        (!item.required || !pathNames.delete(item.name))
      )
        ctx.addIssue({
          code: 'custom',
          path: ['parameters', index],
          message: '路径参数必须存在于路由中并标为必填。',
        });
      if (
        (item.location === 'cookie' ||
          forbiddenHeaderValueNames.test(item.name)) &&
        item.examples.length
      )
        ctx.addIssue({
          code: 'custom',
          path: ['parameters', index, 'examples'],
          message: '凭据类参数只能声明，不能存储示例值。',
        });
    }
    if (pathNames.size)
      ctx.addIssue({
        code: 'custom',
        path: ['parameters'],
        message: '为 URL 中的每个路径变量提供参数声明。',
      });
    if (Object.keys(definition.models).length > 150)
      ctx.addIssue({
        code: 'custom',
        path: ['models'],
        message: '接口定义最多包含 150 个公共模型。',
      });
    if (
      new Set(
        definition.requestBodies.map((body) => body.mediaType.toLowerCase()),
      ).size !== definition.requestBodies.length
    )
      ctx.addIssue({
        code: 'custom',
        path: ['requestBodies'],
        message: '同一个请求媒体类型只能声明一次。',
      });
    if (
      new Set(definition.responses.map((response) => response.code)).size !==
      definition.responses.length
    )
      ctx.addIssue({
        code: 'custom',
        path: ['responses'],
        message: '同一个响应状态码只能声明一次。',
      });
    for (const [index, item] of definition.responses.entries()) {
      if (
        new Set(item.content.map((body) => body.mediaType.toLowerCase()))
          .size !== item.content.length
      )
        ctx.addIssue({
          code: 'custom',
          path: ['responses', index, 'content'],
          message: '同一个响应媒体类型只能声明一次。',
        });
      if (
        new Set(item.headers.map((header) => header.name.toLowerCase()))
          .size !== item.headers.length
      )
        ctx.addIssue({
          code: 'custom',
          path: ['responses', index, 'headers'],
          message: '响应头名称不得重复。',
        });
      for (const [headerIndex, header] of item.headers.entries()) {
        if (
          forbiddenHeaderValueNames.test(header.name) &&
          header.examples.length
        )
          ctx.addIssue({
            code: 'custom',
            path: ['responses', index, 'headers', headerIndex, 'examples'],
            message: '凭据类响应头只能声明，不能存储示例值。',
          });
      }
    }
    if (
      new Set(definition.mocks.map((mock) => mock.priority)).size !==
      definition.mocks.length
    )
      ctx.addIssue({
        code: 'custom',
        path: ['mocks'],
        message: 'Mock 规则必须具有不同的优先级。',
      });
    for (const [index, mock] of definition.mocks.entries()) {
      const result = mock.response;
      if (result.kind === 'fixed') continue;
      const content = definition.responses
        .find((item) => item.code === String(mock.status))
        ?.content.find((body) => body.mediaType === mock.mediaType);
      if (
        result.kind === 'schema'
          ? content?.schema === undefined
          : !content?.examples.some((item) => item.name === result.name)
      )
        ctx.addIssue({
          code: 'custom',
          path: ['mocks', index, 'response'],
          message: 'Mock 引用的响应 Schema 或命名示例不存在。',
        });
    }
  });

export const apiInterfaceResponseContractSchema =
  apiInterfaceDefinitionFields.pick({
    responses: true,
    models: true,
  });
export type ApiInterfaceResponseContract = z.infer<
  typeof apiInterfaceResponseContractSchema
>;

export const apiCatalogNodeSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema,
  kind: apiCatalogKindSchema,
  parentId: idSchema.nullable(),
  title: titleSchema,
  position: orderSchema,
  rowVersion: persistedRowVersionSchema,
  archivedAt: timestampSchema.nullable(),
  updatedAt: timestampSchema,
  currentRevisionId: idSchema.nullable(),
  revisionNumber: z.number().int().min(0),
  serviceKey: keySchema.nullable(),
  method: apiInterfaceMethodSchema.nullable(),
  path: apiInterfacePathSchema.nullable(),
  status: apiInterfaceStatusSchema.nullable(),
  tags: z.array(titleSchema),
});

export const apiCatalogRevisionSummarySchema = z.strictObject({
  id: idSchema,
  nodeId: idSchema,
  title: titleSchema,
  revisionNumber: z.number().int().min(1),
  createdAt: timestampSchema,
  createdBy: idSchema,
});

export const apiCatalogRevisionSchema = apiCatalogRevisionSummarySchema.extend({
  definition: apiInterfaceDefinitionSchema,
  stageProviders: z.array(apiCatalogStageProviderSchema).max(3),
});

export const apiCatalogUsageSchema = z.strictObject({
  projectId: idSchema,
  caseId: idSchema,
  caseType: z.enum(['single', 'scenario']),
  title: titleSchema,
  caseRevisionId: idSchema,
  interfaceRevisionId: idSchema,
});

export const apiCatalogListResultSchema = z.strictObject({
  nodes: z.array(apiCatalogNodeSchema),
});
export const apiCatalogGetResultSchema = z.strictObject({
  node: apiCatalogNodeSchema,
  directoryStages: apiStageSettingsSchema.nullable(),
  directoryProviders: z.array(apiCatalogStageProviderSchema).max(2),
  revision: apiCatalogRevisionSchema.nullable(),
  revisions: z.array(apiCatalogRevisionSummarySchema),
  usage: z.array(apiCatalogUsageSchema),
});

export const apiCatalogListInputSchema = z.strictObject({
  query: z.string().trim().max(200).optional(),
  method: apiInterfaceMethodSchema.optional(),
  status: apiInterfaceStatusSchema.optional(),
  tag: titleSchema.optional(),
  includeArchived: z.boolean().optional(),
});
export const apiCatalogGetInputSchema = z.strictObject({
  revisionId: idSchema.optional(),
});

const create = {
  commandId: commandIdSchema,
  title: titleSchema,
  position: orderSchema.optional(),
};
export const apiCatalogCreateInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...create,
    kind: z.literal('module'),
    directoryStages: apiStageSettingsSchema.optional(),
  }),
  z.strictObject({
    ...create,
    kind: z.literal('folder'),
    parentId: idSchema,
    directoryStages: apiStageSettingsSchema.optional(),
  }),
  z.strictObject({
    ...create,
    kind: z.literal('interface'),
    parentId: idSchema,
    definition: apiInterfaceDefinitionSchema,
  }),
]);
export const apiCatalogOrganizeInputSchema = z
  .strictObject({
    commandId: commandIdSchema,
    id: idSchema,
    rowVersion: persistedRowVersionSchema,
    title: titleSchema.optional(),
    parentId: idSchema.optional(),
    position: orderSchema.optional(),
    archived: z.boolean().optional(),
    directoryStages: apiStageSettingsSchema.optional(),
  })
  .refine(
    ({ title, parentId, position, archived, directoryStages }) =>
      title !== undefined ||
      parentId !== undefined ||
      position !== undefined ||
      archived !== undefined ||
      directoryStages !== undefined,
    '至少选择一项目录变更。',
  );
export const apiCatalogReviseInputSchema = z.strictObject({
  commandId: commandIdSchema,
  id: idSchema,
  baseRevisionId: idSchema,
  rowVersion: persistedRowVersionSchema,
  restoredFromRevisionId: idSchema.optional(),
  definition: apiInterfaceDefinitionSchema,
});

const importFormatSchema = z.enum([
  'openapi',
  'swagger',
  'postman',
  'har',
  'curl',
]);
export const apiCatalogImportPreviewInputSchema = z.strictObject({
  format: importFormatSchema,
  folderId: idSchema,
  serviceKey: keySchema,
  document: z.string().min(1).max(1_048_576),
  basis: z
    .discriminatedUnion('kind', [materialBasisSchema, statementBasisSchema])
    .optional(),
});
export const apiCatalogImportCandidateSchema = z.strictObject({
  title: titleSchema,
  definition: apiInterfaceDefinitionSchema,
  operation: z.enum(['create', 'revise', 'skip', 'conflict']),
  existing: apiCatalogNodeSchema.nullable(),
  changedFields: z.array(
    z.enum([
      'title',
      'method',
      'path',
      'status',
      'description',
      'tags',
      'ownerId',
      'auth',
      'parameters',
      'requestBodies',
      'responses',
      'models',
      'mocks',
      'basisRefs',
      'requirementVersionId',
    ]),
  ),
});
export const apiCatalogImportPreviewResultSchema = z.strictObject({
  digest: sha256Schema,
  candidates: z.array(apiCatalogImportCandidateSchema),
  warnings: z.array(z.string()),
});
export const apiCatalogImportApplyInputSchema =
  apiCatalogImportPreviewInputSchema.extend({
    commandId: commandIdSchema,
    digest: sha256Schema,
    selections: z
      .array(
        z.strictObject({
          index: z.number().int().min(0).max(499),
          fields: z
            .array(apiCatalogImportCandidateSchema.shape.changedFields.element)
            .min(1)
            .max(16)
            .optional(),
        }),
      )
      .min(1)
      .max(500),
  });

export const apiCatalogExportInputSchema = z.strictObject({
  revisionId: idSchema.optional(),
  format: z.enum(['openapi', 'markdown', 'curl']),
});
export const apiCatalogMockInputSchema = z.strictObject({
  revisionId: idSchema.optional(),
  method: apiInterfaceMethodSchema,
  path: z
    .string()
    .min(1)
    .max(2000)
    .startsWith('/')
    .refine((value) => !/[?#\p{Cc}]/u.test(value) && !value.startsWith('//')),
  query: z.record(z.string().max(256), z.string().max(10_000)).default({}),
  headers: z.record(headerNameSchema, z.string().max(10_000)).default({}),
  body: z.json().optional(),
});
export const apiCatalogExportResultSchema = z.strictObject({
  format: apiCatalogExportInputSchema.shape.format,
  mediaType: z.string(),
  fileName: z.string(),
  content: z.string(),
});
export const apiCatalogMockResultSchema = z.strictObject({
  source: z.literal('mock'),
  status: httpStatusSchema,
  mediaType: mediaTypeSchema,
  body: z.json(),
  ruleName: titleSchema.nullable(),
  revisionId: idSchema,
});

export const apiCatalogDiagnosticDraftInputSchema = z.strictObject({
  runId: idSchema,
  attemptId: idSchema,
  serviceKey: keySchema,
});
export const apiCatalogCloneDraftInputSchema = z.strictObject({
  interfaceId: idSchema,
  revisionId: idSchema,
});
export const apiCatalogSourceDraftSchema = z.strictObject({
  title: titleSchema,
  definition: apiInterfaceDefinitionSchema,
  warnings: z.array(z.string()).max(10),
});

export type ApiCatalogNode = z.infer<typeof apiCatalogNodeSchema>;
export type ApiCatalogGetResult = z.infer<typeof apiCatalogGetResultSchema>;
export type ApiInterfaceDefinition = z.infer<
  typeof apiInterfaceDefinitionSchema
>;
export type ApiInterfaceRevision = z.infer<typeof apiCatalogRevisionSchema>;
export type ApiCatalogImportPreviewInput = z.infer<
  typeof apiCatalogImportPreviewInputSchema
>;
export type ApiCatalogImportCandidate = z.infer<
  typeof apiCatalogImportCandidateSchema
>;
export type ApiCatalogMockInput = z.infer<typeof apiCatalogMockInputSchema>;
export type ApiCatalogSourceDraft = z.infer<typeof apiCatalogSourceDraftSchema>;
