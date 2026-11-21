import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import type {
  Database,
  SqlExecutor,
  SecurityControlChange,
  TransactionControlObserver,
} from '../../../persistence/src/database.js';
import { DomainError } from '../errors.js';
import {
  ControlFiles,
  type ControlReference,
  type ControlHead,
} from './control-files.js';
import {
  captureSecurityState,
  securityStateDigest,
  type SecurityState,
} from './security-state.js';

interface StateRow {
  platform_id: string;
  control_sequence: string;
  state_digest: string | null;
}
const receiptSchema = z.strictObject({
  id: z.uuid(),
  sequence: z.number().int().positive(),
  stateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  encryptedDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
const unavailable = (
  message = '最新独立安全控制无法确认，旧资料不能开放；请先在隔离模式核对。',
) => new DomainError('DEPENDENCY_UNAVAILABLE', message, 503);
export class ControlJournal implements TransactionControlObserver {
  private platformId: string | undefined;
  private readonly livePrepared = new Set<string>();
  constructor(
    readonly db: Database,
    readonly files: ControlFiles,
    private readonly masterFingerprint: string,
  ) {}
  static async fromEnvironment(
    db: Database,
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    const root =
      environment.AITESTHUB_LOCAL_ROOT ??
      (environment.LOCALAPPDATA
        ? join(environment.LOCALAPPDATA, 'AITestHub')
        : undefined);
    const directory =
        environment.AITESTHUB_RECOVERY_CONTROL_DIRECTORY ??
        (root ? join(root, 'control', 'security-controls') : undefined),
      keyFile =
        environment.AITESTHUB_RECOVERY_CONTROL_KEY_FILE ??
        (root ? join(root, 'secrets', 'recovery-control-key') : undefined),
      anchor =
        environment.AITESTHUB_RECOVERY_CONTROL_ANCHOR_FILE ??
        (root
          ? join(root, 'recovery', 'controls', 'security-control-anchor.json')
          : undefined);
    const master =
        environment.AITESTHUB_MASTER_KEY_FILE ??
        (root ? join(root, 'secrets', 'platform-master-key') : undefined),
      backups =
        environment.AITESTHUB_BACKUP_DIRECTORY ??
        (root ? join(root, 'backups', 'product') : undefined);
    if (
      !directory ||
      !keyFile ||
      !anchor ||
      !master ||
      !backups ||
      ![directory, keyFile, anchor, master, backups].every(isAbsolute)
    )
      throw unavailable();
    for (const path of [directory, keyFile, anchor]) {
      const inside = relative(resolve(backups), resolve(path));
      if (!inside || (!inside.startsWith('..') && !isAbsolute(inside)))
        throw unavailable(
          '最新控制、anchor及密钥不能位于会被旧备份恢复的目录。',
        );
    }
    await mkdir(join(keyFile, '..'), { recursive: true, mode: 0o700 });
    try {
      await readFile(keyFile);
    } catch (error: unknown) {
      if (!(
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw unavailable();
      let existingHead = false;
      for (const path of [join(directory, 'head.json'), anchor]) {
        try {
          await readFile(path);
          existingHead = true;
        } catch (probe: unknown) {
          if (!(
            probe &&
            typeof probe === 'object' &&
            'code' in probe &&
            probe.code === 'ENOENT'
          ))
            throw unavailable();
        }
      }
      const row = (
        await db.query<{ control_sequence: string }>(
          'SELECT control_sequence FROM app.recovery_control_state WHERE singleton',
        )
      ).rows[0];
      if (existingHead || !row || Number(row.control_sequence) !== 0)
        throw unavailable(
          '已有安全控制的密钥缺失；不会生成新Key覆盖旧恢复条件。',
        );
      try {
        await writeFile(keyFile, randomBytes(32).toString('hex'), {
          flag: 'wx',
          mode: 0o600,
        });
      } catch (write: unknown) {
        if (!(
          write &&
          typeof write === 'object' &&
          'code' in write &&
          write.code === 'EEXIST'
        ))
          throw unavailable();
      }
    }
    let key: Buffer, fingerprint: string;
    try {
      const raw = (await readFile(keyFile, 'utf8')).trim(),
        platformMaster = (await readFile(master, 'utf8')).trim();
      if (
        !/^[a-f0-9]{64}$/i.test(raw) ||
        !/^[a-f0-9]{64}$/i.test(platformMaster)
      )
        throw new Error();
      key = Buffer.from(raw, 'hex');
      fingerprint = createHash('sha256')
        .update(Buffer.from(platformMaster, 'hex'))
        .digest('hex');
    } catch {
      throw unavailable();
    }
    return new ControlJournal(
      db,
      new ControlFiles(directory, anchor, key),
      fingerprint,
    );
  }
  private async row(transaction: SqlExecutor) {
    const row = (
      await transaction.query<StateRow>(
        'SELECT * FROM app.recovery_control_state WHERE singleton FOR UPDATE',
      )
    ).rows[0];
    if (!row) throw unavailable('恢复控制迁移尚未完成，不能建立产品备份。');
    return row;
  }
  private async resolvePending(transaction: SqlExecutor, head: ControlHead) {
    if (!head.pending) return head;
    const row = (
      await transaction.query<{ sequence: string; state_digest: string }>(
        'SELECT sequence,state_digest FROM app.recovery_control_commits WHERE id=$1 AND platform_id=$2',
        [head.pending.id, head.platformId],
      )
    ).rows[0];
    if (
      !row ||
      Number(row.sequence) !== head.pending.sequence ||
      row.state_digest !== head.pending.stateDigest
    )
      throw unavailable(
        '存在尚未证明数据库提交的控制意图，保持隔离；不会假定撤权未发生。',
      );
    await this.files.commit(head.pending);
    return this.files.head();
  }
  private validateSource(row: StateRow, head: ControlHead) {
    if (
      row.platform_id !== head.platformId ||
      (head.committed &&
        (Number(row.control_sequence) !== head.committed.sequence ||
          row.state_digest !== head.committed.stateDigest))
    )
      throw unavailable(
        '数据库安全水位与独立最新控制不一致，不能用旧库覆盖外部控制。',
      );
  }
  private async writePrepared(
    transaction: SqlExecutor,
    head: ControlHead,
    changes: readonly SecurityControlChange[],
  ) {
    const state = await captureSecurityState(
        transaction,
        this.masterFingerprint,
      ),
      digest = securityStateDigest(state);
    let ref: ControlReference | undefined;
    try {
      ref = await this.files.prepare(head, state, digest);
      await transaction.query(
        'INSERT INTO app.recovery_control_commits(id,platform_id,sequence,state_digest,changes) VALUES($1,$2,$3,$4,$5)',
        [
          ref.id,
          head.platformId,
          ref.sequence,
          digest,
          JSON.stringify(changes),
        ],
      );
      await transaction.query(
        'UPDATE app.recovery_control_state SET control_sequence=$1,state_digest=$2,updated_at=clock_timestamp() WHERE singleton',
        [ref.sequence, digest],
      );
      return ref;
    } catch (error: unknown) {
      if (ref) await this.files.abort(ref).catch(() => {});
      throw error;
    }
  }
  async initialize() {
    let prepared: ControlReference | undefined;
    await this.db.transaction(async (transaction) => {
      await transaction.query('SELECT pg_advisory_xact_lock(415948022)');
      const row = await this.row(transaction);
      this.platformId = row.platform_id;
      await this.files.withWriter(async () => {
        let head: ControlHead;
        if (await this.files.exists()) head = await this.files.head();
        else {
          if (Number(row.control_sequence) !== 0) throw unavailable();
          head = await this.files.initialize(row.platform_id);
        }
        head = await this.resolvePending(transaction, head);
        this.validateSource(row, head);
        if (!head.committed)
          prepared = await this.writePrepared(transaction, head, [
            {
              action: 'recovery.initial-baseline',
              objectId: row.platform_id,
              projectId: null,
            },
          ]);
        else {
          const state = await this.files.state(head);
          if (state.platformMasterFingerprint !== this.masterFingerprint)
            throw unavailable(
              '平台master密钥与最新控制指纹不同，保持隔离；不能用替代Key重新发布旧密文。',
            );
        }
      }, true);
    });
    if (prepared) await this.committed(prepared);
    this.db.setControlObserver(this);
    return this.status();
  }
  async prepare(
    transaction: SqlExecutor,
    changes: readonly SecurityControlChange[],
  ) {
    await transaction.query('SELECT pg_advisory_xact_lock(415948022)');
    const row = await this.row(transaction);
    const receipt = await this.files.withWriter(async () => {
      const head = await this.resolvePending(
        transaction,
        await this.files.head(),
      );
      this.validateSource(row, head);
      return this.writePrepared(transaction, head, changes);
    }, true);
    this.livePrepared.add(receipt.id);
    return receipt;
  }
  async committed(receipt: unknown) {
    const ref = receiptSchema.parse(receipt);
    try {
      await this.db.transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(415948022)');
        await this.files.withWriter(() => this.files.commit(ref), true);
      });
    } finally {
      this.livePrepared.delete(ref.id);
    }
  }
  async rolledBack(receipt: unknown) {
    const ref = receiptSchema.parse(receipt);
    try {
      await this.db.transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(415948022)');
        await this.files.withWriter(() => this.files.abort(ref), true);
      });
    } finally {
      this.livePrepared.delete(ref.id);
    }
  }
  uncertainError() {
    this.livePrepared.clear();
    return new DomainError(
      'OPERATION_RESULT_UNKNOWN',
      '数据库可能已提交，但独立控制回执尚未确认；请核对原状态，不能当作未发生重做。',
      503,
    );
  }
  async checkpoint(expected?: {
    platformId: string;
    sequence: number;
    stateDigest: string;
    sourceHeadId: string;
    sourceProofDigest: string;
    targetMigrationsDigest: string;
  }) {
    if (!this.platformId) throw unavailable();
    await this.db.transaction(async (transaction) => {
      if (expected) {
        z.strictObject({
          platformId: z.uuid(),
          sequence: z.number().int().positive(),
          stateDigest: z.string().regex(/^[a-f0-9]{64}$/),
          sourceHeadId: z.uuid(),
          sourceProofDigest: z.string().regex(/^[a-f0-9]{64}$/),
          targetMigrationsDigest: z.string().regex(/^[a-f0-9]{64}$/),
        }).parse(expected);
        await transaction.query('SELECT pg_advisory_xact_lock(415948007)');
        await transaction.query('SELECT pg_advisory_xact_lock(415948022)');
        const migrations = (
          await transaction.query<{ version: string; checksum: string }>(
            'SELECT version,checksum FROM app.schema_migrations ORDER BY version',
          )
        ).rows;
        if (
          createHash('sha256')
            .update(
              JSON.stringify(
                migrations.map((row) => [row.version, row.checksum]),
              ),
            )
            .digest('hex') !== expected.targetMigrationsDigest
        )
          throw unavailable();
        const row = await this.row(transaction),
          head = await this.files.head();
        this.validateSource(row, head);
        if (
          head.pending ||
          !head.committed ||
          head.platformId !== expected.platformId ||
          head.committed.id !== expected.sourceHeadId ||
          head.committed.sequence !== expected.sequence ||
          head.committed.stateDigest !== expected.stateDigest
        )
          throw unavailable(
            '升级checkpoint原控制水位已变化；未创建新控制记录。',
          );
      }
      transaction.noteSecurityControlChange?.({
        action: expected
          ? `recovery.model-upgrade-checkpoint:${expected.sourceProofDigest}`
          : 'recovery.checkpoint',
        objectId: expected?.sourceHeadId ?? this.platformId!,
        projectId: null,
      });
    });
    return this.status();
  }
  async prune() {
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(415948022)');
      return this.files.pruneSupersededBodies(86400000, new Date(), true);
    });
  }
  async status() {
    const head = await this.files.head();
    if (head.pending) throw unavailable();
    await this.files.state(head);
    return {
      platformId: head.platformId,
      sequence: head.committed?.sequence ?? 0,
      stateDigest: head.committed?.stateDigest ?? null,
      pending: false,
    };
  }
  async assertCurrentSource() {
    return this.db.transaction(async (tx) => {
      // The same lock guards every journal write. Verify the signed file and DB position together.
      await tx.query('SELECT pg_advisory_xact_lock_shared(415948022)');
      const head = await this.files.head();
      if (!head.committed) throw unavailable();
      const row = (
        await tx.query<StateRow>(
          'SELECT platform_id,control_sequence,state_digest FROM app.recovery_control_state WHERE singleton',
        )
      ).rows[0];
      if (
        !row ||
        row.platform_id !== head.platformId ||
        Number(row.control_sequence) < head.committed.sequence
      )
        throw unavailable();
      if (
        Number(row.control_sequence) === head.committed.sequence &&
        row.state_digest === head.committed.stateDigest &&
        (!head.pending || this.livePrepared.has(head.pending.id))
      ) {
        await this.files.assertBodyAvailable(head);
        return;
      }
      if (
        head.pending &&
        Number(row.control_sequence) === head.pending.sequence &&
        row.state_digest === head.pending.stateDigest
      ) {
        await this.files.assertBodyAvailable({
          ...head,
          committed: head.pending,
          pending: null,
        });
        return;
      }
      throw unavailable();
    });
  }
  /** Trusted restore/backup dependency only; never register this internal value as a Web/AI/MCP DTO. */
  async latest(): Promise<{ head: ControlHead; state: SecurityState }> {
    const head = await this.files.head();
    return { head, state: await this.files.state(head) };
  }
}
