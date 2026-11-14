import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { createDatabaseFromEnvironment } from '../../../dist/packages/persistence/src/config.js';
import { migrateDatabase } from '../../../dist/packages/persistence/src/migrate.js';
import { createStorageFromEnvironment } from '../../../dist/packages/storage/src/s3.js';
import { ControlJournal } from '../../../dist/packages/application/src/recovery/control-journal.js';
import { FilePrivacyLedger } from '../../../dist/packages/application/src/conversations/privacy.js';
import {
  createIsolatedTarget,
  targetEnvironment,
  restoreDatabase,
  removeIsolatedTarget,
} from './isolated-target.mjs';

/** No old snapshot or target metadata is allowed to choose an external control/key path. */
export async function createRestorePort(options = {}) {
  const descriptor = await createIsolatedTarget(options),
    environment = { ...process.env, ...targetEnvironment(descriptor) },
    db = await createDatabaseFromEnvironment(environment),
    storage = await createStorageFromEnvironment(environment);
  const originalMaster =
    process.env.AITESTHUB_MASTER_KEY_FILE ??
    join(
      process.env.AITESTHUB_LOCAL_ROOT ??
        join(process.env.LOCALAPPDATA, 'AITestHub'),
      'secrets',
      'platform-master-key',
    );
  const migrations =
    options.migrationDirectory ?? process.env.AITESTHUB_TEST_MIGRATIONS_DIR;
  let finalEnvironment;
  return {
    descriptor,
    db,
    storage,
    id: descriptor.id,
    async assertFresh() {
      const row = (
        await db.query("SELECT to_regnamespace('app') IS NULL fresh")
      ).rows[0];
      if (!row?.fresh)
        throw new Error(
          'Restore target is not empty; no overwrite was attempted.',
        );
    },
    async restoreDatabase(input) {
      return restoreDatabase(descriptor, input);
    },
    async migrate() {
      await migrateDatabase(db, migrations);
    },
    async initializeNamespace(platformId, expectedMasterFingerprint) {
      const namespace = join(descriptor.directory, 'namespace'),
        secrets = join(descriptor.directory, 'secrets');
      await mkdir(namespace, { mode: 0o700 });
      const control = join(namespace, 'controls'),
        privacy = join(namespace, 'privacy-deletions'),
        backups = join(namespace, 'backups');
      for (const path of [control, privacy, backups])
        await mkdir(path, { mode: 0o700 });
      const master = join(secrets, 'platform-master-key'),
        controlKey = join(secrets, 'recovery-control-key'),
        backupKey = join(secrets, 'backup-encryption-key'),
        bootstrap = join(secrets, 'api-worker-bootstrap');
      if (
        (await currentMasterFingerprint(environment)) !==
        expectedMasterFingerprint
      )
        throw new Error('Private master key changed during validation');
      await copyFile(originalMaster, master, constants.COPYFILE_EXCL);
      for (const path of [controlKey, backupKey, bootstrap])
        await writeFile(path, randomBytes(32).toString('hex'), {
          flag: 'wx',
          mode: 0o600,
        });
      finalEnvironment = {
        ...environment,
        AITESTHUB_MASTER_KEY_FILE: master,
        AITESTHUB_RECOVERY_CONTROL_DIRECTORY: control,
        AITESTHUB_RECOVERY_CONTROL_KEY_FILE: controlKey,
        AITESTHUB_RECOVERY_CONTROL_ANCHOR_FILE: join(
          namespace,
          'security-control-anchor.json',
        ),
        AITESTHUB_BACKUP_DIRECTORY: backups,
        AITESTHUB_BACKUP_KEY_FILE: backupKey,
        AITESTHUB_PRIVACY_LEDGER_DIRECTORY: privacy,
        AITESTHUB_API_WORKER_BOOTSTRAP_FILE: bootstrap,
      };
      const journal = await ControlJournal.fromEnvironment(
        db,
        finalEnvironment,
      );
      const initialized = await journal.initialize();
      if (initialized.platformId !== platformId)
        throw new Error('New isolated control namespace mismatch');
      const ledger = await FilePrivacyLedger.fromEnvironment(finalEnvironment);
      const rows = (
        await db.query(
          'SELECT * FROM app.privacy_deletion_events ORDER BY occurred_at,id',
        )
      ).rows;
      for (const row of rows)
        await ledger.record({
          id: row.id,
          ownerId: row.owner_id,
          targetType: row.target_type,
          targetId: row.target_id,
          exclusiveResourceIds: row.exclusive_resource_ids,
          occurredAt: row.occurred_at.toISOString(),
          controlVersion: 1,
        });
      // This file has paths only. Password/key values remain exclusively in the target's private secret files.
      const names = [
        'DB_HOST',
        'DB_PORT',
        'DB_NAME',
        'DB_USER',
        'AITESTHUB_DB_PASSWORD_FILE',
        'AITESTHUB_S3_ENDPOINT',
        'AITESTHUB_S3_BUCKET',
        'AITESTHUB_S3_ACCESS_KEY_FILE',
        'AITESTHUB_S3_SECRET_KEY_FILE',
        'AITESTHUB_MASTER_KEY_FILE',
        'AITESTHUB_RECOVERY_CONTROL_DIRECTORY',
        'AITESTHUB_RECOVERY_CONTROL_KEY_FILE',
        'AITESTHUB_RECOVERY_CONTROL_ANCHOR_FILE',
        'AITESTHUB_BACKUP_DIRECTORY',
        'AITESTHUB_BACKUP_KEY_FILE',
        'AITESTHUB_PRIVACY_LEDGER_DIRECTORY',
        'AITESTHUB_API_WORKER_BOOTSTRAP_FILE',
      ];
      const paths = Object.fromEntries(
        names
          .filter((name) => finalEnvironment[name] !== undefined)
          .map((name) => [name, finalEnvironment[name]]),
      );
      await writeFile(
        join(namespace, 'application-environment.json'),
        JSON.stringify(paths, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
      return {
        platformId,
        controlSequence: initialized.sequence,
        environmentFile: join(namespace, 'application-environment.json'),
      };
    },
    get environment() {
      return finalEnvironment ?? environment;
    },
    async close(remove = false) {
      storage.close();
      await db.close();
      if (remove) await removeIsolatedTarget(descriptor);
    },
  };
}
export async function currentMasterFingerprint(environment = process.env) {
  const root =
      environment.AITESTHUB_LOCAL_ROOT ??
      join(environment.LOCALAPPDATA, 'AITestHub'),
    file =
      environment.AITESTHUB_MASTER_KEY_FILE ??
      join(root, 'secrets', 'platform-master-key');
  const text = (await readFile(file, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/i.test(text))
    throw new Error('Invalid private platform master key file');
  return createHash('sha256').update(Buffer.from(text, 'hex')).digest('hex');
}
