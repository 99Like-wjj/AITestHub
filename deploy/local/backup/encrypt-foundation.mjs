// Local foundation archive protection. No network calls or secret output.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, open, stat } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';

const values = {};
for (let i = 2; i < process.argv.length; i += 2)
  values[process.argv[i]] = process.argv[i + 1];
const runtime = resolve(process.env.LOCALAPPDATA, 'AITestHub');
const input = resolve(values['--input'] || '');
const output = resolve(values['--output'] || '');
const keyPath = resolve(runtime, 'secrets', 'backup-encryption-key');
for (const p of [input, output]) {
  const r = relative(resolve(runtime, 'backups'), p);
  if (!r || r.startsWith('..' + sep) || r === '..' || r.includes(':'))
    throw new Error('Backup path must stay under the task backup directory');
}
const key = Buffer.from((await readFile(keyPath, 'utf8')).trim(), 'hex');
if (key.length !== 32) throw new Error('Invalid local backup key');
const magic = Buffer.from('ATHBK01\n');
const iv = randomBytes(12);
const plaintextHash = createHash('sha256');
for await (const chunk of createReadStream(input)) plaintextHash.update(chunk);
const expected = plaintextHash.digest('hex');
const handle = await open(output, 'wx');
await handle.write(Buffer.concat([magic, iv]));
await handle.close();
const cipher = createCipheriv('aes-256-gcm', key, iv);
await pipeline(
  createReadStream(input),
  cipher,
  createWriteStream(output, { flags: 'a' }),
);
const append = await open(output, 'a');
await append.write(cipher.getAuthTag());
await append.close();
const size = (await stat(output)).size;
const reader = await open(output, 'r');
const tag = Buffer.alloc(16);
await reader.read(tag, 0, 16, size - 16);
await reader.close();
const decoder = createDecipheriv('aes-256-gcm', key, iv);
decoder.setAuthTag(tag);
const actualHash = createHash('sha256');
await pipeline(
  createReadStream(output, { start: magic.length + iv.length, end: size - 17 }),
  decoder,
  new Writable({
    write(chunk, encoding, callback) {
      actualHash.update(chunk);
      callback();
    },
  }),
);
if (actualHash.digest('hex') !== expected)
  throw new Error('Backup round-trip checksum mismatch');
const encryptedHash = createHash('sha256');
for await (const chunk of createReadStream(output)) encryptedHash.update(chunk);
console.log(
  JSON.stringify({
    scope: 'foundation-database-only',
    encryption: 'AES-256-GCM',
    bytes: size,
    plaintextSha256: expected,
    encryptedSha256: encryptedHash.digest('hex'),
    authenticatedDecryptChecksumPassed: true,
    secretValuesPrinted: false,
  }),
);
