import { DomainError } from '../errors.js';

const secretField =
  /^(password|passwd|api[_-]?key|authorization|token|access[_-]?token|refresh[_-]?token|cookie|set-cookie)$/i;
const placeholder =
  /^(?:\[redacted\]|<redacted>|\{\{[^{}]+\}\}|\$[A-Z_][A-Z0-9_]*|已脱敏|\*{3,})$/i;
/** Reject visible credential patterns before a report/command payload is persisted. No value is echoed. */
export function assertSafeResultContent(value: unknown): void {
  const reject = (): never => {
    throw new DomainError(
      'VALIDATION_ERROR',
      '结果含未脱敏凭据，请在本地生成安全副本后重新提交。',
      400,
    );
  };
  const stack: { item: unknown; key: string; depth: number }[] = [
    { item: value, key: '', depth: 0 },
  ];
  let nodes = 0,
    characters = 0;
  while (stack.length) {
    const { item, key, depth } = stack.pop()!;
    if (depth > 64 || ++nodes > 500000) reject();
    if (typeof item === 'string') {
      characters += item.length;
      if (characters > 16 * 1024 * 1024) reject();
      const candidate = item
        .replace(/\\u([a-f0-9]{4})/gi, (_match: string, hex: string) =>
          String.fromCharCode(Number.parseInt(hex, 16)),
        )
        .replace(/\\(["'\\])/g, '$1');
      if (
        secretField.test(key) &&
        candidate.length !== 0 &&
        !placeholder.test(candidate)
      )
        reject();
      if (
        /\bsk-[A-Za-z0-9_-]{20,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/.test(
          candidate,
        )
      )
        reject();
      for (const match of candidate.matchAll(
        /\b(?:authorization|password|passwd|api[_-]?key|token|access[_-]?token|refresh[_-]?token|cookie)["']?\s*[:=]\s*(?:(?:Bearer|Basic)\s+)?(?:"([^"\r\n]*)"|'([^'\r\n]*)'|(\[REDACTED\]|\{\{[^{}]+\}\}|[^\s,;&{}\[\]\r\n]+))/gi,
      )) {
        const content = (match[1] ?? match[2] ?? match[3] ?? '').trim();
        const token = content.replace(/^Bearer\s+/i, '');
        if (token.length !== 0 && !placeholder.test(token)) reject();
      }
      continue;
    }
    if (Array.isArray(item)) {
      for (const child of item)
        stack.push({ item: child, key: '', depth: depth + 1 });
      continue;
    }
    if (item && typeof item === 'object')
      for (const [name, child] of Object.entries(item))
        stack.push({ item: child, key: name, depth: depth + 1 });
  }
}
