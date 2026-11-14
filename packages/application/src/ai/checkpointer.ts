import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  compareWritesSortKeys,
  writesSortKey,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
  type CheckpointListOptions,
  type ChannelVersions,
  type PendingWrite,
  type CheckpointPendingWrite,
} from '@langchain/langgraph-checkpoint';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { Database } from '../../../persistence/src/database.js';
import { DomainError } from '../errors.js';
import { AiRuntimeAccess, type AiCheckpointScope } from './access.js';

const checkpointSchema = z.object({
  v: z.number(),
  id: z.string(),
  ts: z.string(),
  channel_values: z.record(z.string(), z.unknown()),
  channel_versions: z.record(z.string(), z.union([z.number(), z.string()])),
  versions_seen: z.record(
    z.string(),
    z.record(z.string(), z.union([z.number(), z.string()])),
  ),
});
const metadataSchema = z
  .object({
    source: z.enum(['input', 'loop', 'update', 'fork']),
    step: z.number(),
    parents: z.record(z.string(), z.string()),
    counters_since_delta_snapshot: z
      .record(z.string(), z.tuple([z.number(), z.number()]))
      .optional(),
  })
  .passthrough();
interface CheckpointRow {
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  checkpoint_type: string;
  checkpoint: Buffer;
  metadata_type: string;
  metadata: Buffer;
}
interface WriteRow {
  task_id: string;
  channel: string;
  value_type: string;
  value: Buffer;
  task_path: string;
  idx: number;
}

/** Owner-bound PostgreSQL checkpoint port. DDL is only in explicit migration 0006. */
export class ScopedPostgresCheckpointer extends BaseCheckpointSaver {
  readonly #access: AiRuntimeAccess;
  constructor(
    readonly db: Database,
    readonly actor: ActorContext,
    readonly scope: AiCheckpointScope,
  ) {
    super();
    this.#access = new AiRuntimeAccess(db);
  }
  async #check(
    config: RunnableConfig,
  ): Promise<{ ns: string; checkpointId: string | undefined }> {
    if (config.configurable?.thread_id !== this.scope.threadKey)
      throw new DomainError('NOT_FOUND', '运行上下文不属于此账号范围。', 404);
    const ns = z
      .string()
      .max(1000)
      .parse(config.configurable.checkpoint_ns ?? '');
    const checkpointId =
      config.configurable.checkpoint_id === undefined
        ? undefined
        : z.string().min(1).max(100).parse(config.configurable.checkpoint_id);
    return { ns, checkpointId };
  }
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { ns, checkpointId } = await this.#check(config);
    return this.#access.withAccess(this.actor, this.scope, async (tx) => {
      const row = (
        await tx.query<CheckpointRow>(
          `SELECT * FROM app.ai_runtime_checkpoints
      WHERE thread_key=$1 AND checkpoint_ns=$2 AND ($3::text IS NULL OR checkpoint_id=$3) ORDER BY checkpoint_id DESC LIMIT 1`,
          [this.scope.threadKey, ns, checkpointId ?? null],
        )
      ).rows[0];
      if (!row) return undefined;
      const checkpoint = checkpointSchema.parse(
        await this.serde.loadsTyped(row.checkpoint_type, row.checkpoint),
      );
      const parsedMetadata = metadataSchema.parse(
        await this.serde.loadsTyped(row.metadata_type, row.metadata),
      );
      const { counters_since_delta_snapshot: counters, ...metadataBase } =
        parsedMetadata;
      const metadata: CheckpointMetadata = {
        ...metadataBase,
        ...(counters ? { counters_since_delta_snapshot: counters } : {}),
      };
      const writes = (
        await tx.query<WriteRow>(
          'SELECT * FROM app.ai_runtime_checkpoint_writes WHERE thread_key=$1 AND checkpoint_ns=$2 AND checkpoint_id=$3',
          [this.scope.threadKey, ns, row.checkpoint_id],
        )
      ).rows;
      writes.sort((a, b) =>
        compareWritesSortKeys(
          writesSortKey(a.task_path, a.task_id, a.idx),
          writesSortKey(b.task_path, b.task_id, b.idx),
        ),
      );
      const pendingWrites: CheckpointPendingWrite[] = [];
      for (const write of writes)
        pendingWrites.push([
          write.task_id,
          write.channel,
          await this.serde.loadsTyped(write.value_type, write.value),
        ]);
      return {
        config: {
          configurable: {
            thread_id: this.scope.threadKey,
            checkpoint_ns: ns,
            checkpoint_id: row.checkpoint_id,
          },
        },
        checkpoint,
        metadata,
        pendingWrites,
        ...(row.parent_checkpoint_id
          ? {
              parentConfig: {
                configurable: {
                  thread_id: this.scope.threadKey,
                  checkpoint_ns: ns,
                  checkpoint_id: row.parent_checkpoint_id,
                },
              },
            }
          : {}),
      };
    });
  }
  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const { ns } = await this.#check(config);
    const limit = z
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(options?.limit ?? 50);
    if (options?.filter && Object.keys(options.filter).length)
      throw new DomainError(
        'UNSUPPORTED_OPERATION',
        '此检查点端口不开放任意元数据查询。',
        400,
      );
    const before = options?.before?.configurable?.checkpoint_id;
    if (before !== undefined) z.string().max(100).parse(before);
    const rows = await this.#access.withAccess(this.actor, this.scope, (tx) =>
      tx.query<{ checkpoint_id: string }>(
        'SELECT checkpoint_id FROM app.ai_runtime_checkpoints WHERE thread_key=$1 AND checkpoint_ns=$2 AND ($3::text IS NULL OR checkpoint_id<$3) ORDER BY checkpoint_id DESC LIMIT $4',
        [this.scope.threadKey, ns, before ?? null, limit],
      ),
    );
    for (const row of rows.rows) {
      const tuple = await this.getTuple({
        configurable: {
          thread_id: this.scope.threadKey,
          checkpoint_ns: ns,
          checkpoint_id: row.checkpoint_id,
        },
      });
      if (tuple) yield tuple;
    }
  }
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    const { ns, checkpointId } = await this.#check(config);
    const [checkpointType, checkpointBytes] =
      await this.serde.dumpsTyped(checkpoint);
    const [metadataType, metadataBytes] = await this.serde.dumpsTyped(metadata);
    await this.#access.withAccess(
      this.actor,
      this.scope,
      (tx) =>
        tx.query(
          `INSERT INTO app.ai_runtime_checkpoints(thread_key,conversation_id,checkpoint_ns,checkpoint_id,parent_checkpoint_id,checkpoint_type,checkpoint,metadata_type,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(thread_key,checkpoint_ns,checkpoint_id) DO NOTHING`,
          [
            this.scope.threadKey,
            this.scope.conversationId,
            ns,
            checkpoint.id,
            checkpointId ?? null,
            checkpointType,
            Buffer.from(checkpointBytes),
            metadataType,
            Buffer.from(metadataBytes),
          ],
        ),
      true,
    );
    return {
      configurable: {
        thread_id: this.scope.threadKey,
        checkpoint_ns: ns,
        checkpoint_id: checkpoint.id,
      },
    };
  }
  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
    taskPath = '',
  ): Promise<void> {
    const { ns, checkpointId } = await this.#check(config);
    if (!checkpointId)
      throw new DomainError(
        'VALIDATION_ERROR',
        '检查点写入缺少目标版本。',
        400,
      );
    const dumped = await Promise.all(
      writes.map(async ([channel, value], index) => {
        const [type, bytes] = await this.serde.dumpsTyped(value);
        return { channel, idx: WRITES_IDX_MAP[channel] ?? index, type, bytes };
      }),
    );
    await this.#access.withAccess(
      this.actor,
      this.scope,
      async (tx) => {
        for (const write of dumped)
          await tx.query(
            `INSERT INTO app.ai_runtime_checkpoint_writes(thread_key,conversation_id,checkpoint_ns,checkpoint_id,task_id,idx,channel,value_type,value,task_path)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(thread_key,checkpoint_ns,checkpoint_id,task_id,idx)
        DO UPDATE SET channel=EXCLUDED.channel,value_type=EXCLUDED.value_type,value=EXCLUDED.value,task_path=EXCLUDED.task_path WHERE app.ai_runtime_checkpoint_writes.idx<0`,
            [
              this.scope.threadKey,
              this.scope.conversationId,
              ns,
              checkpointId,
              taskId,
              write.idx,
              write.channel,
              write.type,
              Buffer.from(write.bytes),
              taskPath,
            ],
          );
      },
      true,
    );
  }
  async deleteThread(threadId: string): Promise<void> {
    await this.#check({ configurable: { thread_id: threadId } });
    await this.#access.withAccess(
      this.actor,
      this.scope,
      async (tx) => {
        await tx.query(
          'DELETE FROM app.ai_runtime_checkpoint_writes WHERE thread_key=$1',
          [this.scope.threadKey],
        );
        await tx.query(
          'DELETE FROM app.ai_runtime_checkpoints WHERE thread_key=$1',
          [this.scope.threadKey],
        );
      },
      true,
    );
  }
}
