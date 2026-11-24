import { z } from 'zod';
import {
  apiCatalogSourceDraftSchema,
  apiInterfaceMethodSchema,
  apiInterfacePathSchema,
  type ApiCatalogSourceDraft,
  type ApiInterfaceDefinition,
  type ApiInterfaceRevision,
} from '../../../contracts/src/api-catalog.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { isSensitiveName } from '../api-execution/redaction.js';
import { DomainError } from '../errors.js';

type DiagnosticOrigin = {
  runId: string;
  attemptId: string;
};
type DiagnosticRow = {
  request_safe: unknown;
  response_safe: unknown;
};
type SchemaValue = z.infer<ReturnType<typeof z.json>>;
type DefinitionSchema = ApiInterfaceDefinition['models'][string];

const safeHttp = z.object({
  type: z.literal('http'),
  method: apiInterfaceMethodSchema,
  url: z.string().max(8000),
  headers: z.record(z.string(), z.string()),
  body: z.json(),
});
const safeResponseMetadata = z.object({
  status: z.number().int().min(100).max(599).nullable(),
  headers: z.record(z.string(), z.string()),
});
const mediaType = /^[a-zA-Z0-9!#$%&'*+.^_~-]+\/[a-zA-Z0-9!#$%&'*+.^_~-]+$/u;
const runtimeHeader =
  /^(?:host|content-length|transfer-encoding|connection|content-type|set-cookie|proxy-authorization|x-api-key|x-auth-token)$/iu;
const headerName = /^[!#$%&'*+.^_a-zA-Z0-9|~\x60-]+$/u;
const redactedUrl = /\[redacted(?:[^\]]*)\]|\[\s*已脱敏\s*\]/iu;

function bodyMediaType(headers: Record<string, string>) {
  const metadata = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === 'content-type',
  )?.[1];
  const mime = metadata?.split(';')[0]?.trim().toLowerCase();
  return mime && mime.length <= 128 && mediaType.test(mime) ? mime : undefined;
}

export async function readCatalogDiagnosticSource(
  tx: SqlExecutor,
  projectId: string,
  origin: DiagnosticOrigin,
): Promise<DiagnosticRow> {
  const result = await tx.query<DiagnosticRow>(
    "SELECT a.request_safe,a.response_safe FROM app.api_step_attempts a JOIN app.api_debug_drafts d ON d.run_id=a.run_id AND d.project_id=a.project_id WHERE a.project_id=$1 AND a.run_id=$2 AND a.id=$3 AND a.phase='business' AND a.state='completed' AND a.send_intent_at IS NOT NULL AND (d.expires_at>clock_timestamp() OR EXISTS(SELECT 1 FROM app.api_regression_qualifications q WHERE q.debug_run_id=d.run_id))",
    [projectId, origin.runId, origin.attemptId],
  );
  const row = result.rows[0];
  if (!row)
    throw new DomainError(
      'NOT_FOUND',
      '未找到当前项目已完成、仍可访问的诊断请求。',
      404,
    );
  if (!safeHttp.safeParse(row.request_safe).success)
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '此诊断没有可用于创建接口的安全 HTTP 定义。',
      422,
    );
  return row;
}

function literalRoute(value: string): URL {
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      redactedUrl.test(decodeURIComponent(url.pathname)) ||
      !apiInterfacePathSchema.safeParse(url.pathname).success
    )
      throw Error('request target not portable');
    return url;
  } catch {
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '诊断目标没有可复用的明文相对路由。',
      422,
    );
  }
}

export function catalogDraftFromDiagnostic(
  row: DiagnosticRow,
  origin: DiagnosticOrigin,
  serviceKey: string,
): ApiCatalogSourceDraft {
  const http = safeHttp.parse(row.request_safe);
  const actual = literalRoute(http.url);
  const definitions: ApiInterfaceDefinition['parameters'] = [];
  for (const name of new Set(actual.searchParams.keys())) {
    if (definitions.length === 200) break;
    if (
      name.length <= 256 &&
      /^[^\s\p{Cc}]+$/u.test(name) &&
      !isSensitiveName(name)
    )
      definitions.push({
        location: 'query',
        name,
        required: false,
        description: '',
        examples: [],
      });
  }
  for (const name of new Set(
    Object.keys(http.headers).map((item) => item.toLowerCase()),
  )) {
    if (definitions.length === 200) break;
    if (
      name.length <= 256 &&
      headerName.test(name) &&
      !runtimeHeader.test(name) &&
      !isSensitiveName(name)
    )
      definitions.push({
        location: 'header',
        name,
        required: false,
        description: '',
        examples: [],
      });
  }
  const mime = bodyMediaType(http.headers);
  const response = safeResponseMetadata.safeParse(row.response_safe);
  const observedType = response.success
    ? bodyMediaType(response.data.headers)
    : undefined;
  const observedStatus = response.success ? response.data.status : null;
  return apiCatalogSourceDraftSchema.parse({
    title: (http.method + ' ' + actual.pathname).slice(0, 200),
    definition: {
      serviceKey,
      method: http.method,
      path: actual.pathname,
      status: 'draft',
      auth: { mode: 'none' },
      parameters: definitions,
      requestBodies: http.body !== null && mime ? [{ mediaType: mime }] : [],
      responses: observedStatus
        ? [
            {
              code: String(observedStatus),
              description: '诊断观察到的响应状态。请补充业务契约。',
              content: observedType ? [{ mediaType: observedType }] : [],
            },
          ]
        : [],
      basisRefs: [
        {
          kind: 'diagnostic',
          ...origin,
          description: '从已授权 HTTP 诊断的安全请求结构创建。',
        },
      ],
    },
    warnings: [
      '已去掉真实主机地址、认证和所有请求或响应示例值。请选择项目服务并补齐契约。',
      '路径保留诊断实际相对路径。编辑路径变量和对应声明后，可用于不同测试数据。',
    ],
  });
}

const schemaMapKeywords = new Set([
  'properties',
  'patternProperties',
  'dependentSchemas',
  '$defs',
  'definitions',
]);
const schemaBranchKeywords = new Set([
  'allOf',
  'anyOf',
  'oneOf',
  'prefixItems',
]);
const schemaChildKeywords = new Set([
  'items',
  'additionalProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
]);
const schemaAnnotationsWithValues = new Set(['default', 'examples', 'example']);
function copySchema(value: SchemaValue, protectedField = false): SchemaValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]): [string, SchemaValue][] => {
      if (
        schemaAnnotationsWithValues.has(key) ||
        (protectedField && (key === 'const' || key === 'enum'))
      )
        return [];
      if (
        schemaMapKeywords.has(key) &&
        child &&
        typeof child === 'object' &&
        !Array.isArray(child)
      ) {
        return [
          [
            key,
            Object.fromEntries(
              Object.entries(child).map(([name, definition]) => [
                name,
                copySchema(definition, protectedField || isSensitiveName(name)),
              ]),
            ),
          ],
        ];
      }
      if (schemaBranchKeywords.has(key) && Array.isArray(child))
        return [
          [key, child.map((branch) => copySchema(branch, protectedField))],
        ];
      return [
        [
          key,
          schemaChildKeywords.has(key)
            ? copySchema(child, protectedField)
            : child,
        ],
      ];
    }),
  );
}

function withoutExamples<
  T extends { schema?: DefinitionSchema | undefined; examples: unknown[] },
>(entry: T, protectedField = false): T {
  return {
    ...entry,
    examples: [],
    ...(entry.schema !== undefined && {
      schema: copySchema(entry.schema, protectedField),
    }),
  };
}

export function catalogDraftFromRevision(
  revision: ApiInterfaceRevision,
): ApiCatalogSourceDraft {
  // A copy carries declarations only. The source's environment, examples and
  // conditional mock payloads must not be imported as the copy's new data.
  const { stageSettings: _sourceStages, ...definition } = revision.definition;
  return apiCatalogSourceDraftSchema.parse({
    title: (revision.title + ' · 副本').slice(0, 200),
    definition: {
      ...definition,
      status: 'draft',
      ownerId: null,
      requirementVersionId: null,
      auth: { mode: 'none' },
      parameters: definition.parameters.map((item) =>
        withoutExamples(item, isSensitiveName(item.name)),
      ),
      requestBodies: definition.requestBodies.map((item) =>
        withoutExamples(item),
      ),
      responses: definition.responses.map((item) => ({
        ...item,
        headers: item.headers.map((header) =>
          withoutExamples(header, isSensitiveName(header.name)),
        ),
        content: item.content.map((body) => withoutExamples(body)),
      })),
      models: Object.fromEntries(
        Object.entries(definition.models).map(([name, schema]) => [
          name,
          copySchema(schema, isSensitiveName(name)),
        ]),
      ),
      mocks: [],
      basisRefs: [
        {
          kind: 'interfaceRevision',
          interfaceId: revision.nodeId,
          revisionId: revision.id,
          description: '复制自选定的固定接口修订。',
        },
      ],
    },
    warnings: [
      '本次复制不带示例、账号用途、前后置动作或 Mock。新接口按目标目录重新继承配置。',
      '请选择目标目录。要在同一项目保留独立副本，请使用不同的服务、方法或路径。',
    ],
  });
}
