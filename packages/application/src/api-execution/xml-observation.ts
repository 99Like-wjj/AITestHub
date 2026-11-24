import { apiXmlElementPathSchema } from '../../../contracts/src/domain.js';

type Selector = { name: string; order: number };
type Frame = { name: string; children: Map<string, number>; matches: boolean };
const tagPattern = '[A-Za-z_][A-Za-z0-9_.:-]*';
const invalidText = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u;
const predefined = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['apos', "'"],
  ['quot', '"'],
]);

function entityText(text: string): string | undefined {
  if (invalidText.test(text)) return undefined;
  let valid = true;
  const decoded = text.replace(
    /&([^;&<\s]{1,40});|&/gu,
    (_whole: string, encoded?: string) => {
      if (encoded && predefined.has(encoded))
        return predefined.get(encoded) ?? '';
      if (encoded && /^(?:#[0-9]+|#x[0-9a-f]+)$/iu.test(encoded)) {
        const hexadecimal = encoded[1] === 'x' || encoded[1] === 'X';
        const value = Number.parseInt(
          encoded.slice(hexadecimal ? 2 : 1),
          hexadecimal ? 16 : 10,
        );
        if (
          value === 9 ||
          value === 10 ||
          value === 13 ||
          (value >= 32 &&
            value <= 0x10ffff &&
            !(value >= 0xd800 && value <= 0xdfff) &&
            value !== 0xfffe &&
            value !== 0xffff)
        )
          return String.fromCodePoint(value);
      }
      valid = false;
      return '';
    },
  );
  return valid ? decoded : undefined;
}

function readStartTag(document: string, offset: number) {
  const name = new RegExp(tagPattern, 'uy');
  const attribute = new RegExp('\\s+(' + tagPattern + ')\\s*=\\s*', 'uy');
  name.lastIndex = offset + 1;
  const head = name.exec(document);
  if (!head) return undefined;
  const keys = new Set<string>();
  let cursor = name.lastIndex;
  for (;;) {
    let next = cursor;
    while (/\s/u.test(document.charAt(next))) next++;
    if (document.startsWith('/>', next))
      return { tag: head[0], end: next + 2, closed: true };
    if (document.charAt(next) === '>')
      return { tag: head[0], end: next + 1, closed: false };
    if (keys.size >= 200) return undefined;
    attribute.lastIndex = cursor;
    const found = attribute.exec(document);
    const key = found?.[1];
    if (!key || keys.has(key)) return undefined;
    keys.add(key);
    const quote = document.charAt(attribute.lastIndex);
    if (quote !== "'" && quote !== '"') return undefined;
    const quoteEnd = document.indexOf(quote, attribute.lastIndex + 1);
    if (quoteEnd < 0) return undefined;
    const value = document.slice(attribute.lastIndex + 1, quoteEnd);
    if (value.includes('<') || entityText(value) === undefined)
      return undefined;
    cursor = quoteEnd + 1;
  }
}

/** Bounded read-only XML element text. No DTD, custom entity or external resolver. */
export function xmlElementText(
  input: string,
  path: string,
): string | undefined {
  if (
    input.length > 1_048_576 ||
    !apiXmlElementPathSchema.safeParse(path).success
  )
    return undefined;
  const selectors: Selector[] = path
    .slice(1)
    .split('/')
    .map((part) => {
      const bracket = part.indexOf('[');
      return bracket < 0
        ? { name: part, order: 1 }
        : {
            name: part.slice(0, bracket),
            order: Number(part.slice(bracket + 1, -1)),
          };
    });
  const document = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const stack: Frame[] = [];
  const pieces: string[] = [];
  const closing = new RegExp('</(' + tagPattern + ')\\s*>', 'uy');
  let count = 0,
    root = false,
    selected = false,
    capturing = false,
    cursor = 0;
  const textContent = (raw: string, isCdata = false): boolean => {
    const text = isCdata
      ? invalidText.test(raw)
        ? undefined
        : raw
      : entityText(raw);
    if (text === undefined || (!stack.length && text.trim())) return false;
    if (capturing) pieces.push(text);
    return true;
  };
  while (cursor < document.length) {
    if (document.charAt(cursor) !== '<') {
      const next = document.indexOf('<', cursor);
      const end = next < 0 ? document.length : next;
      const raw = document.slice(cursor, end);
      if (raw.includes(']]>') || !textContent(raw)) return undefined;
      cursor = end;
      continue;
    }
    if (++count > 50_000) return undefined;
    if (document.startsWith('<!--', cursor)) {
      const end = document.indexOf('-->', cursor + 4);
      if (end < 0 || document.slice(cursor + 4, end).includes('--'))
        return undefined;
      cursor = end + 3;
      continue;
    }
    if (document.startsWith('<![CDATA[', cursor)) {
      if (!stack.length) return undefined;
      const end = document.indexOf(']]>', cursor + 9);
      if (end < 0 || !textContent(document.slice(cursor + 9, end), true))
        return undefined;
      cursor = end + 3;
      continue;
    }
    if (document.startsWith('<?xml ', cursor) && cursor === 0) {
      const end = document.indexOf('?>', cursor + 6);
      if (end < 0) return undefined;
      cursor = end + 2;
      continue;
    }
    if (document.startsWith('</', cursor)) {
      closing.lastIndex = cursor;
      const tag = closing.exec(document);
      const frame = stack.at(-1);
      if (!tag || !frame || tag[1] !== frame.name) return undefined;
      if (frame.matches && stack.length === selectors.length) capturing = false;
      stack.pop();
      cursor = closing.lastIndex;
      continue;
    }
    if (document.startsWith('<!', cursor) || document.startsWith('<?', cursor))
      return undefined;
    if (!stack.length && root) return undefined;
    if (stack.length >= 80) return undefined;
    const parsed = readStartTag(document, cursor);
    if (!parsed) return undefined;
    root = true;
    const parent = stack.at(-1);
    const ordinal = (parent?.children.get(parsed.tag) ?? 0) + 1;
    parent?.children.set(parsed.tag, ordinal);
    const selector = selectors[stack.length];
    const matches =
      (!parent || parent.matches) &&
      selector?.name === parsed.tag &&
      selector.order === ordinal;
    if (matches && stack.length + 1 === selectors.length) {
      selected = true;
      capturing = !parsed.closed;
    }
    if (!parsed.closed)
      stack.push({ name: parsed.tag, children: new Map(), matches });
    cursor = parsed.end;
  }
  if (!root || stack.length || !selected) return undefined;
  return pieces.join('').trim();
}
