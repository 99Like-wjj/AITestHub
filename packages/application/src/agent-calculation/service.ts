import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  calculationArtifactSchema,
  calculationImportInputSchema,
  calculationImportReceiptSchema,
  calculationImportStatusSchema,
  calculationReceiptSchema,
  calculationRunInputSchema,
  calculationSourceSnapshotSchema,
  type CalculationReceipt,
} from '../../../contracts/src/agent-calculation.js';
import {
  sandboxLimits,
  sandboxResultSchema,
  type AgentSandboxPort,
  type SandboxResult,
  type SandboxPending,
} from '../../../contracts/src/agent-sandbox.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import { commandIdSchema, idSchema } from '../../../contracts/src/base.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import type { AgentWorkspaceService } from '../agent-workspace/service.js';
import { conversationRow } from '../conversations/common.js';
import { assertTaskCapability } from '../conversations/task-capabilities.js';
import { DomainError } from '../errors.js';
import { canonicalJson } from '../operations/service.js';

export interface SandboxControlPort extends AgentSandboxPort {
  status(
    runId: string,
  ): Promise<
    | SandboxResult
    | SandboxPending
    | { runId: string; state: 'result_unavailable'; cleanupConfirmed: boolean }
  >;
  cancel(runId: string): Promise<void>;
}
export interface AgentCalculationScope {
  conversationId: string;
  taskId: string;
  authorize: () => Promise<void>;
  signal?: AbortSignal;
  authorizeResource: (resourceId: string) => Promise<void>;
}
type SourceSnapshot = z.infer<typeof calculationSourceSnapshotSchema>;
type Artifact = z.infer<typeof calculationArtifactSchema>;
interface RunRow {
  id: string;
  owner_id: string;
  conversation_id: string;
  task_id: string;
  request_digest: string;
  state: string;
  request: unknown;
  source_snapshot: unknown;
  sandbox_result: unknown;
  artifacts: unknown;
  cancel_requested: boolean;
  error_code: string | null;
  created_at: Date;
  finished_at: Date | null;
}
const hash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
const terminal = new Set([
  'completed',
  'execution_failed',
  'cancelled',
  'artifact_conflict',
]);

/** One recorded code execution; the model cannot choose owner, runtime or host authority. */
export class AgentCalculationService {
  constructor(
    readonly db: Database,
    readonly workspace: Pick<
      AgentWorkspaceService,
      'readBytes' | 'putBytes' | 'listManifest' | 'history'
    > &
      Partial<
        Pick<AgentWorkspaceService, 'importTaskResource' | 'taskImportReceipt'>
      >,
    readonly sandbox: SandboxControlPort,
  ) {}

  async #authorize(
    tx: SqlExecutor,
    actor: ActorContext,
    scope: AgentCalculationScope,
    start = false,
  ) {
    if (actor.entrypoint !== 'internal-ai')
      throw new DomainError(
        'FORBIDDEN',
        '计算入口只供本人受控对话任务使用。',
        403,
      );
    const conversation = await conversationRow(
      tx,
      actor,
      scope.conversationId,
      start,
      true,
    );
    const task = await assertTaskCapability(tx, actor, scope, 'office');
    if (
      start &&
      (conversation.archived_at ||
        task.state !== 'running' ||
        task.cancelRequestedAt ||
        scope.signal?.aborted)
    )
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '当前任务已停止或会话已归档，未开始新的计算。',
        409,
      );
  }

  async #row(
    actor: ActorContext,
    scope: AgentCalculationScope,
    runId: string,
  ): Promise<RunRow> {
    z.uuid().parse(runId);
    await scope.authorize();
    return this.db.transaction(async (tx) => {
      await this.#authorize(tx, actor, scope);
      const row = (
        await tx.query<RunRow>(
          'SELECT * FROM app.agent_calculation_runs WHERE id=$1 AND owner_id=$2 AND conversation_id=$3',
          [runId, actor.userId, scope.conversationId],
        )
      ).rows[0];
      if (!row)
        throw new DomainError(
          'NOT_FOUND',
          '计算运行不存在或当前不可访问。',
          404,
        );
      return row;
    });
  }

  async #verifySources(
    actor: ActorContext,
    scope: AgentCalculationScope,
    row: RunRow,
  ) {
    const sources = z
      .array(calculationSourceSnapshotSchema)
      .parse(row.source_snapshot);
    for (const source of sources) {
      await scope.authorizeResource(source.resourceId);
      const current = await this.workspace.readBytes(
        actor,
        scope.conversationId,
        source.entryId,
        source.revision,
      );
      if (
        current.entry.resourceId !== source.resourceId ||
        current.entry.sha256 !== source.sha256 ||
        current.bytes.length !== source.sizeBytes
      )
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '原计算来源已改变，不能继续读取其派生结果。',
          422,
        );
    }
    await scope.authorize();
  }

  #receipt(row: RunRow, replayed = false): CalculationReceipt {
    const result =
      row.sandbox_result === null
        ? null
        : sandboxResultSchema.parse(row.sandbox_result);
    return calculationReceiptSchema.parse({
      runId: row.id,
      taskId: row.task_id,
      state: row.state,
      executionState: result?.state ?? null,
      cleanupConfirmed: result?.cleanupConfirmed ?? null,
      cancelRequested: row.cancel_requested,
      requestSha256: row.request_digest,
      sources: row.source_snapshot,
      artifacts: row.artifacts,
      stdout: result?.stdout.slice(0, 16_000) ?? '',
      stderr: result?.stderr.slice(0, 16_000) ?? '',
      outputPartial: Boolean(
        (result?.stdout.length ?? 0) > 16_000 ||
        (result?.stderr.length ?? 0) > 16_000,
      ),
      stdoutCharacters: result?.stdout.length ?? 0,
      stderrCharacters: result?.stderr.length ?? 0,
      errorCode: row.error_code,
      createdAt: row.created_at.toISOString(),
      finishedAt: row.finished_at?.toISOString() ?? null,
      replayed,
      automaticReplay: false,
    });
  }

  async #update(
    runId: string,
    state: string,
    errorCode: string | null,
    result?: SandboxResult,
    artifacts?: Artifact[],
  ) {
    // A concurrent privacy deletion must never be overwritten with late private results.
    await this.db.query(
      `UPDATE app.agent_calculation_runs r SET state=$2,error_code=$3,
       sandbox_result=CASE WHEN $4::jsonb IS NULL THEN sandbox_result ELSE $4::jsonb END,
       artifacts=CASE WHEN $5::jsonb IS NULL THEN artifacts ELSE $5::jsonb END,
       finished_at=CASE WHEN $2 IN ('completed','execution_failed','cancelled','artifact_conflict') THEN clock_timestamp() ELSE NULL END
       WHERE id=$1 AND EXISTS(SELECT 1 FROM app.ai_conversations c WHERE c.id=r.conversation_id AND c.owner_id=r.owner_id AND c.deleted_at IS NULL)
       AND (NOT cancel_requested OR $2 IN ('cancelled','unknown'))`,
      [
        runId,
        state,
        errorCode,
        result === undefined ? null : JSON.stringify(result),
        artifacts === undefined ? null : JSON.stringify(artifacts),
      ],
    );
  }

  async importResource(
    actor: ActorContext,
    scope: AgentCalculationScope,
    raw: unknown,
  ) {
    const input = calculationImportInputSchema.parse(raw);
    await scope.authorize();
    await this.db.transaction((tx) => this.#authorize(tx, actor, scope, true));
    if (!this.workspace.importTaskResource)
      throw new DomainError(
        'DEPENDENCY_UNAVAILABLE',
        '当前工作区没有接入任务原件导入能力。',
        503,
      );
    const receipt = await this.workspace.importTaskResource(
      actor,
      scope,
      input,
    );
    return calculationImportReceiptSchema.parse({
      ...receipt,
      commandId: input.commandId,
      taskId: idSchema.parse(scope.taskId).toLowerCase(),
      sourceResourceId: receipt.entry.resourceId,
      sourceResourceIds: [receipt.entry.resourceId],
      automaticReplay: false,
    });
  }

  async importStatus(
    actor: ActorContext,
    scope: AgentCalculationScope,
    commandId: string,
    originTaskId = scope.taskId,
  ) {
    commandIdSchema.parse(commandId);
    const originalTaskId = idSchema.parse(originTaskId).toLowerCase();
    await scope.authorize();
    await this.db.transaction((tx) => this.#authorize(tx, actor, scope));
    if (!this.workspace.taskImportReceipt)
      throw new DomainError(
        'DEPENDENCY_UNAVAILABLE',
        '当前工作区没有接入任务原件回执查询能力。',
        503,
      );
    const result = await this.workspace.taskImportReceipt(
      actor,
      scope,
      commandId,
      originalTaskId,
    );
    return calculationImportStatusSchema.parse({
      commandId,
      originTaskId: originalTaskId,
      found: result.found,
      receipt: result.receipt
        ? {
            ...result.receipt,
            commandId,
            taskId: originalTaskId,
            sourceResourceId: result.receipt.entry.resourceId,
            sourceResourceIds: [result.receipt.entry.resourceId],
            automaticReplay: false,
          }
        : null,
      sourceResourceIds: result.receipt
        ? [result.receipt.entry.resourceId]
        : [],
      automaticReplay: false,
      notice: result.found
        ? '已找到原导入命令的已提交回执；查询没有重新导入或新增版本。'
        : '本次查询未确认原命令回执，不代表命令从未执行；不得自动换commandId重试。',
    });
  }

  async files(
    actor: ActorContext,
    scope: AgentCalculationScope,
    offset = 0,
    limit = 50,
  ) {
    z.number().int().min(0).parse(offset);
    z.number().int().min(1).max(100).parse(limit);
    await scope.authorize();
    await this.db.transaction((tx) => this.#authorize(tx, actor, scope));
    const manifest = await this.workspace.listManifest(
      actor,
      scope.conversationId,
    );
    const entries = [];
    for (const entry of manifest.entries) {
      try {
        await scope.authorizeResource(entry.resourceId);
        entries.push(entry);
      } catch (error: unknown) {
        if (
          !(error instanceof DomainError) ||
          !['FORBIDDEN', 'NOT_FOUND'].includes(error.code)
        )
          throw error;
      }
    }
    return {
      entries: entries.slice(offset, offset + limit),
      total: entries.length,
      nextOffset: offset + limit < entries.length ? offset + limit : null,
      notice:
        '条目仅表示可用来源；代码执行必须明确指定entryId、revision和沙箱相对路径。',
    };
  }

  async run(
    actor: ActorContext,
    scope: AgentCalculationScope,
    raw: unknown,
  ): Promise<CalculationReceipt> {
    const request = calculationRunInputSchema.parse(raw);
    if (Buffer.byteLength(request.code) > sandboxLimits.maxCodeBytes)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '代码超过单次执行字节限额。',
        422,
      );
    await scope.authorize();
    await this.db.transaction((tx) => this.#authorize(tx, actor, scope, true));
    const sources: SourceSnapshot[] = [];
    const files: { path: string; contentBase64: string }[] = [];
    let total = 0;
    const manifest = await this.workspace.listManifest(
      actor,
      scope.conversationId,
    );
    for (const input of request.inputs) {
      if (
        !manifest.entries.some(
          (entry) =>
            entry.id === input.entryId && entry.available && !entry.deletedAt,
        )
      )
        throw new DomainError(
          'NOT_FOUND',
          '新计算不能读取已移除或不可用的工作区文件。',
          404,
        );
      const history = await this.workspace.history(
        actor,
        scope.conversationId,
        input.entryId,
      );
      const version = history.versions.find(
        (item) => item.revision === input.revision && item.available,
      );
      if (!version)
        throw new DomainError(
          'NOT_FOUND',
          '输入版本不存在或当前不可读取。',
          404,
        );
      await scope.authorizeResource(version.resourceId);
      const read = await this.workspace.readBytes(
        actor,
        scope.conversationId,
        input.entryId,
        input.revision,
      );
      total += read.bytes.length;
      if (
        read.bytes.length > sandboxLimits.maxFileBytes ||
        total > sandboxLimits.maxTotalFileBytes
      )
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '计算输入超过单文件4MiB或合计16MiB限额，请明确缩小数据范围；没有截断。',
          422,
        );
      sources.push({
        ...input,
        resourceId: read.entry.resourceId,
        sha256: read.entry.sha256,
        sizeBytes: read.bytes.length,
      });
      files.push({
        path: input.path,
        contentBase64: read.bytes.toString('base64'),
      });
    }
    const { commandId, ...execution } = request;
    const digest = hash(canonicalJson({ execution, sources }));
    const selected = await this.db.transaction(async (tx) => {
      await this.#authorize(tx, actor, scope, true);
      const inserted = await tx.query<RunRow>(
        `INSERT INTO app.agent_calculation_runs(id,owner_id,conversation_id,task_id,command_id,request_digest,state,request,source_snapshot)
         VALUES($1,$2,$3,$4,$5,$6,'prepared',$7,$8) ON CONFLICT DO NOTHING RETURNING *`,
        [
          randomUUID(),
          actor.userId,
          scope.conversationId,
          scope.taskId,
          commandId,
          digest,
          JSON.stringify(request),
          JSON.stringify(sources),
        ],
      );
      const row =
        inserted.rows[0] ??
        (
          await tx.query<RunRow>(
            'SELECT * FROM app.agent_calculation_runs WHERE owner_id=$1 AND (command_id=$2 OR (task_id=$3 AND request_digest=$4)) ORDER BY created_at LIMIT 1',
            [actor.userId, commandId, scope.taskId, digest],
          )
        ).rows[0];
      if (
        !row ||
        row.conversation_id !== scope.conversationId ||
        row.request_digest !== digest
      )
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          '原计算命令对应不同请求，必须先核对原回执。',
          409,
        );
      return { row, fresh: Boolean(inserted.rowCount) };
    });
    if (!selected.fresh) {
      await this.#verifySources(actor, scope, selected.row);
      return this.#receipt(selected.row, true);
    }
    try {
      await scope.authorize();
      await this.db.transaction((tx) =>
        this.#authorize(tx, actor, scope, true),
      );
      await this.#verifySources(actor, scope, selected.row);
      const latest = await this.workspace.listManifest(
        actor,
        scope.conversationId,
      );
      if (
        sources.some(
          (source) =>
            !latest.entries.some(
              (entry) =>
                entry.id === source.entryId &&
                entry.available &&
                !entry.deletedAt,
            ),
        )
      )
        throw new DomainError(
          'NOT_FOUND',
          '发送前工作区来源已移除，未执行计算。',
          404,
        );
    } catch (error: unknown) {
      await this.#update(selected.row.id, 'cancelled', 'NOT_DISPATCHED');
      throw error;
    }
    const claimed = await this.db.transaction(async (tx) => {
      await this.#authorize(tx, actor, scope, true);
      return tx.query(
        "UPDATE app.agent_calculation_runs SET state='running' WHERE id=$1 AND state='prepared' AND NOT cancel_requested RETURNING id",
        [selected.row.id],
      );
    });
    if (!claimed.rowCount)
      return this.#receipt(
        await this.#row(actor, scope, selected.row.id),
        true,
      );
    let result: SandboxResult;
    try {
      result = sandboxResultSchema.parse(
        await this.sandbox.execute(
          {
            runId: selected.row.id,
            language: 'python',
            code: request.code,
            files,
            timeoutMs: request.timeoutMs,
          },
          scope.signal,
        ),
      );
      if (result.runId !== selected.row.id || result.state === 'running')
        throw new Error('SANDBOX_RUN_RESULT_MISMATCH');
    } catch {
      await this.#update(selected.row.id, 'unknown', 'SANDBOX_RESULT_UNKNOWN');
      return this.#receipt(await this.#row(actor, scope, selected.row.id));
    }
    await this.#settle(actor, scope, selected.row.id, result);
    const row = await this.#row(actor, scope, selected.row.id);
    await this.#verifySources(actor, scope, row);
    return this.#receipt(row);
  }

  async #recordSandboxResult(
    actor: ActorContext,
    scope: AgentCalculationScope,
    runId: string,
    result: SandboxResult,
  ) {
    if (result.runId !== runId || result.state === 'running')
      throw new Error('SANDBOX_RUN_RESULT_MISMATCH');
    if (actor.entrypoint !== 'internal-ai')
      throw new DomainError(
        'FORBIDDEN',
        '计算入口只供本人受控对话任务使用。',
        403,
      );
    return this.db.transaction(async (tx) => {
      // Lock in privacy deletion order. An EXISTS check alone can observe a stale
      // conversation snapshot after waiting for its redaction trigger's run lock.
      const conversation = await tx.query(
        `SELECT id FROM app.ai_conversations
         WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE`,
        [scope.conversationId, actor.userId],
      );
      if (!conversation.rowCount) return false;
      const current = (
        await tx.query<{
          state: string;
          cancel_requested: boolean;
          task_state: string;
          cancel_requested_at: Date | null;
        }>(
          `SELECT r.state,r.cancel_requested,t.state AS task_state,t.cancel_requested_at
           FROM app.agent_calculation_runs r JOIN app.ai_tasks t ON t.id=r.task_id
           AND t.owner_id=r.owner_id AND t.conversation_id=r.conversation_id
           WHERE r.id=$1 AND r.owner_id=$2 AND r.conversation_id=$3 FOR UPDATE OF r`,
          [runId, actor.userId, scope.conversationId],
        )
      ).rows[0];
      if (!current) return false;
      if (terminal.has(current.state)) return true;
      const cancelled =
        current.cancel_requested ||
        current.task_state === 'cancelled' ||
        current.cancel_requested_at !== null ||
        scope.signal?.aborted ||
        result.state === 'cancelled';
      const cleanupConfirmed =
        result.cleanupConfirmed && result.state !== 'cleanup_unknown';
      const physicallySettled = cancelled || !cleanupConfirmed;
      await tx.query(
        `UPDATE app.agent_calculation_runs SET sandbox_result=$2,
         state=CASE WHEN $3 THEN $4 ELSE state END,
         error_code=CASE WHEN $3 THEN $5 ELSE error_code END,
         finished_at=CASE WHEN $3 THEN CASE WHEN $6 THEN clock_timestamp() ELSE NULL END ELSE finished_at END
         WHERE id=$1`,
        [
          runId,
          JSON.stringify(result),
          Boolean(physicallySettled),
          cleanupConfirmed ? 'cancelled' : 'unknown',
          cleanupConfirmed ? null : 'CLEANUP_UNKNOWN',
          cleanupConfirmed,
        ],
      );
      return Boolean(physicallySettled);
    });
  }

  async #settle(
    actor: ActorContext,
    scope: AgentCalculationScope,
    runId: string,
    result: SandboxResult,
  ) {
    // Physical cancellation must settle even when the task's model-facing
    // authorization has already expired. It grants no result/source access.
    if (await this.#recordSandboxResult(actor, scope, runId, result)) return;
    let current: RunRow;
    try {
      current = await this.#row(actor, scope, runId);
    } catch (error) {
      // A cancellation can land between receipt persistence and authorization.
      await this.#recordSandboxResult(actor, scope, runId, result);
      throw error;
    }
    if (
      current.cancel_requested ||
      scope.signal?.aborted ||
      result.state === 'cancelled'
    ) {
      await this.#update(
        runId,
        result.cleanupConfirmed ? 'cancelled' : 'unknown',
        result.cleanupConfirmed ? null : 'CLEANUP_UNKNOWN',
        result,
      );
      return;
    }
    if (!result.cleanupConfirmed || result.state === 'cleanup_unknown') {
      await this.#update(runId, 'unknown', 'CLEANUP_UNKNOWN', result);
      return;
    }
    if (result.state !== 'completed') {
      await this.#update(
        runId,
        'execution_failed',
        result.state.toUpperCase(),
        result,
      );
      return;
    }
    await this.#update(runId, 'publishing', null, result);
    await this.#publish(actor, scope, runId);
  }

  async #publish(
    actor: ActorContext,
    scope: AgentCalculationScope,
    runId: string,
  ) {
    const row = await this.#row(actor, scope, runId);
    if (row.state !== 'publishing' || row.cancel_requested) return;
    await this.#verifySources(actor, scope, row);
    const request = calculationRunInputSchema.parse(row.request);
    const result = sandboxResultSchema.parse(row.sandbox_result);
    const artifacts: Artifact[] = [];
    try {
      for (const [index, output] of request.outputs.entries()) {
        await scope.authorize();
        const current = await this.#row(actor, scope, runId);
        if (current.cancel_requested || scope.signal?.aborted) {
          await this.#update(runId, 'cancelled', null, undefined, artifacts);
          return;
        }
        const file = result.files.find((item) => item.path === output.path);
        if (!file)
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '代码没有生成所声明的产物。',
            422,
          );
        const bytes = Buffer.from(file.contentBase64, 'base64');
        if (hash(bytes) !== file.sha256 || bytes.length !== file.sizeBytes)
          throw new DomainError(
            'FILE_HASH_MISMATCH',
            '沙箱产物字节与回执不一致。',
            422,
          );
        const saved = await this.workspace.putBytes(
          actor,
          scope.conversationId,
          {
            commandId: `calculation:${runId}:${index}`,
            path: output.workspacePath,
            expectedRowVersion: output.expectedRowVersion,
            mediaType: output.mediaType,
          },
          bytes,
        );
        artifacts.push({
          sandboxPath: output.path,
          entry: saved.entry,
          downloadPath: `/api/v1/me/conversations/${scope.conversationId}/workspace/entries/${saved.entry.id}/content?revision=${saved.entry.revision}`,
        });
        await this.#update(runId, 'publishing', null, undefined, artifacts);
      }
      await scope.authorize();
      await this.#update(runId, 'completed', null, undefined, artifacts);
    } catch (error: unknown) {
      const code =
        error instanceof DomainError ? error.code : 'ARTIFACT_RESULT_UNKNOWN';
      await this.#update(
        runId,
        error instanceof DomainError ? 'artifact_conflict' : 'unknown',
        code,
        undefined,
        artifacts,
      );
    }
  }

  async status(
    actor: ActorContext,
    scope: AgentCalculationScope,
    runId: string,
  ): Promise<CalculationReceipt> {
    let row = await this.#row(actor, scope, runId);
    await this.#verifySources(actor, scope, row);
    if (!terminal.has(row.state)) {
      if (row.state === 'publishing') await this.#publish(actor, scope, runId);
      else if (row.sandbox_result !== null)
        await this.#settle(
          actor,
          scope,
          runId,
          sandboxResultSchema.parse(row.sandbox_result),
        );
      else if (row.state !== 'prepared') {
        try {
          const status = await this.sandbox.status(runId);
          if (status.runId !== runId)
            throw new Error('SANDBOX_STATUS_MISMATCH');
          if (status.state === 'result_unavailable')
            await this.#update(
              runId,
              'unknown',
              status.cleanupConfirmed
                ? 'RESULT_UNAVAILABLE'
                : 'CLEANUP_UNKNOWN',
            );
          else if (status.state !== 'running' && status.state !== 'queued')
            await this.#settle(
              actor,
              scope,
              runId,
              sandboxResultSchema.parse(status),
            );
        } catch (error: unknown) {
          if (error instanceof DomainError) throw error;
          await this.#update(runId, 'unknown', 'SANDBOX_STATUS_UNAVAILABLE');
        }
      }
      row = await this.#row(actor, scope, runId);
    }
    await this.#verifySources(actor, scope, row);
    return this.#receipt(row, true);
  }

  async cancel(
    actor: ActorContext,
    scope: AgentCalculationScope,
    runId: string,
  ): Promise<CalculationReceipt> {
    const row = await this.#row(actor, scope, runId);
    await this.#verifySources(actor, scope, row);
    if (terminal.has(row.state)) return this.#receipt(row, true);
    await this.db.query(
      'UPDATE app.agent_calculation_runs SET cancel_requested=true WHERE id=$1 AND owner_id=$2',
      [runId, actor.userId],
    );
    if (row.state === 'prepared' || row.state === 'publishing')
      await this.#update(runId, 'cancelled', 'CANCELLED_BEFORE_NEXT_STEP');
    else {
      try {
        await this.sandbox.cancel(runId);
      } catch {
        await this.#update(runId, 'unknown', 'CANCEL_REQUEST_UNKNOWN');
      }
    }
    return this.status(actor, scope, runId);
  }

  async readOutput(
    actor: ActorContext,
    scope: AgentCalculationScope,
    runId: string,
    channel: 'stdout' | 'stderr',
    offset = 0,
    limit = 10_000,
  ) {
    z.enum(['stdout', 'stderr']).parse(channel);
    z.number().int().min(0).parse(offset);
    z.number().int().min(1).max(20_000).parse(limit);
    const row = await this.#row(actor, scope, runId);
    await this.#verifySources(actor, scope, row);
    const result =
      row.sandbox_result === null
        ? null
        : sandboxResultSchema.parse(row.sandbox_result);
    const text = result?.[channel] ?? '';
    return {
      runId,
      channel,
      text: text.slice(offset, offset + limit),
      offset,
      nextOffset: offset + limit < text.length ? offset + limit : null,
      totalCharacters: text.length,
      partial: offset > 0 || offset + limit < text.length,
      contentSha256: hash(text),
      sourceResourceIds: z
        .array(calculationSourceSnapshotSchema)
        .parse(row.source_snapshot)
        .map((source) => source.resourceId),
      automaticReplay: false,
    };
  }
}
