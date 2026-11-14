import { Temporal } from '@js-temporal/polyfill';
import {
  schedulePointSchema,
  scheduleRuleSchema,
  type SchedulePoint,
  type ScheduleRule,
} from '../../../contracts/src/schedules.js';
import { DomainError } from '../errors.js';

export const timeZoneRulesVersion = process.versions.tz ?? 'unknown';
export function validateRule(raw: unknown): ScheduleRule {
  const rule = scheduleRuleSchema.parse(raw);
  try {
    if (!/^(?:UTC|[A-Za-z_+-]+(?:\/[A-Za-z0-9_+.-]+)+)$/.test(rule.timeZone))
      throw new Error();
    Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(rule.timeZone);
    Temporal.PlainDate.from(rule.date);
    Temporal.PlainTime.from(rule.time);
  } catch {
    throw new DomainError(
      'VALIDATION_ERROR',
      '请提供有效的日期、时间和IANA时区（例如Asia/Shanghai）。',
      400,
    );
  }
  return rule;
}
export function resolveWall(
  rule: ScheduleRule,
  date = rule.date,
): SchedulePoint {
  const plain = Temporal.PlainDateTime.from(`${date}T${rule.time}`);
  const earlier = plain.toZonedDateTime(rule.timeZone, {
    disambiguation: 'earlier',
  });
  const later = plain.toZonedDateTime(rule.timeZone, {
    disambiguation: 'later',
  });
  const gap =
    !earlier.toPlainDateTime().equals(plain) ||
    !later.toPlainDateTime().equals(plain);
  const fold = !gap && earlier.epochNanoseconds !== later.epochNanoseconds;
  const transition = gap ? later.getTimeZoneTransition('previous') : null;
  const marker =
    gap && transition && transition.epochNanoseconds >= earlier.epochNanoseconds
      ? transition
      : later;
  return schedulePointSchema.parse({
    wallDate: date,
    wallTime: rule.time,
    timeZone: rule.timeZone,
    plannedAt: gap ? null : earlier.toInstant().toString(),
    decisionAt: gap
      ? marker.toInstant().toString()
      : earlier.toInstant().toString(),
    offset: gap ? null : earlier.offset,
    alternateOffset: fold ? later.offset : null,
    resolution: gap ? 'gap' : fold ? 'foldEarlier' : 'unique',
    foldChoice: fold ? 'earlier' : null,
    timeZoneRulesVersion,
  });
}
export function advancePoint(
  rule: ScheduleRule,
  point: SchedulePoint,
): SchedulePoint | null {
  if (rule.frequency === 'once') return null;
  return resolveWall(
    rule,
    Temporal.PlainDate.from(point.wallDate)
      .add({ days: rule.frequency === 'weekly' ? 7 : 1 })
      .toString(),
  );
}
export function futurePoints(
  raw: unknown,
  after: string,
  count = 5,
): SchedulePoint[] {
  const rule = validateRule(raw),
    instant = Temporal.Instant.from(after);
  let date = Temporal.PlainDate.from(rule.date);
  const around = instant
    .toZonedDateTimeISO(rule.timeZone)
    .toPlainDate()
    .subtract({ days: 1 });
  if (
    rule.frequency !== 'once' &&
    Temporal.PlainDate.compare(date, around) < 0
  ) {
    const days = date.until(around, { largestUnit: 'days' }).days;
    date = date.add({
      days: rule.frequency === 'weekly' ? Math.floor(days / 7) * 7 : days,
    });
  }
  const result: SchedulePoint[] = [];
  for (let index = 0; index < 10000 && result.length < count; index++) {
    const point = resolveWall(rule, date.toString());
    if (
      Temporal.Instant.compare(
        Temporal.Instant.from(point.decisionAt),
        instant,
      ) > 0
    )
      result.push(point);
    if (rule.frequency === 'once') break;
    date = date.add({ days: rule.frequency === 'weekly' ? 7 : 1 });
  }
  return result;
}
