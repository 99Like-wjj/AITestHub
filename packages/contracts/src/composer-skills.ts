import {
  platformGuidanceSkillIdSchema,
  type PlatformGuidanceSkillId,
} from './skill-guidance.js';

const maximumSkillPrefixTokens = 32;

/** Plain user-content markers, never submission, execution or authorization. */
export function serializeComposerSkills(
  skillIds: readonly PlatformGuidanceSkillId[],
  text: string,
): string {
  if (skillIds.length > maximumSkillPrefixTokens)
    throw new Error('本次 Skill 标记数量超过输入上限。');
  const selected = new Set<PlatformGuidanceSkillId>();
  for (const id of skillIds) {
    const parsed = platformGuidanceSkillIdSchema.safeParse(id);
    if (!parsed.success) throw new Error('所选 Skill 不属于当前平台能力。');
    selected.add(parsed.data);
  }
  return [...selected].map((id) => `/${id} `).join('') + text;
}

/** Recognized inline markers are metadata; unrelated body text is preserved.
 * Legacy contiguous prefixes keep their original whitespace behavior. */
export function splitComposerSkills(raw: string): {
  skillIds: PlatformGuidanceSkillId[];
  text: string;
} {
  const selected = new Set<PlatformGuidanceSkillId>();
  let offset = 0;
  for (let count = 0; count < maximumSkillPrefixTokens; count++) {
    const match = /^\/([a-z][a-z0-9-]{0,79})(?=$|\s)/u.exec(raw.slice(offset));
    if (!match) break;
    const parsed = platformGuidanceSkillIdSchema.safeParse(match[1]);
    if (!parsed.success) break;
    selected.add(parsed.data);
    offset += match[0].length;
    if (raw[offset] === ' ') offset++;
  }
  // New composers place recognized markers at their actual text positions.
  // They are user-content metadata only, with the same IDs and no execution authority.
  const source = raw.slice(offset);
  const body = source.replace(
    /\[\/([a-z][a-z0-9-]{0,79})\]\(ath-skill:\1\)|\/([a-z][a-z0-9-]{0,79})(?=$|\s)/gu,
    (
      match: string,
      marked: string | undefined,
      legacy: string | undefined,
      index: number,
    ) => {
      const parsed = platformGuidanceSkillIdSchema.safeParse(marked ?? legacy);
      if (
        !parsed.success ||
        (!marked &&
          index > 0 &&
          /[A-Za-z0-9_./:@-]/.test(source[index - 1] ?? '')) ||
        selected.size >= maximumSkillPrefixTokens
      )
        return match;
      selected.add(parsed.data);
      return '';
    },
  );
  return { skillIds: [...selected], text: body };
}
