import { createDatabaseFromEnvironment } from '../packages/persistence/src/config.js';
import { createStorageFromEnvironment } from '../packages/storage/src/s3.js';
import { createRecoveryServices } from '../packages/application/src/recovery/environment.js';
import { DomainError } from '../packages/application/src/errors.js';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

const db = await createDatabaseFromEnvironment(),
  storage = await createStorageFromEnvironment();
try {
  const { runtime } = await createRecoveryServices(db, storage);
  if (process.argv.includes('--once')) await runtime.tick();
  else {
    runtime.start();
    const root =
        process.env.AITESTHUB_LOCAL_ROOT ??
        (process.env.LOCALAPPDATA
          ? join(process.env.LOCALAPPDATA, 'AITestHub')
          : undefined),
      stopFile =
        process.env.AITESTHUB_OPERATIONS_STOP_FILE ??
        (root ? join(root, 'setup', 'operations', 'stop.request') : undefined);
    await new Promise<void>((done) => {
      let timer: ReturnType<typeof setInterval> | undefined;
      const stop = () => {
        if (timer) clearInterval(timer);
        done();
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      if (stopFile)
        timer = setInterval(() => {
          void stat(stopFile)
            .then(stop)
            .catch(() => {});
        }, 1000);
    });
    await runtime.stop();
  }
} catch (error: unknown) {
  process.stderr.write(
    `${error instanceof DomainError ? error.code : 'OPERATIONS_WORKER_FAILED'}\n`,
  );
  process.exitCode = 1;
} finally {
  storage.close();
  await db.close();
}
