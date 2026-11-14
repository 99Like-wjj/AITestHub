import { localFailure } from './errors.js';

const secretName =
  /^(?:password|passwd|api[_-]?key|authorization|token|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|client[_-]?secret|cookie|set-cookie|credentialRefs?|secretRefs?)$/i;
const safePlaceholder =
  /^(?:\[redacted\]|<[^<>\r\n]{1,100}>|\{\{[^{}\r\n]+\}\}|已脱敏|\*{3,}|sk-[xX]{8,})$/;
function masked(value: unknown): boolean {
  return (
    value === null ||
    value === '' ||
    (typeof value === 'string' &&
      safePlaceholder.test(value.replace(/^(?:Bearer|Basic)\s+/i, '')))
  );
}
function scanText(text: string): void {
  if (
    /\b(?:sk-[A-Za-z0-9_-]{20,}|ath_(?:key|session|reset)_[A-Za-z0-9_-]{20,})\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\b|https?:\/\/[^\s/]+:[^\s/]+@/i.test(
      text,
    )
  )
    throw localFailure('UNSAFE_SECRET', '参数或回执含疑似凭据；未回显原内容。');
  if (
    /(?:authorization|api[_-]?key|password|passwd|cookie|client[_-]?secret)["']?\s*[:=]\s*["']?(?:Bearer\s+)?[A-Za-z0-9_+/.=-]{8,}/i.test(
      text,
    )
  )
    throw localFailure(
      'UNSAFE_SECRET',
      '文本包含疑似秘密赋值；请使用专用安全通道。',
    );
}
/** Known-secret/JSON guard, not a promise of complete private-information recognition. */
export function assertSafe(value: unknown): void {
  const active = new WeakSet<object>();
  let count = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++count > 500_000 || depth > 80)
      throw localFailure('JSON_LIMIT', '参数/回执结构超过客户端限额。');
    if (typeof item === 'string') {
      scanText(item);
      if (item.length <= 1_000_000 && /^\s*[\[{]/.test(item))
        try {
          visit(JSON.parse(item), depth + 1);
        } catch (error) {
          if (error instanceof Error && error.name === 'LocalClientError')
            throw error;
        }
      return;
    }
    if (
      item === null ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    )
      return;
    if (typeof item !== 'object')
      throw localFailure('INVALID_JSON', '普通业务参数/回执必须为JSON值。');
    if (active.has(item))
      throw localFailure('INVALID_JSON', 'JSON不能包含循环引用。');
    active.add(item);
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
    } else {
      const proto = Object.getPrototypeOf(item);
      if (proto !== Object.prototype && proto !== null)
        throw localFailure('INVALID_JSON', '只接受普通JSON对象。');
      const row = item as Record<string, unknown>,
        named =
          typeof row.name === 'string'
            ? row.name
            : typeof row.key === 'string'
              ? row.key
              : undefined;
      if (
        named &&
        secretName.test(named) &&
        'value' in row &&
        !masked(row.value)
      )
        throw localFailure('UNSAFE_SECRET', '命名认证字段含未脱敏值。');
      for (const [key, child] of Object.entries(item)) {
        scanText(key);
        if (secretName.test(key) && !masked(child))
          throw localFailure(
            'UNSAFE_SECRET',
            '受保护秘密字段不属于普通工具资料。',
          );
        visit(child, depth + 1);
      }
    }
    active.delete(item);
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 16 * 1024 * 1024)
    throw localFailure('JSON_LIMIT', '参数/回执超过客户端JSON字节限额。');
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
      )
      .join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw localFailure('INVALID_JSON', '值不能编码为JSON。');
  return encoded;
}
export function assertMcpArgumentBudget(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 1024 * 1024 - 4096)
    throw localFailure(
      'MCP_PAYLOAD_LIMIT',
      '参数超过当前MCP单次帧预算；原JSON文件需走已确认文件通道，不自动改写提交。',
    );
}
