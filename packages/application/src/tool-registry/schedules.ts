import { z } from 'zod';
import { idSchema } from '../../../contracts/src/base.js';
import {
  createScheduleInputSchema,
  reviseScheduleInputSchema,
  changeScheduleStateInputSchema,
  copyScheduleInputSchema,
  schedulePreviewInputSchema,
} from '../../../contracts/src/schedules.js';
import type { ScheduleService } from '../schedules/service.js';
import type { BusinessToolRegistry } from './registry.js';
export type ScheduleBusinessService = Pick<
  ScheduleService,
  | 'create'
  | 'revise'
  | 'list'
  | 'detail'
  | 'pause'
  | 'resume'
  | 'copy'
  | 'preview'
  | 'timeline'
>;

/** Reuses the runtime owner's public service; constructor/runtime dispatch are never tool capabilities. */
export function registerScheduleTools(
  registry: BusinessToolRegistry,
  schedules: ScheduleBusinessService,
): void {
  const project = { projectId: idSchema };
  const target = { ...project, id: idSchema };
  const add = registry.add.bind(registry);
  const description =
    '项目接口计划定时配置和时区预览；过去漏时点不补跑，失效创建人原计划不转交，明确复制才产生当前人新计划。';
  add(
    'ath_schedules',
    description,
    'list',
    z.strictObject({ op: z.literal('list'), ...project }),
    'read',
    (a, i) => schedules.list(a, i.projectId),
  );
  add(
    'ath_schedules',
    description,
    'get',
    z.strictObject({ op: z.literal('get'), ...target }),
    'read',
    (a, i) => schedules.detail(a, i.projectId, i.id),
  );
  add(
    'ath_schedules',
    description,
    'preview',
    z.strictObject({
      op: z.literal('preview'),
      ...project,
      input: schedulePreviewInputSchema,
    }),
    'read',
    (a, i) => schedules.preview(a, i.projectId, i.input),
  );
  add(
    'ath_schedules',
    description,
    'create',
    z.strictObject({
      op: z.literal('create'),
      ...project,
      input: createScheduleInputSchema,
    }),
    'write',
    (a, i) => schedules.create(a, i.projectId, i.input),
  );
  add(
    'ath_schedules',
    description,
    'revise',
    z.strictObject({
      op: z.literal('revise'),
      ...target,
      input: reviseScheduleInputSchema,
    }),
    'write',
    (a, i) => schedules.revise(a, i.projectId, i.id, i.input),
  );
  for (const op of ['pause', 'resume'] as const)
    add(
      'ath_schedules',
      description,
      op,
      z.strictObject({
        op: z.literal(op),
        ...target,
        input: changeScheduleStateInputSchema,
      }),
      'write',
      (a, i) => schedules[op](a, i.projectId, i.id, i.input),
    );
  add(
    'ath_schedules',
    description,
    'copy',
    z.strictObject({
      op: z.literal('copy'),
      ...target,
      input: copyScheduleInputSchema,
    }),
    'write',
    (a, i) => schedules.copy(a, i.projectId, i.id, i.input),
  );
  add(
    'ath_schedules',
    description,
    'occurrences',
    z.strictObject({
      op: z.literal('occurrences'),
      ...target,
      before: z
        .string()
        .regex(/^\d{1,19}$/)
        .optional(),
    }),
    'read',
    (a, i) => schedules.timeline(a, i.projectId, i.id, i.before),
  );
}
