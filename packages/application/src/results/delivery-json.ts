import { createHash } from 'node:crypto';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { FilesService } from '../files/service.js';
import { DomainError } from '../errors.js';
import { parseSafeResultJson } from './json-file.js';
import { assertLocalUiActor } from './delivery-access.js';

export interface DeliveryJsonSource {
  fileId: string;
  sha256: string;
  bytes: number;
  runId: string | null;
}
/** Complete file transfer is unchanged; this only reads an already verified JSON resource. */
export async function readDeliveryJson(
  actor: ActorContext,
  projectId: string,
  fileId: string,
  files: FilesService,
): Promise<{ value: unknown; source: DeliveryJsonSource }> {
  assertLocalUiActor(actor);
  const metadata = (await files.metadata(actor, fileId)).file;
  if (metadata.ownerScope !== 'project' || metadata.projectId !== projectId)
    throw new DomainError('FORBIDDEN', '结果批次原JSON须属于此项目。', 403);
  if (
    metadata.mediaType !== 'application/json' ||
    BigInt(metadata.bytes) > 16n * 1024n * 1024n
  )
    throw new DomainError(
      'VALIDATION_ERROR',
      '结果批次原JSON须是至多16MiB的UTF-8 JSON。',
      400,
    );
  const downloaded = await files.download(actor, fileId),
    chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of downloaded.body) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > 16 * 1024 * 1024) throw new Error('Result JSON too large');
      chunks.push(bytes);
    }
    const data = Buffer.concat(chunks);
    if (
      data.length !== Number(metadata.bytes) ||
      createHash('sha256').update(data).digest('hex') !== metadata.sha256
    )
      throw new Error('Result JSON bytes differ from registration');
    return {
      value: parseSafeResultJson(data),
      source: {
        fileId,
        sha256: metadata.sha256,
        bytes: length,
        runId: metadata.runId,
      },
    };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      'VALIDATION_ERROR',
      '结果批次原JSON不能读取为完整已校验原件；请查原资源状态。',
      400,
    );
  } finally {
    downloaded.body.destroy();
  }
}
