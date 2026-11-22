import { createHash } from 'node:crypto';
import { multipartAttachmentSchema } from '../../../contracts/src/api-multipart.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import type { StoragePort } from '../../../storage/src/port.js';
import { requireProject } from '../access/policy.js';
import { DomainError } from '../errors.js';
import { readBoundedSource } from './source-content.js';

export class ApiMultipartFiles {
  constructor(private readonly storage: Pick<StoragePort, 'get'>) {}

  async describe(
    transaction: SqlExecutor,
    actor: ActorContext,
    projectId: string,
    fileId: string,
  ) {
    await requireProject(transaction, actor, projectId, 'files.transfer');
    const record = (
      await transaction.query<{
        original_name: string;
        media_type: string;
        declared_bytes: string;
        declared_sha256: string;
        storage_key: string;
      }>(
        `SELECT original_name,media_type,declared_bytes,declared_sha256,storage_key
         FROM app.file_resources
         WHERE id=$1 AND project_id=$2 AND owner_scope='project'
           AND status='verified' AND deleted_at IS NULL AND storage_key IS NOT NULL FOR SHARE`,
        [fileId, projectId],
      )
    ).rows[0];
    if (!record)
      throw new DomainError(
        'FILE_NOT_READY',
        '仅能发送当前项目内已校验的文件，当前引用不可用。',
        422,
      );
    const filename = record.original_name.split(/[\\/]/).at(-1);
    const validAttachment = multipartAttachmentSchema.safeParse({
      fileResourceId: fileId,
      filename,
      mediaType: record.media_type,
      bytes: Number(record.declared_bytes),
      sha256: record.declared_sha256,
    });
    if (!validAttachment.success)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '请求文件的名称、媒体类型或大小不符合发送范围，未发送。',
        422,
      );
    return { attachment: validAttachment.data, storageKey: record.storage_key };
  }

  async read(file: Awaited<ReturnType<ApiMultipartFiles['describe']>>) {
    const deadline = AbortSignal.timeout(10000);
    const unavailable = () =>
      new DomainError(
        'FILE_NOT_READY',
        '本次请求文件无法完整核验，未发送。',
        422,
      );
    try {
      const stream = await this.storage.get(file.storageKey, deadline);
      const { bytes, truncated } = await readBoundedSource(
        stream,
        file.attachment.bytes,
        deadline,
      );
      if (
        truncated ||
        bytes.length !== file.attachment.bytes ||
        createHash('sha256').update(bytes).digest('hex') !==
          file.attachment.sha256
      )
        throw unavailable();
      return bytes;
    } catch {
      throw unavailable();
    }
  }
}
