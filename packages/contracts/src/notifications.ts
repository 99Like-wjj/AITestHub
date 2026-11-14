import { z } from 'zod';
import { idSchema } from './base.js';
export const notificationSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema.nullable(),
  kind: z.enum([
    'requirementReview',
    'assetReview',
    'reportReady',
    'scheduleCompleted',
    'issueNotDefect',
    'uploadInterrupted',
  ]),
  objectId: idSchema,
  title: z.string(),
  targetPath: z.string(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});
export const notificationListQuerySchema = z.strictObject({
  cursor: idSchema.optional(),
  unreadOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(30),
});
export const notificationListSchema = z.strictObject({
  notifications: z.array(notificationSchema),
  unreadCount: z.number().int().nonnegative(),
  nextCursor: idSchema.nullable(),
});
export const markNotificationsReadSchema = z.strictObject({
  ids: z
    .array(idSchema)
    .min(1)
    .max(1000)
    .refine((v) => new Set(v).size === v.length),
});
export const markNotificationsReadReceiptSchema = z.strictObject({
  readIds: z.array(idSchema),
});
