import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  previewCloseUiProgressBatchInputSchema,
  closeUiProgressBatchInputSchema,
  closeUiProgressBatchReceiptSchema,
  uiProgressClosePreviewSchema,
  uiProgressCloseItemReceiptSchema,
  uiProgressCloseBatchStatusSchema,
} from '../../../contracts/src/ui-results.js';
import {
  commandIdSchema,
  idSchema,
  sha256Schema,
} from '../../../contracts/src/base.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { OperationService, canonicalJson } from '../operations/service.js';
import { DomainError } from '../errors.js';
import { audit } from '../events.js';

type Target = z.infer<
  typeof previewCloseUiProgressBatchInputSchema
>['items'][number];
type ItemReceipt = z.infer<typeof uiProgressCloseItemReceiptSchema>;
type Receipt = z.infer<typeof closeUiProgressBatchReceiptSchema>;
interface ProgressRow {
  id: string;
  kind: 'UI' | 'API';
  state: string;
  row_version: number;
  progress_closed_at: Date | null;
}
const intentOperation = 'ui-executions.close-progress-batch.intent',
  itemOperation = 'ui-executions.close-progress-batch.item',
  finalOperation = 'ui-executions.close-progress-batch';
const manifestSchema = previewCloseUiProgressBatchInputSchema.safeExtend({
  projectId: idSchema,
  scopeDigest: sha256Schema,
});
const digest = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
const normalized = (projectId: string, items: Target[]) => ({
  projectId: projectId.toLowerCase(),
  items: [...items].sort((a, b) =>
    a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0,
  ),
});
const childKey = (
  actor: ActorContext,
  projectId: string,
  key: string,
  target: Target,
) => {
  const value = digest([
    actor.userId,
    projectId,
    key,
    target.runId,
    target.rowVersion,
  ]);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
};
const unknown = () =>
  new DomainError(
    'OPERATION_RESULT_UNKNOWN',
    '原批量操作尚无可用的完整回执，请只读查询原范围，不扩大或重放。',
    409,
  );
/** Platform progress metadata only; no local agent control, result write or run-state transition. */
export class UiProgressBatchService {
  readonly operations: OperationService;
  constructor(readonly db: Database) {
    this.operations = new OperationService(db);
  }
  private async authorize(
    tx: SqlExecutor,
    actor: ActorContext,
    projectId: string,
  ): Promise<void> {
    await requireProject(tx, actor, projectId, 'runs.organize');
  }
  private async lock(
    tx: SqlExecutor,
    actor: ActorContext,
    projectId: string,
    key: string,
  ) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `ui-progress-batch:${actor.userId}:${projectId}:${key}`,
    ]);
  }
  private async final(
    tx: SqlExecutor,
    actor: ActorContext,
    projectId: string,
    key: string,
  ) {
    const row = (
      await tx.query<{
        status: string;
        response: unknown;
        project_id: string | null;
      }>(
        'SELECT status,response,project_id FROM app.commands WHERE actor_id=$1 AND operation=$2 AND key=$3',
        [actor.userId, finalOperation, key],
      )
    ).rows[0];
    if (!row) return null;
    const receipt = closeUiProgressBatchReceiptSchema.safeParse(row.response);
    if (
      row.status !== 'completed' ||
      row.project_id !== projectId ||
      !receipt.success
    )
      throw unknown();
    return receipt.data;
  }
  private skipped(
    target: Target,
    code: string,
    status: 'conflict' | 'skipped' = 'skipped',
  ): ItemReceipt {
    return {
      runId: target.runId,
      baseRowVersion: target.rowVersion,
      status,
      rowVersion: null,
      progressClosedAt: null,
      code,
      localExecutionStopped: false,
    };
  }
  async preview(actor: ActorContext, projectId: string, raw: unknown) {
    const scope = normalized(
      projectId,
      previewCloseUiProgressBatchInputSchema.parse(raw).items,
    );
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, scope.projectId, 'runs.organize');
      const rows = await tx.query<ProgressRow>(
        'SELECT id,kind,state,row_version,progress_closed_at FROM app.runs WHERE project_id=$1 AND id=ANY($2::uuid[])',
        [scope.projectId, scope.items.map((item) => item.runId)],
      );
      return uiProgressClosePreviewSchema.parse({
        projectId: scope.projectId,
        scopeDigest: digest(scope),
        items: scope.items.map((target) => {
          const row = rows.rows.find((row) => row.id === target.runId),
            code = !row
              ? 'NOT_FOUND'
              : row.kind !== 'UI'
                ? 'NOT_UI_EXECUTION'
                : row.row_version !== target.rowVersion
                  ? 'STALE_BASE_REVISION'
                  : row.progress_closed_at
                    ? 'ALREADY_CLOSED'
                    : null;
          return {
            ...target,
            actualRowVersion: row?.row_version ?? null,
            kind: row?.kind ?? null,
            state: row?.state ?? null,
            progressClosedAt: row?.progress_closed_at?.toISOString() ?? null,
            eligible: code === null,
            code,
          };
        }),
        localExecutionStopped: false,
      });
    });
  }
  private async item(
    tx: SqlExecutor,
    actor: ActorContext,
    projectId: string,
    key: string,
    target: Target,
  ): Promise<ItemReceipt> {
    await this.lock(tx, actor, projectId, key);
    const finished = await this.final(tx, actor, projectId, key);
    if (finished) {
      const original = finished.items.find(
        (item) =>
          item.runId === target.runId &&
          item.baseRowVersion === target.rowVersion,
      );
      if (!original) throw unknown();
      return original;
    }
    const row = (
      await tx.query<ProgressRow>(
        'SELECT id,kind,state,row_version,progress_closed_at FROM app.runs WHERE project_id=$1 AND id=$2 FOR UPDATE',
        [projectId, target.runId],
      )
    ).rows[0];
    if (!row) return this.skipped(target, 'NOT_FOUND');
    if (row.kind !== 'UI')
      return {
        ...this.skipped(target, 'NOT_UI_EXECUTION'),
        rowVersion: row.row_version,
      };
    if (row.row_version !== target.rowVersion)
      return {
        ...this.skipped(target, 'STALE_BASE_REVISION', 'conflict'),
        rowVersion: row.row_version,
        progressClosedAt: row.progress_closed_at?.toISOString() ?? null,
      };
    if (row.progress_closed_at)
      return {
        ...this.skipped(target, 'ALREADY_CLOSED'),
        status: 'alreadyClosed',
        rowVersion: row.row_version,
        progressClosedAt: row.progress_closed_at.toISOString(),
      };
    const closed = (
      await tx.query<{ row_version: number; progress_closed_at: Date }>(
        'UPDATE app.runs SET progress_closed_at=clock_timestamp(),progress_closed_by=$2,row_version=row_version+1 WHERE id=$1 RETURNING row_version,progress_closed_at',
        [row.id, actor.userId],
      )
    ).rows[0];
    if (!closed) throw unknown();
    await audit(tx, actor, 'ui-execution.progress-closed', row.id, projectId, {
      batchCommandId: key,
    });
    return {
      runId: row.id,
      baseRowVersion: target.rowVersion,
      status: 'closed',
      rowVersion: closed.row_version,
      progressClosedAt: closed.progress_closed_at.toISOString(),
      code: null,
      localExecutionStopped: false,
    };
  }
  private async children(
    tx: SqlExecutor,
    actor: ActorContext,
    projectId: string,
    key: string,
    targets: Target[],
  ) {
    const keys = targets.map((target) =>
      childKey(actor, projectId, key, target),
    );
    const rows = await tx.query<{
      key: string;
      status: string;
      response: unknown;
    }>(
      'SELECT key,status,response FROM app.commands WHERE actor_id=$1 AND operation=$2 AND key=ANY($3::text[])',
      [actor.userId, itemOperation, keys],
    );
    return targets.map((target, index) => {
      const row = rows.rows.find((row) => row.key === keys[index]);
      if (!row) return null;
      const parsed = uiProgressCloseItemReceiptSchema.safeParse(row.response);
      if (
        row.status !== 'completed' ||
        !parsed.success ||
        parsed.data.runId !== target.runId ||
        parsed.data.baseRowVersion !== target.rowVersion
      )
        throw unknown();
      return parsed.data;
    });
  }
  async close(
    actor: ActorContext,
    projectId: string,
    raw: unknown,
  ): Promise<Receipt> {
    const input = closeUiProgressBatchInputSchema.parse(raw),
      scope = normalized(projectId, input.items),
      scopeDigest = digest(scope);
    if (scopeDigest !== input.scopeDigest)
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '批量关闭范围摘要不匹配，请核对精确执行ID与版本。',
        409,
      );
    const original = await this.db.transaction(async (tx) => {
      await this.authorize(tx, actor, scope.projectId);
      return this.final(tx, actor, scope.projectId, input.commandId);
    });
    if (original) {
      if (original.scopeDigest !== scopeDigest)
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          '原批量提交标识已绑定另一份精确范围。',
          409,
        );
      return original;
    }
    const manifest = await this.operations.execute(
      actor,
      intentOperation,
      input.commandId,
      { ...scope, scopeDigest },
      (tx) => this.authorize(tx, actor, scope.projectId),
      async () => ({ ...scope, scopeDigest }),
      scope.projectId,
    );
    const finished = await this.db.transaction(async (tx) => {
      await requireProject(tx, actor, scope.projectId, 'runs.organize');
      return this.final(tx, actor, scope.projectId, input.commandId);
    });
    if (finished) {
      if (finished.scopeDigest !== scopeDigest)
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          '原批量提交标识已绑定另一份精确范围。',
          409,
        );
      return finished;
    }
    const failures = new Map<string, ItemReceipt>();
    for (const target of manifest.items) {
      try {
        await this.operations.execute(
          actor,
          itemOperation,
          childKey(actor, scope.projectId, input.commandId, target),
          { parentCommandId: input.commandId, scopeDigest, ...target },
          (tx) => this.authorize(tx, actor, scope.projectId),
          (tx) =>
            this.item(tx, actor, scope.projectId, input.commandId, target),
          scope.projectId,
        );
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        failures.set(
          target.runId,
          this.skipped(
            target,
            error.code,
            error.code === 'STALE_BASE_REVISION' ||
              error.code === 'OPERATION_RESULT_UNKNOWN'
              ? 'conflict'
              : 'skipped',
          ),
        );
      }
    }
    return this.operations.execute(
      actor,
      finalOperation,
      input.commandId,
      { ...scope, scopeDigest },
      (tx) => this.authorize(tx, actor, scope.projectId),
      async (tx) => {
        await this.lock(tx, actor, scope.projectId, input.commandId);
        const receipts = await this.children(
          tx,
          actor,
          scope.projectId,
          input.commandId,
          manifest.items,
        );
        const result = closeUiProgressBatchReceiptSchema.parse({
          commandId: input.commandId,
          projectId: scope.projectId,
          scopeDigest,
          items: receipts.map(
            (receipt, index) =>
              receipt ??
              failures.get(manifest.items[index]!.runId) ??
              this.skipped(
                manifest.items[index]!,
                'OPERATION_RESULT_UNKNOWN',
                'conflict',
              ),
          ),
          localExecutionStopped: false,
        });
        const parent = (
          await tx.query<{ id: string }>(
            'SELECT id FROM app.commands WHERE actor_id=$1 AND operation=$2 AND key=$3',
            [actor.userId, intentOperation, input.commandId],
          )
        ).rows[0];
        if (!parent) throw unknown();
        await audit(
          tx,
          actor,
          'ui-execution.progress-batch-closed',
          parent.id,
          scope.projectId,
          {
            scopeDigest,
            requested: manifest.items.length,
            closed: result.items.filter((item) => item.status === 'closed')
              .length,
          },
        );
        return result;
      },
      scope.projectId,
    );
  }
  async receipt(actor: ActorContext, projectId: string, key: string) {
    commandIdSchema.parse(key);
    const p = projectId.toLowerCase();
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, p, 'project.read');
      const complete = await this.final(tx, actor, p, key);
      if (complete)
        return uiProgressCloseBatchStatusSchema.parse({
          commandId: key,
          projectId: p,
          scopeDigest: complete.scopeDigest,
          state: 'completed',
          receipt: complete,
          items: complete.items.map((item) => ({
            runId: item.runId,
            rowVersion: item.baseRowVersion,
            receipt: item,
          })),
          localExecutionStopped: false,
        });
      const intent = (
        await tx.query<{
          project_id: string | null;
          response: unknown;
          status: string;
        }>(
          'SELECT project_id,response,status FROM app.commands WHERE actor_id=$1 AND operation=$2 AND key=$3',
          [actor.userId, intentOperation, key],
        )
      ).rows[0];
      const parsed = manifestSchema.safeParse(intent?.response);
      if (!intent || intent.project_id !== p)
        throw new DomainError(
          'NOT_FOUND',
          '暂未检索到本人该原批量范围；不能据此重新提交。',
          404,
        );
      if (intent.status !== 'completed' || !parsed.success) throw unknown();
      const scope = normalized(p, parsed.data.items),
        items = await this.children(tx, actor, p, key, scope.items);
      return uiProgressCloseBatchStatusSchema.parse({
        commandId: key,
        projectId: p,
        scopeDigest: digest(scope),
        state: complete ? 'completed' : 'receiptIncomplete',
        receipt: complete,
        items: scope.items.map((target, index) => ({
          ...target,
          receipt: items[index] ?? null,
        })),
        localExecutionStopped: false,
      });
    });
  }
}
