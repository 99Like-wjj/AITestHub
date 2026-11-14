import { z } from 'zod';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { requirePlatformAdmin } from '../access/policy.js';
import { personalActor } from './common.js';

export type UsageOriginScope =
  'liveProvider' | 'fixture' | 'legacyUnknown' | 'all';
const scopeSchema = z.enum(['liveProvider', 'fixture', 'legacyUnknown', 'all']);
const annualStart =
  "(((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date-364)::timestamp AT TIME ZONE 'Asia/Shanghai')";
const annualEnd =
  "((((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date+1)::timestamp) AT TIME ZONE 'Asia/Shanghai')";
const effectiveTotal =
  'COALESCE(l.total_tokens,l.input_tokens+l.output_tokens)';
const eligible = 'l.request_count IS DISTINCT FROM 0';
const aggregate = `sum(l.input_tokens) FILTER(WHERE ${eligible})::text input_tokens,
  sum(l.output_tokens) FILTER(WHERE ${eligible})::text output_tokens,
  sum(${effectiveTotal}) FILTER(WHERE ${eligible})::text tokens,
  count(l.id) FILTER(WHERE ${eligible} AND ${effectiveTotal} IS NOT NULL)::text known_calls,
  count(l.id) FILTER(WHERE ${eligible} AND ${effectiveTotal} IS NULL)::text unknown_calls,
  count(l.id) FILTER(WHERE ${eligible} AND (l.input_tokens IS NULL OR l.output_tokens IS NULL))::text component_unknown_calls,
  count(l.id) FILTER(WHERE ${eligible} AND l.total_tokens IS NULL AND l.input_tokens IS NOT NULL AND l.output_tokens IS NOT NULL)::text total_fallback_calls,
  COALESCE(sum(l.request_count),0)::text confirmed_requests,
  count(l.id) FILTER(WHERE l.request_count IS NULL)::text unknown_request_intents,
  count(l.id) FILTER(WHERE l.request_count=0)::text not_dispatched_calls`;
interface Aggregate {
  input_tokens: string | null;
  output_tokens: string | null;
  tokens: string | null;
  known_calls: string;
  unknown_calls: string;
  component_unknown_calls: string;
  total_fallback_calls: string;
  confirmed_requests: string;
  unknown_request_intents: string;
  not_dispatched_calls: string;
}
interface OriginRow {
  execution_origin: 'fixture' | 'liveProvider' | 'legacyUnknown';
  ledger_rows: string;
  confirmed_requests: string;
  unknown_request_intents: string;
  not_dispatched_calls: string;
  recorded_tokens: string | null;
}
const originDto = (row: OriginRow) => ({
  executionOrigin: row.execution_origin,
  ledgerRows: row.ledger_rows,
  confirmedRequests: row.confirmed_requests,
  unknownRequestIntents: row.unknown_request_intents,
  notDispatchedCalls: row.not_dispatched_calls,
  recordedTokens: row.recorded_tokens,
});
const base = (scope: UsageOriginScope) => ({
  timezone: 'Asia/Shanghai' as const,
  range: '365days-including-today' as const,
  executionOriginScope: scope,
  totalPolicy: 'reported-total-first-else-input-output' as const,
  requestPolicy: 'native-fetch-invocations' as const,
  datePolicy: 'call-start-date' as const,
  activityScope: 'all-platform-user-tasks' as const,
});

/** Own aggregates only: no message text, source bodies, checkpoint data or credentials. */
export class ModelUsageService {
  constructor(readonly db: Pick<Database, 'transaction'>) {}
  async #origins(
    tx: SqlExecutor,
    userId: string | null,
  ): Promise<ReturnType<typeof originDto>[]> {
    const rows = (
      await tx.query<OriginRow>(
        `WITH origins AS(SELECT unnest(ARRAY['liveProvider','fixture','legacyUnknown']) execution_origin)
      SELECT o.execution_origin,count(l.id)::text ledger_rows,COALESCE(sum(l.request_count),0)::text confirmed_requests,
      count(l.id) FILTER(WHERE l.request_count IS NULL)::text unknown_request_intents,count(l.id) FILTER(WHERE l.request_count=0)::text not_dispatched_calls,
      sum(${effectiveTotal}) FILTER(WHERE ${eligible})::text recorded_tokens
      FROM origins o LEFT JOIN app.model_call_ledger l ON l.execution_origin=o.execution_origin AND l.started_at>=${annualStart} AND ($1::uuid IS NULL OR l.initiator_user_id=$1)
      GROUP BY o.execution_origin ORDER BY o.execution_origin`,
        [userId],
      )
    ).rows;
    return rows.map(originDto);
  }
  async personal(
    actor: ActorContext,
    rawScope: UsageOriginScope = 'liveProvider',
  ) {
    const scope = scopeSchema.parse(rawScope);
    const selected = scope === 'all' ? null : scope;
    return this.db.transaction(async (tx) => {
      await personalActor(tx, actor);
      const totals = (
        await tx.query<Aggregate>(
          `SELECT ${aggregate} FROM app.model_call_ledger l WHERE l.initiator_user_id=$1 AND l.started_at>=${annualStart} AND ($2::text IS NULL OR l.execution_origin=$2)`,
          [actor.userId, selected],
        )
      ).rows[0];
      const hasAuxiliary = (
        await tx.query<{ present: boolean }>(
          "SELECT to_regclass('app.auxiliary_tasks') IS NOT NULL present",
        )
      ).rows[0]?.present;
      // Dates describe accepted human tasks, not arbitrary CRUD/audit events.
      // A queued API request owns its original actor/time; its later run is not
      // counted as another initiation. Scheduled occurrences are never human activity.
      const activeTaskRows = `(
        SELECT created_at FROM app.ai_tasks WHERE owner_id=$1
        ${hasAuxiliary ? 'UNION ALL SELECT created_at FROM app.auxiliary_tasks WHERE owner_id=$1' : ''}
        UNION ALL SELECT created_at FROM app.api_execution_requests WHERE actor_id=$1 AND source IN ('manual','debug')
        UNION ALL SELECT r.created_at FROM app.runs r WHERE r.created_by=$1 AND r.source IN ('localUi','manual','debug','retest')
          AND NOT EXISTS(SELECT 1 FROM app.api_execution_requests q WHERE q.run_id=r.id)
      ) accepted_user_tasks`;
      const activity = (
        await tx.query<{ active_days: string }>(
          `SELECT count(DISTINCT(created_at AT TIME ZONE 'Asia/Shanghai')::date)::text active_days
          FROM ${activeTaskRows} WHERE created_at>=${annualStart} AND created_at<${annualEnd}`,
          [actor.userId],
        )
      ).rows[0];
      const hasAuxiliaryStart =
        hasAuxiliary &&
        Boolean(
          (
            await tx.query<{ present: boolean }>(
              "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='app' AND table_name='auxiliary_tasks' AND column_name='started_at') present",
            )
          ).rows[0]?.present,
        );
      // Keep every existing terminal state. A lifecycle event must prove the
      // exact stored finish time; queue/recovery/privacy timestamps are not an
      // inferred processing duration. Legacy missing signals remain unknown.
      const aiDurationRows = `SELECT t.state,t.started_at processing_start,t.finished_at,t.error_code,
        (t.worker_id IS NOT NULL AND t.fence>0) worker_claimed,
        EXISTS(SELECT 1 FROM app.ai_task_events e WHERE e.task_id=t.id AND e.event_type='task.finished' AND e.created_at=t.finished_at) terminal_signal,
        (t.state='cancelled' AND t.started_at IS NULL AND t.worker_id IS NULL AND t.fence=0
          AND NOT EXISTS(SELECT 1 FROM app.ai_task_events e WHERE e.task_id=t.id AND e.event_type='task.started')
          AND NOT EXISTS(SELECT 1 FROM app.model_call_ledger l WHERE l.task_id=t.id)
          AND NOT EXISTS(SELECT 1 FROM app.recovery_dispatch_fences f WHERE f.namespace='model' AND f.source_id=t.id)) not_started
        FROM app.ai_tasks t WHERE t.owner_id=$1 AND t.created_at>=${annualStart} AND t.created_at<${annualEnd}
          AND t.state IN ('completed','failed','cancelled','interrupted','unknown')`;
      const auxStart = hasAuxiliaryStart ? 't.started_at' : 'NULL::timestamptz';
      const auxDurationRows = hasAuxiliary
        ? `UNION ALL SELECT t.state,${auxStart} processing_start,t.finished_at,t.error_code,
        (t.worker_id IS NOT NULL) worker_claimed,
        EXISTS(SELECT 1 FROM app.audit_events e WHERE e.object_id=t.id AND e.actor_id=t.owner_id AND e.action='auxiliary.finished' AND e.created_at=t.finished_at) terminal_signal,
        (t.state='cancelled' AND ${auxStart} IS NULL AND t.worker_id IS NULL AND t.call_id IS NULL AND t.lease_expires_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM app.model_call_ledger l WHERE l.auxiliary_task_id=t.id)
          AND NOT EXISTS(SELECT 1 FROM app.recovery_dispatch_fences f WHERE f.namespace='auxiliary' AND f.source_id=t.id)) not_started
        FROM app.auxiliary_tasks t WHERE t.owner_id=$1 AND t.created_at>=${annualStart} AND t.created_at<${annualEnd}
          AND t.state IN ('completed','failed','cancelled','interrupted','unknown')`
        : '';
      const durations = (
        await tx.query<{
          longest_task_ms: string | null;
          known_task_durations: string;
          unknown_task_durations: string;
          not_started_tasks: string;
        }>(
          `WITH ended AS(${aiDurationRows} ${auxDurationRows}), qualified AS(
          SELECT *,CASE WHEN COALESCE(error_code,'') IN ('WORKER_INTERRUPTED','RECOVERY_DISPATCH_FENCE','RESTORED_NOT_REPLAYED') THEN 'unknown'
            WHEN not_started THEN 'notStarted'
            WHEN processing_start IS NOT NULL AND finished_at IS NOT NULL AND finished_at>=processing_start AND worker_claimed AND terminal_signal
             AND COALESCE(error_code,'') NOT IN ('WORKER_INTERRUPTED','RECOVERY_DISPATCH_FENCE','RESTORED_NOT_REPLAYED') THEN 'known'
            ELSE 'unknown' END quality FROM ended)
         SELECT floor(max(extract(epoch FROM(finished_at-processing_start))*1000) FILTER(WHERE quality='known'))::text longest_task_ms,
          count(*) FILTER(WHERE quality='known')::text known_task_durations,
          count(*) FILTER(WHERE quality='unknown')::text unknown_task_durations,
          count(*) FILTER(WHERE quality='notStarted')::text not_started_tasks FROM qualified`,
          [actor.userId],
        )
      ).rows[0]!;
      const heatmap = (
        await tx.query<{
          date: string;
          tokens: string | null;
          unknown_calls: string;
          component_unknown_calls: string;
          confirmed_requests: string;
          unknown_request_intents: string;
        }>(
          `WITH days AS(SELECT generate_series((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date-364,(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date,interval '1 day')::date calendar_date)
        SELECT to_char(d.calendar_date,'YYYY-MM-DD') date,sum(${effectiveTotal}) FILTER(WHERE ${eligible})::text tokens,
        count(l.id) FILTER(WHERE ${eligible} AND ${effectiveTotal} IS NULL)::text unknown_calls,
        count(l.id) FILTER(WHERE ${eligible} AND (l.input_tokens IS NULL OR l.output_tokens IS NULL))::text component_unknown_calls,
        COALESCE(sum(l.request_count),0)::text confirmed_requests,count(l.id) FILTER(WHERE l.request_count IS NULL)::text unknown_request_intents
        FROM days d LEFT JOIN app.model_call_ledger l ON (l.started_at AT TIME ZONE 'Asia/Shanghai')::date=d.calendar_date AND l.initiator_user_id=$1 AND ($2::text IS NULL OR l.execution_origin=$2)
        GROUP BY d.calendar_date ORDER BY d.calendar_date`,
          [actor.userId, selected],
        )
      ).rows;
      const models = (
        await tx.query<
          Aggregate & { model_id: string; source: string; ledger_rows: string }
        >(
          `SELECT l.model_id,l.source,count(l.id)::text ledger_rows,${aggregate} FROM app.model_call_ledger l WHERE l.initiator_user_id=$1 AND l.started_at>=${annualStart} AND ($2::text IS NULL OR l.execution_origin=$2) GROUP BY l.model_id,l.source ORDER BY l.model_id,l.source`,
          [actor.userId, selected],
        )
      ).rows;
      return {
        ...base(scope),
        longestTaskScope: 'ended-platform-ai-and-auxiliary-tasks' as const,
        longestTaskPolicy: 'worker-start-to-matching-terminal-event' as const,
        originBreakdown: await this.#origins(tx, actor.userId),
        summary: totals
          ? {
              input_tokens: totals.input_tokens,
              output_tokens: totals.output_tokens,
              total_tokens: totals.tokens,
              known_calls: totals.known_calls,
              unknown_calls: totals.unknown_calls,
              component_unknown_calls: totals.component_unknown_calls,
              total_fallback_calls: totals.total_fallback_calls,
              confirmed_requests: totals.confirmed_requests,
              unknown_request_intents: totals.unknown_request_intents,
              not_dispatched_calls: totals.not_dispatched_calls,
              active_days: activity?.active_days ?? '0',
              longest_task_ms: durations.longest_task_ms,
              known_task_durations: durations.known_task_durations,
              unknown_task_durations: durations.unknown_task_durations,
              not_started_tasks: durations.not_started_tasks,
            }
          : null,
        heatmap,
        models: models.map((row) => ({
          model_id: row.model_id,
          source: row.source,
          tokens: row.tokens,
          calls: row.confirmed_requests,
          unknown_calls: row.unknown_calls,
          component_unknown_calls: row.component_unknown_calls,
          total_fallback_calls: row.total_fallback_calls,
          unknown_request_intents: row.unknown_request_intents,
          not_dispatched_calls: row.not_dispatched_calls,
          ledger_rows: row.ledger_rows,
        })),
      };
    });
  }
  async platform(
    actor: ActorContext,
    rawScope: UsageOriginScope = 'liveProvider',
  ) {
    const scope = scopeSchema.parse(rawScope);
    const selected = scope === 'all' ? null : scope;
    return this.db.transaction(async (tx) => {
      await requirePlatformAdmin(tx, actor);
      const totals = (
        await tx.query<Aggregate>(
          `SELECT ${aggregate} FROM app.model_call_ledger l WHERE l.started_at>=${annualStart} AND ($1::text IS NULL OR l.execution_origin=$1)`,
          [selected],
        )
      ).rows[0];
      const bySource = (
        await tx.query<Aggregate & { source: string }>(
          `SELECT l.source,${aggregate} FROM app.model_call_ledger l WHERE l.started_at>=${annualStart} AND ($1::text IS NULL OR l.execution_origin=$1) GROUP BY l.source ORDER BY l.source`,
          [selected],
        )
      ).rows;
      const byUser = (
        await tx.query<
          Aggregate & { user_id: string; account: string; display_name: string }
        >(
          `SELECT u.id user_id,u.display_account account,u.display_name,${aggregate} FROM app.model_call_ledger l JOIN app.users u ON u.id=l.initiator_user_id WHERE l.started_at>=${annualStart} AND ($1::text IS NULL OR l.execution_origin=$1) GROUP BY u.id ORDER BY u.account`,
          [selected],
        )
      ).rows;
      const byModelRows = (
        await tx.query<
          Aggregate & { model_id: string; source: string; ledger_rows: string }
        >(
          `SELECT l.model_id,l.source,count(l.id)::text ledger_rows,${aggregate} FROM app.model_call_ledger l WHERE l.started_at>=${annualStart} AND ($1::text IS NULL OR l.execution_origin=$1) GROUP BY l.model_id,l.source ORDER BY l.model_id,l.source`,
          [selected],
        )
      ).rows;
      const heatmap = (
        await tx.query<{
          date: string;
          tokens: string | null;
          unknown_calls: string;
          component_unknown_calls: string;
          confirmed_requests: string;
          unknown_request_intents: string;
        }>(
          `WITH days AS(SELECT generate_series((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date-364,(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date,interval '1 day')::date calendar_date)
        SELECT to_char(d.calendar_date,'YYYY-MM-DD') date,sum(${effectiveTotal}) FILTER(WHERE ${eligible})::text tokens,
        count(l.id) FILTER(WHERE ${eligible} AND ${effectiveTotal} IS NULL)::text unknown_calls,
        count(l.id) FILTER(WHERE ${eligible} AND (l.input_tokens IS NULL OR l.output_tokens IS NULL))::text component_unknown_calls,
        COALESCE(sum(l.request_count),0)::text confirmed_requests,count(l.id) FILTER(WHERE l.request_count IS NULL)::text unknown_request_intents
        FROM days d LEFT JOIN app.model_call_ledger l ON (l.started_at AT TIME ZONE 'Asia/Shanghai')::date=d.calendar_date AND ($1::text IS NULL OR l.execution_origin=$1)
        GROUP BY d.calendar_date ORDER BY d.calendar_date`,
          [selected],
        )
      ).rows;
      const counters = (row: Aggregate) => ({
        tokens: row.tokens,
        calls: row.confirmed_requests,
        unknown_calls: row.unknown_calls,
        component_unknown_calls: row.component_unknown_calls,
        total_fallback_calls: row.total_fallback_calls,
        unknown_request_intents: row.unknown_request_intents,
        not_dispatched_calls: row.not_dispatched_calls,
      });
      return {
        ...base(scope),
        originBreakdown: await this.#origins(tx, null),
        heatmap,
        totals: totals ? counters(totals) : null,
        bySource: bySource.map((row) => ({
          source: row.source,
          ...counters(row),
        })),
        byModel: byModelRows.map((row) => ({
          model_id: row.model_id,
          source: row.source,
          ledger_rows: row.ledger_rows,
          ...counters(row),
        })),
        byUser: byUser.map((row) => ({
          user_id: row.user_id,
          account: row.account,
          display_name: row.display_name,
          ...counters(row),
        })),
      };
    });
  }
}
