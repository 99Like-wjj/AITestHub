import { z } from 'zod';
import {
commandIdSchema,
idSchema,
persistedRowVersionSchema,
titleSchema,
} from './base.js';
export const scheduleRuleSchema = z.strictObject({
  frequency: z.enum(['once', 'daily', 'weekly']),
  date: z.iso.date(),
  time: z
    .string()
    .regex(/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/)
    .transform((value) => (value.length === 5 ? `${value}:00` : value)),
  timeZone: z.string().min(1).max(100),
});
export const schedulePointSchema = z.strictObject({
  wallDate: z.iso.date(),
  wallTime: z.string(),
  timeZone: z.string(),
  plannedAt: z.iso.datetime().nullable(),
  decisionAt: z.iso.datetime(),
  offset: z.string().nullable(),
  alternateOffset: z.string().nullable(),
  resolution: z.enum(['unique', 'foldEarlier', 'gap']),
  foldChoice: z.literal('earlier').nullable(),
  timeZoneRulesVersion: z.string(),
});
export const schedulePreviewInputSchema = z.strictObject({
  rule: scheduleRuleSchema,
  after: z.iso.datetime().optional(),
  count: z.number().int().min(1).max(20).default(5),
});
export const schedulePreviewSchema = z.strictObject({
  points: z.array(schedulePointSchema),
  noFuturePoint: z.boolean(),
  pastPointsWillNotRun: z.literal(true),
});
export const createScheduleInputSchema = z.strictObject({
  commandId: commandIdSchema,
  planId: idSchema,
  planRevisionId: idSchema,
  environmentId: idSchema,
  rule: scheduleRuleSchema,
  enabled: z.boolean().default(true),
});
export const reviseScheduleInputSchema = z.strictObject({
  commandId: commandIdSchema,
  rowVersion: persistedRowVersionSchema,
  baseRevisionId: idSchema,
  planRevisionId: idSchema,
  environmentId: idSchema,
  rule: scheduleRuleSchema,
});
export const changeScheduleStateInputSchema = z.strictObject({
  commandId: commandIdSchema,
  rowVersion: persistedRowVersionSchema,
});
export const copyScheduleInputSchema = z.strictObject({
  commandId: commandIdSchema,
  rowVersion: persistedRowVersionSchema,
  name: titleSchema,
  environmentId: idSchema,
  rule: scheduleRuleSchema,
  enabled: z.boolean().default(true),
});
export const scheduleSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema,
  planId: idSchema,
  planRevisionId: idSchema,
  environmentId: idSchema,
  planName: z.string(),
  createdBy: idSchema,
  copiedFromScheduleId: idSchema.nullable(),
  revisionId: idSchema,
  revisionNo: z.number().int().positive(),
  rowVersion: persistedRowVersionSchema,
  status: z.enum(['active', 'paused', 'completed']),
  pauseReason: z.string().nullable(),
  rule: scheduleRuleSchema,
  nextPoint: schedulePointSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const scheduleReceiptSchema = z.strictObject({
  schedule: scheduleSchema,
});
export const scheduleOperationLookupSchema = z.strictObject({
  operation: z.enum([
    'schedules.create',
    'schedules.revise',
    'schedules.pause',
    'schedules.resume',
    'schedules.copy',
  ]),
  key: commandIdSchema,
});
export const scheduleListSchema = z.strictObject({
  schedules: z.array(scheduleSchema),
});
export const scheduleOccurrenceStateSchema = z.enum([
  'queued',
  'started',
  'completed',
  'overlapSkipped',
  'missedOffline',
  'preconditionsMissing',
  'creatorUnavailable',
  'dstNonexistent',
  'cancelled',
  'expired',
]);
export const scheduleOccurrenceSchema = z.strictObject({
  id: idSchema,
  sequence: z.string().regex(/^\d+$/),
  scheduleId: idSchema,
  revisionId: idSchema,
  point: schedulePointSchema,
  state: scheduleOccurrenceStateSchema,
  reasonCode: z.string(),
  details: z.json(),
  epochId: idSchema.nullable(),
  requestId: idSchema.nullable(),
  runId: idSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const scheduleTimelineSchema = z.strictObject({
  occurrences: z.array(scheduleOccurrenceSchema),
  nextBefore: z.string().regex(/^\d+$/).nullable(),
});
export const scheduleDetailSchema = z.strictObject({
  schedule: scheduleSchema,
  revisions: z.array(
    z.strictObject({
      id: idSchema,
      revisionNo: z.number().int().positive(),
      planRevisionId: idSchema,
      environmentId: idSchema,
      rule: scheduleRuleSchema,
      createdBy: idSchema,
      createdAt: z.iso.datetime(),
    }),
  ),
});
export type ScheduleRule = z.infer<typeof scheduleRuleSchema>;
export type SchedulePoint = z.infer<typeof schedulePointSchema>;
