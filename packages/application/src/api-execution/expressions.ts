import type {
  JsonValue,
  RuntimeVariables,
} from '../../../contracts/src/api-execution.js';
import { DomainError } from '../errors.js';
import {
  apiCaseContentSchema,
  assertionSchema,
  extractorSchema,
} from '../../../contracts/src/domain.js';
import type { z } from 'zod';
import {
  apiPlaceholderPattern,
  readApiPath,
} from '../../../contracts/src/api-variable-refs.js';

export const readPath = readApiPath;
export function nonEmpty(value: unknown): value is string | number | boolean {
  return typeof value === 'number'
    ? Number.isFinite(value)
    : typeof value === 'boolean' ||
        (typeof value === 'string' && value.trim().length > 0);
}
export function contextVariables(
  environment: Record<string, JsonValue>,
  variables: RuntimeVariables,
) {
  return { env: environment, case: variables.case, extract: variables.extract };
}
export function interpolate(value: unknown, context: unknown): JsonValue {
  if (typeof value === 'string') {
    const exact = apiPlaceholderPattern().exec(value);
    if (exact?.[0] === value && exact[1]) {
      const resolved = readPath(context, exact[1]);
      if (resolved === undefined)
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '缺少必需变量，未发送请求。',
          422,
        );
      return asJson(resolved);
    }
    return value.replace(
      apiPlaceholderPattern(),
      (_match: string, path: string) => {
        const resolved = readPath(context, path);
        if (
          resolved === undefined ||
          resolved === null ||
          typeof resolved === 'object'
        )
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '缺少可直接插入的必需变量，未发送请求。',
            422,
          );
        return String(resolved);
      },
    );
  }
  if (Array.isArray(value))
    return value.map((item) => interpolate(item, context));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (['__proto__', 'constructor', 'prototype'].includes(key))
          throw new DomainError('VALIDATION_ERROR', '变量不能修改原型。', 400);
        return [key, interpolate(item, context)];
      }),
    );
  return asJson(value);
}
function asJson(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    typeof value === 'number'
  )
    return value;
  if (Array.isArray(value)) return value.map(asJson);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, asJson(item)]),
    );
  throw new DomainError('VALIDATION_ERROR', '变量必须是JSON值。', 400);
}
export type RawObservation = {
  status: number | null;
  headers: Record<string, string>;
  body: JsonValue;
};
function observationValue(
  source: string,
  path: string | undefined,
  response: RawObservation,
  variables: RuntimeVariables,
): unknown {
  if (source === 'status') return response.status;
  if (source === 'body')
    return typeof response.body === 'string'
      ? response.body
      : JSON.stringify(response.body);
  if (source === 'header') return response.headers[(path ?? '').toLowerCase()];
  if (source === 'variable')
    return readPath(
      { case: variables.case, extract: variables.extract },
      path ?? '',
    );
  return readPath(response.body, path ?? '');
}
export function evaluateAssertions(
  assertions: z.infer<typeof assertionSchema>[],
  response: RawObservation,
  variables: RuntimeVariables,
) {
  return assertions.map((assertion) => {
    const actual = observationValue(
      assertion.source,
      assertion.path,
      response,
      variables,
    );
    const expected = assertion.expected;
    let passed = false;
    if (assertion.operator === 'exists')
      passed = actual !== undefined && actual !== null;
    else if (assertion.operator === 'equals')
      passed = JSON.stringify(actual) === JSON.stringify(expected);
    else if (assertion.operator === 'notEquals')
      passed = JSON.stringify(actual) !== JSON.stringify(expected);
    else if (assertion.operator === 'contains')
      passed =
        typeof actual === 'string' &&
        typeof expected === 'string' &&
        actual.includes(expected);
    else if (assertion.operator === 'greaterThan')
      passed =
        typeof actual === 'number' &&
        typeof expected === 'number' &&
        actual > expected;
    else if (assertion.operator === 'lessThan')
      passed =
        typeof actual === 'number' &&
        typeof expected === 'number' &&
        actual < expected;
    else if (assertion.operator === 'matches') {
      // Bounded patterns are executed in the isolated script process by the worker, not the API host.
      throw new DomainError(
        'UNSUPPORTED_OPERATION',
        '正则断言须经隔离脚本运行时处理。',
        422,
      );
    }
    return {
      passed,
      message: `断言${assertion.id}${passed ? '通过' : '未满足'}。`,
    };
  });
}
export function extractVariables(
  extractors: z.infer<typeof extractorSchema>[],
  response: RawObservation,
): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const extractor of extractors) {
    const value = extractionValue(extractor, response);
    if (
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim().length === 0)
    ) {
      if (extractor.required)
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '必需响应提取值缺失，停止本用例后续业务步骤。',
          422,
        );
      continue;
    }
    if (['__proto__', 'constructor', 'prototype'].includes(extractor.name))
      throw new DomainError('VALIDATION_ERROR', '提取名不可修改原型。', 400);
    result[extractor.name] = asJson(value);
  }
  return result;
}
export function extractionValue(
  extractor: Pick<
    z.infer<typeof extractorSchema>,
    'source' | 'path' | 'sensitive'
  >,
  response: RawObservation,
): unknown {
  if (extractor.sensitive && extractor.source === 'body') return response.body;
  return observationValue(extractor.source, extractor.path, response, {
    case: {},
    extract: {},
  });
}
export const parseApiContent = (value: unknown) =>
  apiCaseContentSchema.parse(value);
