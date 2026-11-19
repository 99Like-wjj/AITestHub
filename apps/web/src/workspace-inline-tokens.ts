import {
  composerReferenceMarkerPattern,
  type ConversationReferenceInput,
} from '../../../packages/contracts/src/conversations';
import {
  platformGuidanceSkillIdSchema,
  type PlatformGuidanceSkillId,
} from '../../../packages/contracts/src/skill-guidance';

export interface InlineComposerToken {
  start: number;
  end: number;
  raw: string;
  label: string;
  kind: 'skill' | 'reference';
  skillId?: PlatformGuidanceSkillId;
  referenceKey?: string;
}
export function inlineReferenceKey(
  reference: ConversationReferenceInput,
): string {
  const id =
    reference.kind === 'conversation'
      ? reference.conversationId
      : reference.kind === 'resource'
        ? reference.resourceId
        : reference.kind === 'requirementVersion'
          ? reference.requirementVersionId
          : reference.kind === 'knowledge'
            ? reference.entryId
            : reference.kind === 'externalMcpConnection'
              ? reference.connectionId
              : reference.invocationId;
  return `${reference.kind}:${id}`;
}
export function inlineReferenceMarker(
  label: string,
  reference: ConversationReferenceInput,
) {
  let bounded = '';
  for (const point of label) {
    const code = point.codePointAt(0) ?? 0;
    const scalar = code >= 0xd800 && code <= 0xdfff ? '\ufffd' : point;
    if (bounded.length + scalar.length > 200) break;
    bounded += scalar;
  }
  const name = encodeURIComponent(bounded).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `@[${name}](ath-ref:${inlineReferenceKey(reference)})`;
}
export function inlineSkillMarker(id: PlatformGuidanceSkillId) {
  return '[/' + id + '](ath-skill:' + id + ')';
}

const composerTokenPattern = new RegExp(
  composerReferenceMarkerPattern.source +
    '|' +
    /\[\/(?<skillId>[a-z][a-z0-9-]{0,79})\]\(ath-skill:\k<skillId>\)|\/(?<legacySkillId>[a-z][a-z0-9-]{0,79})(?=$|\s)/u
      .source,
  'gu',
);

export function replaceConversationReferenceCode(
  raw: string,
  code: string,
  marker: string,
) {
  if (!/^ATHC1-[a-f0-9]{32}$/i.test(code)) return { text: raw, insertions: [] };
  let text = '',
    offset = 0;
  const insertions: { start: number; end: number; text: string }[] = [];
  for (const match of raw.matchAll(new RegExp('@?' + code + '\\b', 'gi'))) {
    text += raw.slice(offset, match.index);
    const start = text.length;
    text += marker;
    insertions.push({ start, end: text.length, text: marker });
    offset = match.index + match[0].length;
  }
  return { text: text + raw.slice(offset), insertions };
}
export function parseInlineComposerTokens(
  raw: string,
  allowedReferences?: ReadonlySet<string>,
): InlineComposerToken[] {
  const found: InlineComposerToken[] = [];
  for (const match of raw.matchAll(composerTokenPattern)) {
    const start = match.index,
      key = match.groups?.referenceKey;
    if (key) {
      if (allowedReferences && !allowedReferences.has(key)) continue;
      let label: string;
      try {
        label = decodeURIComponent(match.groups?.referenceLabel ?? '');
      } catch {
        continue;
      }
      if (!label || label.length > 200) continue;
      found.push({
        start,
        end: start + match[0].length,
        raw: match[0],
        label,
        kind: 'reference',
        referenceKey: key,
      });
    } else {
      const parsed = platformGuidanceSkillIdSchema.safeParse(
        match.groups?.skillId ?? match.groups?.legacySkillId,
      );
      if (
        !parsed.success ||
        (!match.groups?.skillId &&
          start > 0 &&
          /[A-Za-z0-9_./:@-]/.test(raw[start - 1] ?? ''))
      )
        continue;
      found.push({
        start,
        end: start + match[0].length,
        raw: match[0],
        label: parsed.data,
        kind: 'skill',
        skillId: parsed.data,
      });
    }
  }
  return found.slice(0, 100);
}
export function atomicComposerDeletion(
  raw: string,
  start: number,
  end: number,
  direction: 'backward' | 'forward',
  tokens: readonly InlineComposerToken[],
) {
  let from = start,
    to = end;
  if (from === to) {
    const token = tokens.find((t) =>
      direction === 'backward' ? t.end === from : t.start === from,
    );
    if (!token) return null;
    from = token.start;
    to = token.end;
  } else ({ start: from, end: to } = atomicComposerSelection(from, to, tokens));
  return { text: raw.slice(0, from) + raw.slice(to), caret: from };
}

export function atomicComposerSelection(
  start: number,
  end: number,
  tokens: readonly InlineComposerToken[],
) {
  if (start === end) return { start, end };
  for (const token of tokens)
    if (token.start < end && token.end > start) {
      start = Math.min(start, token.start);
      end = Math.max(end, token.end);
    }
  return { start, end };
}
