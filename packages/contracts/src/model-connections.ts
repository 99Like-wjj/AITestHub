import { z } from 'zod';
import {
  idSchema,
  persistedRowVersionSchema,
  timestampSchema,
} from './base.js';

export const modelConnectionObservationSchema = z.strictObject({
  modelServiceId: idSchema,
  modelEntryId: idSchema,
  serviceRevision: persistedRowVersionSchema,
  state: z.enum(['connected', 'failed', 'pending']),
  checkedAt: timestampSchema,
  source: z.enum(['chat', 'auxiliary', 'background']),
});
export const modelConnectionProbeInputSchema = z.strictObject({
  commandId: idSchema,
  modelEntryId: idSchema,
  serviceRevision: persistedRowVersionSchema,
});
export const modelConnectionProbeReceiptSchema = z.strictObject({
  probe: z.strictObject({
    commandId: idSchema,
    modelServiceId: idSchema,
    modelEntryId: idSchema,
    serviceRevision: persistedRowVersionSchema,
    state: z.enum(['testing', 'connected', 'failed', 'unknown']),
    checkedAt: timestampSchema,
    code: z
      .string()
      .regex(/^[A-Z0-9_]{1,80}$/)
      .nullable(),
    upstreamHttpStatus: z.number().int().min(100).max(599).nullable(),
  }),
});
export type ModelConnectionObservation = z.infer<
  typeof modelConnectionObservationSchema
>;
export type ModelConnectionProbeReceipt = z.infer<
  typeof modelConnectionProbeReceiptSchema
>;
