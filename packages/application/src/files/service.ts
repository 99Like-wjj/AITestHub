import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { QueryResultRow } from 'pg';
import { fileRegistrationSchema } from '../../../contracts/src/domain.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import type { StoragePort } from '../../../storage/src/port.js';
import { currentUser, requireProject } from '../access/policy.js';
import { DomainError } from '../errors.js';
import { conversationRow } from '../conversations/common.js';
import { audit } from '../events.js';
import { missingFileTransfers } from './preparation.js';
import { readFileResourceCapabilities } from './capabilities.js';
import {
  registeredFilePolicyIntent as policyIntent,
  fileResourcePolicies,
  type FileResourcePolicies,
} from './resource-policy.js';
import {
  bumpUiDeliveryFileArtifacts,
  lockUiDeliveryFileArtifacts,
} from './ui-delivery-artifacts.js';

const mediaTypes = new Set([
  'application/octet-stream',
  'application/json',
  'application/pdf',
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/html',
  'text/markdown',
  'text/csv',
  'text/event-stream',
  'application/x-ndjson',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/avif',
  'image/svg+xml',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/mp4',
  'application/ogg',
  'application/xml',
  'text/xml',
  'application/yaml',
  'application/x-yaml',
  'text/yaml',
  'application/toml',
  'text/tab-separated-values',
  'text/javascript',
  'application/javascript',
  'text/css',
  'text/x-python',
  'text/x-java-source',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
]);

interface FileRow extends QueryResultRow {
  id: string;
  owner_scope: 'personal' | 'project';
  owner_user_id: string;
  project_id: string | null;
  run_id: string | null;
  local_file_id: string;
  original_name: string;
  media_type: string;
  declared_bytes: string;
  declared_sha256: string;
  status: 'pending' | 'uploading' | 'verified' | 'failed';
  attempt: number;
  storage_key: string | null;
  deleted_at: Date | null;
  created_at: Date;
  verified_at: Date | null;
  upload_expires_at: Date | null;
}

function dto(file: FileRow) {
  return {
    id: file.id,
    ownerScope: file.owner_scope,
    projectId: file.project_id,
    runId: file.run_id,
    originalName: file.original_name,
    mediaType: file.media_type,
    bytes: file.declared_bytes,
    sha256: file.declared_sha256,
    status: file.status,
    attempt: file.attempt,
    createdAt: file.created_at.toISOString(),
    verifiedAt: file.verified_at?.toISOString() ?? null,
  };
}

function signatureMatches(mediaType: string, prefix: Buffer): boolean {
  if (mediaType === 'image/png')
    return prefix
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mediaType === 'image/jpeg')
    return prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255;
  if (mediaType === 'image/webp')
    return (
      prefix.subarray(0, 4).toString() === 'RIFF' &&
      prefix.subarray(8, 12).toString() === 'WEBP'
    );
  if (mediaType === 'image/gif')
    return /^GIF8[79]a$/.test(prefix.subarray(0, 6).toString('ascii'));
  if (mediaType === 'image/bmp')
    return prefix.subarray(0, 2).toString() === 'BM';
  if (
    mediaType === 'image/avif' ||
    mediaType === 'video/mp4' ||
    mediaType === 'audio/mp4'
  )
    return prefix.subarray(4, 8).toString() === 'ftyp';
  if (mediaType === 'video/webm')
    return prefix.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mediaType === 'audio/wav' || mediaType === 'audio/x-wav')
    return (
      prefix.subarray(0, 4).toString() === 'RIFF' &&
      prefix.subarray(8, 12).toString() === 'WAVE'
    );
  if (mediaType === 'audio/ogg' || mediaType === 'application/ogg')
    return prefix.subarray(0, 4).toString() === 'OggS';
  if (mediaType === 'application/pdf')
    return prefix.subarray(0, 5).toString() === '%PDF-';
  if (
    mediaType === 'application/zip' ||
    mediaType.startsWith('application/vnd.openxmlformats') ||
    mediaType.startsWith('application/vnd.oasis.opendocument')
  ) {
    return (
      prefix[0] === 80 &&
      prefix[1] === 75 &&
      [3, 5, 7].includes(prefix[2] ?? -1)
    );
  }
  return true;
}

function chunkBytes(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array || typeof value === 'string')
    return Buffer.from(value);
  throw new DomainError('VALIDATION_ERROR', '文件通道仅接受字节数据。', 400);
}

export class FilesService {
  constructor(
    readonly db: Database,
    readonly storage: StoragePort,
    readonly policies: FileResourcePolicies = fileResourcePolicies,
  ) {}

  async register(actor: ActorContext, raw: unknown) {
    return this.registerFile(actor, raw);
  }

  /** Only the workspace service exposes this port, after binding its trusted conversation. */
  async createConversationArtifact(
    actor: ActorContext,
    conversationId: string,
    raw: unknown,
    source: Readable,
  ) {
    const registered = await this.registerFile(actor, raw, conversationId);
    return this.uploadFile(actor, registered.file.id, source, conversationId);
  }

  async downloadConversationArtifact(
    actor: ActorContext,
    conversationId: string,
    id: string,
  ) {
    return this.downloadFile(actor, id, conversationId);
  }

  private async registerFile(
    actor: ActorContext,
    raw: unknown,
    conversationId?: string,
  ) {
    const input = fileRegistrationSchema.parse(raw);
    if (
      conversationId &&
      (input.ownerScope !== 'personal' ||
        input.projectId !== undefined ||
        input.runId !== undefined ||
        !input.localFileId.startsWith(`workspace:${conversationId}:`))
    )
      throw new DomainError('VALIDATION_ERROR', '会话产物登记范围无效。', 400);
    if (
      /[\x00-\x1f\x7f/\\]/.test(input.originalName) ||
      ['.', '..'].includes(input.originalName)
    ) {
      throw new DomainError(
        'VALIDATION_ERROR',
        '文件名不能包含路径或控制字符。',
        400,
      );
    }
    if (!mediaTypes.has(input.mediaType))
      throw new DomainError(
        'UNSUPPORTED_OPERATION',
        '不支持此文件媒体类型，可用原始二进制类型保存原件。',
        422,
      );
    if (input.ownerScope === 'personal' && input.projectId)
      throw new DomainError('VALIDATION_ERROR', '个人文件不能指定项目。', 400);
    if (input.runId && (input.ownerScope !== 'project' || !input.projectId))
      throw new DomainError(
        'VALIDATION_ERROR',
        '执行文件须明确项目范围。',
        400,
      );
    return this.db.transaction(async (transaction) => {
      await this.authorizeScope(
        transaction,
        actor,
        input.ownerScope,
        input.projectId ?? null,
        actor.userId,
        conversationId,
      );
      if (input.runId && input.projectId) {
        await requireProject(
          transaction,
          actor,
          input.projectId,
          'results.submit',
        );
        if (
          !(
            await transaction.query(
              'SELECT 1 FROM app.runs WHERE project_id=$1 AND id=$2 AND created_by=$3 FOR SHARE',
              [input.projectId, input.runId, actor.userId],
            )
          ).rowCount
        )
          throw new DomainError(
            'FORBIDDEN',
            '只能为本人当前授权的项目执行登记文件。',
            403,
          );
      }
      // Validate the trusted current/original budget before the legacy physical
      // CHECK or bigint cast can reject insertion. Replays never adopt a new head.
      const known = (
        await transaction.query<FileRow>(
          `SELECT * FROM app.file_resources WHERE owner_user_id=$1 AND owner_scope=$2
         AND project_id IS NOT DISTINCT FROM $3::uuid AND local_file_id=$4 AND run_id IS NOT DISTINCT FROM $5::uuid FOR UPDATE`,
          [
            actor.userId,
            input.ownerScope,
            input.projectId ?? null,
            input.localFileId,
            input.runId ?? null,
          ],
        )
      ).rows[0];
      if (known?.deleted_at)
        throw new DomainError('NOT_FOUND', '文件资源不存在。', 404);
      if (
        known &&
        (known.declared_bytes !== input.bytes ||
          known.declared_sha256 !== input.sha256 ||
          known.media_type !== input.mediaType ||
          known.original_name !== input.originalName)
      )
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          '相同本地文件标识已登记不同内容，请使用新文件标识。',
          409,
        );
      const admission = await this.policies.read(
        transaction,
        known ? policyIntent(known) : undefined,
      );
      if (BigInt(input.bytes) > BigInt(admission.policy.files.maxFileBytes))
        throw new DomainError(
          'FILE_TOO_LARGE',
          '单文件超过受理资源策略限制。',
          413,
          { limitBytes: admission.policy.files.maxFileBytes },
        );
      const inserted = await transaction.query(
        `INSERT INTO app.file_resources(owner_scope,owner_user_id,project_id,local_file_id,original_name,media_type,declared_bytes,declared_sha256,run_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
        [
          input.ownerScope,
          actor.userId,
          input.projectId ?? null,
          input.localFileId,
          input.originalName,
          input.mediaType,
          input.bytes,
          input.sha256,
          input.runId ?? null,
        ],
      );
      const file = (
        await transaction.query<FileRow>(
          `SELECT * FROM app.file_resources WHERE owner_user_id=$1 AND owner_scope=$2
        AND project_id IS NOT DISTINCT FROM $3::uuid AND local_file_id=$4 AND run_id IS NOT DISTINCT FROM $5::uuid FOR UPDATE`,
          [
            actor.userId,
            input.ownerScope,
            input.projectId ?? null,
            input.localFileId,
            input.runId ?? null,
          ],
        )
      ).rows[0];
      if (!file || file.deleted_at)
        throw new DomainError('NOT_FOUND', '文件资源不存在。', 404);
      if (
        file.declared_bytes !== input.bytes ||
        file.declared_sha256 !== input.sha256 ||
        file.media_type !== input.mediaType ||
        file.original_name !== input.originalName
      ) {
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          '相同本地文件标识已登记不同内容，请使用新文件标识。',
          409,
        );
      }
      const policy = await this.policies.accept(
        transaction,
        policyIntent(file, !inserted.rowCount),
      );
      if (
        BigInt(file.declared_bytes) > BigInt(policy.policy.files.maxFileBytes)
      )
        throw new DomainError(
          'FILE_TOO_LARGE',
          '单文件超过受理资源策略限制。',
          413,
          { limitBytes: policy.policy.files.maxFileBytes },
        );
      if (conversationId)
        await transaction.query(
          "INSERT INTO app.resource_references(resource_id,reference_type,reference_id,created_by) VALUES($1,'conversation',$2,$3) ON CONFLICT DO NOTHING",
          [file.id, conversationId, actor.userId],
        );
      return { file: dto(file) };
    });
  }

  async metadata(actor: ActorContext, id: string) {
    return this.db.transaction(async (transaction) => {
      const file = await this.authorizedFile(transaction, actor, id);
      return { file: dto(file) };
    });
  }
  missing(actor: ActorContext, raw: unknown) {
    return missingFileTransfers(this, actor, raw);
  }
  capabilities(actor: ActorContext, raw: unknown) {
    return readFileResourceCapabilities(
      this.db,
      this.policies,
      actor,
      raw,
      async (tx, id) => {
        const file = await this.authorizedFile(tx, actor, id);
        return this.policies.read(tx, policyIntent(file));
      },
    );
  }

  async upload(actor: ActorContext, id: string, source: Readable) {
    return this.uploadFile(actor, id, source);
  }

  private async uploadFile(
    actor: ActorContext,
    id: string,
    source: Readable,
    conversationId?: string,
  ) {
    const claimed = await this.db.transaction(async (transaction) => {
      if (conversationId)
        await conversationRow(transaction, actor, conversationId, false, true);
      // Complete write authorization before discovering/locking another run's delivery projection.
      await this.authorizedFile(
        transaction,
        actor,
        id,
        false,
        true,
        conversationId,
      );
      const artifacts = await lockUiDeliveryFileArtifacts(transaction, id);
      const file = await this.authorizedFile(
        transaction,
        actor,
        id,
        true,
        false,
        conversationId,
      );
      const policy = await this.policies.read(transaction, policyIntent(file));
      const maximumBytes = Number(policy.policy.files.maxFileBytes);
      if (
        !Number.isSafeInteger(maximumBytes) ||
        BigInt(file.declared_bytes) > BigInt(policy.policy.files.maxFileBytes)
      )
        throw new DomainError(
          'FILE_TOO_LARGE',
          '文件超出原受理资源策略，未开始传输。',
          413,
        );
      if (file.status === 'verified') return { file, key: null, maximumBytes };
      if (
        file.status === 'uploading' &&
        file.upload_expires_at &&
        file.upload_expires_at.getTime() > Date.now()
      ) {
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '文件仍在传输，请先查询原回执，过期后可完整重传。',
          409,
        );
      }
      const attempt = file.attempt + 1;
      const key = `uploads/${file.id}/${attempt}/${randomUUID()}`;
      await transaction.query(
        "UPDATE app.file_upload_attempts SET status='interrupted',finished_at=clock_timestamp(),error_code='UPLOAD_LEASE_EXPIRED' WHERE resource_id=$1 AND status='uploading'",
        [id],
      );
      const updated = (
        await transaction.query<FileRow>(
          `UPDATE app.file_resources SET status='uploading',attempt=$2,
        upload_expires_at=clock_timestamp()+interval '15 minutes',updated_at=clock_timestamp(),row_version=row_version+1 WHERE id=$1 RETURNING *`,
          [id, attempt],
        )
      ).rows[0];
      if (!updated) throw new Error('File claim returned no row');
      await transaction.query(
        "INSERT INTO app.file_upload_attempts(resource_id,attempt,storage_key,status) VALUES($1,$2,$3,'uploading')",
        [id, attempt, key],
      );
      if (file.status !== updated.status)
        await bumpUiDeliveryFileArtifacts(transaction, artifacts);
      return { file: updated, key, maximumBytes };
    });
    let bytesReceived = 0;
    let digest: string | undefined;
    let validationFailure: DomainError | undefined;
    const expected = Number(claimed.file.declared_bytes);
    const hash = createHash('sha256');
    const verifiedBytes = async function* () {
      let prefix = Buffer.alloc(0);
      try {
        for await (const rawChunk of source) {
          const chunk = chunkBytes(rawChunk);
          bytesReceived += chunk.length;
          if (bytesReceived > expected || bytesReceived > claimed.maximumBytes)
            throw new DomainError(
              'FILE_HASH_MISMATCH',
              '实际文件大小与登记不符，请从头完整重传。',
              409,
            );
          if (prefix.length < 16)
            prefix = Buffer.concat([
              prefix,
              chunk.subarray(0, 16 - prefix.length),
            ]);
          hash.update(chunk);
          yield chunk;
        }
        digest = hash.digest('hex');
        if (
          bytesReceived !== expected ||
          digest !== claimed.file.declared_sha256
        )
          throw new DomainError(
            'FILE_HASH_MISMATCH',
            '文件长度或SHA-256校验失败，请从头完整重传。',
            409,
          );
        if (!signatureMatches(claimed.file.media_type, prefix))
          throw new DomainError(
            'VALIDATION_ERROR',
            '文件内容与登记媒体类型不符。',
            422,
          );
      } catch (error: unknown) {
        validationFailure =
          error instanceof DomainError
            ? error
            : new DomainError(
                'DEPENDENCY_UNAVAILABLE',
                '文件传输中断，请查询状态后从头完整重传。',
                503,
              );
        throw validationFailure;
      }
    };
    try {
      if (claimed.key === null) {
        for await (const _chunk of verifiedBytes()) {
          /* Verify full retransmission without altering the ready object. */
        }
        return { file: dto(claimed.file), replayed: true };
      }
      await this.storage.put(
        claimed.key,
        Readable.from(verifiedBytes()),
        expected,
        claimed.file.media_type,
      );
      const stored = await this.storage.get(claimed.key);
      const storedHash = createHash('sha256');
      let storedBytes = 0;
      for await (const rawChunk of stored) {
        const chunk = chunkBytes(rawChunk);
        storedBytes += chunk.length;
        if (storedBytes > expected) {
          stored.destroy();
          throw new DomainError(
            'FILE_HASH_MISMATCH',
            '存储读回字节校验失败。',
            503,
          );
        }
        storedHash.update(chunk);
      }
      if (
        storedBytes !== expected ||
        storedHash.digest('hex') !== claimed.file.declared_sha256
      )
        throw new DomainError(
          'FILE_HASH_MISMATCH',
          '存储读回字节校验失败。',
          503,
        );
      const result = await this.db.transaction(async (transaction) => {
        if (conversationId)
          await conversationRow(
            transaction,
            actor,
            conversationId,
            false,
            true,
          );
        await this.authorizedFile(
          transaction,
          actor,
          id,
          false,
          true,
          conversationId,
        );
        const artifacts = await lockUiDeliveryFileArtifacts(transaction, id);
        await this.authorizedFile(
          transaction,
          actor,
          id,
          true,
          false,
          conversationId,
        );
        const file = (
          await transaction.query<FileRow>(
            `UPDATE app.file_resources SET status='verified',storage_key=$3,verified_at=clock_timestamp(),
          upload_expires_at=NULL,updated_at=clock_timestamp(),row_version=row_version+1 WHERE id=$1 AND attempt=$2 AND status='uploading' RETURNING *`,
            [id, claimed.file.attempt, claimed.key],
          )
        ).rows[0];
        if (!file)
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '文件传输回执已变化，请查询原状态。',
            409,
          );
        await bumpUiDeliveryFileArtifacts(transaction, artifacts);
        await transaction.query(
          "UPDATE app.file_upload_attempts SET status='verified',bytes_received=$3,sha256=$4,finished_at=clock_timestamp() WHERE resource_id=$1 AND attempt=$2",
          [id, file.attempt, bytesReceived, digest],
        );
        await audit(transaction, actor, 'files.verified', id, file.project_id, {
          bytes: file.declared_bytes,
          sha256: file.declared_sha256,
        });
        return { file: dto(file), replayed: false };
      });
      return result;
    } catch (error: unknown) {
      const failure =
        validationFailure ??
        (error instanceof DomainError
          ? error
          : new DomainError(
              'DEPENDENCY_UNAVAILABLE',
              '私有文件存储暂不可用，请查询状态后完整重传。',
              503,
            ));
      if (claimed.key !== null) {
        let safeToDelete = false;
        try {
          safeToDelete = await this.db.transaction(async (transaction) => {
            // A failed/withdrawn actor must not prevent trusted cleanup of its own
            // previously authorized attempt; preserve the same run→file lock order.
            const artifacts = await lockUiDeliveryFileArtifacts(
              transaction,
              id,
            );
            const current = (
              await transaction.query<FileRow>(
                'SELECT * FROM app.file_resources WHERE id=$1 FOR UPDATE',
                [id],
              )
            ).rows[0];
            // A lost COMMIT acknowledgement must not delete bytes of a verified resource.
            if (!current || current.storage_key === claimed.key) return false;
            const changed = await transaction.query(
              "UPDATE app.file_resources SET status='failed',upload_expires_at=NULL,updated_at=clock_timestamp(),row_version=row_version+1 WHERE id=$1 AND attempt=$2 AND status='uploading'",
              [id, claimed.file.attempt],
            );
            if (changed.rowCount)
              await bumpUiDeliveryFileArtifacts(transaction, artifacts);
            if (
              changed.rowCount &&
              BigInt(bytesReceived) < BigInt(claimed.file.declared_bytes)
            )
              await audit(
                transaction,
                actor,
                'file.upload-incomplete',
                id,
                claimed.file.project_id,
                { attempt: claimed.file.attempt, bytesReceived },
              );
            await transaction.query(
              "UPDATE app.file_upload_attempts SET status='failed',bytes_received=$3,sha256=$4,error_code=$5,finished_at=clock_timestamp() WHERE resource_id=$1 AND attempt=$2 AND status='uploading'",
              [
                id,
                claimed.file.attempt,
                bytesReceived,
                digest ?? null,
                failure.code,
              ],
            );
            return true;
          });
        } catch {
          /* Unknown database state retains the unexposed object for reconciliation. */
        }
        if (safeToDelete)
          try {
            await this.storage.delete(claimed.key);
          } catch {
            /* Orphan remains unreferenced; never mark it ready. */
          }
      }
      throw failure;
    }
  }

  async download(actor: ActorContext, id: string) {
    return this.downloadFile(actor, id);
  }

  private async downloadFile(
    actor: ActorContext,
    id: string,
    conversationId?: string,
  ) {
    const file = await this.db.transaction(async (transaction) => {
      if (conversationId)
        await conversationRow(transaction, actor, conversationId, false, true);
      const row = await this.authorizedFile(
        transaction,
        actor,
        id,
        false,
        false,
        conversationId,
      );
      return row;
    });
    if (file.status !== 'verified' || !file.storage_key)
      throw new DomainError(
        'FILE_NOT_READY',
        '文件尚未完整校验，暂不可下载。',
        422,
      );
    try {
      return {
        file: dto(file),
        body: await this.storage.get(file.storage_key),
      };
    } catch {
      throw new DomainError(
        'DEPENDENCY_UNAVAILABLE',
        '文件字节暂不可用，原回执与缺失状态需核对。',
        503,
      );
    }
  }

  private async authorizedFile(
    transaction: SqlExecutor,
    actor: ActorContext,
    id: string,
    lock = false,
    write = false,
    conversationId?: string,
  ): Promise<FileRow> {
    const file = (
      await transaction.query<FileRow>(
        `SELECT * FROM app.file_resources WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`,
        [id],
      )
    ).rows[0];
    if (!file || file.deleted_at)
      throw new DomainError('NOT_FOUND', '文件资源不存在。', 404);
    await this.authorizeScope(
      transaction,
      actor,
      file.owner_scope,
      file.project_id,
      file.owner_user_id,
      conversationId,
    );
    if (
      conversationId &&
      !(
        await transaction.query(
          "SELECT 1 FROM app.resource_references WHERE resource_id=$1 AND reference_type='conversation' AND reference_id=$2",
          [id, conversationId],
        )
      ).rowCount
    )
      throw new DomainError('NOT_FOUND', '文件不属于当前会话产物。', 404);
    if ((lock || write) && file.run_id && file.project_id) {
      await requireProject(
        transaction,
        actor,
        file.project_id,
        'results.submit',
      );
      if (
        !(
          await transaction.query(
            'SELECT 1 FROM app.runs WHERE id=$1 AND project_id=$2 AND created_by=$3',
            [file.run_id, file.project_id, actor.userId],
          )
        ).rowCount
      )
        throw new DomainError(
          'FORBIDDEN',
          '执行文件写入仅限本人当前授权的执行。',
          403,
        );
    }
    return file;
  }

  private async authorizeScope(
    transaction: SqlExecutor,
    actor: ActorContext,
    scope: 'personal' | 'project',
    projectId: string | null,
    ownerId: string,
    conversationId?: string,
  ) {
    if (conversationId) {
      await conversationRow(transaction, actor, conversationId, false, true);
      if (scope === 'project' && projectId) {
        await requireProject(transaction, actor, projectId, 'files.transfer');
        return;
      }
      if (
        scope !== 'personal' ||
        projectId !== null ||
        actor.userId !== ownerId
      )
        throw new DomainError(
          'FORBIDDEN',
          '会话产物仅限当前本人私有文件。',
          403,
        );
      return;
    }
    if (scope === 'project' && projectId) {
      await requireProject(transaction, actor, projectId, 'files.transfer');
      return;
    }
    await currentUser(transaction, actor);
    if (
      scope !== 'personal' ||
      actor.userId !== ownerId ||
      actor.entrypoint !== 'web'
    )
      throw new DomainError('FORBIDDEN', '无权读取或维护此个人文件。', 403);
  }
}
