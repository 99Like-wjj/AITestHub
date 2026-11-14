import { z } from 'zod';
import { commandIdSchema,idSchema } from './base.js';
export const backupRequestSchema = z.strictObject({
  commandId: commandIdSchema,
});
export const backupStateSchema = z.enum([
  'queued',
  'preparing',
  'complete',
  'failed',
  'expired',
]);
export const backupMetadataSchema = z.strictObject({
  id: idSchema,
  state: backupStateSchema,
  requestedSource: z.enum(['manual', 'daily', 'upgrade']),
  controlSequence: z.number().int().nonnegative().nullable(),
  objectCount: z.number().int().nonnegative().nullable(),
  totalBytes: z.string().regex(/^\d+$/).nullable(),
  errorCode: z.string().nullable(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
});
export const backupReceiptSchema = z.strictObject({
  id: idSchema,
  state: z.literal('queued'),
});
export const backupListSchema = z.strictObject({
  backups: z.array(backupMetadataSchema),
});
export const backupDetailSchema = z.strictObject({
  backup: backupMetadataSchema,
});
export const operationsStatusSchema = z.strictObject({
  maintenance: z.strictObject({
    phase: z.enum([
      'idle',
      'draining',
      'snapshot',
      'restoreQuarantine',
      'readOnly',
    ]),
    operationId: idSchema.nullable(),
    reason: z.string(),
  }),
  controls: z.strictObject({
    platformId: idSchema,
    sequence: z.number().int().nonnegative(),
    stateDigest: z.string().nullable(),
    pending: z.boolean(),
  }),
  capacity: z.strictObject({
    state: z.enum(['unknown', 'healthy', 'warning', 'restricted']),
    availableBytes: z.string().nullable(),
    locations: z.array(
      z.strictObject({
        location: z.enum(['runtime', 'backups', 'objects']),
        availableBytes: z.string().nullable(),
        totalBytes: z.string().nullable(),
        capturedAt: z.iso.datetime(),
        errorCode: z.string().nullable(),
      }),
    ),
  }),
  worker: z.strictObject({
    active: z.boolean(),
    lastHeartbeatAt: z.iso.datetime().nullable(),
  }),
});
