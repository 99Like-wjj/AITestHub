import { z } from 'zod';
import { idSchema,sha256Schema,timestampSchema } from './base.js';

export const resolveBusinessConfirmationInputSchema = z.strictObject({
  scopeDigest: sha256Schema,
  decision: z.enum(['accept', 'decline']),
});
export const businessConfirmationProposalSchema = z.strictObject({
  reason: z.enum([
    'precise-scope',
    'manual-overlap',
    'impact',
    'explicit-selection',
    'human-decision',
  ]),
  summary: z.string(),
  scope: z.json(),
  links: z.array(z.string()),
  digest: sha256Schema,
});
export const businessConfirmationSchema = z.strictObject({
  id: idSchema,
  toolName: z.string(),
  op: z.string(),
  projectId: idSchema.nullable(),
  taskId: idSchema.nullable(),
  conversationId: idSchema.nullable(),
  status: z.enum([
    'waitingConfirmation',
    'executing',
    'completed',
    'declined',
    'failed',
    'unknown',
  ]),
  scopeDigest: sha256Schema,
  proposal: businessConfirmationProposalSchema,
  response: z.json().nullable(),
  createdAt: timestampSchema,
  resolvedAt: timestampSchema.nullable(),
  recovery: z.string(),
});
export const businessConfirmationResponseSchema = z.strictObject({
  confirmation: businessConfirmationSchema,
});
export const listBusinessConfirmationsSchema = z.strictObject({
  confirmations: z.array(businessConfirmationSchema),
});
export type BusinessConfirmation = z.infer<typeof businessConfirmationSchema>;
