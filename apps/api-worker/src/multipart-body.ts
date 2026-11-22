import { createHash, randomBytes } from 'node:crypto';
import {
  multipartMaxPayloadBytes,
  type MultipartAttachment,
  type MultipartTransport,
} from '../../../packages/contracts/src/api-multipart.js';

export type MultipartFileLoader = (
  file: MultipartAttachment,
) => Promise<Buffer>;

const quoted = (value: string) => value.replace(/[\\"]/g, '\\$&');

/** Prepare the whole bounded body before the step opens a target connection. */
export async function encodeMultipart(
  multipart: MultipartTransport,
  loadFile: MultipartFileLoader | undefined,
  signal?: AbortSignal,
) {
  const plannedBytes = multipart.parts.reduce(
    (sum, part) =>
      sum + (part.kind === 'text' ? Buffer.byteLength(part.value) : part.bytes),
    0,
  );
  if (plannedBytes > multipartMaxPayloadBytes)
    throw new Error('Multipart payload exceeds its byte budget');
  const boundary = 'ath-' + randomBytes(24).toString('hex');
  const chunks: Buffer[] = [];
  for (const part of multipart.parts) {
    signal?.throwIfAborted();
    const disposition = `--${boundary}\r\nContent-Disposition: form-data; name="${quoted(part.name)}"`;
    if (part.kind === 'text') {
      chunks.push(Buffer.from(disposition + '\r\n\r\n' + part.value + '\r\n'));
      continue;
    }
    if (!loadFile) throw new Error('Multipart file reader is unavailable');
    const bytes = await loadFile(part);
    if (
      bytes.length !== part.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== part.sha256
    )
      throw new Error('Multipart file no longer matches authorized bytes');
    chunks.push(
      Buffer.from(
        disposition +
          `; filename="${quoted(part.filename)}"\r\nContent-Type: ${part.mediaType}\r\n\r\n`,
      ),
      bytes,
      Buffer.from('\r\n'),
    );
  }
  signal?.throwIfAborted();
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
