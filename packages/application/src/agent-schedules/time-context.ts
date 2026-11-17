import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { schedulePointSchema } from '../../../contracts/src/schedules.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';

const identity = {
  schemaVersion: z.literal('ath.scheduled-draft-time.v1'),
  taskId: z.uuid(),
  taskStartedAtUtc: z.iso.datetime(),
};
const scheduledDraftTimeContextSchema = z.discriminatedUnion('source', [
  z.strictObject({
    ...identity,
    source: z.literal('scheduledOccurrence'),
    occurrenceId: z.uuid(),
    timeZone: z.string().min(1),
    timeZoneRulesVersion: z.string().min(1),
    scheduledAtUtc: z.iso.datetime(),
    scheduledLocalDate: z.iso.date(),
    scheduledLocalTime: z.string().min(1),
    scheduledOffset: z.string().min(1),
    taskStartedLocalDate: z.iso.date(),
    taskStartedLocalTime: z.string().min(1),
    taskStartedOffset: z.string().min(1),
  }),
  z.strictObject({ ...identity, source: z.literal('taskStartOnly') }),
]);
export type ScheduledDraftTimeContext = Readonly<
  z.infer<typeof scheduledDraftTimeContextSchema>
>;

/** Derive once from original persisted facts, never from a later schedule rule. */
export function createScheduledDraftTimeContext(input: {
  taskId: string;
  startedAt: Date;
  occurrence: { id: string; point: unknown } | null;
}): ScheduledDraftTimeContext {
  const base = {
    schemaVersion: 'ath.scheduled-draft-time.v1' as const,
    taskId: z.uuid().parse(input.taskId),
    taskStartedAtUtc: input.startedAt.toISOString(),
  };
  const unknown = () =>
    Object.freeze(
      scheduledDraftTimeContextSchema.parse({
        ...base,
        source: 'taskStartOnly',
      }),
    );
  const parsed = schedulePointSchema.safeParse(input.occurrence?.point);
  if (
    !input.occurrence ||
    !z.uuid().safeParse(input.occurrence.id).success ||
    !parsed.success
  )
    return unknown();
  const point = parsed.data;
  if (
    point.resolution === 'gap' ||
    point.plannedAt === null ||
    point.offset === null
  )
    return unknown();
  try {
    if (!/^(?:UTC|[A-Za-z_+-]+(?:\/[A-Za-z0-9_+.-]+)+)$/.test(point.timeZone))
      return unknown();
    const planned = Temporal.Instant.from(point.plannedAt).toZonedDateTimeISO(
      point.timeZone,
    );
    const wall = Temporal.PlainDateTime.from(
      `${point.wallDate}T${point.wallTime}`,
    );
    if (
      !planned.toPlainDateTime().equals(wall) ||
      planned.offset !== point.offset
    )
      return unknown();
    const started = Temporal.Instant.from(
      base.taskStartedAtUtc,
    ).toZonedDateTimeISO(point.timeZone);
    return Object.freeze(
      scheduledDraftTimeContextSchema.parse({
        ...base,
        source: 'scheduledOccurrence',
        occurrenceId: input.occurrence.id,
        timeZone: point.timeZone,
        timeZoneRulesVersion: point.timeZoneRulesVersion,
        scheduledAtUtc: point.plannedAt,
        scheduledLocalDate: point.wallDate,
        scheduledLocalTime: point.wallTime,
        scheduledOffset: point.offset,
        taskStartedLocalDate: started.toPlainDate().toString(),
        taskStartedLocalTime: started
          .toPlainTime()
          .toString({ smallestUnit: 'millisecond' }),
        taskStartedOffset: started.offset,
      }),
    );
  } catch {
    // Legacy/inconsistent point data cannot establish a trustworthy local date.
    return unknown();
  }
}

/** Internal worker read only: task identity and occurrence identity must agree. */
export async function loadScheduledDraftTimeContext(
  tx: SqlExecutor,
  input: { ownerId: string; conversationId: string; taskId: string },
): Promise<ScheduledDraftTimeContext | null> {
  const rows = (
    await tx.query<{
      started_at: Date | null;
      occurrence_id: string | null;
      point: unknown;
    }>(
      `SELECT t.started_at,o.id occurrence_id,o.point FROM app.ai_tasks t
      LEFT JOIN app.agent_schedule_occurrences o ON o.task_id=t.id
        AND o.owner_id=t.owner_id AND o.conversation_id=t.conversation_id
      WHERE t.owner_id=$1 AND t.conversation_id=$2 AND t.id=$3
        AND t.execution_policy IN ('draftOnly','officeOnly') LIMIT 2`,
      [
        z.uuid().parse(input.ownerId),
        z.uuid().parse(input.conversationId),
        z.uuid().parse(input.taskId),
      ],
    )
  ).rows;
  const row = rows[0];
  if (!row?.started_at) return null;
  return createScheduledDraftTimeContext({
    taskId: input.taskId,
    startedAt: row.started_at,
    occurrence:
      rows.length === 1 && row.occurrence_id
        ? { id: row.occurrence_id, point: row.point }
        : null,
  });
}

export function formatScheduledDraftTimeContext(
  context: ScheduledDraftTimeContext | null,
): string {
  if (!context)
    return 'Trusted scheduled draft time snapshot is unavailable. The planned trigger time, planned IANA time zone and planned local date are unknown. Do not infer a planned local date from UTC or the host time zone. Preserve explicit user dates and time zones.';
  const snapshot = scheduledDraftTimeContextSchema.parse(context);
  const prefix = `Trusted scheduled draft time snapshot (fixed for this task; not authorization): ${JSON.stringify(snapshot)}.`;
  if (snapshot.source === 'taskStartOnly')
    return `${prefix} Only the persisted actual task start UTC is known. The planned trigger time, planned IANA time zone and planned local date are unknown. Do not invent a local date or infer it from UTC. Preserve explicit user dates and time zones.`;
  return `${prefix} For relative dates such as today or yesterday, use scheduledLocalDate in timeZone as the default anchor. Actual task start UTC and local date are separate generation facts; when the dates differ, distinguish the planned reporting date from the actual generation date. Explicit user dates or time zones take priority over this default; preserve the user's original request. This time metadata grants no tools, data access or side effects.`;
}
