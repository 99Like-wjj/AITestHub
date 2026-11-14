import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  createScheduleInputSchema,
  reviseScheduleInputSchema,
  changeScheduleStateInputSchema,
  copyScheduleInputSchema,
  schedulePreviewInputSchema,
  schedulePreviewSchema,
  scheduleReceiptSchema,
  scheduleListSchema,
  scheduleDetailSchema,
  scheduleTimelineSchema,
  schedulePointSchema,
  scheduleOperationLookupSchema,
} from '../../../contracts/src/schedules.js';
import { planningOperationStatusSchema } from '../../../contracts/src/plans.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { DomainError, stale } from '../errors.js';
import { audit } from '../events.js';
import { OperationService } from '../operations/service.js';
import { PlanService } from '../plans/service.js';
import {
  creatorAvailable,
  scheduleRow,
  scheduleDto,
  scheduleSelect,
  occurrenceDto,
  occurrenceEvent,
  hasCreatorRevocation,
  type ScheduleRow,
} from './repository.js';
import {
  futurePoints,
  validateRule,
  timeZoneRulesVersion,
  advancePoint,
  resolveWall,
} from './time.js';
import { ScheduleRuntime, type ScheduleRuntimeOptions } from './runtime.js';

export class ScheduleService {
  readonly operations: OperationService;
  readonly runtime: ScheduleRuntime;
  constructor(
    readonly db: Database,
    readonly plans: PlanService,
    readonly options: ScheduleRuntimeOptions = {},
  ) {
    this.operations = new OperationService(db);
    this.runtime = new ScheduleRuntime(db, plans, options);
    plans.setScheduledStartGuard(this.runtime);
  }
  async operationStatus(actor: ActorContext, projectId: string, raw: unknown) {
    const input = scheduleOperationLookupSchema.parse(raw);
    await this.db.transaction((tx) =>
      requireProject(tx, actor, projectId, 'project.read'),
    );
    const result = await this.operations.get(actor, input);
    if (result.command.projectId !== projectId)
      throw new DomainError('NOT_FOUND', '本项目没有该原操作回执。', 404);
    return planningOperationStatusSchema.parse(result);
  }
  private async now(transaction: SqlExecutor) {
    return (
      this.options.clock?.() ??
      (await transaction.query<{ now: Date }>('SELECT clock_timestamp() now'))
        .rows[0]!.now
    );
  }
  private async authorize(
    transaction: SqlExecutor,
    actor: ActorContext,
    projectId: string,
  ) {
    await requireProject(transaction, actor, projectId, 'plans.write');
  }
  private first(rule: unknown, now: Date) {
    const point = futurePoints(rule, now.toISOString(), 1)[0];
    if (!point)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '单次时点已过期；请明确设置未来日期和时间，不会补跑。',
        422,
      );
    return point;
  }
  private async preserveSkippedBeforeChange(
    transaction: SqlExecutor,
    row: ScheduleRow,
    reason: string,
  ) {
    const now = await this.now(transaction),
      rule = validateRule(row.rule);
    let point =
        row.next_point === null
          ? null
          : schedulePointSchema.parse(row.next_point),
      count = 0;
    while (point && Date.parse(point.decisionAt) <= now.getTime()) {
      if (++count > 1000)
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '历史漏点正在分批对账，请等待后台水位推进后再修改；不会删除时点或补跑。',
          422,
        );
      const id = randomUUID();
      const inserted = await transaction.query(
        `INSERT INTO app.schedule_occurrences(id,project_id,schedule_id,schedule_revision_id,wall_date,wall_time,time_zone,point,planned_at,decision_at,state,reason_code)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'cancelled',$11) ON CONFLICT(schedule_id,wall_date,wall_time) DO NOTHING RETURNING id`,
        [
          id,
          row.project_id,
          row.id,
          row.current_revision_id,
          point.wallDate,
          point.wallTime,
          point.timeZone,
          JSON.stringify(point),
          point.plannedAt,
          point.decisionAt,
          reason,
        ],
      );
      if (inserted.rowCount)
        await occurrenceEvent(transaction, id, 'cancelled', reason, {
          automaticReplay: false,
        });
      point = advancePoint(rule, point);
    }
  }
  async preview(actor: ActorContext, projectId: string, raw: unknown) {
    const input = schedulePreviewInputSchema.parse(raw);
    return this.db.transaction(async (transaction) => {
      await this.authorize(transaction, actor, projectId);
      const points = futurePoints(
        input.rule,
        input.after ?? (await this.now(transaction)).toISOString(),
        input.count,
      );
      return schedulePreviewSchema.parse({
        points,
        noFuturePoint: points.length === 0,
        pastPointsWillNotRun: true,
      });
    });
  }
  async list(actor: ActorContext, projectId: string) {
    return this.db.transaction(async (transaction) => {
      await requireProject(transaction, actor, projectId, 'project.read');
      const rows = await transaction.query(
        `${scheduleSelect} WHERE s.project_id=$1 ORDER BY s.created_at DESC,s.id LIMIT 500`,
        [projectId],
      );
      return scheduleListSchema.parse({
        schedules: rows.rows.map((row) =>
          scheduleDto(row as Awaited<ReturnType<typeof scheduleRow>>),
        ),
      });
    });
  }
  async detail(actor: ActorContext, projectId: string, id: string) {
    return this.db.transaction(async (transaction) => {
      await requireProject(transaction, actor, projectId, 'project.read');
      const row = await scheduleRow(transaction, projectId, id);
      const revisions = await transaction.query(
        'SELECT id,revision_no,plan_revision_id,environment_id,rule,created_by,created_at FROM app.schedule_revisions WHERE schedule_id=$1 ORDER BY revision_no DESC',
        [id],
      );
      return scheduleDetailSchema.parse({
        schedule: scheduleDto(row),
        revisions: revisions.rows.map((revision) => ({
          id: revision.id,
          revisionNo: revision.revision_no,
          planRevisionId: revision.plan_revision_id,
          environmentId: revision.environment_id,
          rule: revision.rule,
          createdBy: revision.created_by,
          createdAt: revision.created_at.toISOString(),
        })),
      });
    });
  }
  private async insert(
    transaction: SqlExecutor,
    actor: ActorContext,
    projectId: string,
    plan: Awaited<ReturnType<PlanService['boundApiPlanInTransaction']>>,
    rule: ReturnType<typeof validateRule>,
    enabled: boolean,
    copiedFrom: string | null,
  ) {
    const point = this.first(rule, await this.now(transaction)),
      id = randomUUID(),
      revisionId = randomUUID();
    if (
      (
        await transaction.query(
          'SELECT 1 FROM app.api_schedules WHERE plan_id=$1',
          [plan.id],
        )
      ).rowCount
    )
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '该API计划已有定时配置，请编辑原配置；失效创建人须显式复制为本人新计划。',
        409,
      );
    if (!(await creatorAvailable(transaction, plan.createdBy, projectId)))
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '原计划创建人无当前测试资格，不能换人启用；请明确复制为本人新计划。',
        422,
      );
    await transaction.query(
      'INSERT INTO app.api_schedules(id,project_id,plan_id,created_by,copied_from_schedule_id,status,pause_reason,next_point) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        id,
        projectId,
        plan.id,
        plan.createdBy,
        copiedFrom,
        enabled ? 'active' : 'paused',
        enabled ? null : 'manual',
        JSON.stringify(point),
      ],
    );
    await transaction.query(
      `INSERT INTO app.schedule_revisions(id,schedule_id,project_id,plan_id,plan_revision_id,environment_id,plan_name,revision_no,rule,time_zone_rules_version,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10)`,
      [
        revisionId,
        id,
        projectId,
        plan.id,
        plan.revisionId,
        plan.environmentId,
        plan.name,
        JSON.stringify(rule),
        timeZoneRulesVersion,
        actor.userId,
      ],
    );
    await transaction.query(
      'UPDATE app.api_schedules SET current_revision_id=$2 WHERE id=$1',
      [id, revisionId],
    );
    await audit(
      transaction,
      actor,
      copiedFrom ? 'schedules.copied' : 'schedules.created',
      id,
      projectId,
      {
        planId: plan.id,
        planRevisionId: plan.revisionId,
        createdBy: plan.createdBy,
        copiedFromScheduleId: copiedFrom,
      },
    );
    return scheduleReceiptSchema.parse({
      schedule: scheduleDto(await scheduleRow(transaction, projectId, id)),
    });
  }
  async create(actor: ActorContext, projectId: string, raw: unknown) {
    const input = createScheduleInputSchema.parse(raw),
      rule = validateRule(input.rule);
    return this.operations.execute(
      actor,
      'schedules.create',
      input.commandId,
      input,
      (tx) => this.authorize(tx, actor, projectId),
      async (transaction) => {
        await transaction.query(
          'SELECT id FROM app.test_plans WHERE project_id=$1 AND id=$2 FOR UPDATE',
          [projectId, input.planId],
        );
        const plan = await this.plans.boundApiPlanInTransaction(
          transaction,
          projectId,
          input.planId,
          input.planRevisionId,
          input.environmentId,
        );
        return this.insert(
          transaction,
          actor,
          projectId,
          plan,
          rule,
          input.enabled,
          null,
        );
      },
      projectId,
    );
  }
  async revise(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    const input = reviseScheduleInputSchema.parse(raw),
      rule = validateRule(input.rule);
    return this.operations.execute(
      actor,
      'schedules.revise',
      input.commandId,
      { id, ...input },
      (tx) => this.authorize(tx, actor, projectId),
      async (transaction) => {
        const row = await scheduleRow(transaction, projectId, id, true);
        if (
          row.row_version !== input.rowVersion ||
          row.current_revision_id !== input.baseRevisionId
        )
          stale();
        await this.preserveSkippedBeforeChange(
          transaction,
          row,
          'EDITED_BEFORE_ACCEPTANCE',
        );
        const plan = await this.plans.boundApiPlanInTransaction(
            transaction,
            projectId,
            row.plan_id,
            input.planRevisionId,
            input.environmentId,
          ),
          point = this.first(rule, await this.now(transaction)),
          revisionId = randomUUID();
        await transaction.query(
          `INSERT INTO app.schedule_revisions(id,schedule_id,project_id,plan_id,plan_revision_id,environment_id,plan_name,revision_no,rule,time_zone_rules_version,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            revisionId,
            id,
            projectId,
            row.plan_id,
            plan.revisionId,
            plan.environmentId,
            plan.name,
            row.revision_no + 1,
            JSON.stringify(rule),
            timeZoneRulesVersion,
            actor.userId,
          ],
        );
        await transaction.query(
          "UPDATE app.api_schedules SET current_revision_id=$2,next_point=$3,row_version=row_version+1,status=CASE WHEN status='completed' THEN 'paused' ELSE status END,pause_reason=CASE WHEN status='completed' THEN 'manual' ELSE pause_reason END,updated_at=clock_timestamp() WHERE id=$1",
          [id, revisionId, JSON.stringify(point)],
        );
        await audit(transaction, actor, 'schedules.revised', id, projectId, {
          revisionId,
          planRevisionId: plan.revisionId,
          affectsExistingRequests: false,
        });
        return scheduleReceiptSchema.parse({
          schedule: scheduleDto(await scheduleRow(transaction, projectId, id)),
        });
      },
      projectId,
    );
  }
  async pause(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    return this.changeState(actor, projectId, id, raw, 'pause');
  }
  async resume(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    return this.changeState(actor, projectId, id, raw, 'resume');
  }
  private async changeState(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
    action: 'pause' | 'resume',
  ) {
    const input = changeScheduleStateInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      `schedules.${action}`,
      input.commandId,
      { id, ...input },
      (tx) => this.authorize(tx, actor, projectId),
      async (transaction) => {
        const row = await scheduleRow(transaction, projectId, id, true);
        if (row.row_version !== input.rowVersion) stale();
        if (action === 'resume') {
          if (
            row.pause_reason === 'creatorUnavailable' ||
            (await hasCreatorRevocation(transaction, row.id)) ||
            !(await creatorAvailable(transaction, row.created_by, projectId))
          )
            throw new DomainError(
              'PRECONDITIONS_MISSING',
              '创建人失效的旧计划保持暂停；恢复账号也不会自动启用，请明确复制为本人新计划并选择未来时点。',
              422,
            );
          if (row.status === 'active')
            return scheduleReceiptSchema.parse({ schedule: scheduleDto(row) });
          await this.preserveSkippedBeforeChange(
            transaction,
            row,
            'PAUSED_INTERVAL_NOT_EXECUTED',
          );
          const point = this.first(
            validateRule(row.rule),
            await this.now(transaction),
          );
          await transaction.query(
            "UPDATE app.api_schedules SET status='active',pause_reason=NULL,next_point=$2,row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1",
            [id, JSON.stringify(point)],
          );
        } else {
          await this.preserveSkippedBeforeChange(
            transaction,
            row,
            'PAUSED_BEFORE_ACCEPTANCE',
          );
          await transaction.query(
            "UPDATE app.api_schedules SET status='paused',pause_reason=CASE WHEN pause_reason='creatorUnavailable' THEN pause_reason ELSE 'manual' END,row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1",
            [id],
          );
        }
        await audit(transaction, actor, `schedules.${action}d`, id, projectId, {
          futureOnly: true,
          existingRequestsPreserved: true,
        });
        return scheduleReceiptSchema.parse({
          schedule: scheduleDto(await scheduleRow(transaction, projectId, id)),
        });
      },
      projectId,
    );
  }
  async copy(actor: ActorContext, projectId: string, id: string, raw: unknown) {
    const input = copyScheduleInputSchema.parse(raw),
      rule = validateRule(input.rule);
    return this.operations.execute(
      actor,
      'schedules.copy',
      input.commandId,
      { id, ...input },
      (tx) => this.authorize(tx, actor, projectId),
      async (transaction) => {
        const source = await scheduleRow(transaction, projectId, id, true);
        if (source.row_version !== input.rowVersion) stale();
        const now = await this.now(transaction);
        if (Date.parse(resolveWall(rule).decisionAt) <= now.getTime())
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '复制须由本人明确设置未来起始日期和时间；不会沿旧周期自动选下一个时点。',
            422,
          );
        this.first(rule, now);
        const plan = await this.plans.copyApiForScheduleInTransaction(
          transaction,
          actor,
          projectId,
          source.plan_id,
          source.plan_revision_id,
          input.name,
          input.environmentId,
        );
        return this.insert(
          transaction,
          actor,
          projectId,
          plan,
          rule,
          input.enabled,
          id,
        );
      },
      projectId,
    );
  }
  async timeline(
    actor: ActorContext,
    projectId: string,
    id: string,
    before?: string,
  ) {
    if (before !== undefined)
      z.string()
        .regex(/^\d{1,19}$/)
        .parse(before);
    return this.db.transaction(async (transaction) => {
      await requireProject(transaction, actor, projectId, 'project.read');
      await scheduleRow(transaction, projectId, id);
      const rows = await transaction.query(
        'SELECT * FROM app.schedule_occurrences WHERE schedule_id=$1 AND ($2::bigint IS NULL OR sequence<$2) ORDER BY sequence DESC LIMIT 100',
        [id, before ?? null],
      );
      return scheduleTimelineSchema.parse({
        occurrences: rows.rows.map(occurrenceDto),
        nextBefore:
          rows.rows.length === 100 ? String(rows.rows.at(-1)?.sequence) : null,
      });
    });
  }
}
