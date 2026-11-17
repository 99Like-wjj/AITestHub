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
