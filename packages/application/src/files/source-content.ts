import { addAbortSignal, type Readable } from 'node:stream';
import { TextDecoder } from 'node:util';
import { DomainError } from '../errors.js';

export const maximumTextSourceBytes = 1024 * 1024;
const otherTextTypes = new Set(['text/csv', 'application/json', 'text/html']);
type SourceType = { mediaType: string; originalName: string };

export function textDocumentFormat({ mediaType, originalName }: SourceType) {
  const genericType = mediaType === 'application/octet-stream';
  if (
    mediaType === 'text/markdown' ||
    (genericType && /\.(?:md|markdown)$/iu.test(originalName))
  )
    return 'markdown';
  if (
    mediaType === 'text/plain' ||
    (genericType && /\.txt$/iu.test(originalName))
  )
    return 'text';
  return null;
}

export function isTextSource(file: SourceType): boolean {
  return (
    textDocumentFormat(file) !== null || otherTextTypes.has(file.mediaType)
  );
}

/** Retain at most the requested byte budget, including for oversized stream chunks. */
export async function readBoundedSource(
  body: Readable,
  maximumBytes: number,
  signal?: AbortSignal,
) {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  try {
    signal?.throwIfAborted();
    if (signal) addAbortSignal(signal, body);
    for await (const raw of body) {
      const chunk: unknown = raw;
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (!(buffer instanceof Uint8Array))
        throw new DomainError('VALIDATION_ERROR', '文件字节格式无效。', 400);
      const length = Math.min(buffer.byteLength, maximumBytes - size);
      if (length) chunks.push(Buffer.from(buffer.subarray(0, length)));
      size += length;
      truncated = length < buffer.byteLength;
      if (truncated) break;
    }
    return { bytes: Buffer.concat(chunks, size), truncated };
  } finally {
    body.destroy();
  }
}

export function decodeUtf8Source(bytes: Uint8Array, truncated = false): string {
  const invalidText = () =>
    new DomainError(
      'VALIDATION_ERROR',
      '文件内容不是有效的 UTF-8 文本。',
      400,
      {
        reason: 'invalidUtf8Text',
      },
    );
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, {
      stream: truncated,
    });
  } catch {
    throw invalidText();
  }
  // Valid byte encoding alone would also admit binary data containing NUL/control bytes.
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f]/u.test(text))
    throw invalidText();
  return text;
}
