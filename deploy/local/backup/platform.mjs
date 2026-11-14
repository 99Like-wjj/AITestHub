// Trusted local operator CLI. Inputs are IDs/paths to private files, never credential values.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { createDatabaseFromEnvironment } from '../../../dist/packages/persistence/src/config.js';
import { createStorageFromEnvironment } from '../../../dist/packages/storage/src/s3.js';
import { createRecoveryServices } from '../../../dist/packages/application/src/recovery/environment.js';
import { ProductRestoreService } from '../../../dist/packages/application/src/recovery/restore.js';
import {
  createRestorePort,
  currentMasterFingerprint,
} from './restore-platform.mjs';
import { removeIsolatedTarget } from './isolated-target.mjs';

const [action, ...args] = process.argv.slice(2),
  value = (name) =>
    args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
if (action === 'cleanup-isolated') {
  const id = z.uuid().parse(value('target')),
    root =
      process.env.AITESTHUB_LOCAL_ROOT ??
      join(process.env.LOCALAPPDATA, 'AITestHub'),
    descriptor = JSON.parse(
      await readFile(
        join(root, 'recovery', 'isolated', id, 'target.json'),
        'utf8',
      ),
    );
  await removeIsolatedTarget(descriptor);
  process.stdout.write(
    JSON.stringify({ targetId: id, state: 'removed' }) + '\n',
  );
} else if (['backup', 'restore-isolated', 'status', 'once'].includes(action)) {
  const db = await createDatabaseFromEnvironment(),
    storage = await createStorageFromEnvironment();
  let target;
  try {
    const recovery = await createRecoveryServices(db, storage);
    if (action === 'backup') {
      const job = await recovery.backups.requestInternal('upgrade');
      process.stdout.write(
        JSON.stringify(await recovery.backups.run(job.id)) + '\n',
      );
    }
    if (action === 'once')
      process.stdout.write(
        JSON.stringify(await recovery.runtime.tick()) + '\n',
      );
    if (action === 'status')
      process.stdout.write(
        JSON.stringify({
          controls: await recovery.controls.status(),
          maintenance: await recovery.maintenance.status(),
          capacity: await recovery.capacity.sample(),
        }) + '\n',
      );
    if (action === 'restore-isolated') {
      const backupId = z.uuid().parse(value('backup'));
      target = await createRestorePort();
      const result = await new ProductRestoreService(
        recovery.files,
        recovery.controls,
        await currentMasterFingerprint(),
      ).restore(backupId, target);
      process.stdout.write(JSON.stringify(result) + '\n');
    }
  } catch {
    process.stderr.write(
      'OPERATIONS_COMMAND_FAILED; target remains isolated; no secret values printed.\n',
    );
    process.exitCode = 1;
  } finally {
    await target?.close(false);
    storage.close();
    await db.close();
  }
} else {
  process.stderr.write(
    'Usage: platform.mjs backup | once | status | restore-isolated --backup=UUID | cleanup-isolated --target=UUID\n',
  );
  process.exitCode = 2;
}
