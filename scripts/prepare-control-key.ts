import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
const root =
  process.env.AITESTHUB_LOCAL_ROOT ??
  (process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'AITestHub')
    : undefined);
if (!root) throw new Error('Private runtime root unavailable');
const keyFile = join(root, 'secrets', 'recovery-control-key'),
  copy = join(root, 'recovery', 'recovery-control-key'),
  directory = join(root, 'control', 'security-controls'),
  anchor = join(root, 'recovery', 'controls', 'security-control-anchor.json');
const text = await readFile(keyFile, 'utf8').catch(
  (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  },
);
let created = false;
if (text === null) {
  const old =
    (
      await readdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      })
    ).length > 0 ||
    (await stat(anchor)
      .then(() => true)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      }));
  if (old)
    throw new Error(
      'Existing control state has no key; recovery must remain isolated',
    );
  await mkdir(join(root, 'secrets'), { recursive: true });
  await writeFile(keyFile, randomBytes(32).toString('hex'), {
    flag: 'wx',
    mode: 0o600,
  });
  created = true;
}
const key = (await readFile(keyFile, 'utf8')).trim();
if (!/^[a-f0-9]{64}$/i.test(key))
  throw new Error('Invalid private control key');
await mkdir(join(root, 'recovery'), { recursive: true });
const prior = await readFile(copy, 'utf8').catch(
  (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  },
);
if (prior === null) await writeFile(copy, key, { flag: 'wx', mode: 0o600 });
else {
  const bytes = Buffer.from(prior.trim(), 'hex');
  if (bytes.length !== 32 || !timingSafeEqual(bytes, Buffer.from(key, 'hex')))
    throw new Error('Existing recovery key copy differs; no overwrite');
}
await mkdir(directory, { recursive: true });
await mkdir(join(root, 'recovery', 'controls'), { recursive: true });
process.stdout.write(
  JSON.stringify({
    controlKeyCreated: created,
    recoveryCopyVerified: true,
    valuesPrinted: false,
  }) + '\n',
);
