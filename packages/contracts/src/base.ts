import { z } from 'zod';

export const CONTRACT_VERSION = 'ath.contracts.v1' as const;
export const idSchema = z.uuid();
export const rowVersionSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
export const persistedRowVersionSchema = rowVersionSchema.min(1);
export const timestampSchema = z.iso.datetime({ offset: true });
export const decimalCountSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const commandIdSchema = z.string().min(8).max(128);
export const operationNotAccepted = { operationAcceptance: 'notAccepted' } as const;
export const operationReceiptClosed = { receiptState: 'closed' } as const;
export const receiptCloseResultSchema = z.strictObject({
  commandId: commandIdSchema,
  status: z.enum(['closed', 'receiptAvailable', 'unknown']),
});
export const safeTextSchema = z.string().max(100_000);
export const titleSchema = z.string().trim().min(1).max(200);
export const kindSchema = z.enum(['UI', 'API']);

export const errorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'ACCOUNT_UNAVAILABLE',
  'ACCOUNT_ALREADY_EXISTS',
  'FORBIDDEN',
  'NOT_FOUND',
  'IDEMPOTENCY_CONFLICT',
  'BUSINESS_CONFLICT',
  'STALE_BASE_REVISION',
  'PRECONDITIONS_MISSING',
  'LAST_PROJECT_ADMIN',
  'LAST_PLATFORM_ADMIN',
  'INVALID_RESET_CREDENTIAL',
  'UNSUPPORTED_SCHEMA_VERSION',
  'UNSUPPORTED_OPERATION',
  'FILE_TOO_LARGE',
  'FILE_HASH_MISMATCH',
  'FILE_NOT_READY',
  'RATE_LIMITED',
  'DEPENDENCY_UNAVAILABLE',
  'MODEL_NOT_CONFIGURED',
  'INVALID_MODEL_OUTPUT',
  'OPERATION_RESULT_UNKNOWN',
  'INTERNAL_ERROR',
]);
export const recoverySchema = z.enum([
  'sign-in',
  'check-access',
  'correct-input',
  'compare-and-resubmit',
  'resolve-preconditions',
  'status-lookup-required',
  'retry-safe-read',
  'retransmit-same-submission',
  'contact-administrator',
]);
export const apiMetaSchema = z.strictObject({
  requestId: z.string().min(1).max(128),
  replayed: z.boolean().optional(),
});
export const apiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: errorCodeSchema,
    message: z.string().min(1).max(1000),
    details: z.record(z.string(), z.json()).optional(),
    recovery: recoverySchema.optional(),
  }),
  meta: apiMetaSchema,
});
export const pageQuerySchema = z.strictObject({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export function apiResponseSchema<T extends z.ZodType>(data: T) {
  return z.strictObject({ data, meta: apiMetaSchema });
}
export function pageSchema<T extends z.ZodType>(item: T) {
  return z.strictObject({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

export type Id = z.infer<typeof idSchema>;
export type TestKind = z.infer<typeof kindSchema>;
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type ApiMeta = z.infer<typeof apiMetaSchema>;
