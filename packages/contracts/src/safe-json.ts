const maxDepth = 64;
const maxNodes = 500_000;
const invalid = () => new Error('Invalid bounded JSON');

/** Pure browser/server JSON syntax boundary. Duplicate decoded keys, NUL and invalid Unicode are rejected before parsing. */
export function parseStrictJsonText(text: string): unknown {
  if (text.length > 16 * 1024 * 1024) throw invalid();
  let at = 0;
  let nodes = 0;
  const token = /true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const whitespace = () => {
    while (
      text[at] === ' ' ||
      text[at] === '\t' ||
      text[at] === '\r' ||
      text[at] === '\n'
    ) {
      at++;
    }
  };
  const string = (): string => {
    if (text[at++] !== '"') throw invalid();
    const parts: string[] = [];
    let chunk = '';
    const append = (part: string) => {
      if (part.length === 0) return;
      // Bound the fragment array even when an entire large string consists of escapes.
      if (part.length >= 4096) {
        if (chunk) parts.push(chunk);
        chunk = '';
        parts.push(part);
      } else {
        chunk += part;
        if (chunk.length >= 4096) {
          parts.push(chunk);
          chunk = '';
        }
      }
    };
    let start = at;
    while (at < text.length) {
      const character = text[at++]!;
      if (character === '"') {
        append(text.slice(start, at - 1));
        if (chunk) parts.push(chunk);
        const value = parts.join('');
        // PostgreSQL JSON/text cannot retain NUL or unpaired surrogate code units.
        for (let index = 0; index < value.length; index++) {
          const code = value.charCodeAt(index);
          if (code === 0) throw invalid();
          if (code >= 0xd800 && code <= 0xdbff) {
            const low = value.charCodeAt(++index);
            if (!(low >= 0xdc00 && low <= 0xdfff)) throw invalid();
          } else if (code >= 0xdc00 && code <= 0xdfff) {
            throw invalid();
          }
        }
        return value;
      }
      if (character.charCodeAt(0) < 0x20) throw invalid();
      if (character !== '\\') continue;

      append(text.slice(start, at - 1));
      const escaped = text[at++];
      switch (escaped) {
        case '"':
        case '\\':
        case '/':
          append(escaped);
          break;
        case 'b':
          append('\b');
          break;
        case 'f':
          append('\f');
          break;
        case 'n':
          append('\n');
          break;
        case 'r':
          append('\r');
          break;
        case 't':
          append('\t');
          break;
        case 'u': {
          const hex = text.slice(at, at + 4);
          if (!/^[a-f\d]{4}$/i.test(hex)) throw invalid();
          append(String.fromCharCode(Number.parseInt(hex, 16)));
          at += 4;
          break;
        }
        default:
          throw invalid();
      }
      start = at;
    }
    throw invalid();
  };
  const visit = (depth: number): void => {
    if (depth > maxDepth || ++nodes > maxNodes) throw invalid();
    whitespace();
    const character = text[at];
    if (character === '{') {
      at++;
      whitespace();
      const keys = new Set<string>();
      if (text[at] === '}') {
        at++;
        return;
      }
      while (true) {
        whitespace();
        const key = string();
        if (keys.has(key)) throw invalid();
        keys.add(key);
        whitespace();
        if (text[at++] !== ':') throw invalid();
        visit(depth + 1);
        whitespace();
        const delimiter = text[at++];
        if (delimiter === '}') return;
        if (delimiter !== ',') throw invalid();
      }
    }
    if (character === '[') {
      at++;
      whitespace();
      if (text[at] === ']') {
        at++;
        return;
      }
      while (true) {
        visit(depth + 1);
        whitespace();
        const delimiter = text[at++];
        if (delimiter === ']') return;
        if (delimiter !== ',') throw invalid();
      }
    }
    if (character === '"') {
      string();
      return;
    }
    // A sticky match scans the original text once, without copying its remaining suffix per node.
    token.lastIndex = at;
    const match = token.exec(text)?.[0];
    if (!match) throw invalid();
    if (
      match !== 'true' &&
      match !== 'false' &&
      match !== 'null' &&
      !Number.isFinite(Number(match))
    ) {
      throw invalid();
    }
    at = token.lastIndex;
  };

  visit(0);
  whitespace();
  if (at !== text.length) throw invalid();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalid();
  }
}
