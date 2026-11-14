import { DomainError } from '../errors.js';
import { parseStrictJsonText } from '../../../contracts/src/safe-json.js';

const field =
  /^(?:password|passwd|api[_-]?key|authorization|token|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|client[_-]?secret|cookie|set-cookie)$/i;
const placeholder =
  /^(?:\[redacted\]|<[^<>\r\n]{1,100}>|\{\{[^{}\r\n]+\}\}|\$[A-Z_][A-Z0-9_]*|process\.env\.[A-Z_][A-Z0-9_]*|已脱敏|\*{3,}|sk-[xX]{8,})$/i;
const declaration =
  /^(?:string|number|integer|boolean|object|array|unknown|null|undefined|required|optional|true|false)$/i;
const allowed = (value: string) =>
  value.length === 0 || placeholder.test(value) || declaration.test(value);
const maximumCharacters = 16 * 1024 * 1024;
const schemaMetadata = new Set([
  'type',
  'description',
  'title',
  'format',
  '$ref',
  '$schema',
  '$id',
  '$defs',
  'definitions',
  'properties',
  'patternProperties',
  'additionalProperties',
  'items',
  'prefixItems',
  'contains',
  'required',
  'dependentRequired',
  'dependentSchemas',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'readOnly',
  'writeOnly',
  'deprecated',
  'nullable',
]);
const reject = (): never => {
  throw new DomainError(
    'VALIDATION_ERROR',
    '输入或所选资料含疑似未脱敏凭据，或超过安全结构限制；请使用占位符或安全副本，尚未发送模型。',
    400,
  );
};

/** Decode for inspection only. Never replace the caller's text or use decoding as authorization. */
function decode(text: string) {
  let decoded = text
    .replace(/\\u\{([a-f\d]{1,6})\}/gi, (_match: string, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : reject();
    })
    .replace(/\\u([a-f\d]{4})/gi, (_match: string, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\\x([a-f\d]{2})/gi, (_match: string, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\\(["'\\/])/g, '$1');
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    decoded = decoded.replace(
      /%([a-f\d]{2})/gi,
      (_match: string, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
    );
  }
  return decoded.normalize('NFKC');
}
function allowedEncoded(value: string) {
  let current = value;
  for (let count = 0; count <= 8; count++) {
    if (allowed(current)) return true;
    const next = decode(current);
    if (next === current) return false;
    if (count === 8) reject();
    current = next;
  }
  return false;
}
function scanText(text: string) {
  for (const match of text.matchAll(
    /\bsk-[A-Za-z0-9_-]{20,}\b|\bath_(?:key|session|reset)_[A-Za-z0-9_-]{20,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g,
  ))
    if (!placeholder.test(match[0])) reject();
  // Inspect every assignment in the raw text, including repeated JSON properties. No JSON.parse overwrite.
  for (const match of text.matchAll(
    /\b(password|passwd|api[_-]?key|authorization|token|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|client[_-]?secret|cookie|set-cookie)["']?\s*[:=]\s*(?:"([^"\r\n]*)(?:"|$)|'([^'\r\n]*)(?:'|$)|(\{\{[^{}\r\n]+\}\}|<[^<>\r\n]{1,100}>|\[redacted\]|(?:Bearer|Basic)\s+(?:\{\{[^{}\r\n]+\}\}|<[^<>\r\n]{1,100}>|\[redacted\]|[^\s"',;&{}\[\]#\r\n]+)|[^\s"',;&{}\[\]#<>\r\n]+))/gi,
  )) {
    const candidate = (match[2] ?? match[3] ?? match[4] ?? '')
      .trim()
      .replace(/^(?:Bearer|Basic)\s+/i, '');
    if (
      /^authorization$/i.test(match[1]!) &&
      /^(?:Bearer|Basic)$/i.test(candidate)
    )
      continue;
    if (!allowedEncoded(candidate)) reject();
  }
  for (const match of text.matchAll(
    /\b[a-z][a-z\d+.-]*:\/\/[^\s<>"'\x60]+/gi,
  )) {
    let url: URL;
    try {
      url = new URL(match[0]);
    } catch {
      continue;
    }
    if (
      (url.username && !allowedEncoded(url.username)) ||
      (url.password && !allowedEncoded(url.password))
    )
      reject();
    for (const [name, value] of url.searchParams)
      if (field.test(name) && !allowedEncoded(value.trim())) reject();
  }
}

/** Secondary structural/pattern guard, not complete private-data detection. Values never enter errors/logs. */
export function assertSafeModelInput(value: unknown): void {
  const stack: {
    item: unknown;
    key: string;
    depth: number;
    parsed?: boolean;
  }[] = [{ item: value, key: '', depth: 0 }];
  let nodes = 0,
    characters = 0,
    inspectionCharacters = 0;
  while (stack.length) {
    const { item, key, depth, parsed } = stack.pop()!;
    if (++nodes > 500000 || depth > 64) reject();
    let sensitive = false,
      currentKey = key;
    for (let count = 0; count <= 8; count++) {
      if (field.test(currentKey)) sensitive = true;
      const next = decode(currentKey);
      if (next === currentKey) break;
      if (count === 8) reject();
      currentKey = next;
    }
    if (typeof item === 'string') {
      characters += item.length;
      if (
        characters > maximumCharacters ||
        item.includes('\0') ||
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
          item,
        )
      )
        reject();
      let current = item;
      for (let count = 0; count <= 8; count++) {
        inspectionCharacters += current.length;
        if (
          current.length > maximumCharacters ||
          inspectionCharacters > 64 * 1024 * 1024
        )
          reject();
        if (
          sensitive &&
          !allowedEncoded(current.trim().replace(/^(?:Bearer|Basic)\s+/i, ''))
        )
          reject();
        scanText(current);
        const next = decode(current);
        if (next === current) break;
        if (count === 8) reject();
        current = next;
      }
      // Structural JSON is parsed only by the duplicate-aware boundary after raw inspection.
      const trimmed = current.trim();
      if (!parsed && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
        let decoded: unknown;
        let valid = false;
        try {
          decoded = parseStrictJsonText(trimmed);
          valid = true;
        } catch {
          /* Raw text was already inspected; no overwrite or valid-JSON claim. */
        }
        if (valid)
          stack.push({ item: decoded, key, depth: depth + 1, parsed: true });
      }
      continue;
    }
    if (sensitive && typeof item === 'number') reject();
    if (Array.isArray(item)) {
      for (const child of item)
        stack.push({
          item: child,
          key: sensitive ? currentKey : '',
          depth: depth + 1,
          ...(parsed ? { parsed: true } : {}),
        });
      continue;
    }
    if (item && typeof item === 'object')
      for (const [name, child] of Object.entries(item)) {
        // Schema descriptions/types remain discussion; credential defaults/examples must be safe values.
        const childKey =
          sensitive && !schemaMetadata.has(name) ? currentKey : name;
        characters += name.length;
        if (characters > maximumCharacters) reject();
        stack.push({
          item: child,
          key: childKey,
          depth: depth + 1,
          ...(parsed ? { parsed: true } : {}),
        });
      }
  }
}
