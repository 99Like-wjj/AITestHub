import { z } from 'zod';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { BaseMessage } from '@langchain/core/messages';
import {
  agentContextArchiveReadSchema,
  agentContextArchiveRecordSchema,
  agentTaskPlanReceiptSchema,
  agentTaskPlanSchema,
  agentTaskPlanUpdateSchema,
  type AgentContextArchiveRecord,
  type AgentTaskPlanReceipt,
  type AgentTaskPlan,
} from '../../../contracts/src/agent-context.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { AiRuntimeAccess, type AiCheckpointScope } from '../ai/access.js';
import { conversationRow } from '../conversations/common.js';
import { DomainError, stale } from '../errors.js';
import {
  compactModelMessages,
  contextHistoryPageBudget,
  type AgentContextBudget,
} from './compaction.js';

interface PlanRow {
  source_stamp: string;
  plan: unknown;
  row_version: number;
}
const receiptMeaning =
  'agent-reported-completion-with-tool-transport-receipt' as const;
const factSchema = z.object({
  invocationId: z.uuid(),
  state: z.enum(['started', 'completed', 'failed', 'waitingConfirmation']),
  unknownEffect: z.boolean().optional(),
});

/** Bound by the trusted host, never by a model-provided conversation/owner or
 * scope. Every read, archive and plan update rechecks current source authority. */
export class AgentContextService {
  readonly #access: AiRuntimeAccess;
  #historyPageBudget: number | null = null;
  readonly #pageFit = new AsyncLocalStorage<
    (body: string, plan: AgentTaskPlan | null) => boolean
  >();
  /** Trusted host scope for the current tool call, never a model-supplied field. */
  withHistoryPageFit<T>(
    fits: (body: string, plan: AgentTaskPlan | null) => boolean,
    work: () => Promise<T>,
  ): Promise<T> {
    return this.#pageFit.run(fits, work);
  }
  constructor(
    readonly db: Database,
    readonly scope: AiCheckpointScope,
    readonly authorizeSources: () => Promise<void>,
  ) {
    this.#access = new AiRuntimeAccess(db);
  }
  async #withScope<T>(
    actor: ActorContext,
    write: boolean,
    work: (tx: SqlExecutor) => Promise<T>,
  ): Promise<T> {
    await this.authorizeSources();
    return this.#access.withAccess(
      actor,
      this.scope,
      async (tx) => {
        await conversationRow(
          tx,
          actor,
          this.scope.conversationId,
          write,
          true,
        );
        return work(tx);
      },
      write,
    );
  }
  async #row(tx: SqlExecutor, lock = false): Promise<PlanRow | undefined> {
    return (
      await tx.query<PlanRow>(
        `SELECT source_stamp,plan,row_version FROM app.agent_task_plans WHERE conversation_id=$1 AND owner_id=$2 ${lock ? 'FOR UPDATE' : ''}`,
        [this.scope.conversationId, this.scope.ownerId],
      )
    ).rows[0];
  }
  #receipt(row: PlanRow | undefined): AgentTaskPlanReceipt {
    const valid = row?.source_stamp === this.scope.threadKey;
    return agentTaskPlanReceiptSchema.parse({
      plan: valid ? agentTaskPlanSchema.parse(row.plan) : null,
      rowVersion: row?.row_version ?? 0,
      availability: !row ? 'empty' : valid ? 'available' : 'sourceChanged',
      evidenceMeaning: receiptMeaning,
      executionQueue: false,
    });
  }
  async readPlan(actor: ActorContext): Promise<AgentTaskPlanReceipt> {
    return this.#withScope(actor, false, async (tx) =>
      this.#receipt(await this.#row(tx)),
    );
  }
  async updatePlan(
    actor: ActorContext,
    raw: unknown,
  ): Promise<AgentTaskPlanReceipt> {
    const input = agentTaskPlanUpdateSchema.parse(raw);
    if (
      new Set(input.plan.items.map((item) => item.id)).size !==
      input.plan.items.length
    )
      throw new DomainError(
        'VALIDATION_ERROR',
        '任务计划的工作项标识不可重复。',
        400,
      );
    return this.#withScope(actor, true, async (tx) => {
      const current = await this.#row(tx, true);
      if (input.rowVersion !== (current?.row_version ?? 0)) stale();
      for (const item of input.plan.items) {
        if (item.status !== 'completed') continue;
        if (!item.evidence.length)
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '完成工作项必须引用本会话真实工具回执；模型文字不构成完成证据。',
            422,
          );
        for (const evidence of item.evidence) {
          const events = await tx.query<{ payload: unknown }>(
            `SELECT e.payload FROM app.ai_task_events e JOIN app.ai_tasks t ON t.id=e.task_id
             WHERE t.owner_id=$1 AND t.conversation_id=$2 AND t.id=$3
             AND e.event_type='ai.tool' AND e.payload->>'invocationId'=$4 ORDER BY e.sequence`,
            [
              actor.userId,
              this.scope.conversationId,
              evidence.taskId,
              evidence.invocationId,
            ],
          );
          const facts = events.rows.map((event) =>
            factSchema.safeParse(event.payload),
          );
          if (!facts.length || facts.some((fact) => !fact.success))
            throw new DomainError(
              'PRECONDITIONS_MISSING',
              '未找到可核验的原工具回执，工作项不能标为完成。',
              422,
            );
          const parsed = facts.flatMap((fact) =>
            fact.success ? [fact.data] : [],
          );
          if (parsed.some((fact) => fact.unknownEffect === true))
            throw new DomainError(
              'OPERATION_RESULT_UNKNOWN',
              '原工具结果未知，请查询原回执；未完成工作项，也不会重放操作。',
              409,
            );
          if (parsed.at(-1)?.state !== 'completed')
            throw new DomainError(
              'PRECONDITIONS_MISSING',
              '原工具尚未完成，工作项不能标为完成。',
              422,
            );
        }
      }
      const saved = (
        await tx.query<PlanRow>(
          `INSERT INTO app.agent_task_plans(conversation_id,owner_id,source_stamp,plan)
         VALUES($1,$2,$3,$4) ON CONFLICT(conversation_id) DO UPDATE
         SET source_stamp=EXCLUDED.source_stamp,plan=EXCLUDED.plan,
         row_version=app.agent_task_plans.row_version+1,updated_at=clock_timestamp()
         WHERE app.agent_task_plans.owner_id=EXCLUDED.owner_id AND app.agent_task_plans.row_version=$5
         RETURNING source_stamp,plan,row_version`,
          [
            this.scope.conversationId,
            actor.userId,
            this.scope.threadKey,
            input.plan,
            input.rowVersion,
          ],
        )
      ).rows[0];
      if (!saved) stale();
      return this.#receipt(saved);
    });
  }
  async readHistory(actor: ActorContext, raw: unknown) {
    const input = agentContextArchiveReadSchema.parse(raw);
    return this.#withScope(actor, false, async (tx) => {
      const row = (
        await tx.query<{ record: unknown }>(
          `SELECT record FROM app.agent_context_archives
         WHERE owner_id=$1 AND conversation_id=$2 AND source_stamp=$3 AND record_id=$4`,
          [
            actor.userId,
            this.scope.conversationId,
            this.scope.threadKey,
            input.recordId,
          ],
        )
      ).rows[0];
      if (!row)
        throw new DomainError(
          'NOT_FOUND',
          '原上下文摘录不存在或当前来源范围不可读。',
          404,
        );
      const record = agentContextArchiveRecordSchema.parse(row.record);
      let end = Math.min(record.text.length, input.offset + input.limit);
      if (input.offset > record.text.length)
        throw new DomainError(
          'VALIDATION_ERROR',
          '读取位置超出原文范围。',
          400,
        );
      const pageAt = (pageEnd: number) => ({
        ...record,
        text: record.text.slice(input.offset, pageEnd),
        offset: input.offset,
        totalCharacters: record.text.length,
        nextOffset: pageEnd < record.text.length ? pageEnd : null,
        partial: input.offset > 0 || pageEnd < record.text.length,
        archivedDataOnly: true,
        executionAuthority: false,
      });
      const maximum = this.#historyPageBudget;
      const fullFit = this.#pageFit.getStore();
      const plan = fullFit ? this.#receipt(await this.#row(tx)).plan : null;
      const fitsAt = (pageEnd: number) => {
        const body = JSON.stringify(pageAt(pageEnd));
        return (
          (maximum === null || body.length <= maximum) &&
          (fullFit?.(body, plan) ?? true)
        );
      };
      if (!fitsAt(end)) {
        if (!fitsAt(input.offset))
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '当前输入及原文页的必要元数据超过读取预算，请缩小当前输入。',
            422,
          );
        let low = input.offset,
          high = end;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (fitsAt(middle)) low = middle;
          else high = middle - 1;
        }
        if (low === input.offset && end > input.offset)
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '当前输入及原文页的必要元数据超过读取预算，请缩小当前输入。',
            422,
          );
        end = low;
      }
      return pageAt(end);
    });
  }
  /** Trusted retained-history loader output only. Not exposed as tool input. */
  async importArchives(
    actor: ActorContext,
    records: readonly AgentContextArchiveRecord[],
  ): Promise<void> {
    const validated = z
      .array(agentContextArchiveRecordSchema)
      .max(5000)
      .parse(records);
    await this.#withScope(actor, true, async (tx) => {
      for (const record of validated) await this.#archive(tx, record);
    });
  }
  async prepare(
    actor: ActorContext,
    messages: readonly BaseMessage[],
    budget: Omit<AgentContextBudget, 'plan'>,
  ) {
    return this.#withScope(actor, true, async (tx) => {
      const plan = this.#receipt(await this.#row(tx));
      const projection = compactModelMessages(messages, {
        ...budget,
        plan: plan.plan,
      });
      for (const record of projection.archives) await this.#archive(tx, record);
      this.#historyPageBudget = contextHistoryPageBudget(messages, {
        ...budget,
        plan: plan.plan,
      });
      return { ...projection, planAvailability: plan.availability };
    });
  }
  async #archive(tx: SqlExecutor, record: AgentContextArchiveRecord) {
    await tx.query(
      `INSERT INTO app.agent_context_archives(conversation_id,owner_id,source_stamp,record_id,record)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT(conversation_id,source_stamp,record_id) DO NOTHING`,
      [
        this.scope.conversationId,
        this.scope.ownerId,
        this.scope.threadKey,
        record.recordId,
        record,
      ],
    );
  }
}

/** Call from the existing privacy deletion transaction. Handles backups made
 * before this migration as well; no dynamic table names or SQL from users. */
export async function redactAgentContextConversation(
  tx: SqlExecutor,
  ownerId: string,
  conversationId: string,
): Promise<void> {
  const present = (
    await tx.query<{ present: boolean }>(
      "SELECT to_regclass('app.agent_task_plans') IS NOT NULL AND to_regclass('app.agent_context_archives') IS NOT NULL present",
    )
  ).rows[0]?.present;
  if (!present) return;
  await tx.query(
    'DELETE FROM app.agent_task_plans WHERE owner_id=$1 AND conversation_id=$2',
    [ownerId, conversationId],
  );
  await tx.query(
    'DELETE FROM app.agent_context_archives WHERE owner_id=$1 AND conversation_id=$2',
    [ownerId, conversationId],
  );
}
