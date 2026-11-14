import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DomainError } from '../errors.js';

const magic = Buffer.from('ATHENC02\n');
export interface SealedFile {
  plaintextBytes: number;
  plaintextSha256: string;
  encryptedBytes: number;
  encryptedSha256: string;
}
const failure = () =>
  new DomainError(
    'DEPENDENCY_UNAVAILABLE',
    '加密归档校验失败；没有标记可恢复，目标保持隔离。',
    503,
  );
function validKey(key: Buffer) {
  if (key.length !== 32) throw failure();
}
export async function fileDigest(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export function sealJson(value: unknown, key: Buffer, context: string): Buffer {
  validKey(key);
  const nonce = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(context));
  const bytes = Buffer.from(JSON.stringify(value));
  return Buffer.concat([
    magic,
    nonce,
    cipher.update(bytes),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}
export function unsealJson(
  bytes: Buffer,
  key: Buffer,
  context: string,
): unknown {
  try {
    validKey(key);
    if (
      bytes.length < magic.length + 28 ||
      !timingSafeEqual(bytes.subarray(0, magic.length), magic)
    )
      throw new Error();
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      bytes.subarray(magic.length, magic.length + 12),
    );
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(bytes.subarray(-16));
    return JSON.parse(
      Buffer.concat([
        decipher.update(bytes.subarray(magic.length + 12, -16)),
        decipher.final(),
      ]).toString('utf8'),
    ) as unknown;
  } catch {
    throw failure();
  }
}
export async function decryptFile(
  path: string,
  key: Buffer,
  context: string,
): Promise<Readable> {
  try {
    validKey(key);
    const size = (await stat(path)).size;
    if (size < magic.length + 28) throw new Error();
    const handle = await open(path, 'r');
    const prefix = Buffer.alloc(magic.length + 12),
      tag = Buffer.alloc(16);
    try {
      await handle.read(prefix, 0, prefix.length, 0);
      await handle.read(tag, 0, 16, size - 16);
    } finally {
      await handle.close();
    }
    if (!timingSafeEqual(prefix.subarray(0, magic.length), magic))
      throw new Error();
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      prefix.subarray(magic.length),
    );
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(tag);
    const source = createReadStream(path, {
      start: prefix.length,
      end: size - 17,
    });
    source.once('error', () => decipher.destroy(failure()));
    decipher.once('close', () => source.destroy());
    return source.pipe(decipher);
  } catch {
    throw failure();
  }
}
export async function verifySealedFile(
  path: string,
  key: Buffer,
  context: string,
  expected?: Pick<SealedFile, 'plaintextBytes' | 'plaintextSha256'>,
) {
  try {
    const hash = createHash('sha256');
    let bytes = 0;
    await pipeline(
      await decryptFile(path, key, context),
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          hash.update(chunk);
          callback();
        },
      }),
    );
    const actual = {
      plaintextBytes: bytes,
      plaintextSha256: hash.digest('hex'),
    };
    if (
      expected &&
      (expected.plaintextBytes !== bytes ||
        expected.plaintextSha256 !== actual.plaintextSha256)
    )
      throw new Error();
    return actual;
  } catch {
    throw failure();
  }
}
export async function encryptFile(
  input: Readable,
  path: string,
  key: Buffer,
  context: string,
): Promise<SealedFile> {
  validKey(key);
  const nonce = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(context));
  const header = await open(path, 'wx', 0o600);
  try {
    await header.writeFile(Buffer.concat([magic, nonce]));
    await header.sync();
  } finally {
    await header.close();
  }
  let plaintextBytes = 0;
  const hash = createHash('sha256');
  try {
    await pipeline(
      input,
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          plaintextBytes += chunk.length;
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      cipher,
      createWriteStream(path, { flags: 'a' }),
    );
    const tag = await open(path, 'a');
    try {
      await tag.write(cipher.getAuthTag());
      await tag.sync();
    } finally {
      await tag.close();
    }
    const plain = { plaintextBytes, plaintextSha256: hash.digest('hex') };
    await verifySealedFile(path, key, context, plain);
    return {
      ...plain,
      encryptedBytes: (await stat(path)).size,
      encryptedSha256: await fileDigest(path),
    };
  } catch {
    input.destroy();
    throw failure();
  }
}
