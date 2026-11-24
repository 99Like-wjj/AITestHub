import { z } from 'zod';
import type {
  ApiCatalogMockInput,
  ApiInterfaceDefinition,
  ApiInterfaceRevision,
  apiCatalogExportInputSchema,
  apiCatalogExportResultSchema,
  apiCatalogMockResultSchema,
} from '../../../contracts/src/api-catalog.js';
import { canonicalJson } from '../operations/service.js';
import { isSensitiveName } from '../api-execution/redaction.js';
import { DomainError } from '../errors.js';

type Json = z.infer<ReturnType<typeof z.json>>;
type JsonObject = Record<string, Json>;
type Body = ApiInterfaceDefinition['requestBodies'][number];
type Example = Body['examples'][number];
type MockRule = ApiInterfaceDefinition['mocks'][number];

function object(value: unknown): JsonObject | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const parsed = z.record(z.string(), z.json()).safeParse(value);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

function mockUnavailable(message: string): never {
  throw new DomainError('PRECONDITIONS_MISSING', message, 422);
}

function pointer(root: unknown, path: string): unknown {
  if (path === '$' || path === '') return root;
  const normalized = path.replace(/^\$\.?/u, '').replace(/\[(\d+)\]/gu, '.$1');
  const steps = normalized.split('.');
  if (
    steps.length > 40 ||
    steps.some(
      (part) =>
        !part || ['__proto__', 'prototype', 'constructor'].includes(part),
    )
  )
    return undefined;
  let current = root;
  for (const part of steps) {
    if (
      !current ||
      typeof current !== 'object' ||
      !Object.hasOwn(current, part)
    )
      return undefined;
    if (Array.isArray(current)) {
      if (!/^\d+$/u.test(part)) return undefined;
      current = current[Number(part)];
    } else current = Object.getOwnPropertyDescriptor(current, part)?.value;
  }
  return current;
}

function routeMatch(
  template: string,
  path: string,
): Record<string, string> | null {
  const prescribed = template.split('/');
  const supplied = path.split('/');
  if (prescribed.length !== supplied.length) return null;
  const values = new Map<string, string>();
  let budget = 20_000;
  for (const [index, segment] of prescribed.entries()) {
    const raw = supplied[index];
    if (raw === undefined) return null;
    const tokens = segment.split(/(\{[^{}]+\})/gu).filter(Boolean);
    const seen = new Set<string>();
    const match = (
      position: number,
      start: number,
    ): [string, string][] | null => {
      if (--budget < 0) return null;
      const token = tokens[position];
      if (token === undefined) return start === raw.length ? [] : null;
      if (!token.startsWith('{')) {
        return raw.startsWith(token, start)
          ? match(position + 1, start + token.length)
          : null;
      }
      const key = position + ':' + start;
      if (seen.has(key)) return null;
      seen.add(key);
      const variable = token.slice(1, -1);
      const next = tokens[position + 1];
      if (next === undefined)
        return start < raw.length ? [[variable, raw.slice(start)]] : null;
      // Prefer the first viable separator and stop after a bounded number of
      // checks. Literal path templates are never compiled into a RegExp.
      const size = next.startsWith('{') ? 1 : next.length;
      for (let end = start + 1; end <= raw.length - size && budget > 0; end++) {
        if (!next.startsWith('{') && !raw.startsWith(next, end)) continue;
        const tail = match(position + 1, end);
        if (tail) return [[variable, raw.slice(start, end)], ...tail];
      }
      return null;
    };
    const pairs = match(0, 0);
    if (!pairs) return null;
    for (const [name, encoded] of pairs) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(encoded);
      } catch {
        return null;
      }
      if (values.has(name) && values.get(name) !== decoded) return null;
      values.set(name, decoded);
    }
  }
  return Object.fromEntries(values);
}

function conditionsMatch(
  rule: MockRule,
  request: ApiCatalogMockInput,
  params: Record<string, string>,
) {
  const headers = Object.fromEntries(
    Object.entries(request.headers).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ]),
  );
  return rule.conditions.every((condition) => {
    const name = condition.name ?? '';
    const actual =
      condition.source === 'method'
        ? request.method
        : condition.source === 'path'
          ? request.path
          : condition.source === 'pathParam'
            ? Object.hasOwn(params, name)
              ? params[name]
              : undefined
            : condition.source === 'query'
              ? Object.hasOwn(request.query, name)
                ? request.query[name]
                : undefined
              : condition.source === 'header'
                ? Object.hasOwn(headers, name.toLowerCase())
                  ? headers[name.toLowerCase()]
                  : undefined
                : pointer(request.body, name);
    if (condition.operator === 'exists') return actual !== undefined;
    if (actual === undefined) return false;
    if (condition.operator === 'contains') {
      if (typeof actual === 'string' && typeof condition.value === 'string')
        return actual.includes(condition.value);
      if (Array.isArray(actual))
        return actual.some(
          (item) => canonicalJson(item) === canonicalJson(condition.value),
        );
      return false;
    }
    return canonicalJson(actual) === canonicalJson(condition.value);
  });
}

function getStatus(
  definition: ApiInterfaceDefinition,
  status: number,
  mediaType: string,
) {
  const body = definition.responses
    .find((response) => response.code === String(status))
    ?.content.find((item) => item.mediaType === mediaType);
  if (!body) mockUnavailable('找不到 Mock 规则引用的响应和媒体类型。');
  return body;
}

function mockSchema(
  root: JsonObject | boolean,
  models: ApiInterfaceDefinition['models'],
): Json {
  let work = 0;
  const build = (raw: Json, refs: Set<string>, depth: number): Json => {
    if (depth > 16 || ++work > 5000)
      mockUnavailable('Mock Schema 超出递归或输出范围，请配置命名示例。');
    if (raw === false) mockUnavailable('Schema 不允许任何值，请配置命名示例。');
    const spec = object(raw) ?? {};
    if (typeof spec.$ref === 'string') {
      const key = spec.$ref.match(
        /^#\/components\/schemas\/([a-zA-Z_][a-zA-Z0-9_-]*)$/u,
      )?.[1];
      if (!key || refs.has(key) || !Object.hasOwn(models, key))
        mockUnavailable('Mock Schema 中的引用不可展开，请配置命名示例。');
      const target = models[key];
      if (target === undefined) mockUnavailable('Mock Schema 缺少公共模型。');
      return build(target, new Set([...refs, key]), depth + 1);
    }
    if (spec.const !== undefined) return spec.const;
    if (spec.example !== undefined) return spec.example;
    if (spec.default !== undefined) return spec.default;
    if (Array.isArray(spec.enum) && spec.enum[0] !== undefined)
      return spec.enum[0];
    if (Array.isArray(spec.examples) && spec.examples[0] !== undefined)
      return spec.examples[0];
    const sub = Array.isArray(spec.oneOf)
      ? spec.oneOf[0]
      : Array.isArray(spec.anyOf)
        ? spec.anyOf[0]
        : undefined;
    if (sub !== undefined) return build(sub, refs, depth + 1);
    if (Array.isArray(spec.allOf)) {
      const pieces = spec.allOf.map((item) => build(item, refs, depth + 1));
      if (pieces.every((value) => object(value) !== undefined))
        return Object.fromEntries(
          pieces.flatMap((item) => Object.entries(object(item) ?? {})),
        );
      if (pieces.length === 1 && pieces[0] !== undefined) return pieces[0];
      return mockUnavailable('组合 Schema 需要提供命名示例。');
    }
    const type = Array.isArray(spec.type)
      ? spec.type.find((item) => item !== 'null')
      : spec.type;
    if (type === 'object' || spec.properties !== undefined) {
      const props = object(spec.properties) ?? {};
      return Object.fromEntries(
        Object.entries(props)
          .filter(([name]) => !isSensitiveName(name))
          .map(([name, child]) => [name, build(child, refs, depth + 1)]),
      );
    }
    if (type === 'array') {
      const minimum =
        typeof spec.minItems === 'number'
          ? Math.max(0, Math.ceil(spec.minItems))
          : 0;
      if (minimum > 30)
        mockUnavailable('Mock 数组超出示例范围，请配置命名示例。');
      const size =
        typeof spec.maxItems === 'number' ? Math.min(1, spec.maxItems) : 1;
      return Array.from({ length: Math.max(minimum, size) }, () =>
        build(spec.items ?? true, refs, depth + 1),
      );
    }
    if (type === 'boolean') return false;
    if (type === 'integer' || type === 'number') {
      const min =
        typeof spec.minimum === 'number'
          ? spec.minimum
          : typeof spec.exclusiveMinimum === 'number'
            ? spec.exclusiveMinimum + 1
            : 0;
      const cap =
        typeof spec.maximum === 'number'
          ? spec.maximum
          : typeof spec.exclusiveMaximum === 'number'
            ? spec.exclusiveMaximum - 1
            : Infinity;
      if (min > cap) return mockUnavailable('数字范围需要提供命名示例。');
      return type === 'integer'
        ? Math.ceil(Math.min(min, cap))
        : Math.min(min, cap);
    }
    if (type === 'string') {
      if (spec.format === 'date') return '2000-01-01';
      if (spec.format === 'date-time') return '2000-01-01T00:00:00Z';
      if (spec.format === 'uuid') return '00000000-0000-4000-8000-000000000001';
      if (spec.format === 'email') return 'example@example.invalid';
      if (spec.pattern)
        return mockUnavailable('带正则限制的 Schema 需要提供命名示例。');
      const min =
        typeof spec.minLength === 'number'
          ? Math.max(0, Math.ceil(spec.minLength))
          : 0;
      if (min > 1000)
        return mockUnavailable('文本长度超过 Mock 生成限制，请配置命名示例。');
      const cap =
        typeof spec.maxLength === 'number' ? spec.maxLength : Infinity;
      return 'x'.repeat(Math.min(Math.max(1, min), cap));
    }
    return null;
  };
  return build(root, new Set(), 1);
}

function sampleFor(
  content: Body,
  model: ApiInterfaceDefinition['models'],
  mode: MockRule['response'] | undefined,
): Json {
  if (mode?.kind === 'fixed') return mode.value;
  if (mode?.kind === 'example') {
    const sample = content.examples.find(
      (example) => example.name === mode.name,
    );
    if (!sample) mockUnavailable('找不到指定的响应示例。');
    return sample.value;
  }
  const example = content.examples[0];
  if (mode === undefined && example) return example.value;
  if (content.schema !== undefined) return mockSchema(content.schema, model);
  return mockUnavailable('该响应尚无可用于模拟的示例或 Schema。');
}

export function simulateApiInterface(
  revision: ApiInterfaceRevision,
  request: ApiCatalogMockInput,
): z.infer<typeof apiCatalogMockResultSchema> {
  const definition = revision.definition;
  const params = routeMatch(definition.path, request.path);
  if (!params || request.method !== definition.method)
    throw new DomainError('NOT_FOUND', '请求方法或路径不匹配当前接口。', 404);
  const rule = [...definition.mocks]
    .sort((left, right) => left.priority - right.priority)
    .find((item) => item.enabled && conditionsMatch(item, request, params));
  if (rule) {
    const body =
      rule.response.kind === 'fixed'
        ? rule.response.value
        : sampleFor(
            getStatus(definition, rule.status, rule.mediaType),
            definition.models,
            rule.response,
          );
    return {
      source: 'mock',
      status: rule.status,
      mediaType: rule.mediaType,
      body,
      ruleName: rule.name,
      revisionId: revision.id,
    };
  }
  const response =
    definition.responses.find((item) => /^2\d\d$/u.test(item.code)) ??
    definition.responses.find((item) => /^[1-5]\d\d$/u.test(item.code));
  if (!response)
    mockUnavailable('当前接口未定义数字响应码或可匹配的 Mock 规则。');
  const content = response.content[0];
  return {
    source: 'mock',
    status: Number(response.code),
    mediaType: content?.mediaType ?? 'application/json',
    body: content ? sampleFor(content, definition.models, undefined) : null,
    ruleName: null,
    revisionId: revision.id,
  };
}

function examples(examplesList: Example[]) {
  return examplesList.length
    ? {
        examples: Object.fromEntries(
          examplesList.map((sample) => [
            sample.name,
            { description: sample.description, value: sample.value },
          ]),
        ),
      }
    : {};
}
function openApiContent(content: Body[]) {
  return Object.fromEntries(
    content.map((body) => [
      body.mediaType,
      {
        ...(body.schema !== undefined ? { schema: body.schema } : {}),
        ...examples(body.examples),
      },
    ]),
  );
}

function openApiDocument(title: string, revision: ApiInterfaceRevision) {
  const definition = revision.definition;
  return {
    openapi: '3.1.0',
    info: { title, version: String(revision.revisionNumber) },
    paths: {
      [definition.path]: {
        [definition.method.toLowerCase()]: {
          summary: title,
          description: definition.description,
          tags: definition.tags,
          ...(definition.status === 'deprecated' ? { deprecated: true } : {}),
          ...(definition.auth.mode === 'none' ? { security: [] } : {}),
          parameters: definition.parameters.map((item) => ({
            in: item.location,
            name: item.name,
            required: item.required,
            description: item.description,
            ...(item.schema !== undefined ? { schema: item.schema } : {}),
            ...examples(item.examples),
          })),
          ...(definition.requestBodies.length
            ? {
                requestBody: {
                  required: definition.requestBodies.some(
                    (body) => body.required,
                  ),
                  content: openApiContent(definition.requestBodies),
                },
              }
            : {}),
          responses: Object.fromEntries(
            definition.responses.map((item) => [
              item.code,
              {
                description: item.description || '响应',
                headers: Object.fromEntries(
                  item.headers.map((header) => [
                    header.name,
                    {
                      description: header.description,
                      ...(header.schema !== undefined
                        ? { schema: header.schema }
                        : {}),
                      ...examples(header.examples),
                    },
                  ]),
                ),
                content: openApiContent(item.content),
              },
            ]),
          ),
        },
      },
    },
    components: { schemas: definition.models },
  };
}

function curlQuote(text: string) {
  return "'" + text.replace(/'/gu, "'\\''") + "'";
}
function firstParamExample(examplesList: Example[]) {
  const candidate = examplesList[0]?.value;
  return typeof candidate === 'string' ||
    typeof candidate === 'number' ||
    typeof candidate === 'boolean'
    ? String(candidate)
    : null;
}
function curlDocument(definition: ApiInterfaceDefinition) {
  const available = definition.parameters.filter(
    (item) =>
      !isSensitiveName(item.name) &&
      item.location !== 'cookie' &&
      !/^proxy-authorization$|^x-api-key$/iu.test(item.name),
  );
  let path = definition.path;
  for (const item of available)
    if (item.location === 'path')
      path = path.replaceAll(
        '{' + item.name + '}',
        encodeURIComponent(
          firstParamExample(item.examples) ?? '{' + item.name + '}',
        ),
      );
  const address = new URL('https://example.invalid' + path);
  for (const item of available) {
    const sample = firstParamExample(item.examples);
    if (sample !== null && item.location === 'query')
      address.searchParams.append(item.name, sample);
  }
  const command = [
    'curl',
    '--request',
    definition.method,
    curlQuote(address.toString()),
  ];
  for (const item of available) {
    const sample = firstParamExample(item.examples);
    if (sample !== null && item.location === 'header')
      command.push('--header', curlQuote(item.name + ': ' + sample));
  }
  const body = definition.requestBodies[0];
  const sample = body?.examples[0];
  if (body && sample)
    command.push(
      '--header',
      curlQuote('Content-Type: ' + body.mediaType),
      '--data-raw',
      curlQuote(
        typeof sample.value === 'string'
          ? sample.value
          : JSON.stringify(sample.value),
      ),
    );
  return command.join(' ');
}

function markdownDocument(title: string, revision: ApiInterfaceRevision) {
  const definition = revision.definition;
  const code = String.fromCharCode(96);
  const info = [
    '# ' + title,
    '',
    code +
      definition.method +
      ' ' +
      definition.path +
      code +
      ' · 修订 ' +
      revision.revisionNumber,
    '',
    definition.description,
    '',
    '## 请求参数',
    ...definition.parameters.map(
      (item) =>
        '- ' +
        item.location +
        ' ' +
        code +
        item.name +
        code +
        (item.required ? '（必填）' : '') +
        ' ' +
        item.description,
    ),
    '',
    '## 请求正文',
    ...definition.requestBodies.map(
      (item) => '- ' + code + item.mediaType + code + ' ' + item.description,
    ),
    '',
    '## 响应',
    ...definition.responses.flatMap((item) => [
      '### ' + item.code + ' ' + item.description,
      ...item.content.map(
        (body) => '- ' + code + body.mediaType + code + ' ' + body.description,
      ),
    ]),
  ];
  return info.join('\n') + '\n';
}

export function exportApiInterface(
  title: string,
  revision: ApiInterfaceRevision,
  format: z.infer<typeof apiCatalogExportInputSchema>['format'],
): z.infer<typeof apiCatalogExportResultSchema> {
  const base = revision.nodeId + '-r' + revision.revisionNumber;
  if (format === 'openapi')
    return {
      format,
      mediaType: 'application/json',
      fileName: base + '.openapi.json',
      content: JSON.stringify(openApiDocument(title, revision), null, 2) + '\n',
    };
  if (format === 'markdown')
    return {
      format,
      mediaType: 'text/markdown',
      fileName: base + '.md',
      content: markdownDocument(title, revision),
    };
  return {
    format,
    mediaType: 'text/plain',
    fileName: base + '.curl.txt',
    content: curlDocument(revision.definition) + '\n',
  };
}
