import { parseDocument } from 'yaml';
import { z } from 'zod';
import {
  apiInterfaceDefinitionSchema,
  apiInterfaceMethodSchema,
  type ApiCatalogImportPreviewInput,
  type ApiInterfaceDefinition,
} from '../../../contracts/src/api-catalog.js';
import { isSensitiveName } from '../api-execution/redaction.js';
import { DomainError } from '../errors.js';

type Json = z.infer<ReturnType<typeof z.json>>;
type JsonObject = Record<string, Json>;
type Body = ApiInterfaceDefinition['requestBodies'][number];
type Parameter = ApiInterfaceDefinition['parameters'][number];
type Response = ApiInterfaceDefinition['responses'][number];
type Candidate = { title: string; definition: ApiInterfaceDefinition };
const maxDocumentBytes = 1024 * 1024;
const maxCandidates = 500;
const record = z.record(z.string(), z.json());
const secretPattern =
  /\b(?:ath_(?:key|session|reset)_|sk-)[\w-]{20,}|\b(?:Bearer|Basic)\s+[\w+/=-]{12,}|\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----/iu;
const credentialField = (name: string) =>
  isSensitiveName(name) ||
  /^(?:proxy[-_]?authorization|x[-_]?api[-_]?key|x[-_]?auth[-_]?token|private[-_]?key)$/iu.test(
    name,
  );
const restrictedKey = new Set(['__proto__', 'prototype', 'constructor']);

const validation = (message: string) =>
  new DomainError('VALIDATION_ERROR', message, 400);
const obj = (value: unknown): JsonObject => {
  const parsed = record.safeParse(value);
  return parsed.success ? parsed.data : {};
};
const arr = (value: unknown): Json[] => (Array.isArray(value) ? value : []);
const text = (value: unknown, max = 4000) =>
  typeof value === 'string' ? value.slice(0, max) : '';
const json = (value: unknown): Json | undefined => {
  const parsed = z.json().safeParse(value);
  return parsed.success ? parsed.data : undefined;
};
const schema = (value: unknown): JsonObject | boolean | undefined =>
  typeof value === 'boolean'
    ? value
    : value && typeof value === 'object' && !Array.isArray(value)
      ? obj(value)
      : undefined;
const stripRef = (value: string) =>
  value.replace(/^#\/definitions\//u, '#/components/schemas/');

function walk(
  root: unknown,
  visit: (name: string, value: unknown, parent: JsonObject | undefined) => void,
) {
  const queue: {
    key: string;
    value: unknown;
    depth: number;
    parent?: JsonObject;
  }[] = [{ key: '', value: root, depth: 0 }];
  let count = 0;
  while (queue.length) {
    const current = queue.pop();
    if (!current) continue;
    if (++count > 100000 || current.depth > 64)
      throw validation('接口文档的嵌套层级或字段数量超过支持范围。');
    if (restrictedKey.has(current.key))
      throw validation('接口文档含有保留对象字段，请在导入前移除。');
    visit(current.key, current.value, current.parent);
    if (Array.isArray(current.value)) {
      for (const item of current.value)
        queue.push({ key: '', value: item, depth: current.depth + 1 });
    } else if (current.value !== null && typeof current.value === 'object') {
      for (const [name, value] of Object.entries(current.value))
        queue.push({
          key: name,
          value,
          depth: current.depth + 1,
          parent: current.value as JsonObject,
        });
    }
  }
}

function assertExample(value: unknown) {
  walk(value, (name, child) => {
    if (
      (name && credentialField(name) && child !== null) ||
      (typeof child === 'string' && secretPattern.test(child))
    )
      throw validation('示例或 Mock 响应含有凭据值，请通过授权配置引用。');
    if (
      typeof child === 'string' &&
      /(?:^|[?&\s])(?:password|token|auth|secret|api[-_]?key|credential)=/iu.test(
        child,
      )
    )
      throw validation('示例或 Mock 响应含有认证表单值，请通过授权配置引用。');
  });
}

export function assertNativeDefinition(definition: ApiInterfaceDefinition) {
  if (Buffer.byteLength(JSON.stringify(definition)) > maxDocumentBytes)
    throw validation('单个接口定义超过 1 MiB。');
  walk(definition, (name, child, parent) => {
    if (typeof child === 'string' && secretPattern.test(child))
      throw validation('接口定义含有明文凭据，请通过授权配置引用。');
    if (
      name === '$ref' &&
      (typeof child !== 'string' || !child.startsWith('#/'))
    )
      throw validation('外部 Schema 引用不可登记，请导入文档内的声明。');
    if (
      (name === 'default' ||
        name === 'example' ||
        name === 'const' ||
        name === 'enum') &&
      parent
    )
      assertExample(child);
  });
  const groups = [
    ...definition.parameters,
    ...definition.requestBodies,
    ...definition.responses.flatMap((response) => [
      ...response.headers,
      ...response.content,
    ]),
  ];
  for (const group of groups)
    for (const example of group.examples) assertExample(example.value);
  for (const mock of definition.mocks) {
    if (mock.response.kind === 'fixed') assertExample(mock.response.value);
    for (const condition of mock.conditions)
      if (condition.value !== undefined) {
        if (condition.name && credentialField(condition.name))
          throw validation('Mock 规则不得使用凭据字段值。');
        assertExample(condition.value);
      }
  }
}

function sourceDocument(raw: string): JsonObject {
  if (Buffer.byteLength(raw) > maxDocumentBytes)
    throw validation('导入材料不得大于 1 MiB。');
  const document = parseDocument(raw, {
    strict: true,
    uniqueKeys: true,
    prettyErrors: false,
  });
  if (document.errors.length || document.warnings.length)
    throw validation('导入材料含无效的 JSON/YAML、重复字段或自定义标记。');
  let decoded: unknown;
  try {
    decoded = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw validation('导入材料含有不支持的 YAML 别名。');
  }
  // Inspect bounds before Zod walks untrusted nested input.
  walk(decoded, () => {});
  const parsed = record.safeParse(decoded);
  if (!parsed.success) throw validation('请选择以对象形式提供的导入文档。');
  return parsed.data;
}

function localPointer(root: Json, pointer: string): Json | undefined {
  if (!pointer.startsWith('#/')) return undefined;
  let value: Json | undefined = root;
  for (const token of pointer.slice(2).split('/')) {
    const key = token.replace(/~1/gu, '/').replace(/~0/gu, '~');
    if (
      !value ||
      typeof value !== 'object' ||
      !Object.hasOwn(value, key) ||
      restrictedKey.has(key)
    )
      return undefined;
    value = obj(value)[key];
  }
  return value;
}

function dereference(
  root: JsonObject,
  raw: Json | undefined,
  warnings: Set<string>,
): JsonObject {
  let value = obj(raw);
  const visited = new Set<string>();
  while (typeof value.$ref === 'string') {
    const ref = value.$ref;
    if (visited.has(ref) || visited.size >= 16) {
      warnings.add('部分结构引用存在环路或超出引用深度。');
      return {};
    }
    visited.add(ref);
    const target = localPointer(root, ref);
    if (target === undefined) {
      warnings.add(
        '部分定义引用不可解析；导入器只读取文档内引用，不读取外部地址。',
      );
      return {};
    }
    value = obj(target);
  }
  return value;
}

function cleanSchema(raw: unknown): JsonObject | boolean | undefined {
  if (typeof raw === 'boolean') return raw;
  const value = schema(raw);
  if (!value || typeof value !== 'object') return undefined;
  const visit = (current: Json): Json => {
    if (Array.isArray(current)) return current.map(visit);
    if (current && typeof current === 'object') {
      const fields: [string, Json][] = [];
      for (const [key, child] of Object.entries(current)) {
        if (key === '$ref') {
          if (typeof child === 'string' && child.startsWith('#/'))
            fields.push([key, stripRef(child)]);
          // Do not carry an unresolvable external address into the catalog.
        } else if (
          !['example', 'examples', 'default', 'const', 'enum'].includes(key) ||
          canUseExample(child)
        ) {
          fields.push([key, visit(child)]);
        }
      }
      return Object.fromEntries(fields);
    }
    return current;
  };
  return obj(visit(value));
}

function canUseExample(value: unknown): boolean {
  try {
    assertExample(value);
    return true;
  } catch (error) {
    if (error instanceof DomainError) return false;
    throw error;
  }
}

function examples(root: JsonObject, spec: JsonObject, warnings: Set<string>) {
  const result: ApiInterfaceDefinition['parameters'][number]['examples'] = [];
  const add = (name: string, value: unknown, description = '') => {
    const decoded = json(value);
    if (decoded === undefined) return;
    if (!canUseExample(decoded)) {
      warnings.add('凭据类或受限示例未导入。');
      return;
    }
    result.push({ name, description, value: decoded });
  };
  if (spec.example !== undefined) add('默认示例', spec.example);
  for (const [key, value] of Object.entries(obj(spec.examples)).slice(0, 24)) {
    const sample = dereference(root, value, warnings);
    if (sample.externalValue !== undefined) warnings.add('外部示例未导入。');
    add(key.slice(0, 200), sample.value, text(sample.description));
  }
  return result;
}

function mediaBodies(
  root: JsonObject,
  content: unknown,
  warnings: Set<string>,
  required = false,
): Body[] {
  const output: Body[] = [];
  for (const [mediaType, raw] of Object.entries(obj(content))) {
    const spec = obj(raw);
    const standard = cleanSchema(spec.schema);
    output.push({
      mediaType,
      required,
      description: text(spec.description),
      ...(standard !== undefined ? { schema: standard } : {}),
      examples: examples(root, spec, warnings),
    });
  }
  return output;
}

function simpleParameter(
  root: JsonObject,
  raw: Json,
  warnings: Set<string>,
): Parameter | undefined {
  const parameter = dereference(root, raw, warnings);
  const name = text(parameter.name, 256);
  const location = parameter.in;
  if (
    !name ||
    (location !== 'path' &&
      location !== 'query' &&
      location !== 'header' &&
      location !== 'cookie')
  )
    return undefined;
  const standardized = cleanSchema(
    parameter.schema ??
      (typeof parameter.type === 'string'
        ? {
            type: parameter.type,
            ...(parameter.format ? { format: parameter.format } : {}),
            ...(parameter.items ? { items: parameter.items } : {}),
            ...(parameter.enum ? { enum: parameter.enum } : {}),
            ...(parameter.minimum !== undefined
              ? { minimum: parameter.minimum }
              : {}),
            ...(parameter.maximum !== undefined
              ? { maximum: parameter.maximum }
              : {}),
            ...(parameter.pattern !== undefined
              ? { pattern: parameter.pattern }
              : {}),
            ...(parameter.default !== undefined
              ? { default: parameter.default }
              : {}),
          }
        : undefined),
  );
  return {
    location,
    name,
    required: location === 'path' || parameter.required === true,
    description: text(parameter.description),
    ...(standardized !== undefined ? { schema: standardized } : {}),
    examples:
      credentialField(name) || location === 'cookie'
        ? []
        : examples(root, parameter, warnings),
  };
}

function materialCandidates(
  input: ApiCatalogImportPreviewInput,
  warnings: Set<string>,
): Candidate[] {
  const root = sourceDocument(input.document);
  const swagger = input.format === 'swagger';
  if (
    swagger
      ? root.swagger !== '2.0'
      : !/^3\.[01]\.\d+(?:[-+].*)?$/u.test(text(root.openapi))
  )
    throw validation(
      swagger
        ? '请选择 Swagger 2.0 文档。'
        : '请选择 OpenAPI 3.0 或 3.1 文档。',
    );
  if (
    root.servers !== undefined ||
    root.host !== undefined ||
    root.security !== undefined
  )
    warnings.add(
      '文档中的目标主机与认证方案不作为运行配置，执行时使用项目配置绑定。',
    );
  const models = Object.fromEntries(
    Object.entries(
      obj(swagger ? root.definitions : obj(root.components).schemas),
    ).flatMap(([label, raw]) => {
      if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,99}$/u.test(label)) {
        warnings.add('部分公共模型的名称不符合平台命名要求。');
        return [];
      }
      const normalized = cleanSchema(raw);
      return normalized !== undefined ? [[label, normalized]] : [];
    }),
  );
  const result: Candidate[] = [];
  for (const [path, raw] of Object.entries(obj(root.paths))) {
    const item = dereference(root, raw, warnings);
    for (const [verb, rawOperation] of Object.entries(item)) {
      const method = apiInterfaceMethodSchema.safeParse(verb.toUpperCase());
      if (!method.success) continue;
      const op = dereference(root, rawOperation, warnings);
      const allParameters = [...arr(item.parameters), ...arr(op.parameters)];
      const parameters = new Map<string, Parameter>();
      let requestBodies: Body[] = [];
      for (const parameter of allParameters) {
        const structured = simpleParameter(root, parameter, warnings);
        if (structured) {
          parameters.set(
            structured.location + ':' + structured.name.toLowerCase(),
            structured,
          );
          continue;
        }
        const spec = dereference(root, parameter, warnings);
        if (!swagger || spec.in !== 'body') {
          warnings.add('部分参数位置或结构未映射。');
          continue;
        }
        const standard = cleanSchema(spec.schema);
        requestBodies = mediaList(op.consumes ?? root.consumes).map(
          (mediaType) => ({
            mediaType,
            required: spec.required === true,
            description: text(spec.description),
            ...(standard !== undefined ? { schema: standard } : {}),
            examples: examples(root, spec, warnings),
          }),
        );
      }
      if (!swagger && op.requestBody !== undefined) {
        const body = dereference(root, op.requestBody, warnings);
        requestBodies = mediaBodies(
          root,
          body.content,
          warnings,
          body.required === true,
        );
      }
      const responses: Response[] = [];
      for (const [code, rawResponse] of Object.entries(obj(op.responses))) {
        const response = dereference(root, rawResponse, warnings);
        const headers: Response['headers'] = [];
        for (const [name, rawHeader] of Object.entries(obj(response.headers))) {
          const header = dereference(root, rawHeader, warnings);
          const standard = cleanSchema(
            header.schema ??
              (typeof header.type === 'string'
                ? { type: header.type }
                : undefined),
          );
          headers.push({
            name,
            required: header.required === true,
            description: text(header.description),
            ...(standard !== undefined ? { schema: standard } : {}),
            examples: credentialField(name)
              ? []
              : examples(root, header, warnings),
          });
        }
        const standard = cleanSchema(response.schema);
        const content = swagger
          ? mediaList(op.produces ?? root.produces).flatMap((mediaType) => {
              const example = obj(response.examples)[mediaType];
              if (standard === undefined && example === undefined) return [];
              return [
                {
                  mediaType,
                  description: '',
                  required: false,
                  ...(standard !== undefined ? { schema: standard } : {}),
                  examples:
                    example === undefined
                      ? []
                      : examples(root, { example }, warnings),
                },
              ];
            })
          : mediaBodies(root, response.content, warnings);
        responses.push({
          code,
          description: text(response.description),
          headers,
          content,
        });
      }
      add(
        result,
        warnings,
        text(op.summary ?? op.operationId, 200) || method.data + ' ' + path,
        {
          serviceKey: input.serviceKey,
          method: method.data,
          path,
          description: text(op.description, 30000),
          tags: arr(op.tags)
            .map((tag) => text(tag, 200))
            .filter(Boolean),
          parameters: [...parameters.values()],
          requestBodies,
          responses,
          models,
        },
        input,
      );
    }
  }
  return result;
}

function mediaList(raw: unknown) {
  const list = arr(raw)
    .map((value) => text(value, 128))
    .filter(Boolean);
  return list.length ? [...new Set(list)] : ['application/json'];
}

function add(
  result: Candidate[],
  warnings: Set<string>,
  title: string,
  raw: Record<string, unknown>,
  input: ApiCatalogImportPreviewInput,
) {
  const parsed = apiInterfaceDefinitionSchema.safeParse({
    ...raw,
    basisRefs: input.basis ? [input.basis] : [],
  });
  if (!parsed.success) {
    warnings.add('部分接口定义不通过新契约，未列入可导入结果。');
    return;
  }
  try {
    assertNativeDefinition(parsed.data);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    warnings.add('部分接口定义含受限值或超出边界，未列入可导入结果。');
    return;
  }
  if (result.length >= maxCandidates)
    throw validation('一次最多预览 500 个接口，请拆分文档。');
  result.push({ title: title.slice(0, 200).trim(), definition: parsed.data });
}

type CapturedRequest = {
  title?: string;
  method?: string;
  url: string;
  headers: { name: string; value: string }[];
  body?: string;
  bodyType?: string;
  response?: { status: number; mediaType?: string; body?: string };
};

function parsedLiteral(raw: string, mediaType: string): Json {
  if (/(?:\/json|\+json)$/iu.test(mediaType)) {
    try {
      return z.json().parse(JSON.parse(raw));
    } catch {
      throw validation('JSON 示例的格式无效。');
    }
  }
  return raw;
}

function requestCandidate(
  capture: CapturedRequest,
  input: ApiCatalogImportPreviewInput,
  warnings: Set<string>,
  result: Candidate[],
) {
  let address: URL;
  try {
    const url = capture.url
      .trim()
      .replace(/^\{\{[^{}]+\}\}(?=\/)/u, 'https://example.invalid');
    address = new URL(url, 'https://example.invalid');
  } catch {
    warnings.add('部分请求目标无法解析，未导入。');
    return;
  }
  if (
    !['http:', 'https:'].includes(address.protocol) ||
    address.username ||
    address.password ||
    address.hash
  ) {
    warnings.add('部分请求含凭据、片段或不支持的协议，未导入。');
    return;
  }
  const path = address.pathname
    .replace(/%7B/giu, '{')
    .replace(/%7D/giu, '}')
    .replace(/\/:([A-Za-z_][A-Za-z0-9_-]*)(?=\/|$)/gu, '/{$1}');
  const method = (
    capture.method || (capture.body === undefined ? 'GET' : 'POST')
  ).toUpperCase();
  const parameters: Parameter[] = [];
  const seen = new Set<string>();
  const setParameter = (
    location: Parameter['location'],
    name: string,
    sample?: string,
  ) => {
    const key =
      location + ':' + (location === 'header' ? name.toLowerCase() : name);
    if (seen.has(key) || !name) return;
    seen.add(key);
    const include =
      !credentialField(name) && sample !== undefined && canUseExample(sample);
    if (sample !== undefined && !include)
      warnings.add('认证头、Cookie 和凭据值不作为导入示例。');
    parameters.push({
      location,
      name,
      required: location === 'path',
      description: '',
      schema: { type: 'string' },
      examples: include
        ? [{ name: '导入示例', description: '', value: sample }]
        : [],
    });
  };
  for (const [name] of [...path.matchAll(/\{([^{}]+)\}/gu)].flatMap((item) =>
    item[1] ? [[item[1]]] : [],
  ))
    if (name) setParameter('path', name);
  for (const [name, value] of address.searchParams)
    setParameter('query', name, value);
  for (const { name, value } of capture.headers)
    if (
      /^(?:authorization|cookie|host|proxy-authorization|x-api-key|api-key)$/iu.test(
        name,
      )
    )
      warnings.add('认证头、Cookie 和凭据值不作为导入示例。');
    else setParameter('header', name, value);
  const requestBodies: Body[] = [];
  if (capture.body !== undefined) {
    const mediaType = (
      capture.bodyType ||
      capture.headers.find(
        (header) => header.name.toLowerCase() === 'content-type',
      )?.value ||
      'text/plain'
    )
      .split(';')[0]
      ?.trim();
    if (mediaType) {
      const value = parsedLiteral(capture.body, mediaType);
      if (canUseExample(value))
        requestBodies.push({
          mediaType,
          required: false,
          description: '',
          examples: [{ name: '导入示例', description: '', value }],
        });
      else warnings.add('含有凭据字段的请求正文示例未导入。');
    }
  }
  const responses: Response[] = [];
  if (
    capture.response &&
    capture.response.status >= 100 &&
    capture.response.status <= 599
  ) {
    const mediaType = capture.response.mediaType?.split(';')[0]?.trim();
    const body = capture.response.body;
    const content: Body[] = [];
    if (mediaType && body !== undefined) {
      try {
        const value = parsedLiteral(body, mediaType);
        if (canUseExample(value))
          content.push({
            mediaType,
            required: false,
            description: '',
            examples: [{ name: '导入示例', description: '', value }],
          });
        else warnings.add('含有凭据字段的响应正文示例未导入。');
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        warnings.add('响应正文无法作为有效示例导入。');
      }
    }
    responses.push({
      code: String(capture.response.status),
      description: '',
      headers: [],
      content,
    });
  }
  add(
    result,
    warnings,
    capture.title || method + ' ' + path,
    {
      serviceKey: input.serviceKey,
      method,
      path,
      parameters,
      requestBodies,
      responses,
    },
    input,
  );
}

function captureHeaders(value: unknown) {
  return arr(value)
    .map(obj)
    .filter((header) => header.disabled !== true)
    .flatMap((header) => {
      const name = text(header.key ?? header.name, 256);
      const value = text(header.value, 10_000);
      return name ? [{ name, value }] : [];
    });
}

function postman(
  input: ApiCatalogImportPreviewInput,
  warnings: Set<string>,
): Candidate[] {
  const root = sourceDocument(input.document);
  const pending = [...arr(root.item)];
  const result: Candidate[] = [];
  if (!pending.length) throw validation('此文档没有 Postman 请求项目。');
  while (pending.length) {
    const item = obj(pending.shift());
    pending.push(...arr(item.item));
    const request = obj(item.request);
    const url =
      typeof item.request === 'string'
        ? item.request
        : typeof request.url === 'string'
          ? request.url
          : text(obj(request.url).raw, 4000);
    if (!url) continue;
    const bodyInput = obj(request.body);
    const headers = captureHeaders(request.header);
    const responseExample = obj(arr(item.response)[0]);
    const status = responseExample.code;
    const responseType = captureHeaders(responseExample.header).find(
      ({ name }) => name.toLowerCase() === 'content-type',
    )?.value;
    if (request.auth !== undefined || item.event !== undefined)
      warnings.add('Postman 认证与脚本未导入。');
    if (bodyInput.mode !== undefined && bodyInput.mode !== 'raw')
      warnings.add('Postman 的非 raw 请求体未导入；可在工作台补充。');
    requestCandidate(
      {
        title: text(item.name, 200),
        method: text(request.method, 10),
        url,
        headers,
        ...(bodyInput.mode === 'raw' && typeof bodyInput.raw === 'string'
          ? { body: bodyInput.raw }
          : {}),
        ...(typeof status === 'number'
          ? {
              response: {
                status,
                ...(responseType ? { mediaType: responseType } : {}),
                ...(typeof responseExample.body === 'string'
                  ? { body: responseExample.body }
                  : {}),
              },
            }
          : {}),
      },
      input,
      warnings,
      result,
    );
  }
  return result;
}

function har(
  input: ApiCatalogImportPreviewInput,
  warnings: Set<string>,
): Candidate[] {
  const root = sourceDocument(input.document);
  const entries = arr(obj(root.log).entries);
  if (!entries.length) throw validation('此文档没有 HAR 请求条目。');
  const result: Candidate[] = [];
  for (const raw of entries) {
    const entry = obj(raw);
    const request = obj(entry.request);
    if (typeof request.url !== 'string') continue;
    const body = obj(request.postData);
    const response = obj(entry.response);
    const content = obj(response.content);
    if (content.encoding !== undefined || request.cookies !== undefined)
      warnings.add('HAR 中的编码二进制响应与 Cookie 未作为示例导入。');
    requestCandidate(
      {
        url: request.url,
        method: text(request.method, 10),
        headers: captureHeaders(request.headers),
        ...(typeof body.text === 'string' ? { body: body.text } : {}),
        ...(typeof body.mimeType === 'string'
          ? { bodyType: body.mimeType }
          : {}),
        ...(typeof response.status === 'number'
          ? {
              response: {
                status: response.status,
                ...(typeof content.mimeType === 'string'
                  ? { mediaType: content.mimeType }
                  : {}),
                ...(content.encoding === undefined &&
                typeof content.text === 'string'
                  ? { body: content.text }
                  : {}),
              },
            }
          : {}),
      },
      input,
      warnings,
      result,
    );
  }
  return result;
}

function curlWords(raw: string) {
  const input = raw.replace(/\\\r?\n/gu, ' ').trim();
  if (input.length > 12000) throw validation('单条 cURL 配置最多 12000 字符。');
  const words: string[] = [];
  let token = '',
    quote = '',
    started = false;
  for (let index = 0; index < input.length; index++) {
    const character = input.charAt(index);
    if (quote && character === quote) quote = '';
    else if (character === '\\' && quote !== "'" && index + 1 < input.length) {
      token += input.charAt(++index);
      started = true;
    } else if (quote) token += character;
    else if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (/\s/u.test(character)) {
      if (started) words.push(token);
      token = '';
      started = false;
    } else {
      if (/[|;&$<>]/u.test(character) || character.charCodeAt(0) === 96)
        throw validation('仅支持静态单条 cURL 配置。');
      token += character;
      started = true;
    }
  }
  if (quote) throw validation('cURL 配置中的引号未闭合。');
  if (started) words.push(token);
  return words;
}

function curl(
  input: ApiCatalogImportPreviewInput,
  warnings: Set<string>,
): Candidate[] {
  const words = curlWords(input.document);
  if (!/^curl(?:\.exe)?$/iu.test(words.shift() ?? ''))
    throw validation('请输入单条 cURL 请求配置。');
  let url: string | undefined,
    method: string | undefined,
    body: string | undefined;
  const headers: CapturedRequest['headers'] = [];
  while (words.length) {
    const word = words.shift();
    if (!word) throw validation('cURL 配置含空参数。');
    if (!word.startsWith('-')) {
      if (url !== undefined) throw validation('一次只能导入一个请求地址。');
      url = word;
      continue;
    }
    const inline = /^(--[^=]+)=(.*)$/su.exec(word);
    const flag = inline?.[1] ?? word;
    if (
      ![
        '-X',
        '--request',
        '-H',
        '--header',
        '-d',
        '--data',
        '--data-raw',
        '--data-binary',
        '--url',
      ].includes(flag)
    )
      throw validation(
        'cURL 含未支持的选项。导入仅处理方法、URL、请求头和字面量正文。',
      );
    const value = inline?.[2] ?? words.shift();
    if (value === undefined || value.startsWith('@'))
      throw validation('cURL 选项缺少值或引用了外部文件。');
    if (flag === '-X' || flag === '--request') {
      if (method !== undefined) throw validation('cURL 只能指定一个请求方法。');
      method = value;
    } else if (flag === '--url') {
      if (url !== undefined) throw validation('一次只能导入一个请求地址。');
      url = value;
    } else if (flag === '-H' || flag === '--header') {
      const colon = value.indexOf(':');
      if (colon < 1) throw validation('cURL 请求头需使用名称:值。');
      headers.push({
        name: value.slice(0, colon).trim(),
        value: value.slice(colon + 1).trim(),
      });
    } else {
      if (body !== undefined) throw validation('cURL 仅支持一段正文。');
      body = value;
    }
  }
  if (!url) throw validation('cURL 缺少请求地址。');
  const result: Candidate[] = [];
  requestCandidate(
    {
      url,
      headers,
      ...(method !== undefined ? { method } : {}),
      ...(body !== undefined ? { body } : {}),
    },
    input,
    warnings,
    result,
  );
  return result;
}

export function parseApiCatalogDocument(input: ApiCatalogImportPreviewInput) {
  const warnings = new Set<string>();
  const formats = {
    openapi: materialCandidates,
    swagger: materialCandidates,
    postman,
    har,
    curl,
  };
  const definitions = formats[input.format](input, warnings);
  if (!definitions.length)
    throw new DomainError(
      'VALIDATION_ERROR',
      '材料中没有符合新接口契约的可导入记录。',
      400,
    );
  return { definitions, warnings: [...warnings] };
}
