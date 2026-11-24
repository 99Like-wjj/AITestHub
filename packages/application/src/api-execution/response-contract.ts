import type { ApiInterfaceResponseContract } from '../../../contracts/src/api-catalog.js';
import type { JsonValue } from '../../../contracts/src/api-execution.js';
import { canonicalJson } from '../operations/service.js';

type Obj = Record<string, JsonValue>;
type Verdict = boolean | undefined;
const annotations = [
  'title',
  'description',
  'default',
  'examples',
  'example',
  '$schema',
  '$id',
  '$comment',
  'readOnly',
  'writeOnly',
  'deprecated',
  'format',
];
const keywords = new Set([
  ...annotations,
  '$ref',
  'type',
  'nullable',
  'enum',
  'const',
  'required',
  'properties',
  'additionalProperties',
  'minProperties',
  'maxProperties',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'items',
  'prefixItems',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
]);
const own = (value: object, key: string) => Object.hasOwn(value, key);
const isObject = (value: JsonValue | undefined): value is Obj =>
  value !== undefined &&
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value);
const bodyMediaType = (header: string | undefined) =>
  (header ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
const isJson = (mime: string) =>
  mime === 'application/json' || mime.endsWith('+json');
const and = (results: Verdict[]): Verdict =>
  results.includes(undefined) ? undefined : results.every(Boolean);

function reference(
  ref: string,
  models: ApiInterfaceResponseContract['models'],
): JsonValue | undefined {
  const parts = ref.split('/');
  if (
    parts[0] !== '#' ||
    parts[1] !== 'components' ||
    parts[2] !== 'schemas' ||
    !parts[3]
  )
    return undefined;
  let value: JsonValue | undefined;
  for (let index = 3; index < parts.length; index++) {
    const part = parts[index];
    if (part === undefined) return undefined;
    const key = part.replace(/~1/gu, '/').replace(/~0/gu, '~');
    if (index === 3) value = own(models, key) ? models[key] : undefined;
    else if (isObject(value) && own(value, key)) value = value[key];
    else if (Array.isArray(value) && /^(?:0|[1-9]\d*)$/u.test(key))
      value = value[Number(key)];
    else return undefined;
  }
  return value;
}

function typeMatches(value: JsonValue, type: JsonValue): Verdict {
  switch (type) {
    case 'null':
      return value === null;
    case 'object':
      return isObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value);
    default:
      return undefined;
  }
}

/** Handles a portable, bounded JSON Schema subset. Unsupported assertions fail
 * closed; no pattern execution or external reference resolvers are present. */
function validateJsonSchema(
  schema: JsonValue,
  value: JsonValue,
  models: ApiInterfaceResponseContract['models'],
): Verdict {
  let remaining = 50_000;
  const validate = (
    spec: JsonValue,
    current: JsonValue,
    depth: number,
  ): Verdict => {
    if (depth > 45 || --remaining < 0) return undefined;
    if (typeof spec === 'boolean') return spec;
    if (
      !isObject(spec) ||
      Object.keys(spec).some(
        (key) => !keywords.has(key) && !key.startsWith('x-'),
      )
    )
      return undefined;
    const results: Verdict[] = [];
    const test = (child: JsonValue, instance = current) =>
      validate(child, instance, depth + 1);
    if (spec.$ref !== undefined) {
      const target =
        typeof spec.$ref === 'string'
          ? reference(spec.$ref, models)
          : undefined;
      results.push(target === undefined ? undefined : test(target));
    }
    if (
      spec.type !== undefined &&
      !(current === null && spec.nullable === true)
    ) {
      const matches = (Array.isArray(spec.type) ? spec.type : [spec.type]).map(
        (entry) => typeMatches(current, entry),
      );
      results.push(
        matches.length && !matches.includes(undefined)
          ? matches.some(Boolean)
          : undefined,
      );
    }
    if (spec.enum !== undefined)
      results.push(
        Array.isArray(spec.enum) && spec.enum.length
          ? spec.enum.some(
              (item) => canonicalJson(item) === canonicalJson(current),
            )
          : undefined,
      );
    if (spec.const !== undefined)
      results.push(canonicalJson(spec.const) === canonicalJson(current));
    for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
      const group = spec[key];
      if (group === undefined) continue;
      if (!Array.isArray(group) || !group.length) {
        results.push(undefined);
        continue;
      }
      const statuses = group.map((child) => test(child));
      if (statuses.includes(undefined)) results.push(undefined);
      else if (key === 'allOf') results.push(statuses.every(Boolean));
      else if (key === 'anyOf') results.push(statuses.some(Boolean));
      else results.push(statuses.filter(Boolean).length === 1);
    }
    if (spec.not !== undefined) {
      const verdict = test(spec.not);
      results.push(verdict === undefined ? undefined : !verdict);
    }
    const limits = (
      minimum: JsonValue | undefined,
      maximum: JsonValue | undefined,
      actual: number,
      integer: boolean,
    ) => {
      if (minimum !== undefined)
        results.push(
          typeof minimum === 'number' &&
            (!integer || (minimum >= 0 && Number.isSafeInteger(minimum)))
            ? actual >= minimum
            : undefined,
        );
      if (maximum !== undefined)
        results.push(
          typeof maximum === 'number' &&
            (!integer || (maximum >= 0 && Number.isSafeInteger(maximum)))
            ? actual <= maximum
            : undefined,
        );
    };
    if (typeof current === 'number') {
      limits(spec.minimum, spec.maximum, current, false);
      for (const [key, inclusive, comparison] of [
        [
          'exclusiveMinimum',
          spec.minimum,
          (left: number, right: number) => left > right,
        ],
        [
          'exclusiveMaximum',
          spec.maximum,
          (left: number, right: number) => left < right,
        ],
      ] as const) {
        const bound = spec[key];
        if (typeof bound === 'number') results.push(comparison(current, bound));
        else if (bound === true && typeof inclusive === 'number')
          results.push(comparison(current, inclusive));
        else if (bound !== undefined && bound !== false)
          results.push(undefined);
      }
      if (spec.multipleOf !== undefined) {
        if (typeof spec.multipleOf !== 'number' || spec.multipleOf <= 0)
          results.push(undefined);
        else {
          const ratio = current / spec.multipleOf;
          results.push(
            Number.isFinite(ratio) &&
              Math.abs(ratio - Math.round(ratio)) <= 1e-9,
          );
        }
      }
    }
    if (typeof current === 'string')
      limits(spec.minLength, spec.maxLength, [...current].length, true);
    if (Array.isArray(current)) {
      limits(spec.minItems, spec.maxItems, current.length, true);
      if (spec.uniqueItems === true)
        results.push(
          new Set(current.map(canonicalJson)).size === current.length,
        );
      if (
        spec.uniqueItems !== undefined &&
        typeof spec.uniqueItems !== 'boolean'
      )
        results.push(undefined);
      const prefix = spec.prefixItems;
      if (prefix !== undefined && !Array.isArray(prefix))
        results.push(undefined);
      for (const [index, item] of current.entries()) {
        const entry =
          Array.isArray(prefix) && index < prefix.length
            ? prefix[index]
            : spec.items;
        if (entry !== undefined) results.push(test(entry, item));
        if (remaining < 0) return undefined;
      }
    }
    if (isObject(current)) {
      limits(
        spec.minProperties,
        spec.maxProperties,
        Object.keys(current).length,
        true,
      );
      if (spec.required !== undefined) {
        const all = spec.required;
        results.push(
          Array.isArray(all) && all.every((key) => typeof key === 'string')
            ? all.every((key) => typeof key === 'string' && own(current, key))
            : undefined,
        );
      }
      const props = spec.properties;
      if (props !== undefined && !isObject(props)) results.push(undefined);
      for (const [key, item] of Object.entries(current)) {
        const child =
          isObject(props) && own(props, key)
            ? props[key]
            : spec.additionalProperties;
        if (child !== undefined) results.push(test(child, item));
        if (remaining < 0) return undefined;
      }
    }
    return and(results);
  };
  return validate(schema, value, 1);
}

function headerValue(raw: string, schema: JsonValue): JsonValue {
  if (!isObject(schema)) return raw;
  if (schema.type === 'integer' || schema.type === 'number')
    return /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(raw) &&
      Number.isFinite(Number(raw))
      ? Number(raw)
      : raw;
  if (schema.type === 'boolean' && (raw === 'true' || raw === 'false'))
    return raw === 'true';
  return raw;
}

export function matchesResponseContract(
  contract: ApiInterfaceResponseContract,
  observation: {
    status: number | null;
    headers: Record<string, string>;
    body: JsonValue;
    jsonParsed?: boolean;
  },
): Verdict {
  const { status, headers, body, jsonParsed } = observation;
  if (status === null || !contract.responses.length) return undefined;
  const response =
    contract.responses.find((item) => item.code === String(status)) ??
    contract.responses.find(
      (item) => item.code === String(Math.floor(status / 100)) + 'XX',
    ) ??
    contract.responses.find((item) => item.code === 'default');
  if (!response) return false;
  const actualHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const results: Verdict[] = [];
  for (const header of response.headers) {
    const name = header.name.toLowerCase();
    const actual = own(actualHeaders, name) ? actualHeaders[name] : undefined;
    if (actual === undefined) {
      if (header.required) results.push(false);
    } else if (header.schema !== undefined) {
      results.push(
        validateJsonSchema(
          header.schema,
          headerValue(actual, header.schema),
          contract.models,
        ),
      );
    }
  }
  if (!response.content.length) return and(results);
  const mediaType = bodyMediaType(actualHeaders['content-type']);
  const mimeClass = mediaType.split('/')[0];
  const matched =
    response.content.find(
      (option) => option.mediaType.toLowerCase() === mediaType,
    ) ??
    response.content.find(
      (option) => option.mediaType.toLowerCase() === mimeClass + '/*',
    ) ??
    response.content.find((option) => option.mediaType === '*/*');
  if (!mediaType || !matched) return false;
  if (matched.schema === undefined || !isJson(mediaType)) return undefined;
  if (jsonParsed === false) return false;
  if (typeof body === 'string' && jsonParsed !== true) return undefined;
  results.push(validateJsonSchema(matched.schema, body, contract.models));
  return and(results);
}
