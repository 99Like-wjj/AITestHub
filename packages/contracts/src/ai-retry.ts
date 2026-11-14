import { z } from 'zod';
import { idSchema,timestampSchema } from './base.js';

export const modelRetryReasonSchema = z.enum(['rateLimited', 'network', 'timeout', 'serverUnavailable']);
export const modelAttemptContextSchema = z.strictObject({
  logicalCallId: idSchema,
  attemptId: idSchema,
  modelOrdinal: z.number().int().min(1),
  attemptNo: z.number().int().min(0).max(5),
  maxRetries: z.number().int().min(0).max(5),
});
export type ModelAttemptContext = z.infer<typeof modelAttemptContextSchema>;
export const modelRetryEventSchema = modelAttemptContextSchema.safeExtend({
  phase: z.enum(['scheduled', 'started', 'recovered', 'exhausted']),
  retryNo: z.number().int().min(0).max(5),
  reason: modelRetryReasonSchema.nullable(),
  nextAttemptAt: timestampSchema.nullable(),
  delayMs: z.number().int().min(0).nullable(),
  stopReason: z.enum(['maxRetries', 'timeBudget']).nullable(),
});
export type ModelRetryEvent = z.infer<typeof modelRetryEventSchema>;
export const modelAttemptViewSchema = z.strictObject({
  id: idSchema,
  logicalCallId: idSchema,
  modelOrdinal: z.number().int().min(1),
  attemptNo: z.number().int().min(0).max(5),
  state: z.enum(['running', 'retryWait', 'completed', 'failed', 'cancelled']),
  visibleText: z.string().max(100_000),
  prefixLength: z.number().int().min(0).max(100_000).nullable().default(null),
  errorCode: z.string().nullable(),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  nextAttemptAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  finishedAt: timestampSchema.nullable(),
});
export type ModelAttemptView = z.infer<typeof modelAttemptViewSchema>;
export interface ModelAttemptFailure {
  httpStatus: number | null;
  providerCode: string | null;
  providerType: string | null;
  requestId: string | null;
  dispatchCertainty: 'notDispatched' | 'responseReceived' | 'unknown';
  attemptedRequests: 0 | 1;
  retryAfterMs: number | null;
}
