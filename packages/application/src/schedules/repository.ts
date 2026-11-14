import {
  scheduleSchema,
  schedulePointSchema,
  scheduleOccurrenceSchema,
  type ScheduleRule,
} from '../../../contracts/src/schedules.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { DomainError } from '../errors.js';
import type { QueryResultRow } from 'pg';
export interface ScheduleRow extends QueryResultRow {
  id: string;
  project_id: string;
  plan_id: string;
  current_revision_id: string;
  created_by: string;
  copied_from_schedule_id: string | null;
  row_version: number;
  status: 'active' | 'paused' | 'completed';
  pause_reason: string | null;
  next_point: unknown | null;
  created_at: Date;
  updated_at: Date;
  plan_revision_id: string;
  environment_id: string;
  plan_name: string;
  revision_no: number;
  rule: ScheduleRule;
}
export const scheduleSelect = `SELECT s.*,r.plan_revision_id,r.environment_id,r.plan_name,r.revision_no,r.rule FROM app.api_schedules s JOIN app.schedule_revisions r ON r.id=s.current_revision_id`;
export async function scheduleRow(
  transaction: SqlExecutor,
  projectId: string,
  id: string,
  lock = false,
) {
  // Lock the logical row before joining its mutable revision pointer. A lock wait inside the join can
  // otherwise recheck the new pointer against the old statement snapshot and return a false 404.
  if (lock) {
    const found = await transaction.query(
      'SELECT id FROM app.api_schedules WHERE project_id=$1 AND id=$2 FOR UPDATE',
      [projectId, id],
    );
    if (!found.rowCount)
      throw new DomainError('NOT_FOUND', '此项目没有该定时计划。', 404);
  }
  const row = (
    await transaction.query<ScheduleRow>(
      `${scheduleSelect} WHERE s.project_id=$1 AND s.id=$2`,
      [projectId, id],
    )
  ).rows[0];
  if (!row) throw new DomainError('NOT_FOUND', '此项目没有该定时计划。', 404);
  return row;
}
export function scheduleDto(row: ScheduleRow) {
  return scheduleSchema.parse({
    id: row.id,
    projectId: row.project_id,
    planId: row.plan_id,
    planRevisionId: row.plan_revision_id,
    environmentId: row.environment_id,
    planName: row.plan_name,
    createdBy: row.created_by,
    copiedFromScheduleId: row.copied_from_schedule_id,
    revisionId: row.current_revision_id,
    revisionNo: row.revision_no,
    rowVersion: row.row_version,
    status: row.status,
    pauseReason: row.pause_reason,
    rule: row.rule,
    nextPoint:
      row.next_point === null
        ? null
        : schedulePointSchema.parse(row.next_point),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}
export async function creatorAvailable(
  transaction: SqlExecutor,
  userId: string,
  projectId: string,
) {
  const actor: ActorContext = {
    userId,
    entrypoint: 'worker',
    requestId: 'schedule-current-creator',
  };
  try {
    await requireProject(transaction, actor, projectId, 'runs.organize');
    return true;
  } catch (error: unknown) {
    if (error instanceof DomainError && [401, 403].includes(error.status))
      return false;
    throw error;
  }
}
export const revocationPredicate = `((e.action='identity.account-updated' AND e.payload->>'active'='false') OR e.action='project.member-removed'
  OR (e.action='project.member-updated' AND NOT coalesce(e.payload->'roles'?'tester',false)))`;
export async function hasCreatorRevocation(
  transaction: SqlExecutor,
  scheduleId: string,
) {
  return Boolean(
    (
      await transaction.query(
        `SELECT 1 FROM app.api_schedules s JOIN app.audit_events e ON e.object_id=s.created_by
    WHERE s.id=$1 AND e.created_at>=s.created_at AND (e.project_id=s.project_id OR e.action='identity.account-updated') AND ${revocationPredicate} LIMIT 1`,
        [scheduleId],
      )
    ).rowCount,
  );
}
export function occurrenceDto(row: QueryResultRow) {
  return scheduleOccurrenceSchema.parse({
    id: row.id,
    sequence: row.sequence,
    scheduleId: row.schedule_id,
    revisionId: row.schedule_revision_id,
    point: row.point,
    state: row.state,
    reasonCode: row.reason_code,
    details: row.details,
    epochId: row.epoch_id,
    requestId: row.request_id,
    runId: row.run_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}
export async function occurrenceEvent(
  transaction: SqlExecutor,
  id: string,
  state: string,
  reason: string,
  details: unknown = {},
) {
  await transaction.query(
    'INSERT INTO app.schedule_occurrence_events(occurrence_id,state,reason_code,details) VALUES($1,$2,$3,$4)',
    [id, state, reason, JSON.stringify(details)],
  );
}
