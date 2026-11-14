import { z } from 'zod';
export const sourceLinkUnavailableReasonSchema = z.enum([
  'AUTHENTICATION_SOURCE_LINK',
  'UNSUPPORTED_SOURCE_LINK_PROTOCOL',
  'INVALID_SOURCE_LINK',
]);
export type SourceLinkUnavailableReason = z.infer<
  typeof sourceLinkUnavailableReasonSchema
>;
const authentication =
  /^(?:password|passwd|api[_-]?key|x-api-key|authorization|auth|auth[_-]?key|token|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|client[_-]?secret|cookie|set-cookie|session(?:[_-]?id)?|jsessionid|phpsessid|secret|signature|sig|credential|x-amz-signature|x-amz-security-token|x-amz-credential|x-goog-signature|x-goog-credential)$/i;
function decode(text: string) {
  let decoded = text
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

/** Literal URL classification only; no DNS, network, rewrite, secret extraction or readability claim. */
export function sourceLinkUnavailableReason(
  value: unknown,
  nesting = 0,
): SourceLinkUnavailableReason | undefined {
  if (
    nesting > 8 ||
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4000 ||
    /[\x00-\x20\x7f]/.test(value) ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
      value,
    )
  )
    return 'INVALID_SOURCE_LINK';
  let current = value;
  for (let iteration = 0; iteration <= 8; iteration++) {
    if (
      /\bsk-[A-Za-z0-9_-]{20,}\b|\bath_(?:key|session|reset)_[A-Za-z0-9_-]{20,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/.test(
        current,
      )
    )
      return 'AUTHENTICATION_SOURCE_LINK';
    let url: URL;
    try {
      url = new URL(current);
    } catch {
      return 'INVALID_SOURCE_LINK';
    }
    if (!['http:', 'https:'].includes(url.protocol))
      return 'UNSUPPORTED_SOURCE_LINK_PROTOCOL';
    if (
      url.username ||
      url.password ||
      /^[a-z][a-z\d+.-]*:\/\/[^/?#]*@/i.test(current)
    )
      return 'AUTHENTICATION_SOURCE_LINK';
    for (const [name, content] of url.searchParams) {
      if (authentication.test(name.normalize('NFKC')))
        return 'AUTHENTICATION_SOURCE_LINK';
      for (const match of content.matchAll(/\bhttps?:\/\/[^\s<>]+/gi)) {
        const reason = sourceLinkUnavailableReason(match[0], nesting + 1);
        if (reason) return reason;
      }
    }
    for (const match of decode(url.hash.slice(1)).matchAll(
      /(?:^|[?&#;\s{"'])([a-z][a-z\d_-]*)["']?\s*[:=]/gi,
    ))
      if (authentication.test(match[1]!)) return 'AUTHENTICATION_SOURCE_LINK';
    const next = decode(current);
    if (next === current) return undefined;
    if (iteration === 8 || next.length > 4000) return 'INVALID_SOURCE_LINK';
    current = next;
  }
  return 'INVALID_SOURCE_LINK';
}
export const safeSourceLinkSchema = z
  .url()
  .max(4000)
  .refine(
    (value) => sourceLinkUnavailableReason(value) === undefined,
    '来源链接须为无认证信息的HTTP(S)地址；请使用不带Token/密码的资料入口。',
  );

/** Safe transport projection only. Original history, hashes and references are never mutated. */
export function sanitizeSourceLinkFields<T>(value: T): T {
  const hiddenLinks = new Map<string, SourceLinkUnavailableReason>(),
    pending: { item: unknown; depth: number }[] = [{ item: value, depth: 0 }];
  let inspected = 0;
  while (pending.length) {
    const { item, depth } = pending.pop()!;
    if (++inspected > 500000 || depth > 128)
      throw new Error('Source-link projection structure exceeds limit');
    if (Array.isArray(item))
      for (const child of item) pending.push({ item: child, depth: depth + 1 });
    else if (item && typeof item === 'object')
      for (const [key, child] of Object.entries(item)) {
        if (
          key === 'sourceLink' &&
          typeof child === 'string' &&
          /^https?:\/\//i.test(child) &&
          sourceLinkUnavailableReason(child) !== undefined
        )
          hiddenLinks.set(child, sourceLinkUnavailableReason(child)!);
        pending.push({ item: child, depth: depth + 1 });
      }
  }
  let nodes = 0;
  const walk = (item: unknown, depth: number): unknown => {
    if (++nodes > 500000 || depth > 128)
      throw new Error('Source-link projection structure exceeds limit');
    if (item instanceof Date) return new Date(item.getTime());
    if (typeof item === 'string') {
      let safe = item;
      for (const [hidden, reason] of hiddenLinks)
        if (safe.includes(hidden))
          safe = safe
            .split(hidden)
            .join(
              reason === 'AUTHENTICATION_SOURCE_LINK'
                ? '[认证来源链接已隐藏]'
                : '[来源链接不可用，已隐藏]',
            );
      return safe.replace(/\bhttps?:\/\/[^\s<>]+/gi, (url) =>
        sourceLinkUnavailableReason(url) === 'AUTHENTICATION_SOURCE_LINK'
          ? '[认证来源链接已隐藏]'
          : url,
      );
    }
    if (Array.isArray(item)) return item.map((child) => walk(child, depth + 1));
    if (!item || typeof item !== 'object') return item;
    const output: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const [key, child] of Object.entries(item)) {
      if (key === 'sourceLink' && typeof child === 'string') {
        const reason = sourceLinkUnavailableReason(child);
        if (reason) {
          output.sourceLinkUnavailableReason = reason;
          continue;
        }
      }
      output[key] = walk(child, depth + 1);
    }
    return output;
  };
  return walk(value, 0) as T;
}
