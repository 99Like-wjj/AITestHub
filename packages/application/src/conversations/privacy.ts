import { redactAutomaticAuxiliaryConversation } from '../auxiliary/automatic-common.js';
import {
  createHmac,
  randomUUID,
  timingSafeEqual,
  createHash,
} from 'node:crypto';
import { readFile, mkdir, open, link, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { redactDeletedModelAttemptsInTransaction } from './model-attempts.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { idSchema, timestampSchema } from '../../../contracts/src/base.js';
import { canonicalJson } from '../operations/service.js';
import { DomainError } from '../errors.js';
import { redactExternalPrivacyDerivatives } from '../external-mcp/privacy.js';

const deletionSchema = z.strictObject({
  id: idSchema,
  ownerId: idSchema,
  targetType: z.enum(['conversation', 'resource']),
  targetId: idSchema,
  exclusiveResourceIds: z.array(idSchema),
  occurredAt: timestampSchema,
  controlVersion: z.literal(1),
});
export type PrivacyDeletion = z.infer<typeof deletionSchema>;
export interface PrivacyLedgerPort {
  record(entry: PrivacyDeletion): Promise<void>;
}

/** Files stay outside backups/repository. Each signed record is independently atomic and immutable. */
export class FilePrivacyLedger implements PrivacyLedgerPort {
  readonly #key: Buffer;
  constructor(
    readonly directory: string,
    key: Buffer,
  ) {
    if (key.length !== 32)
      throw new Error('Privacy control key must contain 32 bytes.');
    this.#key = key;
  }
  static async fromEnvironment(
    environment: NodeJS.ProcessEnv = process.env,
  ): Promise<FilePrivacyLedger> {
    const root =
      environment.AITESTHUB_LOCAL_ROOT ??
      (environment.LOCALAPPDATA
        ? join(environment.LOCALAPPDATA, 'AITestHub')
        : undefined);
    const directory =
      environment.AITESTHUB_PRIVACY_LEDGER_DIRECTORY ??
      (root ? join(root, 'control', 'privacy-deletions') : undefined);
    const keyFile =
      environment.AITESTHUB_MASTER_KEY_FILE ??
      (root ? join(root, 'secrets', 'platform-master-key') : undefined);
    if (!directory || !keyFile)
      throw new DomainError(
        'DEPENDENCY_UNAVAILABLE',
        '独立隐私删除台账配置不可用。',
        503,
      );
    try {
      const key = (await readFile(keyFile, 'utf8')).trim();
      if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('Invalid key');
      return new FilePrivacyLedger(directory, Buffer.from(key, 'hex'));
    } catch {
      throw new DomainError(
        'DEPENDENCY_UNAVAILABLE',
        '独立隐私删除台账配置不可用。',
        503,
      );
    }
  }
  #signature(entry: PrivacyDeletion): string {
    return createHmac('sha256', this.#key)
      .update(canonicalJson(entry))
      .digest('hex');
  }
  async #read(name: string): Promise<PrivacyDeletion> {
    try {
      const raw = z
        .strictObject({
          entry: deletionSchema,
          signature: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .parse(JSON.parse(await readFile(join(this.directory, name), 'utf8')));
      if (
        !timingSafeEqual(
          Buffer.from(raw.signature, 'hex'),
          Buffer.from(this.#signature(raw.entry), 'hex'),
        )
      )
        throw new Error('Invalid signature');
      if (name !== `${raw.entry.id}.json`)
        throw new Error('Mismatched identity');
      return raw.entry;
    } catch {
      throw new DomainError(
        'DEPENDENCY_UNAVAILABLE',
        '隐私删除控制台账校验失败，恢复后不得开放旧个人资料。',
        503,
      );
    }
  }
  async record(raw: PrivacyDeletion): Promise<void> {
    const entry = deletionSchema.parse(raw);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const finalName = `${entry.id}.json`;
    const temporary = join(this.directory, `${entry.id}.${randomUUID()}.tmp`);
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(temporary, 'wx', 0o600);
      await file.writeFile(
        JSON.stringify({ entry, signature: this.#signature(entry) }) + '\n',
      );
      await file.sync();
      await file.close();
      file = undefined;
      try {
        await link(temporary, join(this.directory, finalName));
      } catch (error: unknown) {
        if (
          !error ||
          typeof error !== 'object' ||
          !('code' in error) ||
          error.code !== 'EEXIST'
        )
          throw error;
        if (canonicalJson(await this.#read(finalName)) !== canonicalJson(entry))
          throw new Error('Conflicting deletion control identity');
      }
    } catch {
      throw new DomainError(
        'DEPENDENCY_UNAVAILABLE',
        '资料访问已关闭，独立删除台账尚待安全同步。',
        503,
      );
    } finally {
      await file?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }
  async records(): Promise<PrivacyDeletion[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error: unknown) {
      throw new DomainError(
        'DEPENDENCY_UNAVAILABLE',
        '隐私删除控制目录不可用，恢复保持隔离。',
        503,
      );
    }
    const entries = await Promise.all(
      names
        .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
        .map((name) => this.#read(name)),
    );
    return entries.sort(
      (a, b) =>
        a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id),
    );
  }
  async watermark(): Promise<{ records: number; digest: string }> {
    const entries = await this.records();
    return {
      records: entries.length,
      digest: createHash('sha256').update(canonicalJson(entries)).digest('hex'),
    };
  }
  async reapply(database: Database): Promise<{
    applied: number;
    orphanSkipped: number;
    watermark: { records: number; digest: string };
  }> {
    const entries = await this.records();
    let applied = 0;
    let orphanSkipped = 0;
    for (const entry of entries)
      await database.transaction(async (tx) => {
        const result = await insertDeletionEvent(tx, entry);
        if (result === 'orphanSkipped') {
          orphanSkipped++;
          return;
        }
        await applyPrivacyDeletion(tx, entry);
        await tx.query(
          "INSERT INTO app.privacy_deletion_replication(event_id,state,recorded_at) VALUES($1,'recorded',clock_timestamp()) ON CONFLICT(event_id) DO UPDATE SET state='recorded',recorded_at=clock_timestamp()",
          [entry.id],
        );
        applied++;
      });
    return { applied, orphanSkipped, watermark: await this.watermark() };
  }
}

export async function insertDeletionEvent(
  tx: SqlExecutor,
  entry: PrivacyDeletion,
): Promise<'applied' | 'orphanSkipped'> {
  deletionSchema.parse(entry);
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `privacy-control:${entry.id.toLowerCase()}`,
  ]);
  const existing = (
    await tx.query<{
      id: string;
      owner_id: string;
      target_type: 'conversation' | 'resource';
      target_id: string;
      exclusive_resource_ids: string[];
      occurred_at: Date;
      control_version: number;
    }>('SELECT * FROM app.privacy_deletion_events WHERE id=$1', [entry.id])
  ).rows[0];
  const semantic = (value: PrivacyDeletion) =>
    canonicalJson({
      ...value,
      id: value.id.toLowerCase(),
      ownerId: value.ownerId.toLowerCase(),
      targetId: value.targetId.toLowerCase(),
      exclusiveResourceIds: [
        ...new Set(value.exclusiveResourceIds.map((id) => id.toLowerCase())),
      ].sort(),
      occurredAt: new Date(value.occurredAt).toISOString(),
    });
  if (
    existing &&
    semantic(entry) !==
      semantic({
        id: existing.id,
        ownerId: existing.owner_id,
        targetType: existing.target_type,
        targetId: existing.target_id,
        exclusiveResourceIds: existing.exclusive_resource_ids,
        occurredAt: existing.occurred_at.toISOString(),
        controlVersion: 1,
      })
  )
    throw new DomainError(
      'BUSINESS_CONFLICT',
      '独立删除控制记录与恢复库同标识事件内容不一致，保持隔离。',
      409,
    );
  const owner = (
    await tx.query('SELECT id FROM app.users WHERE id=$1 FOR SHARE', [
      entry.ownerId,
    ])
  ).rowCount;
  let targetExists = false;
  if (entry.targetType === 'conversation') {
    const target = (
      await tx.query<{ owner_id: string }>(
        'SELECT owner_id FROM app.ai_conversations WHERE id=$1 FOR UPDATE',
        [entry.targetId],
      )
    ).rows[0];
    const runtime = (
      await tx.query<{ owner_id: string }>(
        'SELECT owner_id FROM app.ai_runtime_threads WHERE conversation_id=$1',
        [entry.targetId],
      )
    ).rows[0];
    if (
      (target && target.owner_id !== entry.ownerId.toLowerCase()) ||
      (runtime && runtime.owner_id !== entry.ownerId.toLowerCase())
    )
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '删除控制目标与恢复对象归属冲突，保持隔离。',
        409,
      );
    if (!target && runtime)
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '恢复库存在缺少会话主体的执行上下文，须先核对清理，保持隔离。',
        409,
      );
    targetExists = Boolean(target || runtime);
  }
  const ids = [
    ...new Set([
      ...entry.exclusiveResourceIds,
      ...(entry.targetType === 'resource' ? [entry.targetId] : []),
    ]),
  ].sort();
  const files = ids.length
    ? (
        await tx.query<{
          id: string;
          owner_scope: string;
          owner_user_id: string;
        }>(
          'SELECT id,owner_scope,owner_user_id FROM app.file_resources WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
          [ids],
        )
      ).rows
    : [];
  for (const file of files)
    if (
      file.owner_scope !== 'personal' ||
      file.owner_user_id !== entry.ownerId.toLowerCase()
    )
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '删除控制包含归属不符或正式项目资源，保持隔离。',
        409,
      );
  if (!owner) {
    if (targetExists || files.length || existing)
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '恢复库删除目标仍存在但原owner缺失，保持隔离。',
        409,
      );
    return 'orphanSkipped'; // External signed record/watermark stays authoritative; do not fabricate a user.
  }
  await tx.query(
    `INSERT INTO app.privacy_deletion_events(id,owner_id,target_type,target_id,exclusive_resource_ids,occurred_at,control_version)
    VALUES($1,$2,$3,$4,$5,$6,1) ON CONFLICT(id) DO NOTHING`,
    [
      entry.id,
      entry.ownerId,
      entry.targetType,
      entry.targetId,
      entry.exclusiveResourceIds,
      entry.occurredAt,
    ],
  );
  return 'applied';
}

/** Immediate logical denial plus erasure of exclusive database bodies, distinct from pending object GC. */
export async function applyPrivacyDeletion(
  tx: SqlExecutor,
  entry: PrivacyDeletion,
): Promise<void> {
  if (entry.targetType === 'conversation') {
    const owned = (
      await tx.query<{ id: string }>(
        'SELECT id FROM app.ai_conversations WHERE id=$1 AND owner_id=$2 FOR UPDATE',
        [entry.targetId, entry.ownerId],
      )
    ).rows[0];
    if (owned) {
      await tx.query(
        "UPDATE app.ai_conversations SET deleted_at=COALESCE(deleted_at,$2),default_title='已删除会话',alias=NULL,pinned_at=NULL,source_fingerprints='{}'::jsonb,row_version=row_version+CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END WHERE id=$1",
        [entry.targetId, entry.occurredAt],
      );
      // Worker text/attempt transactions hold the task before its assistant message.
      // Use the same order while deleting so a retry-prefix trim cannot deadlock with C5.
      await tx.query(
        "UPDATE app.ai_tasks SET operation_target=NULL,cancel_requested_at=COALESCE(cancel_requested_at,$2),state=CASE WHEN state='accepted' THEN 'cancelled' WHEN state IN ('running','cancelling') THEN 'interrupted' ELSE state END,finished_at=COALESCE(finished_at,$2) WHERE conversation_id=$1",
        [entry.targetId, entry.occurredAt],
      );
      await tx.query(
        "UPDATE app.ai_messages SET content='',explicit_refs='[]'::jsonb,operation_target=NULL,status='deleted',deleted_at=COALESCE(deleted_at,$2) WHERE conversation_id=$1",
        [entry.targetId, entry.occurredAt],
      );
      await tx.query(
        "UPDATE app.model_call_ledger SET status='unknown',finished_at=COALESCE(finished_at,clock_timestamp()) WHERE task_id IN(SELECT id FROM app.ai_tasks WHERE conversation_id=$1) AND status='dispatchIntent'",
        [entry.targetId],
      );
      await tx.query(
        'UPDATE app.ai_task_events SET payload=\'{"deleted":true}\'::jsonb WHERE task_id IN (SELECT id FROM app.ai_tasks WHERE conversation_id=$1)',
        [entry.targetId],
      );
      await tx.query(
        `UPDATE app.business_confirmations SET arguments='{}'::jsonb,proposal='{"deleted":true}'::jsonb,
         response='{"deleted":true}'::jsonb,state=CASE WHEN state='waitingConfirmation' THEN 'declined'
         WHEN state='executing' THEN 'unknown' ELSE state END,resolved_at=COALESCE(resolved_at,$2)
         WHERE conversation_id=$1 AND owner_id=$3`,
        [entry.targetId, entry.occurredAt, entry.ownerId],
      );
      await tx.query(
        'UPDATE app.ai_runtime_threads SET deleted_at=COALESCE(deleted_at,$2),active_run_id=NULL WHERE conversation_id=$1 AND owner_id=$3',
        [entry.targetId, entry.occurredAt, entry.ownerId],
      );
      await tx.query(
        'DELETE FROM app.ai_runtime_checkpoint_writes WHERE conversation_id=$1',
        [entry.targetId],
      );
      await tx.query(
        'DELETE FROM app.ai_runtime_checkpoints WHERE conversation_id=$1',
        [entry.targetId],
      );
      if (
        (
          await tx.query<{ present: boolean }>(
            "SELECT to_regclass('app.auxiliary_tasks') IS NOT NULL present",
          )
        ).rows[0]?.present
      ) {
        await tx.query(
          `UPDATE app.auxiliary_tasks SET request='{}'::jsonb,source_snapshot='{}'::jsonb,result=NULL,error_details=NULL,
          state=CASE WHEN state='accepted' THEN 'cancelled' WHEN state IN ('running','cancelling') THEN 'unknown' ELSE state END,
          cancel_requested_at=COALESCE(cancel_requested_at,$2),finished_at=COALESCE(finished_at,$2)
          WHERE conversation_id=$1 AND owner_id=$3`,
          [entry.targetId, entry.occurredAt, entry.ownerId],
        );
        await tx.query(
          `UPDATE app.commands SET response='{"deleted":true}'::jsonb WHERE actor_id=$1 AND operation LIKE 'auxiliary.%'
          AND response->'task'->>'id' IN (SELECT id::text FROM app.auxiliary_tasks WHERE conversation_id=$2 AND owner_id=$1)`,
          [entry.ownerId, entry.targetId],
        );
      }
      if (
        (
          await tx.query<{ present: boolean }>(
            "SELECT to_regclass('app.auxiliary_disclosures') IS NOT NULL present",
          )
        ).rows[0]?.present
      ) {
        await tx.query(
          `UPDATE app.auxiliary_disclosures SET request_hash=repeat('0',64),scope_digest=repeat('0',64),source_digest=repeat('0',64),model_snapshot='{}'::jsonb,source_meta='{}'::jsonb,invalidated_at=COALESCE(invalidated_at,$3) WHERE owner_id=$1 AND source_meta->>'conversationId'=$2`,
          [entry.ownerId, entry.targetId, entry.occurredAt],
        );
      }
      await tx.query(
        "DELETE FROM app.resource_references WHERE reference_type='conversation' AND reference_id=$1",
        [entry.targetId],
      );
      await tx.query(
        "UPDATE app.commands SET response='{\"deleted\":true}'::jsonb WHERE actor_id=$1 AND operation LIKE 'conversations.%' AND (response->'conversation'->>'id')=$2",
        [entry.ownerId, entry.targetId],
      );
    }
  }
  if (entry.targetType === 'conversation')
    await redactAutomaticAuxiliaryConversation(
      tx,
      entry.ownerId,
      entry.targetId,
    );
  for (const resourceId of entry.exclusiveResourceIds) {
    if (
      (
        await tx.query(
          "SELECT 1 FROM app.resource_references WHERE resource_id=$1 AND reference_type<>'conversation' LIMIT 1",
          [resourceId],
        )
      ).rowCount
    )
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '删除控制资源存在正式资料引用，保持隔离；不得以显式删除标记绕过正式副本保护。',
        409,
      );
    const explicit =
      entry.targetType === 'resource' && entry.targetId === resourceId;
    const removed = await tx.query(
      `UPDATE app.file_resources f SET deleted_at=COALESCE(deleted_at,$3),row_version=row_version+CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END
      WHERE f.id=$1 AND f.owner_user_id=$2 AND f.owner_scope='personal'
      AND ($4 OR NOT EXISTS(SELECT 1 FROM app.resource_references r WHERE r.resource_id=f.id)) RETURNING id`,
      [resourceId, entry.ownerId, entry.occurredAt, explicit],
    );
    if (removed.rowCount)
      await tx.query(
        'INSERT INTO app.privacy_resource_gc(resource_id,event_id) VALUES($1,$2) ON CONFLICT(resource_id) DO NOTHING',
        [resourceId, entry.id],
      );
  }
  await redactExternalPrivacyDerivatives(
    tx,
    entry.ownerId,
    entry.exclusiveResourceIds,
  );
  await redactDeletedModelAttemptsInTransaction(
    tx,
    entry.ownerId,
    entry.exclusiveResourceIds,
  );
}
