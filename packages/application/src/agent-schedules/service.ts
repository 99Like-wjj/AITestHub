import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ActorContext } from '../../../contracts/src/identity.js';
import {
  agentScheduleCreateSchema,
  agentScheduleReviseSchema,
  agentScheduleStateChangeSchema,
  agentScheduleSchema,
  agentScheduleOccurrenceSchema,
  scheduledTaskTemplateSchema,
  type ScheduledTaskTemplate,
} from '../../../contracts/src/agent-schedules.js';
import { schedulePointSchema } from '../../../contracts/src/schedules.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { currentUser } from '../access/policy.js';
import { conversationRow, personalActor } from '../conversations/common.js';
import { DomainError, stale } from '../errors.js';
import { audit } from '../events.js';
import { OperationService } from '../operations/service.js';
import { advancePoint, futurePoints, validateRule } from '../schedules/time.js';
import { assertSafeModelInput } from '../security/model-input.js';
import { assertTaskCapability } from '../conversations/task-capabilities.js';

interface ScheduleManagementTask {
  taskId: string;
  conversationId: string;
}

export interface AgentSchedulePorts {
  validateDraft(
    actor: ActorContext,
    conversationId: string,
    template: ScheduledTaskTemplate,
  ): Promise<void>;
  enqueue(
    occurrenceId: string,
    claimToken: string,
  ): Promise<{ taskId: string }>;
  lookup(
    occurrenceId: string,
  ): Promise<{ taskId: string; state: string } | null>;
  cancelTask(occurrenceId: string): Promise<void>;
  now?: () => Date;
}
export interface AgentScheduleSnapshot {
  title: string;
  message: string;
  kind: 'reminder' | 'draft' | 'office';
  template: ScheduledTaskTemplate | null;
}
interface ScheduleRow {
  id: string;
  owner_id: string;
  conversation_id: string | null;
  title: string;
  kind: 'reminder' | 'draft' | 'office';
  message: string;
  rule: unknown;
  template: unknown;
  state: string;
  next_point: unknown;
  next_decision_at: Date | null;
  row_version: number;
  created_at: Date;
  updated_at: Date;
}
interface OccurrenceRow {
  id: string;
  schedule_id: string;
  owner_id: string;
  conversation_id: string | null;
  schedule_revision: number;
  point: unknown;
  snapshot: unknown;
  state: string;
  claim_token: string;
  lease_expires_at: Date;
  task_id: string | null;
  error_code: string | null;
  missed_through_at: Date | null;
  created_at: Date;
  finished_at: Date | null;
}
const terminalTasks = new Set([
  'completed',
  'failed',
  'cancelled',
  'unknown',
  'interrupted',
]);
const snapshotSchema = z.strictObject({
  title: z.string(),
  message: z.string(),
  kind: z.enum(['reminder', 'draft', 'office']),
  template: scheduledTaskTemplateSchema.nullable(),
});
export function scheduledActor(
  ownerId: string,
  occurrenceId: string,
): ActorContext {
  return {
    userId: ownerId,
    entrypoint: 'internal-ai',
    requestId: occurrenceId,
  };
}
export class AgentScheduleService {
  readonly operations: OperationService;
  constructor(
    readonly db: Database,
    readonly ports: AgentSchedulePorts,
  ) {
    this.operations = new OperationService(db);
  }
  now() {
    const time = this.ports.now?.() ?? new Date();
    if (!Number.isFinite(time.getTime())) throw Error('INVALID_SCHEDULE_CLOCK');
    return time;
  }
  private async personal(tx: SqlExecutor, actor: ActorContext) {
    await personalActor(tx, actor, true);
  }
  private async management(
    tx: SqlExecutor,
    actor: ActorContext,
    task?: ScheduleManagementTask,
  ) {
    await this.personal(tx, actor);
    if (actor.entrypoint !== 'internal-ai') return;
    if (!task)
      throw new DomainError('FORBIDDEN', '计划管理须关联原交互任务。', 403);
    await assertTaskCapability(tx, actor, task, 'scheduleManage', {
      active: true,
    });
  }
  private async owned(
    tx: SqlExecutor,
    actor: ActorContext,
    id: string,
    lock = false,
    nextConversationId?: string | null,
  ): Promise<ScheduleRow> {
    await this.personal(tx, actor);
    const locator = (
      await tx.query<ScheduleRow>(
        'SELECT * FROM app.agent_schedules WHERE id=$1 AND owner_id=$2',
        [z.uuid().parse(id), actor.userId],
      )
    ).rows[0];
    if (!locator)
      throw new DomainError('NOT_FOUND', '本人定时任务不存在。', 404);
    if (!lock) return locator;
    // Privacy deletion locks the conversation before its derived schedules.
    // Lock both old and replacement parents in stable order before the schedule.
    const parents = [...new Set([locator.conversation_id, nextConversationId])]
      .filter((value): value is string => typeof value === 'string')
      .sort();
    if (parents.length)
      await tx.query(
        'SELECT id FROM app.ai_conversations WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE',
        [actor.userId, parents],
      );
    if (nextConversationId)
      await conversationRow(tx, actor, nextConversationId, false, true);
    const row = (
      await tx.query<ScheduleRow>(
        'SELECT * FROM app.agent_schedules WHERE id=$1 AND owner_id=$2 FOR UPDATE',
        [id, actor.userId],
      )
    ).rows[0];
    if (
      !row ||
      row.conversation_id !== locator.conversation_id ||
      row.row_version !== locator.row_version
    )
      stale();
    return row;
  }
  private async view(tx: SqlExecutor, actor: ActorContext, row: ScheduleRow) {
    let readable = true;
    if (row.conversation_id)
      try {
        await conversationRow(tx, actor, row.conversation_id, false, true);
      } catch (error: unknown) {
        if (
          !(error instanceof DomainError) ||
          !['FORBIDDEN', 'NOT_FOUND', 'UNAUTHENTICATED'].includes(error.code)
        )
          throw error;
        readable = false;
      }
    return agentScheduleSchema.parse({
      id: row.id,
      title: readable ? row.title : '[当前会话不可访问]',
      kind: row.kind,
      conversationId: row.conversation_id,
      rule: row.rule,
      message: readable ? row.message : '',
      template: readable ? row.template : null,
      state: row.state,
      rowVersion: row.row_version,
      nextPoint: row.next_point,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      taskPolicy: row.kind === 'office' ? 'officeOnly' : 'draftOnly',
      missedPointsWillNotRun: true,
    });
  }
  async preview(actor: ActorContext, raw: unknown) {
    await this.db.transaction((tx) => this.personal(tx, actor));
    const rule = validateRule(raw);
    return {
      points: futurePoints(rule, this.now().toISOString(), 5),
      pastPointsWillNotRun: true as const,
      lateToleranceSeconds: 60 as const,
    };
  }
  async list(actor: ActorContext) {
    return this.db.transaction(async (tx) => {
      await this.personal(tx, actor);
      const rows = await tx.query<ScheduleRow>(
        'SELECT * FROM app.agent_schedules WHERE owner_id=$1 ORDER BY created_at DESC,id LIMIT 200',
        [actor.userId],
      );
      const schedules = [];
      for (const row of rows.rows)
        schedules.push(await this.view(tx, actor, row));
      return { schedules };
    });
  }
  async detail(actor: ActorContext, id: string) {
    return this.db.transaction(async (tx) => {
      const row = await this.owned(tx, actor, id);
      const history = (
        await tx.query<OccurrenceRow>(
          'SELECT * FROM app.agent_schedule_occurrences WHERE schedule_id=$1 AND owner_id=$2 ORDER BY created_at DESC,id LIMIT 100',
          [id, actor.userId],
        )
      ).rows;
      return {
        schedule: await this.view(tx, actor, row),
        occurrences: history.map((item) =>
          agentScheduleOccurrenceSchema.parse({
            id: item.id,
            scheduleId: item.schedule_id,
            scheduleRevision: item.schedule_revision,
            point: item.point,
            state: item.state,
            taskId: item.task_id,
            errorCode: item.error_code,
            createdAt: item.created_at.toISOString(),
            finishedAt: item.finished_at?.toISOString() ?? null,
            missedThrough: item.missed_through_at?.toISOString() ?? null,
            automaticReplay: false,
          }),
        ),
      };
    });
  }
  async commandReceipt(
    actor: ActorContext,
    operation: 'create' | 'revise' | 'pause' | 'resume' | 'cancel',
    key: string,
  ) {
    await this.db.transaction((tx) => this.personal(tx, actor));
    const result = await this.operations.get(actor, {
      operation: `agent-schedules.${operation}`,
      key,
    });
    const response = z
      .object({ schedule: z.object({ id: z.uuid() }) })
      .parse(result.command.response);
    const current = await this.detail(actor, response.schedule.id);
    return { schedule: current.schedule };
  }
  private async validate(
    actor: ActorContext,
    input: z.infer<typeof agentScheduleCreateSchema>,
  ) {
    validateRule(input.rule);
    assertSafeModelInput({ title: input.title, message: input.message });
    await this.db.transaction(async (tx) => {
      await this.personal(tx, actor);
      if (input.conversationId)
        await conversationRow(tx, actor, input.conversationId, false, true);
    });
    if (input.kind !== 'reminder' && input.template && input.conversationId) {
      assertSafeModelInput(input.template.content);
      await this.ports.validateDraft(
        actor,
        input.conversationId,
        input.template,
      );
    }
    const next = futurePoints(input.rule, this.now().toISOString(), 1)[0];
    return next;
  }
  async create(
    actor: ActorContext,
    raw: unknown,
    task?: ScheduleManagementTask,
  ) {
    await this.db.transaction((tx) => this.management(tx, actor, task));
    const input = agentScheduleCreateSchema.parse(raw),
      next = await this.validate(actor, input);
    return this.operations.execute(
      actor,
      'agent-schedules.create',
      input.commandId,
      input,
      (tx) => this.management(tx, actor, task),
      async (tx) => {
        await this.management(tx, actor, task);
        if (!next)
          throw new DomainError(
            'VALIDATION_ERROR',
            '此时间已过去，请设置未来时间；不会补跑。',
            400,
          );
        if (input.conversationId)
          await conversationRow(tx, actor, input.conversationId, false, true);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `agent-schedule-limit:${actor.userId}`,
        ]);
        const count =
          (
            await tx.query<{ n: number }>(
              "SELECT count(*)::integer n FROM app.agent_schedules WHERE owner_id=$1 AND state IN ('active','paused')",
              [actor.userId],
            )
          ).rows[0]?.n ?? 0;
        if (count >= 100)
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '最多保留100个活动或暂停的定时任务，请先取消不需要的计划。',
            422,
          );
        const row = (
          await tx.query<ScheduleRow>(
            "INSERT INTO app.agent_schedules(id,owner_id,conversation_id,title,kind,message,rule,template,state,next_point,next_decision_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10) RETURNING *",
            [
              randomUUID(),
              actor.userId,
              input.conversationId,
              input.title,
              input.kind,
              input.message,
              JSON.stringify(input.rule),
              input.template ? JSON.stringify(input.template) : null,
              JSON.stringify(next),
              next.decisionAt,
            ],
          )
        ).rows[0];
        if (!row) throw Error('SCHEDULE_INSERT_FAILED');
        await audit(tx, actor, 'agent-schedule.created', row.id);
        return { schedule: await this.view(tx, actor, row) };
      },
    );
  }
  async revise(
    actor: ActorContext,
    id: string,
    raw: unknown,
    task?: ScheduleManagementTask,
  ) {
    await this.db.transaction((tx) => this.management(tx, actor, task));
    const input = agentScheduleReviseSchema.parse(raw),
      next = await this.validate(actor, input);
    return this.operations.execute(
      actor,
      'agent-schedules.revise',
      input.commandId,
      { id, input },
      async (tx) => {
        await this.management(tx, actor, task);
        await this.owned(tx, actor, id);
      },
      async (tx) => {
        await this.management(tx, actor, task);
        const row = await this.owned(tx, actor, id, true, input.conversationId);
        if (!next)
          throw new DomainError(
            'VALIDATION_ERROR',
            '此时间已过去，请设置未来时间；不会补跑。',
            400,
          );
        if (row.row_version !== input.rowVersion) stale();
        if (['cancelled', 'finished'].includes(row.state))
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '已结束的计划不能修改，请新建计划。',
            409,
          );
        await tx.query(
          "UPDATE app.agent_schedule_occurrences SET state='cancelled',error_code='SCHEDULE_REVISED',finished_at=$2 WHERE schedule_id=$1 AND state='claimed'",
          [id, this.now()],
        );
        const updated = (
          await tx.query<ScheduleRow>(
            'UPDATE app.agent_schedules SET conversation_id=$2,title=$3,kind=$4,message=$5,rule=$6,template=$7,next_point=$8,next_decision_at=$9,row_version=row_version+1,updated_at=$10 WHERE id=$1 RETURNING *',
            [
              id,
              input.conversationId,
              input.title,
              input.kind,
              input.message,
              JSON.stringify(input.rule),
              input.template ? JSON.stringify(input.template) : null,
              JSON.stringify(next),
              next.decisionAt,
              this.now(),
            ],
          )
        ).rows[0];
        if (!updated) throw Error('SCHEDULE_UPDATE_FAILED');
        await audit(tx, actor, 'agent-schedule.revised', id);
        return { schedule: await this.view(tx, actor, updated) };
      },
    );
  }
  async changeState(
    actor: ActorContext,
    id: string,
    action: 'pause' | 'resume' | 'cancel',
    raw: unknown,
    task?: ScheduleManagementTask,
  ) {
    await this.db.transaction((tx) => this.management(tx, actor, task));
    const input = agentScheduleStateChangeSchema.parse(raw);
    const result = await this.operations.execute(
      actor,
      `agent-schedules.${action}`,
      input.commandId,
      { id, input },
      async (tx) => {
        await this.management(tx, actor, task);
        await this.owned(tx, actor, id);
      },
      async (tx) => {
        await this.management(tx, actor, task);
        const row = await this.owned(tx, actor, id, true);
        if (row.row_version !== input.rowVersion) stale();
        if (
          action !== 'cancel' &&
          ['cancelled', 'finished'].includes(row.state)
        )
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '已结束的计划不能恢复。',
            409,
          );
        if (action === 'resume' && row.conversation_id)
          await conversationRow(tx, actor, row.conversation_id, false, true);
        const next =
          action === 'resume'
            ? (futurePoints(row.rule, this.now().toISOString(), 1)[0] ?? null)
            : row.next_point
              ? schedulePointSchema.parse(row.next_point)
              : null;
        const state =
          action === 'cancel'
            ? 'cancelled'
            : action === 'pause'
              ? 'paused'
              : next
                ? 'active'
                : 'finished';
        const updated = (
          await tx.query<ScheduleRow>(
            'UPDATE app.agent_schedules SET state=$2,next_point=$3,next_decision_at=$4,row_version=row_version+1,updated_at=$5 WHERE id=$1 RETURNING *',
            [
              id,
              state,
              action === 'cancel' ? null : JSON.stringify(next),
              action === 'resume'
                ? (next?.decisionAt ?? null)
                : row.next_decision_at,
              this.now(),
            ],
          )
        ).rows[0];
        if (!updated) throw Error('SCHEDULE_STATE_FAILED');
        if (action !== 'resume')
          await tx.query(
            "UPDATE app.agent_schedule_occurrences SET state='cancelled',error_code=$2,finished_at=$3 WHERE schedule_id=$1 AND state='claimed'",
            [
              id,
              action === 'cancel' ? 'SCHEDULE_CANCELLED' : 'SCHEDULE_PAUSED',
              this.now(),
            ],
          );
        await audit(tx, actor, `agent-schedule.${action}`, id);
        return { schedule: await this.view(tx, actor, updated) };
      },
    );
    if (action !== 'resume') {
      const active = (
        await this.db.query<{ id: string }>(
          "SELECT id FROM app.agent_schedule_occurrences WHERE schedule_id=$1 AND owner_id=$2 AND state IN ('dispatching','enqueued')",
          [id, actor.userId],
        )
      ).rows;
      for (const occurrence of active)
        try {
          await this.ports.cancelTask(occurrence.id);
        } catch {
          await this.db.query(
            "UPDATE app.agent_schedule_occurrences SET error_code='CANCEL_RESULT_UNKNOWN' WHERE id=$1",
            [occurrence.id],
          );
        }
    }
    return result;
  }
  private async notify(
    tx: SqlExecutor,
    row: OccurrenceRow,
    kind: 'agentReminder' | 'agentTaskReady',
    title: string,
  ) {
    if (
      !(
        await tx.query('SELECT 1 FROM app.users WHERE id=$1 AND active', [
          row.owner_id,
        ])
      ).rowCount
    )
      return;
    if (
      row.conversation_id &&
      !(
        await tx.query(
          'SELECT 1 FROM app.ai_conversations WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR SHARE',
          [row.conversation_id, row.owner_id],
        )
      ).rowCount
    )
      return;
    const eventId = row.id;
    await tx.query(
      'INSERT INTO app.outbox(id,actor_id,event_type,aggregate_id,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING',
      [
        eventId,
        row.owner_id,
        `agent-schedule.${kind}`,
        row.id,
        JSON.stringify({ occurrenceId: row.id, scheduleId: row.schedule_id }),
      ],
    );
    const path = row.conversation_id
      ? `/#workspace?conversationId=${row.conversation_id}`
      : '/#personal-settings?tab=agent-schedules';
    await tx.query(
      'INSERT INTO app.notifications(recipient_id,event_id,kind,object_id,title,target_path) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(recipient_id,event_id) DO NOTHING',
      [row.owner_id, eventId, kind, row.id, title, path],
    );
    await tx.query(
      'INSERT INTO app.notification_dispatches(event_id) VALUES($1) ON CONFLICT DO NOTHING',
      [eventId],
    );
  }
  /** Called by a trusted worker. Claim and lease are persistent; this never replays an old dispatch. */
  async claimDue(): Promise<OccurrenceRow | null> {
    const now = this.now();
    return this.db.transaction(async (tx) => {
      const locator = (
        await tx.query<ScheduleRow>(
          "SELECT * FROM app.agent_schedules WHERE state='active' AND next_decision_at<=$1 ORDER BY next_decision_at,id LIMIT 1",
          [now],
        )
      ).rows[0];
      if (!locator) return null;
      // Even a blocked owner must acquire the parent before schedule/FK writes.
      // This trusted locator read exposes no conversation content or authority.
      if (locator.conversation_id)
        await tx.query(
          'SELECT id FROM app.ai_conversations WHERE id=$1 AND owner_id=$2 FOR SHARE',
          [locator.conversation_id, locator.owner_id],
        );
      const actor = scheduledActor(locator.owner_id, randomUUID());
      let blocked = false;
      try {
        await currentUser(tx, actor);
        if (locator.conversation_id)
          await conversationRow(
            tx,
            actor,
            locator.conversation_id,
            false,
            true,
          );
      } catch (error: unknown) {
        if (!(error instanceof DomainError)) throw error;
        blocked = true;
      }
      const schedule = (
        await tx.query<ScheduleRow>(
          "SELECT * FROM app.agent_schedules WHERE id=$1 AND state='active' AND next_decision_at<=$2 AND owner_id=$3 AND conversation_id IS NOT DISTINCT FROM $4::uuid AND row_version=$5 AND next_point=$6::jsonb FOR UPDATE SKIP LOCKED",
          [
            locator.id,
            now,
            locator.owner_id,
            locator.conversation_id,
            locator.row_version,
            JSON.stringify(locator.next_point),
          ],
        )
      ).rows[0];
      if (!schedule) return null;
      const point = schedulePointSchema.parse(schedule.next_point),
        rule = validateRule(schedule.rule);
      const missed =
        now.getTime() - new Date(point.decisionAt).getTime() > 60_000;
      const gap = point.resolution === 'gap';
      const state = blocked
        ? 'blocked'
        : gap
          ? 'skipped'
          : missed
            ? 'missed'
            : 'claimed';
      const next = missed
        ? (futurePoints(rule, now.toISOString(), 1)[0] ?? null)
        : advancePoint(rule, point);
      const result = (
        await tx.query<OccurrenceRow>(
          'INSERT INTO app.agent_schedule_occurrences(id,schedule_id,owner_id,conversation_id,schedule_revision,point,wall_date,wall_time,snapshot,state,claim_token,lease_expires_at,error_code,missed_through_at,finished_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(schedule_id,schedule_revision,wall_date,wall_time) DO NOTHING RETURNING *',
          [
            randomUUID(),
            schedule.id,
            schedule.owner_id,
            schedule.conversation_id,
            schedule.row_version,
            JSON.stringify(point),
            point.wallDate,
            point.wallTime,
            JSON.stringify({
              title: schedule.title,
              message: schedule.message,
              kind: schedule.kind,
              template: schedule.template,
            }),
            state,
            randomUUID(),
            new Date(now.getTime() + 60_000),
            blocked
              ? 'OWNER_OR_SOURCE_UNAVAILABLE'
              : gap
                ? 'DST_GAP'
                : missed
                  ? 'MISSED_NO_CATCHUP'
                  : null,
            missed ? now : null,
            state === 'claimed' ? null : now,
          ],
        )
      ).rows[0];
      await tx.query(
        "UPDATE app.agent_schedules SET next_point=$2,next_decision_at=$3,state=CASE WHEN $2::jsonb IS NULL THEN 'finished' ELSE state END,updated_at=$4 WHERE id=$1",
        [
          schedule.id,
          next ? JSON.stringify(next) : null,
          next?.decisionAt ?? null,
          now,
        ],
      );
      return result ?? null;
    });
  }
  async dispatchClaim(id: string, claimToken: string) {
    const candidate = (
      await this.db.query<OccurrenceRow>(
        'SELECT * FROM app.agent_schedule_occurrences WHERE id=$1 AND claim_token=$2',
        [z.uuid().parse(id), z.uuid().parse(claimToken)],
      )
    ).rows[0];
    if (!candidate || candidate.state !== 'claimed') return false;
    try {
      const snapshot = snapshotSchema.parse(candidate.snapshot);
      if (snapshot.kind !== 'reminder') {
        if (!candidate.conversation_id || !snapshot.template)
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '定时任务模板不完整。',
            422,
          );
        await this.ports.validateDraft(
          scheduledActor(candidate.owner_id, id),
          candidate.conversation_id,
          snapshot.template,
        );
      }
      const ready = await this.db.transaction(async (tx) => {
        const checked = await authorizeScheduledOccurrence(tx, id, claimToken, [
          'claimed',
        ]);
        if (checked.snapshot.kind === 'reminder') {
          await this.notify(
            tx,
            checked.occurrence,
            'agentReminder',
            `${checked.snapshot.title}${checked.snapshot.message ? '：' + checked.snapshot.message : ''}`.slice(
              0,
              2200,
            ),
          );
          await tx.query(
            "UPDATE app.agent_schedule_occurrences SET state='completed',finished_at=$2 WHERE id=$1",
            [id, this.now()],
          );
          return false;
        }
        await tx.query(
          "UPDATE app.agent_schedule_occurrences SET state='dispatching',lease_expires_at=$2 WHERE id=$1",
          [id, new Date(this.now().getTime() + 60_000)],
        );
        return true;
      });
      if (!ready) return true;
      const sent = await this.ports.enqueue(id, claimToken);
      // The trusted enqueue port binds the original kind's policy and task_id atomically.
      const saved = (
        await this.db.query<{ task_id: string | null; state: string }>(
          'SELECT task_id,state FROM app.agent_schedule_occurrences WHERE id=$1',
          [id],
        )
      ).rows[0];
      if (saved?.task_id !== sent.taskId || saved.state !== 'enqueued')
        throw new DomainError(
          'OPERATION_RESULT_UNKNOWN',
          '排队原回执未完整绑定。',
          409,
        );
      return true;
    } catch (error: unknown) {
      const current = (
        await this.db.query<{ state: string }>(
          'SELECT state FROM app.agent_schedule_occurrences WHERE id=$1',
          [id],
        )
      ).rows[0];
      if (current?.state === 'claimed')
        await this.db.query(
          "UPDATE app.agent_schedule_occurrences SET state='blocked',error_code=$2,finished_at=$3 WHERE id=$1 AND state='claimed'",
          [
            id,
            error instanceof DomainError
              ? error.code
              : 'DEPENDENCY_UNAVAILABLE',
            this.now(),
          ],
        );
      else if (current?.state === 'dispatching')
        await this.db.query(
          "UPDATE app.agent_schedule_occurrences SET state='unknown',error_code='DISPATCH_RESULT_UNKNOWN' WHERE id=$1 AND state='dispatching'",
          [id],
        );
      return true;
    }
  }
  async reconcile(limit = 20) {
    const rows = (
      await this.db.query<OccurrenceRow>(
        "SELECT * FROM app.agent_schedule_occurrences WHERE state='enqueued' OR (state IN ('claimed','dispatching','unknown') AND finished_at IS NULL AND lease_expires_at<=$1) ORDER BY created_at,id LIMIT $2",
        [this.now(), Math.min(Math.max(limit, 1), 100)],
      )
    ).rows;
    for (const row of rows) {
      if (row.state === 'claimed') {
        await this.db.query(
          "UPDATE app.agent_schedule_occurrences SET state='missed',error_code='CLAIM_EXPIRED_NO_REPLAY',finished_at=$2 WHERE id=$1 AND state='claimed'",
          [row.id, this.now()],
        );
        continue;
      }
      let task: { taskId: string; state: string } | null;
      try {
        task = await this.ports.lookup(row.id);
      } catch {
        continue;
      }
      if (!task) {
        if (row.state !== 'enqueued')
          await this.db.query(
            "UPDATE app.agent_schedule_occurrences SET state='unknown',error_code='ORIGINAL_QUEUE_RECEIPT_UNAVAILABLE' WHERE id=$1 AND state IN ('dispatching','unknown')",
            [row.id],
          );
        continue;
      }
      if (!terminalTasks.has(task.state)) {
        await this.db.query(
          "UPDATE app.agent_schedule_occurrences SET task_id=$2,state='enqueued' WHERE id=$1 AND state IN ('dispatching','unknown')",
          [row.id, task.taskId],
        );
        continue;
      }
      await this.db.transaction(async (tx) => {
        // Privacy deletion locks the conversation before its derived occurrences.
        // Keep that order while settling the original task; notify rechecks deletion.
        if (row.conversation_id)
          await tx.query(
            'SELECT id FROM app.ai_conversations WHERE id=$1 AND owner_id=$2 FOR SHARE',
            [row.conversation_id, row.owner_id],
          );
        const locked = (
          await tx.query<OccurrenceRow>(
            'SELECT * FROM app.agent_schedule_occurrences WHERE id=$1 FOR UPDATE',
            [row.id],
          )
        ).rows[0];
        if (
          !locked ||
          !['enqueued', 'dispatching', 'unknown'].includes(locked.state)
        )
          return;
        const state =
          task.state === 'completed'
            ? 'completed'
            : task.state === 'cancelled'
              ? 'cancelled'
              : task.state === 'unknown'
                ? 'unknown'
                : 'failed';
        await tx.query(
          'UPDATE app.agent_schedule_occurrences SET task_id=$2,state=$3,finished_at=$4,error_code=$5 WHERE id=$1',
          [
            row.id,
            task.taskId,
            state,
            this.now(),
            state === 'completed' ? null : `TASK_${task.state.toUpperCase()}`,
          ],
        );
        await this.notify(
          tx,
          locked,
          'agentTaskReady',
          state === 'completed'
            ? z.object({ kind: z.literal('office') }).safeParse(locked.snapshot)
                .success
              ? '定时办公任务已结束，请打开原任务查看结果。'
              : '定时草稿已生成，请打开原对话查看。'
            : `定时任务已结束（${state}），请核对原任务。`,
        );
      });
    }
    return rows.length;
  }
  async tick() {
    await this.reconcile();
    const claim = await this.claimDue();
    if (claim && claim.state === 'claimed')
      await this.dispatchClaim(claim.id, claim.claim_token);
    return Boolean(claim);
  }
}

/** Used inside the original ConversationsService queue transaction. No model parameter supplies authority. */
export async function authorizeScheduledOccurrence(
  tx: SqlExecutor,
  id: string,
  claimToken: string,
  states: readonly string[] = ['dispatching'],
) {
  const locator = (
    await tx.query<OccurrenceRow>(
      'SELECT * FROM app.agent_schedule_occurrences WHERE id=$1 AND claim_token=$2',
      [z.uuid().parse(id), z.uuid().parse(claimToken)],
    )
  ).rows[0];
  if (!locator || !states.includes(locator.state))
    throw new DomainError(
      'BUSINESS_CONFLICT',
      '原定时执行状态已关闭，不能重新发送。',
      409,
    );
  const actor = scheduledActor(locator.owner_id, locator.id);
  await currentUser(tx, actor);
  if (locator.conversation_id)
    await conversationRow(tx, actor, locator.conversation_id, false, true);
  // Keep c -> schedule -> occurrence ordering across dispatch, CAS and privacy.
  const schedule = (
    await tx.query<ScheduleRow>(
      'SELECT * FROM app.agent_schedules WHERE id=$1 FOR UPDATE',
      [locator.schedule_id],
    )
  ).rows[0];
  const occurrence = (
    await tx.query<OccurrenceRow>(
      'SELECT * FROM app.agent_schedule_occurrences WHERE id=$1 AND claim_token=$2 FOR UPDATE',
      [id, claimToken],
    )
  ).rows[0];
  // A once schedule becomes finished when its sole point is claimed, but this claim is still valid.
  if (
    !schedule ||
    !occurrence ||
    !states.includes(occurrence.state) ||
    occurrence.owner_id !== locator.owner_id ||
    occurrence.conversation_id !== locator.conversation_id ||
    occurrence.schedule_id !== locator.schedule_id ||
    occurrence.schedule_revision !== locator.schedule_revision ||
    schedule.owner_id !== locator.owner_id ||
    schedule.conversation_id !== locator.conversation_id ||
    !['active', 'finished'].includes(schedule.state) ||
    schedule.row_version !== occurrence.schedule_revision
  )
    throw new DomainError(
      'BUSINESS_CONFLICT',
      '计划已取消、暂停或修改，未发起本次任务。',
      409,
    );
  const snapshot = snapshotSchema.parse(occurrence.snapshot);
  return { occurrence, snapshot, actor };
}

/** Bind the task and physical capability policy atomically with the original queue INSERT. */
export async function bindScheduledTask(
  tx: SqlExecutor,
  occurrenceId: string,
  claimToken: string,
  taskId: string,
) {
  const checked = await authorizeScheduledOccurrence(
    tx,
    occurrenceId,
    claimToken,
  );
  if (
    checked.snapshot.kind === 'reminder' ||
    !checked.occurrence.conversation_id
  )
    throw new DomainError('PRECONDITIONS_MISSING', '原时点不是模型任务。', 422);
  const policy =
    checked.snapshot.kind === 'office' ? 'officeOnly' : 'draftOnly';
  const updated = await tx.query(
    "UPDATE app.ai_tasks SET execution_policy=$4 WHERE id=$1 AND owner_id=$2 AND conversation_id=$3 AND state='accepted' RETURNING id",
    [
      z.uuid().parse(taskId),
      checked.actor.userId,
      checked.occurrence.conversation_id,
      policy,
    ],
  );
  if (!updated.rowCount)
    throw new DomainError(
      'BUSINESS_CONFLICT',
      '任务不能原子绑定定时执行权限。',
      409,
    );
  await tx.query(
    "UPDATE app.agent_schedule_occurrences SET state='enqueued',task_id=$2 WHERE id=$1 AND claim_token=$3 AND state='dispatching'",
    [occurrenceId, taskId, claimToken],
  );
}
