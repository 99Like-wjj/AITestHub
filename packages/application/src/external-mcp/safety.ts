import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import type {
  jsonSchemaValidator,
  JsonSchemaType,
  JsonSchemaValidator,
} from '@modelcontextprotocol/client';
import { z } from 'zod';
import {
  externalToolDefinitionSchema,
  type ExternalToolDefinition,
} from '../../../contracts/src/external-mcp.js';
import { DomainError } from '../errors.js';
import { canonicalJson } from '../operations/service.js';
import { assertSafeModelInput } from '../security/model-input.js';
import { parseSafeResultJson } from '../results/json-file.js';
import { assertSafeResultContent } from '../results/safety.js';

export const externalDigest = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
const invalid = (message = '外部MCP内容超出安全结构或Schema支持范围。') =>
  new DomainError('VALIDATION_ERROR', message, 400);
function wellFormed(value: string) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(++index);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
export function boundedExternalJson(value: unknown, maxBytes = 1024 * 1024) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized) > maxBytes)
    throw invalid();
  let nodes = 0;
  const stack = [{ value, depth: 0 }];
  while (stack.length) {
    const current = stack.pop()!;
    if (++nodes > 20000 || current.depth > 32) throw invalid();
    const item = current.value;
    if (typeof item === 'string') {
      if (item.includes('\0') || /[\uD800-\uDFFF]/u.test(item)) {
        // JSON text permits valid supplementary pairs; reject only lone surrogates.
        if (item.includes('\0') || !wellFormed(item)) throw invalid();
      }
    } else if (Array.isArray(item)) {
      if (item.length > 1024) throw invalid();
      for (const child of item)
        stack.push({ value: child, depth: current.depth + 1 });
    } else if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        if (
          !wellFormed(key) ||
          key.includes('\0') ||
          /^(?:secret_?refs?|credential_?refs?)$/i.test(key)
        )
          throw invalid();
        stack.push({ value: child, depth: current.depth + 1 });
      }
    } else if (typeof item === 'number' && !Number.isFinite(item))
      throw invalid();
  }
  assertSafeModelInput(value);
  try {
    assertSafeResultContent(serialized);
    assertSafeResultContent(value);
  } catch {
    throw invalid('外部MCP资料或输出含疑似未脱敏凭据，未发送或返回。');
  }
  return value;
}
export function credentialAbsent(value: unknown, credential: string) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  const candidates = [
    credential,
    JSON.stringify(credential).slice(1, -1),
    encodeURIComponent(credential),
    Buffer.from(credential).toString('base64'),
    Buffer.from(credential).toString('base64').replace(/=+$/, ''),
    Buffer.from(credential).toString('base64url'),
    Buffer.from(credential).toString('hex'),
    Buffer.from(credential).toString('hex').toUpperCase(),
  ];
  const reject = () => {
    throw invalid(
      '外部MCP内容含凭据或过度嵌套编码，已阻止进入工具输出或调用资料。',
    );
  };
  const contains = (text: string) => {
    const compact = text.replace(/\s+/g, '');
    return candidates.some(
      (candidate) =>
        candidate.length > 0 &&
        (text.includes(candidate) || compact.includes(candidate)),
    );
  };
  const decode = (text: string) =>
    text
      .replace(/%([a-f\d]{2})/gi, (_all: string, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
      .replace(/\\(["'\\])/g, '$1')
      .replace(/\\u([a-f\d]{4})/gi, (_all: string, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
      .replace(/\\x([a-f\d]{2})/gi, (_all: string, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
  const scan = (input: string) => {
    let text = input;
    for (let depth = 0; depth < 8; depth++) {
      if (contains(text)) reject();
      const next = decode(text);
      if (next === text) return;
      text = next;
    }
    if (contains(text) || decode(text) !== text) reject();
  };
  scan(raw);
  const stack = [value];
  let nodes = 0;
  while (stack.length) {
    if (++nodes > 20000) reject();
    const item = stack.pop();
    if (typeof item === 'string') scan(item);
    else if (Array.isArray(item)) {
      if (item.length > 1024) reject();
      for (const child of item) stack.push(child);
    } else if (item && typeof item === 'object')
      for (const [key, child] of Object.entries(item)) {
        scan(key);
        stack.push(child);
      }
  }
}
export function decodeExternalJson(bytes: Uint8Array, credential: string) {
  // The shared strict decoder rejects decoded duplicate keys and checks the complete original text too.
  const value = parseSafeResultJson(bytes, 1024 * 1024);
  credentialAbsent(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    credential,
  );
  credentialAbsent(value, credential);
  return boundedExternalJson(value);
}
export function normalizedExternalEndpoint(
  raw: string,
  allowedTestEndpoints: readonly string[] = [],
) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid('远程MCP地址无效。');
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['https:', 'http:'].includes(url.protocol)
  )
    throw invalid('远程MCP须为无凭据、无查询参数的固定HTTP服务地址。');
  const endpoint = url.href;
  if (allowedTestEndpoints.includes(endpoint)) return endpoint;
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() === 'localhost' ||
    isIP(url.hostname.replace(/^\[|\]$/g, ''))
  )
    throw invalid(
      '远程MCP默认须使用公网HTTPS域名；本地合成目标须由工程注入确切端点。',
    );
  return endpoint;
}
export function publicAddress(address: string) {
  let normalized = address.toLowerCase();
  if (isIP(normalized) === 6)
    normalized = new URL(`http://[${normalized}]/`).hostname.slice(1, -1);
  if (isIP(normalized) === 4) {
    if (normalized === '168.63.129.16') return false;
    const parts = normalized.split('.').map(Number);
    const [a, b] = parts as [number, number];
    return (
      a > 0 &&
      a < 224 &&
      a !== 10 &&
      a !== 127 &&
      !(a === 169 && b === 254) &&
      !(a === 172 && b >= 16 && b <= 31) &&
      !(a === 192 && (b === 168 || b === 0)) &&
      !(a === 100 && b >= 64 && b <= 127) &&
      !(a === 198 && (b === 18 || b === 19)) &&
      !(a === 192 && b === 0) &&
      !(a === 198 && b === 51) &&
      !(a === 203 && b === 0)
    );
  }
  if (isIP(normalized) !== 6) return false;
  // Public IPv6 global unicast only. Embedded IPv4, translation, transition and special ranges are denied.
  return (
    /^[23][a-f\d]{3}:/.test(normalized) &&
    !normalized.startsWith('2001:db8:') &&
    !normalized.startsWith('2001::') &&
    !normalized.startsWith('2001:0:') &&
    !normalized.startsWith('2001:2:') &&
    !normalized.startsWith('2002:') &&
    !normalized.startsWith('2001:20:') &&
    !normalized.startsWith('2001:10:')
  );
}
function schemaSafe(schema: JsonSchemaType) {
  boundedExternalJson(schema, 64 * 1024);
  const root = schema as Record<string, unknown>;
  let nodes = 0;
  const walk = (value: unknown, path: Set<unknown>, depth: number): void => {
    if (++nodes > 4096 || depth > 24) throw invalid();
    if (!value || typeof value !== 'object') return;
    if (path.has(value)) throw invalid();
    const next = new Set(path);
    next.add(value);
    if (Array.isArray(value)) {
      for (const child of value) walk(child, next, depth + 1);
      return;
    }
    const object = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(object)) {
      if (
        [
          'pattern',
          'patternProperties',
          '$dynamicRef',
          '$recursiveRef',
          '$id',
          '$async',
          'x-mcp-header',
        ].includes(key)
      )
        throw invalid(
          '该工具Schema含首版不执行的正则、动态引用或自定义请求头，请管理员缩小工具定义。',
        );
      if (key === '$ref') {
        if (typeof child !== 'string' || !child.startsWith('#/'))
          throw invalid('外部Schema只支持无循环的本地JSON指针引用。');
        let target: unknown = root;
        for (const segment of child.slice(2).split('/')) {
          const name = segment.replaceAll('~1', '/').replaceAll('~0', '~');
          if (
            !target ||
            typeof target !== 'object' ||
            !Object.hasOwn(target, name)
          )
            throw invalid();
          target = (target as Record<string, unknown>)[name];
        }
        walk(target, next, depth + 1);
      } else if (
        ['properties', '$defs', 'definitions', 'dependentSchemas'].includes(key)
      ) {
        if (child && typeof child === 'object' && !Array.isArray(child))
          for (const entry of Object.values(child))
            walk(entry, next, depth + 1);
      } else if (['allOf', 'anyOf', 'oneOf', 'prefixItems'].includes(key)) {
        if (Array.isArray(child))
          for (const entry of child) walk(entry, next, depth + 1);
      } else if (
        [
          'items',
          'contains',
          'not',
          'if',
          'then',
          'else',
          'propertyNames',
          'additionalProperties',
          'unevaluatedProperties',
          'unevaluatedItems',
        ].includes(key)
      )
        walk(child, next, depth + 1);
    }
  };
  walk(schema, new Set(), 0);
}
export class SafeExternalSchemaValidator implements jsonSchemaValidator {
  private readonly delegate = new AjvJsonSchemaValidator();
  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    schemaSafe(schema);
    const validate = this.delegate.getValidator<T>(schema);
    return (value) => {
      try {
        boundedExternalJson(value);
        return validate(value);
      } catch {
        return {
          valid: false,
          data: undefined,
          errorMessage: '外部工具参数或结果未通过受限Schema校验。',
        };
      }
    };
  }
}
export function externalDefinition(raw: unknown): ExternalToolDefinition {
  const record = z.record(z.string(), z.unknown()).parse(raw);
  const { name, description, inputSchema, outputSchema, ...metadata } = record;
  const definition = externalToolDefinitionSchema.parse({
    name,
    description: description ?? '',
    inputSchema,
    ...(outputSchema ? { outputSchema } : {}),
    metadata,
  });
  boundedExternalJson(definition, 128 * 1024);
  return definition;
}
export function validateApprovedDefinition(definition: ExternalToolDefinition) {
  const validator = new SafeExternalSchemaValidator();
  validator.getValidator(definition.inputSchema as JsonSchemaType);
  if (definition.outputSchema)
    validator.getValidator(definition.outputSchema as JsonSchemaType);
  if (definition.inputSchema.type !== 'object')
    throw invalid('外部工具输入须是对象Schema。');
}
