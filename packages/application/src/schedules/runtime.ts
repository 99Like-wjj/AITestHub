import { randomUUID } from 'node:crypto';
import {
  schedulePointSchema,
  type SchedulePoint,
} from '../../../contracts/src/schedules.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import { DomainError } from '../errors.js';
import { maintenanceMode } from '../recovery/maintenance.js';
import { audit } from '../events.js';
import type { PlanService, ScheduledStartGuard } from '../plans/service.js';
import { advancePoint, validateRule } from './time.js';
import {
  creatorAvailable,
  occurrenceEvent,
  scheduleSelect,
  type ScheduleRow,
  revocationPredicate,
  hasCreatorRevocation,
} from './repository.js';

const processEpochId = randomUUID();
export interface ScheduleRuntimeOptions {
  epochId?: string;
  clock?: () => Date;
  dispatchWindowMs?: number;
  heartbeatMaxAgeMs?: number;
}
interface RuntimeRow {
  epoch_id: string;
  booted_at: Date;
  last_heartbeat_at: Date;
  watermark_at: Date;
  recovery_cutoff_at: Date;
}
export class ScheduleRuntime implements ScheduledStartGuard {
  readonly epochId: string;
  readonly instanceId = randomUUID();
  private initialized = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  constructor(
    readonly db: Database,
    readonly plans: PlanService,
    readonly options: ScheduleRuntimeOptions = {},
  ) {
    this.epochId = options.epochId ?? processEpochId;
  }
  private async now(transaction: SqlExecutor) {
    return (
      this.options.clock?.() ??
      (await transaction.query<{ now: Date }>('SELECT clock_timestamp() now'))
        .rows[0]!.now
    );
  }
  async beginEpoch() {
    const result = await this.db.transaction(async (transaction) => {
      await transaction.query('SELECT pg_advisory_xact_lock(415948019)');
      const now = await this.now(transaction),
        previous = (
          await transaction.query<RuntimeRow>(
            'SELECT * FROM app.schedule_runtime WHERE singleton FOR UPDATE',
          )
        ).rows[0];
      if (previous?.epoch_id !== this.epochId) {
        if (previous)
          await transaction.query(
            'UPDATE app.schedule_epochs SET ended_at=COALESCE(ended_at,$2) WHERE id=$1',
            [previous.epoch_id, now],
          );
        await transaction.query(
          'INSERT INTO app.schedule_epochs(id,started_at,instance_id) VALUES($1,$2,$3)',
          [this.epochId, now, this.instanceId],
        );
        await transaction.query(
          `INSERT INTO app.schedule_runtime(singleton,epoch_id,booted_at,last_heartbeat_at,watermark_at,recovery_cutoff_at) VALUES(true,$1,$2,$2,$2,$2)
          ON CONFLICT(singleton) DO UPDATE SET epoch_id=$1,booted_at=$2,last_heartbeat_at=$2,watermark_at=$2,recovery_cutoff_at=$2`,
          [this.epochId, now],
        );
      } else
        await transaction.query(
          'UPDATE app.schedule_runtime SET last_heartbeat_at=$2,recovery_cutoff_at=CASE WHEN $3 THEN $2 ELSE recovery_cutoff_at END WHERE epoch_id=$1',
          [
            this.epochId,
            now,
            now.getTime() - previous.last_heartbeat_at.getTime() >
              (this.options.heartbeatMaxAgeMs ?? 10000),
          ],
        );
      await this.expireOldQueued(transaction);
      return {
        epochId: this.epochId,
        bootedAt: (previous?.epoch_id === this.epochId
          ? previous.booted_at
          : now
        ).toISOString(),
      };
    });
    this.initialized = true;
    return result;
  }
  private async expireOldQueued(transaction: SqlExecutor) {
    const cutoff = (
      await transaction.query<{ recovery_cutoff_at: Date }>(
        'SELECT recovery_cutoff_at FROM app.schedule_runtime WHERE singleton',
      )
    ).rows[0]!.recovery_cutoff_at;
    const rows = await transaction.query<{ request_id: string; id: string }>(
      `SELECT q.id request_id,o.id FROM app.api_execution_requests q JOIN app.schedule_occurrences o ON o.request_id=q.id
      WHERE q.source='scheduled' AND q.state='queued' AND (o.epoch_id<>$1 OR o.decision_at<=$2) FOR UPDATE OF q SKIP LOCKED`,
      [this.epochId, cutoff],
    );
    for (const row of rows.rows) {
      await transaction.query(
        "UPDATE app.api_execution_requests SET state='notExecuted',reason_code='MISSED_OFFLINE' WHERE id=$1",
        [row.request_id],
      );
      await transaction.query(
        "UPDATE app.schedule_occurrences SET state='missedOffline',reason_code='EPOCH_CHANGED_BEFORE_START',updated_at=clock_timestamp() WHERE id=$1",
        [row.id],
      );
      await occurrenceEvent(
        transaction,
        row.id,
        'missedOffline',
        'EPOCH_CHANGED_BEFORE_START',
        { automaticReplay: false },
      );
    }
    const prepared = await transaction.query<{ run_id: string }>(
      `SELECT r.id run_id FROM app.runs r JOIN app.api_execution_requests q ON q.run_id=r.id JOIN app.schedule_occurrences o ON o.request_id=q.id
      WHERE r.source='scheduled' AND r.state='prepared' AND (o.epoch_id<>$1 OR o.decision_at<=$2) AND NOT EXISTS(SELECT 1 FROM app.api_worker_grants g WHERE g.run_id=r.id)
      FOR UPDATE OF r SKIP LOCKED`,
      [this.epochId, cutoff],
    );
    for (const row of prepared.rows)
      await this.plans.rejectUnclaimedScheduledInTransaction(
        transaction,
        row.run_id,
        new DomainError(
          'PRECONDITIONS_MISSING',
          '旧定时意图尚未交给worker，新epoch不补跑。',
          422,
          { scheduleReason: 'MISSED_OFFLINE' },
        ),
      );
  }
  private async runtime(transaction: SqlExecutor, lock = false) {
    const row = (
      await transaction.query<RuntimeRow>(
        `SELECT * FROM app.schedule_runtime WHERE singleton${lock ? ' FOR SHARE' : ''}`,
      )
    ).rows[0];
    if (!this.initialized || !row || row.epoch_id !== this.epochId)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '定时控制面未就绪或已被新启动epoch替代，不补跑旧意图。',
        422,
        { scheduleReason: 'MISSED_OFFLINE' },
      );
    return row;
  }
  async beforeStartInTransaction(transaction: SqlExecutor, requestId: string) {
    const runtime = await this.runtime(transaction, true),
      now = await this.now(transaction);
    const occurrence = (
      await transaction.query<{
        id: string;
        schedule_id: string;
        epoch_id: string;
        state: string;
        created_by: string;
        project_id: string;
        pause_reason: string | null;
        decision_at: Date;
      }>(
        `SELECT o.id,o.schedule_id,o.epoch_id,o.state,o.decision_at,s.created_by,s.project_id,s.pause_reason FROM app.schedule_occurrences o
      JOIN app.api_schedules s ON s.id=o.schedule_id WHERE o.request_id=$1 FOR SHARE OF o,s`,
        [requestId],
      )
    ).rows[0];
    if (
      !occurrence ||
      occurrence.epoch_id !== runtime.epoch_id ||
      occurrence.decision_at.getTime() <=
        runtime.recovery_cutoff_at.getTime() ||
      !['queued', 'started'].includes(occurrence.state) ||
      now.getTime() - runtime.last_heartbeat_at.getTime() >
        (this.options.heartbeatMaxAgeMs ?? 10000)
    )
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '定时意图已过在线epoch或尚未登记，不自动重放。',
        422,
        { scheduleReason: 'MISSED_OFFLINE' },
      );
    if (
      occurrence.pause_reason === 'creatorUnavailable' ||
      (await hasCreatorRevocation(transaction, occurrence.schedule_id)) ||
      !(await creatorAvailable(
        transaction,
        occurrence.created_by,
        occurrence.project_id,
      ))
    )
      throw new DomainError(
        'FORBIDDEN',
        '原创建人当前无测试资格，后续定时保持暂停；请明确复制为本人新计划。',
        403,
        { scheduleReason: 'CREATOR_UNAVAILABLE' },
      );
  }
  async startedInTransaction(
    transaction: SqlExecutor,
    requestId: string,
    runId: string,
  ) {
    const row = (
      await transaction.query<{ id: string }>(
        "UPDATE app.schedule_occurrences SET state='started',reason_code='SNAPSHOT_FIXED',run_id=$2,updated_at=clock_timestamp() WHERE request_id=$1 RETURNING id",
        [requestId, runId],
      )
    ).rows[0];
    if (!row)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '定时来源时点不存在，不能伪造启动。',
        422,
      );
    await occurrenceEvent(transaction, row.id, 'started', 'SNAPSHOT_FIXED', {
      runId,
    });
  }
  async rejectedInTransaction(
    transaction: SqlExecutor,
    requestId: string,
    error: DomainError,
  ) {
    const row = (
      await transaction.query<{
        id: string;
        schedule_id: string;
        created_by: string;
        project_id: string;
      }>(
        `SELECT o.id,o.schedule_id,s.created_by,s.project_id FROM app.schedule_occurrences o JOIN app.api_schedules s ON s.id=o.schedule_id WHERE o.request_id=$1 FOR UPDATE OF o`,
        [requestId],
      )
    ).rows[0];
    if (!row) return;
    const creatorLost =
      [401, 403].includes(error.status) ||
      error.details?.scheduleReason === 'CREATOR_UNAVAILABLE' ||
      !(await creatorAvailable(transaction, row.created_by, row.project_id));
    const state = creatorLost
      ? 'creatorUnavailable'
      : error.details?.scheduleReason === 'MISSED_OFFLINE'
        ? 'missedOffline'
        : 'preconditionsMissing';
    await transaction.query(
      'UPDATE app.schedule_occurrences SET state=$2,reason_code=$3,details=$4,updated_at=clock_timestamp() WHERE id=$1',
      [
        row.id,
        state,
        String(error.details?.scheduleReason ?? error.code),
        JSON.stringify({ message: error.message, automaticReplay: false }),
      ],
    );
    if (creatorLost)
      await this.pauseCreator(
        transaction,
        row.schedule_id,
        row.created_by,
        row.project_id,
      );
    await occurrenceEvent(
      transaction,
      row.id,
      state,
      String(error.details?.scheduleReason ?? error.code),
    );
  }
  private async pauseCreator(
    transaction: SqlExecutor,
    id: string,
    userId: string,
    projectId: string,
  ) {
    const changed = await transaction.query(
      "UPDATE app.api_schedules SET status='paused',pause_reason='creatorUnavailable',row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1 AND (status<>'paused' OR pause_reason IS DISTINCT FROM 'creatorUnavailable')",
      [id],
    );
    if (changed.rowCount)
      await audit(
        transaction,
        { userId, entrypoint: 'worker', requestId: this.epochId },
        'schedules.creator-unavailable',
        id,
        projectId,
        { requiresExplicitCopy: true },
      );
  }
  private async reconcilePermissionEvents(transaction: SqlExecutor) {
    const events = await transaction.query<{
      id: string;
      object_id: string;
      project_id: string | null;
      action: string;
      created_at: Date;
    }>(`SELECT e.id,e.object_id,e.project_id,e.action,e.created_at FROM app.audit_events e
      WHERE ${revocationPredicate} AND NOT EXISTS(SELECT 1 FROM app.schedule_permission_events p WHERE p.event_id=e.id)
      ORDER BY e.seq LIMIT 500 FOR UPDATE OF e SKIP LOCKED`);
    for (const event of events.rows) {
      const rows = await transaction.query<{
        id: string;
        created_by: string;
        project_id: string;
      }>(
        `SELECT id,created_by,project_id FROM app.api_schedules WHERE created_by=$1 AND created_at<=$2
        AND ($3::uuid IS NULL OR project_id=$3) AND pause_reason IS DISTINCT FROM 'creatorUnavailable' FOR UPDATE`,
        [
          event.object_id,
          event.created_at,
          event.action === 'identity.account-updated' ? null : event.project_id,
        ],
      );
      for (const schedule of rows.rows)
        await this.pauseCreator(
          transaction,
          schedule.id,
          schedule.created_by,
          schedule.project_id,
        );
      await transaction.query(
        'INSERT INTO app.schedule_permission_events(event_id) VALUES($1) ON CONFLICT DO NOTHING',
        [event.id],
      );
    }
  }
  private async recordPoint(
    transaction: SqlExecutor,
    schedule: ScheduleRow,
    point: SchedulePoint,
    state: string,
    reason: string,
    details: unknown = {},
    requestId: string | null = null,
  ) {
    const id = randomUUID();
    const inserted = await transaction.query<{ id: string }>(
      `INSERT INTO app.schedule_occurrences(id,project_id,schedule_id,schedule_revision_id,wall_date,wall_time,time_zone,point,planned_at,decision_at,state,reason_code,details,epoch_id,request_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(schedule_id,wall_date,wall_time) DO NOTHING RETURNING id`,
      [
        id,
        schedule.project_id,
        schedule.id,
        schedule.current_revision_id,
        point.wallDate,
        point.wallTime,
        point.timeZone,
        JSON.stringify(point),
        point.plannedAt,
        point.decisionAt,
        state,
        reason,
        JSON.stringify(details),
        this.epochId,
        requestId,
      ],
    );
    if (inserted.rowCount)
      await occurrenceEvent(transaction, id, state, reason, details);
    return inserted.rows[0]?.id ?? null;
  }
  private async settleCompleted(transaction: SqlExecutor) {
    const completed = await transaction.query<{
      id: string;
      schedule_id: string;
      project_id: string;
      created_by: string;
      plan_id: string;
      run_id: string;
      run_state: string;
    }>(`SELECT o.id,o.schedule_id,s.project_id,s.created_by,s.plan_id,o.run_id,r.state run_state FROM app.schedule_occurrences o JOIN app.api_schedules s ON s.id=o.schedule_id JOIN app.runs r ON r.id=o.run_id
      WHERE o.state='started' AND o.completion_processed_at IS NULL AND r.state IN ('completed','terminated','interrupted') AND r.ended_at IS NOT NULL FOR UPDATE OF o SKIP LOCKED`);
    for (const row of completed.rows) {
      const eligible = await creatorAvailable(
        transaction,
        row.created_by,
        row.project_id,
      );
      const actual = (
        await transaction.query(
          'SELECT 1 FROM app.api_case_facts WHERE run_id=$1 LIMIT 1',
          [row.run_id],
        )
      ).rowCount;
      await transaction.query(
        "UPDATE app.schedule_occurrences SET state='completed',reason_code=$2,completion_processed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1",
        [
          row.id,
          eligible ? 'RUN_FINISHED' : 'CREATOR_UNAVAILABLE_AT_COMPLETION',
        ],
      );
      await occurrenceEvent(transaction, row.id, 'completed', 'RUN_FINISHED', {
        runState: row.run_state,
        notification:
          eligible && Boolean(actual) ? 'originalCreator' : 'suppressed',
      });
      if (!eligible)
        await this.pauseCreator(
          transaction,
          row.schedule_id,
          row.created_by,
          row.project_id,
        );
      if (eligible && actual)
        await audit(
          transaction,
          {
            userId: row.created_by,
            entrypoint: 'worker',
            requestId: this.epochId,
          },
          'schedule.run.completed',
          row.schedule_id,
          row.project_id,
          {
            recipientUserId: row.created_by,
            projectId: row.project_id,
            scheduleId: row.schedule_id,
            planId: row.plan_id,
            runId: row.run_id,
            state: row.run_state,
          },
        );
    }
  }
  async tick() {
    return this.db.transaction(async (transaction) => {
      const maintenance = await maintenanceMode(transaction, true);
      if (maintenance.phase !== 'idle')
        return { fenced: false, processed: 0, maintenance: true };
      const lease = (
        await transaction.query<{ acquired: boolean }>(
          'SELECT pg_try_advisory_xact_lock(415948019) acquired',
        )
      ).rows[0];
      if (!lease?.acquired) return { fenced: false, processed: 0, busy: true };
      let runtime: RuntimeRow;
      try {
        runtime = await this.runtime(transaction, true);
      } catch (error: unknown) {
        if (error instanceof DomainError) return { fenced: true, processed: 0 };
        throw error;
      }
      const now = await this.now(transaction);
      if (
        now.getTime() - runtime.last_heartbeat_at.getTime() >
        (this.options.heartbeatMaxAgeMs ?? 10000)
      ) {
        runtime.recovery_cutoff_at = now;
        await transaction.query(
          'UPDATE app.schedule_runtime SET recovery_cutoff_at=$2 WHERE epoch_id=$1',
          [this.epochId, now],
        );
      }
      await transaction.query(
        'UPDATE app.schedule_runtime SET last_heartbeat_at=$2,watermark_at=$2 WHERE epoch_id=$1',
        [this.epochId, now],
      );
      await this.expireOldQueued(transaction);
      await this.reconcilePermissionEvents(transaction);
      const due = await transaction.query<ScheduleRow>(
        `${scheduleSelect} WHERE s.status='active' AND s.next_point IS NOT NULL AND (s.next_point->>'decisionAt')::timestamptz<=$1 ORDER BY (s.next_point->>'decisionAt')::timestamptz,s.id LIMIT 100 FOR UPDATE OF s SKIP LOCKED`,
        [now],
      );
      let processed = 0;
      let inspected = 0;
      for (const schedule of due.rows) {
        if (inspected >= 100) break;
        let next: SchedulePoint | null = schedulePointSchema.parse(
          schedule.next_point,
        );
        let creatorPaused = false;
        while (
          next &&
          Date.parse(next.decisionAt) <= now.getTime() &&
          inspected < 100
        ) {
          const point = next;
          inspected++;
          const already = (
            await transaction.query(
              'SELECT 1 FROM app.schedule_occurrences WHERE schedule_id=$1 AND wall_date=$2 AND wall_time=$3',
              [schedule.id, point.wallDate, point.wallTime],
            )
          ).rowCount;
          if (!already) {
            if (point.resolution === 'gap')
              await this.recordPoint(
                transaction,
                schedule,
                point,
                'dstNonexistent',
                'LOCAL_TIME_DOES_NOT_EXIST',
              );
            else if (
              Date.parse(point.decisionAt) <= runtime.booted_at.getTime() ||
              Date.parse(point.decisionAt) <=
                runtime.recovery_cutoff_at.getTime() ||
              now.getTime() - Date.parse(point.decisionAt) >
                (this.options.dispatchWindowMs ?? 5000)
            )
              await this.recordPoint(
                transaction,
                schedule,
                point,
                'missedOffline',
                'NOT_ACCEPTED_IN_LIVE_WINDOW',
                { automaticReplay: false },
              );
            else if (
              !(await creatorAvailable(
                transaction,
                schedule.created_by,
                schedule.project_id,
              ))
            ) {
              await this.recordPoint(
                transaction,
                schedule,
                point,
                'creatorUnavailable',
                'CREATOR_UNAVAILABLE',
              );
              await this.pauseCreator(
                transaction,
                schedule.id,
                schedule.created_by,
                schedule.project_id,
              );
              creatorPaused = true;
            } else {
              const requestId = randomUUID(),
                actor: ActorContext = {
                  userId: schedule.created_by,
                  entrypoint: 'worker',
                  requestId: requestId,
                };
              const queued = await this.plans.queueScheduledInTransaction(
                transaction,
                actor,
                schedule.project_id,
                schedule.plan_id,
                schedule.plan_revision_id,
                requestId,
              );
              if (queued.accepted)
                await this.recordPoint(
                  transaction,
                  schedule,
                  point,
                  'queued',
                  'ACCEPTED_WAITING_CAPACITY',
                  {},
                  requestId,
                );
              else
                await this.recordPoint(
                  transaction,
                  schedule,
                  point,
                  queued.reason,
                  queued.reason === 'overlapSkipped'
                    ? 'SAME_PLAN_IN_FLIGHT'
                    : 'START_PRECONDITIONS_MISSING',
                  queued.details,
                );
            }
            processed++;
          }
          next = advancePoint(validateRule(schedule.rule), point);
          if (creatorPaused) break;
        }
        await transaction.query(
          "UPDATE app.api_schedules SET next_point=$2,status=CASE WHEN $2::jsonb IS NULL AND status='active' THEN 'completed' ELSE status END,updated_at=clock_timestamp() WHERE id=$1",
          [schedule.id, next ? JSON.stringify(next) : null],
        );
      }
      const invalid = await transaction.query<ScheduleRow>(
        `${scheduleSelect} WHERE s.pause_reason IS DISTINCT FROM 'creatorUnavailable' AND (s.status<>'active' OR s.next_point IS NULL OR (s.next_point->>'decisionAt')::timestamptz>$1) AND NOT EXISTS(
        SELECT 1 FROM app.users u JOIN app.project_members m ON m.user_id=u.id JOIN app.projects p ON p.id=m.project_id
        WHERE u.id=s.created_by AND u.active AND m.project_id=s.project_id AND m.active AND p.active AND 'tester'=ANY(m.roles)) LIMIT 100 FOR UPDATE OF s SKIP LOCKED`,
        [now],
      );
      for (const schedule of invalid.rows)
        await this.pauseCreator(
          transaction,
          schedule.id,
          schedule.created_by,
          schedule.project_id,
        );
      await this.settleCompleted(transaction);
      return { fenced: false, processed };
    });
  }
  async start(intervalMs = 1000) {
    if (this.timer) return;
    await this.beginEpoch();
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      void this.tick()
        .catch(() => process.stderr.write('SCHEDULE_TICK_FAILED\n'))
        .finally(() => {
          this.busy = false;
        });
    }, intervalMs);
    this.timer.unref();
  }
  async stop() {
    if (!this.initialized && !this.timer && !this.busy) return;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    while (this.busy) await new Promise<void>((done) => setTimeout(done, 20));
    this.initialized = false;
    await this.db.transaction(async (transaction) => {
      const now = await this.now(transaction);
      await transaction.query(
        'UPDATE app.schedule_runtime SET last_heartbeat_at=$2 WHERE epoch_id=$1',
        [
          this.epochId,
          new Date(
            now.getTime() - (this.options.heartbeatMaxAgeMs ?? 10000) - 1,
          ),
        ],
      );
    });
  }
}
