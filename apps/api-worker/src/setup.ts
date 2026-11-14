import { randomBytes } from 'node:crypto';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root =
  process.env.AITESTHUB_LOCAL_ROOT ??
  (process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'AITestHub')
    : undefined);
if (!root) throw new Error('Host private runtime root is required.');
const directory = join(root, 'secrets');
await mkdir(directory, { recursive: true, mode: 0o700 });
if ((await lstat(directory)).isSymbolicLink())
  throw new Error(
    'Private runtime secrets directory cannot be a symbolic link.',
  );
const created: string[] = [];
for (const name of [
  'api-worker-bootstrap',
  'target-postgres-admin-password',
  'target-postgres-app-password',
  'target-postgres-cleanup-password',
  'target-mysql-root-password',
  'target-mysql-app-password',
  'target-mysql-cleanup-password',
  'target-api-auth-password',
]) {
  try {
    await writeFile(join(directory, name), randomBytes(32).toString('hex'), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    created.push(name);
  } catch (error: unknown) {
    if (!(
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'EEXIST'
    ))
      throw new Error(
        'Could not create private worker/target credential file.',
      );
  }
}
process.stdout.write(
  `${JSON.stringify({ createdNames: created, existingFilesPreserved: true, secretValuesPrinted: false })}\n`,
);
