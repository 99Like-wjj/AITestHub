import { splitComposerSkills } from '../../../contracts/src/composer-skills.js';
import { assertSafeModelInput } from '../security/model-input.js';
import { DomainError } from '../errors.js';

export const isPlaceholderConversationTitle = (title: string) =>
  title === '新聊天' || title === '新对话';

export function truncateConversationText(value: string, limit: number): string {
  let result = '';
  for (const character of value) {
    if (result.length + character.length > limit) break;
    result += character;
  }
  return result;
}

/** A local, owner-private label exists before any optional summary request. */
export function fallbackConversationTitle(content: string): string {
  const body = splitComposerSkills(content).text;
  const first = body
    .split(/[\r\n。！？!?]/u)
    .map((line) =>
      line
        .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim(),
    )
    .find((line) => line.length > 0);
  if (!first || /^@\S+\s*$/u.test(first)) return '对话讨论';
  const text = first.replace(/^#{1,6}\s+/u, '');
  const title =
    text.length > 48 ? truncateConversationText(text, 47) + '…' : text;
  try {
    assertSafeModelInput(title);
    return title || '对话讨论';
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return '对话讨论';
  }
}

/** c is already owner/project-authorized by every caller. Historical naming is
 * a read projection, never a migration or a background replay of old chats. */
export const conversationFirstUserTitleSql = `CASE WHEN c.alias IS NULL AND c.default_title IN ('新聊天','新对话') THEN
 (SELECT left(m.content,16000) FROM app.ai_messages m WHERE m.conversation_id=c.id AND m.role='user' AND m.deleted_at IS NULL ORDER BY m.created_at,m.id LIMIT 1)
 ELSE NULL END first_user_title_content`;
