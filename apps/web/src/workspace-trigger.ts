import type { PlatformGuidanceSkillId } from '../../../packages/contracts/src/skill-guidance';

export interface ComposerTrigger {
  symbol: '@' | '/';
  query: string;
  start: number;
  end: number;
}

/** Only a token at the caret, never an email address, URL or path segment. */
export function composerTrigger(
  text: string,
  caret: number,
): ComposerTrigger | null {
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return null;
  const prefix = text.slice(0, caret),
    match = /(?:^|\s)([@/])([^\s@/]{0,80})$/u.exec(prefix);
  if (!match) return null;
  const symbol = match[1] as '@' | '/',
    query = match[2] ?? '';
  return { symbol, query, start: caret - query.length - 1, end: caret };
}

export function insertComposerReference(
  text: string,
  trigger: ComposerTrigger,
  label: string,
) {
  const token = `@${label.replace(/[\r\n]/g, ' ')} `;
  return {
    text: text.slice(0, trigger.start) + token + text.slice(trigger.end),
    caret: trigger.start + token.length,
  };
}

/** Selection prepares a user message; it does not send or authorize a tool. */
export function insertComposerSkill(
  text: string,
  trigger: ComposerTrigger,
  skillId: PlatformGuidanceSkillId,
) {
  const token = `/${skillId} `;
  return {
    text: text.slice(0, trigger.start) + token + text.slice(trigger.end),
    caret: trigger.start + token.length,
  };
}
