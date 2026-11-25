import { z } from 'zod';
import {
  idSchema,
  persistedRowVersionSchema,
  sha256Schema,
  timestampSchema,
} from './base.js';
import { humanConfirmationProposalSchema } from './human-confirmation.js';

export const actionIntentDecisionSchema = z.strictObject({
  revision: persistedRowVersionSchema,
  scopeDigest: sha256Schema,
  decision: z.enum(['execute', 'cancel']),
});

export const actionIntentChatReplySchema = z.strictObject({
  text: z.string().trim().min(1).max(80),
});
export const mcpActionIntentReplySchema = actionIntentChatReplySchema.extend({
  id: idSchema,
  revision: persistedRowVersionSchema,
  scopeDigest: sha256Schema,
});

export function parseActionIntentReply(input: string) {
  const match =
    /^(确认(?:执行)?|取消(?:执行)?)(?:\s+([0-9a-f-]{8,36}))?$/iu.exec(
      input.normalize('NFKC').trim(),
    );
  if (!match) return null;
  return {
    decision: match[1]?.startsWith('确认')
      ? ('execute' as const)
      : ('cancel' as const),
    locator: match[2]?.toLowerCase(),
  };
}

export const actionIntentPresentationSchema = z.strictObject({
  title: z.string().min(1).max(200),
  summary: z.string().max(4000),
  projectName: z.string().max(200).nullable(),
  changes: z
    .array(
      z.strictObject({
        label: z.string().max(200),
        before: z.string().max(2000).nullable(),
        after: z.string().max(2000).nullable(),
      }),
    )
    .max(100),
  details: z
    .array(
      z.strictObject({
        label: z.string().max(200),
        value: z.string().max(2000),
      }),
    )
    .max(100),
});
export const actionIntentSchema = z.strictObject({
  id: idSchema,
  revision: persistedRowVersionSchema,
  toolName: z.string(),
  op: z.string(),
  projectId: idSchema.nullable(),
  taskId: idSchema.nullable(),
  conversationId: idSchema.nullable(),
  messageId: idSchema.nullable(),
  ...actionIntentPresentationSchema.shape,
  status: z.enum([
    'waitingConfirmation',
    'executing',
    'completed',
    'declined',
    'failed',
    'unknown',
    'expired',
  ]),
  scopeDigest: sha256Schema,
  proposal: humanConfirmationProposalSchema,
  arguments: z.json(),
  response: z.json().nullable(),
  createdAt: timestampSchema,
  expiresAt: timestampSchema,
  resolvedAt: timestampSchema.nullable(),
  recovery: z.string(),
});
export const actionIntentResponseSchema = z.strictObject({
  intent: actionIntentSchema,
});
export const actionIntentListSchema = z.strictObject({
  intents: z.array(actionIntentSchema).max(1000),
});
export type ActionIntent = z.infer<typeof actionIntentSchema>;
