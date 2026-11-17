import { z } from 'zod';
import {
  commandIdSchema,
  idSchema,
  persistedRowVersionSchema,
} from './base.js';
import { modelSelectionV2Schema } from './model-configuration-v2.js';
import { dataScopeSchema } from './conversations.js';
import { schedulePointSchema, scheduleRuleSchema } from './schedules.js';
import {
  workspaceAccessModeSchema,
  workspaceDataScope,
} from './workspace-access.js';

export const scheduledDocumentSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('resource'),
    resourceId: idSchema,
    dataScope: dataScopeSchema,
  }),
  z.strictObject({
    kind: z.literal('requirementVersion'),
    requirementVersionId: idSchema,
    dataScope: dataScopeSchema,
  }),
  z.strictObject({
    kind: z.literal('knowledge'),
    entryId: idSchema,
    revisionId: idSchema,
    dataScope: dataScopeSchema,
  }),
]);
export const scheduledDraftTemplateSchema = z
  .strictObject({
    content: z.string().trim().min(1).max(20_000),
    modelSelection: modelSelectionV2Schema,
    dataScope: dataScopeSchema,
    references: z.array(scheduledDocumentSourceSchema).max(20),
  })
  .superRefine((input, ctx) => {
    if (
      input.dataScope === 'syntheticPublicOnly' &&
      input.references.some((ref) => ref.dataScope !== 'syntheticPublicOnly')
    )
      ctx.addIssue({
        code: 'custom',
        path: ['references'],
        message: '内部资料不能改标为公开定时任务。',
      });
  });
export const scheduledOfficeTemplateSchema = scheduledDraftTemplateSchema
  .safeExtend({ accessMode: workspaceAccessModeSchema })
  .superRefine((input, ctx) => {
    if (input.dataScope !== workspaceDataScope(input.accessMode))
      ctx.addIssue({
        code: 'custom',
        path: ['dataScope'],
        message: '定时办公任务资料范围须与所选访问模式一致。',
      });
    if (input.accessMode === 'restricted' && input.references.length > 0)
      ctx.addIssue({
        code: 'custom',
        path: ['references'],
        message: '受限访问不能读取项目引用，请选择完全访问。',
      });
  });
export const scheduledTaskTemplateSchema = z.union([
  scheduledDraftTemplateSchema,
  scheduledOfficeTemplateSchema,
]);
export const agentScheduleStateSchema = z.enum([
  'active',
  'paused',
  'cancelled',
  'finished',
]);
export const agentScheduleOccurrenceStateSchema = z.enum([
  'claimed',
  'dispatching',
  'enqueued',
  'completed',
  'failed',
  'blocked',
  'missed',
  'skipped',
  'cancelled',
  'unknown',
]);
const editableShape = {
  title: z.string().trim().min(1).max(200),
  kind: z.enum(['reminder', 'draft', 'office']),
  conversationId: idSchema.nullable(),
  rule: scheduleRuleSchema,
  message: z.string().max(2000),
  template: scheduledTaskTemplateSchema.nullable(),
};
function validKind(
  input: { kind: string; template: unknown; conversationId: string | null },
  ctx: z.RefinementCtx,
) {
  if (
    ['draft', 'office'].includes(input.kind) &&
    (!input.template || !input.conversationId)
  )
    ctx.addIssue({
      code: 'custom',
      path: ['template'],
      message: '定时任务需明确目标会话、模型和提示词。',
    });
  if (input.template && input.kind !== 'reminder') {
    const expected =
      input.kind === 'office'
        ? scheduledOfficeTemplateSchema
        : scheduledDraftTemplateSchema;
    if (!expected.safeParse(input.template).success)
      ctx.addIssue({
        code: 'custom',
        path: ['template'],
        message: '任务模板与所选草稿或办公类型不一致。',
      });
  }
  if (input.kind === 'reminder' && input.template !== null)
    ctx.addIssue({
      code: 'custom',
      path: ['template'],
      message: '提醒不能携带模型任务模板。',
    });
}
export const agentScheduleCreateSchema = z
  .strictObject({ commandId: commandIdSchema, ...editableShape })
  .superRefine(validKind);
export const agentScheduleReviseSchema = z
  .strictObject({
    commandId: commandIdSchema,
    rowVersion: persistedRowVersionSchema,
    ...editableShape,
  })
  .superRefine(validKind);
export const agentScheduleStateChangeSchema = z.strictObject({
  commandId: commandIdSchema,
  rowVersion: persistedRowVersionSchema,
});
export const agentScheduleSchema = z.strictObject({
  id: idSchema,
  ...editableShape,
  state: agentScheduleStateSchema,
  rowVersion: persistedRowVersionSchema,
  nextPoint: schedulePointSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  taskPolicy: z.enum(['draftOnly', 'officeOnly']),
  missedPointsWillNotRun: z.literal(true),
});
export const agentScheduleOccurrenceSchema = z.strictObject({
  id: idSchema,
  scheduleId: idSchema,
  scheduleRevision: persistedRowVersionSchema,
  point: schedulePointSchema,
  state: agentScheduleOccurrenceStateSchema,
  taskId: idSchema.nullable(),
  errorCode: z.string().nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  missedThrough: z.iso.datetime().nullable(),
  automaticReplay: z.literal(false),
});
export const agentScheduleListSchema = z.strictObject({
  schedules: z.array(agentScheduleSchema),
});
export const agentScheduleReceiptSchema = z.strictObject({
  schedule: agentScheduleSchema,
});
export const agentScheduleDetailSchema = z.strictObject({
  schedule: agentScheduleSchema,
  occurrences: z.array(agentScheduleOccurrenceSchema),
});
export const agentSchedulePreviewSchema = z.strictObject({
  points: z.array(schedulePointSchema),
  pastPointsWillNotRun: z.literal(true),
  lateToleranceSeconds: z.literal(60),
});
export const agentScheduleToolSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('list') }),
  z.strictObject({ action: z.literal('detail'), id: idSchema }),
  agentScheduleCreateSchema.safeExtend({ action: z.literal('create') }),
  agentScheduleReviseSchema.safeExtend({
    action: z.literal('revise'),
    id: idSchema,
  }),
  agentScheduleStateChangeSchema.extend({
    action: z.enum(['pause', 'resume', 'cancel']),
    id: idSchema,
  }),
]);
export type ScheduledDraftTemplate = z.infer<
  typeof scheduledDraftTemplateSchema
>;
export type ScheduledOfficeTemplate = z.infer<
  typeof scheduledOfficeTemplateSchema
>;
export type ScheduledTaskTemplate = z.infer<typeof scheduledTaskTemplateSchema>;
export type AgentSchedule = z.infer<typeof agentScheduleSchema>;
export type AgentScheduleOccurrence = z.infer<
  typeof agentScheduleOccurrenceSchema
>;
