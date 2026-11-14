import { z } from 'zod';
import { idSchema } from './base.js';

/** A locator, never an access token. Read permission is checked by the server. */
export function encodeConversationReference(conversationId: string): string {
  return `ATHC1-${idSchema.parse(conversationId).toLowerCase().replaceAll('-', '')}`;
}

/** Data scope is deliberately absent: the human must select it for each send. */
export function decodeConversationReference(value: string): {
  kind: 'conversation';
  conversationId: string;
  mode: 'full';
} | null {
  if (value.length > 100) return null;
  const match = /^ATHC1-([0-9a-f]{32})$/i.exec(value.trim());
  const hex = match?.[1]?.toLowerCase();
  if (!hex) return null;
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const parsed = idSchema.safeParse(id);
  return parsed.success
    ? { kind: 'conversation', conversationId: parsed.data, mode: 'full' }
    : null;
}

export const conversationMarkdownExportSchema = z.strictObject({
  filename: z.string().regex(/^aitesthub-conversation-[0-9a-f-]{36}\.md$/),
  markdown: z.string(),
  messageCount: z.number().int().nonnegative(),
  exportedAt: z.iso.datetime(),
});
