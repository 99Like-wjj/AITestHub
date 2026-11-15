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

/** Only the recognized contiguous prefix is metadata; every remaining body
 * character, including excess whitespace and unknown commands, is preserved. */
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
  return { skillIds: [...selected], text: raw.slice(offset) };
}
