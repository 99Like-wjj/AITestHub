import type {
  JsonValue,
  SafeResponse,
} from '../../../contracts/src/api-execution.js';
const protectedName =
  /^(?:(?:new|old|current|client|server)?(?:password|passwd|secret|apikey|accesstoken|refreshtoken|authtoken)|token|authorization|cookie|setcookie|credential)$/i;
export const isSensitiveName = (name: string) =>
  name
    .split(/[.\[\]\/]+/)
    .some((segment) => protectedName.test(segment.replace(/[_-]/g, '')));
function keysFor(value: object, values: readonly string[]) {
  const names = Object.keys(value);
  const reserved = new Set(names);
  const result = new Map<string, string>();
  let index = 0;
  for (const name of names) {
    if (['__proto__', 'constructor', 'prototype'].includes(name)) continue;
    if (String(redact(name, values)) === name) {
      result.set(name, name);
      continue;
    }
    let safe: string;
    do {
      safe = `[REDACTED_KEY_${index++}]`;
    } while (reserved.has(safe));
    reserved.add(safe);
    result.set(name, safe);
  }
  return result;
}
export function redact(
  value: unknown,
  protectedValues: readonly string[] = [],
  key = '',
): JsonValue {
  if (typeof value === 'string' && isSensitiveName(key)) return '[REDACTED]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number')
    return value;
  if (typeof value === 'string') {
    let text = value;
    for (const secret of [...new Set(protectedValues)]
      .filter((secret) => secret.length > 0)
      .sort((a, b) => b.length - a.length)) {
      text = text.split(secret).join('[REDACTED]');
      const encoded = encodeURIComponent(secret);
      if (encoded !== secret) text = text.split(encoded).join('[REDACTED]');
      const formEncoded = encoded.replace(/%20/g, '+');
      if (formEncoded !== secret)
        text = text.split(formEncoded).join('[REDACTED]');
      const jsonEscaped = JSON.stringify(secret).slice(1, -1);
      if (jsonEscaped !== secret)
        text = text.split(jsonEscaped).join('[REDACTED]');
    }
    text = text.replace(
      /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
      'Bearer [REDACTED]',
    );
    return text.replace(
      /\b(password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie)\s*[:=]\s*[^&\s;,]+/gi,
      '$1=[REDACTED]',
    );
  }
  if (Array.isArray(value))
    return value.map((item) => redact(item, protectedValues));
  if (typeof value === 'object') {
    const names = keysFor(value, protectedValues);
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([name]) => !['__proto__', 'constructor', 'prototype'].includes(name),
        )
        .map(([name, item]) => [
          names.get(name) ?? name,
          names.get(name) !== name
            ? '[REDACTED]'
            : redact(item, protectedValues, name),
        ]),
    );
  }
  return '[unsupported]';
}
export class RedactionResult {
  readonly #discovered: string[];
  constructor(
    readonly value: JsonValue,
    readonly protectedPaths: string[],
    discovered: string[],
  ) {
    this.#discovered = discovered;
  }
  /** Trusted control/worker memory only; private values never participate in JSON serialization. */
  protectedValues(): string[] {
    return [...this.#discovered];
  }
}
/** JSON Pointer paths refer only to changed scalar values, never unrelated sibling business IDs. */
export function redactWithPaths(
  value: unknown,
  protectedValues: readonly string[] = [],
  key = '',
) {
  const safe = redact(value, protectedValues, key);
  const protectedPaths: string[] = [];
  const discoveredValues: string[] = [];
  const escape = (part: string) =>
    part.replace(/~/g, '~0').replace(/\//g, '~1');
  const compare = (raw: unknown, filtered: JsonValue, path: string) => {
    if (typeof raw === 'string' && raw !== filtered) {
      protectedPaths.push(path);
      discoveredValues.push(raw);
      return;
    }
    if (Array.isArray(raw) && Array.isArray(filtered)) {
      for (const [index, entry] of raw.entries())
        compare(entry, filtered[index] ?? null, `${path}/${index}`);
      return;
    }
    if (
      raw !== null &&
      typeof raw === 'object' &&
      filtered !== null &&
      typeof filtered === 'object' &&
      !Array.isArray(filtered)
    ) {
      const names = keysFor(raw, protectedValues);
      for (const [name, entry] of Object.entries(raw)) {
        const safeName = names.get(name);
        if (!safeName) continue;
        if (safeName !== name) {
          protectedPaths.push(`${path}/${escape(safeName)}`);
          discoveredValues.push(name);
        } else
          compare(entry, filtered[name] ?? null, `${path}/${escape(name)}`);
      }
    }
  };
  compare(value, safe, '');
  return new RedactionResult(safe, protectedPaths, discoveredValues);
}
export function redactResponse(
  response: SafeResponse,
  values: readonly string[],
): SafeResponse {
  const headers: Record<string, string> = {};
  const safeHeaders = redact(response.headers, values);
  if (
    safeHeaders !== null &&
    typeof safeHeaders === 'object' &&
    !Array.isArray(safeHeaders)
  )
    for (const [name, value] of Object.entries(safeHeaders))
      headers[name] = String(value);
  return {
    ...response,
    headers,
    body: redact(response.body, values),
    errorCode:
      response.errorCode === null
        ? null
        : String(redact(response.errorCode, values)),
  };
}
