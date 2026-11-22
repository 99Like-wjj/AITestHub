import { z } from 'zod';
import { idSchema, timestampSchema } from './base.js';
export const notificationKindSchema = z.enum([
  'requirementReview',
  'assetReview',
  'reportReady',
  'scheduleCompleted',
  'issueNotDefect',
  'uploadInterrupted',
  'agentReminder',
  'agentTaskReady',
  'issueAssigned',
  'issueRetest',
  'issueReturned',
]);
export const notificationLaneSchema = z.enum(['attention', 'activity']);
const notificationGroupKey = z.string().min(1).max(200);
export const notificationSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema.nullable(),
  kind: notificationKindSchema,
  objectId: idSchema,
  title: z.string(),
  targetPath: z.string(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});
export const notificationListQuerySchema = z.strictObject({
  cursor: idSchema.optional(),
  lane: notificationLaneSchema.default('attention'),
  unreadOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(30),
});
export const notificationGroupItemsQuerySchema =
  notificationListQuerySchema.extend({ groupKey: notificationGroupKey });
export const notificationGroupSchema = z.strictObject({
  key: notificationGroupKey,
  kind: notificationKindSchema,
  projectId: idSchema.nullable(),
  projectName: z.string().nullable(),
  requirementId: idSchema.nullable(),
  requirementTitle: z.string().nullable(),
  requirementVersionNo: z.number().int().positive().nullable(),
  assetKind: z.enum(['UI', 'API']).nullable(),
  title: z.string(),
  latestAt: timestampSchema,
  itemCount: z.number().int().positive(),
  unreadCount: z.number().int().nonnegative(),
  readThrough: timestampSchema,
  preview: z.array(notificationSchema),
});
export const notificationListSchema = z.strictObject({
  groups: z.array(notificationGroupSchema),
  unreadCount: z.number().int().nonnegative(),
  nextCursor: idSchema.nullable(),
});
export const notificationGroupItemsSchema = z.strictObject({
  notifications: z.array(notificationSchema),
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
export const markNotificationGroupsReadSchema = z.strictObject({
  lane: notificationLaneSchema,
  groups: z
    .array(z.strictObject({ key: notificationGroupKey, readThrough: timestampSchema }))
    .min(1)
    .max(100)
    .refine((groups) => new Set(groups.map(({ key }) => key)).size === groups.length),
});
export const markNotificationGroupsReadReceiptSchema = z.strictObject({
  readCount: z.number().int().nonnegative(),
});
