// Explicit local 33 -> 34 handoff. Never part of application startup or restoration.
import assert from 'node:assert/strict';
import {
  createHmac,
  createHash,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { mkdir, readFile, writeFile, lstat, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { createDatabaseFromEnvironment } from '../../dist/packages/persistence/src/config.js';
import { IdentityService } from '../../dist/packages/application/src/identity/service.js';
import { ControlJournal } from '../../dist/packages/application/src/recovery/control-journal.js';
import { backupFilesFromEnvironment } from '../../dist/packages/application/src/recovery/environment.js';
import {
  resourcePolicyReaderFromEnvironment,
  resourcePolicyWriterFromEnvironment,
} from '../../dist/packages/application/src/resource-policy/environment.js';
import {
  ResourcePolicyOperations,
  resourcePolicyPlatformId,
} from '../../dist/packages/application/src/resource-policy/operations.js';
import { runtimeResourceCapabilities } from '../../dist/packages/application/src/resource-policy/capabilities.js';
import { loadActiveResourcePolicy } from '../../dist/packages/application/src/resource-policy/loader.js';
import {
  defaultResourcePolicy,
  resourcePolicyHeadIdentitySchema,
} from '../../dist/packages/contracts/src/resource-policy.js';
import { resourcePolicyDigest } from '../../dist/packages/application/src/resource-policy/core.js';
import { fileDigest } from '../../dist/packages/application/src/recovery/crypto.js';
import { LocalPolicyUpgradeFence } from './resource-policy-upgrade-fence.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const args = process.argv.slice(2),
  command = args.shift();
const migration = '0034_resource_policy.sql';
const frozenMigrationChecksum =
  'ac84e64462bea989f009667aeca8b61fc1c973b7ab40f9775e4e279f51d29ea0';
const previousMigration = {
  version: '0033_ui_delivery.sql',
  checksum: '436ea1cc48958f2d8d537d8b58bc9b86f0a53d33b2c754f53bdd9a8a451b2744',
};
const defaultHead = {
  revisionId: '34dbe2ea-c9c9-48d9-9318-06b20fba8e92',
  digest: resourcePolicyDigest(defaultResourcePolicy),
  activationVersion: '1',
};
const permitSchema = z.strictObject({
  schemaVersion: z.literal('ath.local-resource-policy-upgrade-permit.v1'),
  id: z.uuid(),
  platformId: z.uuid(),
  preparedAt: z.iso.datetime(),
  previousMigration: z.strictObject({
    version: z.literal('0033_ui_delivery.sql'),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  migrationChecksum: z.literal(frozenMigrationChecksum),
  backupId: z.uuid(),
  backupManifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  backupObjects: z.number().int().nonnegative(),
  head: resourcePolicyHeadIdentitySchema,
});
const privateRoot = resolve(
  process.env.AITESTHUB_LOCAL_ROOT ??
    join(process.env.LOCALAPPDATA ?? '', 'AITestHub'),
);
const directory = join(privateRoot, 'setup', 'resource-policy-upgrade');
const outputId = randomUUID(),
  evidenceDirectory = resolve('test-results/resource-policy');
const evidence = {
  schemaVersion: 'ath.local-resource-policy-upgrade.v1',
  id: outputId,
  command,
  startedAt: new Date().toISOString(),
  passed: false,
  providerRequests: 0,
  businessTargetRequests: 0,
  restoredDatabase: false,
};
let db, identity, session;
function requireLocal() {
  assert.ok(['prepare', 'initialize', 'status'].includes(command));
  assert.equal(
    process.env.AITESTHUB_RESOURCE_POLICY_LOCAL_UPGRADE,
    'explicit-local-33-to-34',
  );
  assert.equal(process.env.DB_HOST, '127.0.0.1');
  assert.equal(process.env.DB_PORT, '55432');
  assert.equal(process.env.DB_NAME, 'aitesthub');
  assert.ok(args.length === (command === 'status' ? 0 : 1));
  // This local-only installer deliberately rejects alternate deployment paths.
  // Its permit and the running readers must use the same existing control key.
  for (const [name, path] of Object.entries({
    AITESTHUB_RECOVERY_CONTROL_KEY_FILE: join(
      privateRoot,
      'secrets',
      'recovery-control-key',
    ),
    AITESTHUB_RECOVERY_CONTROL_DIRECTORY: join(
      privateRoot,
      'control',
      'security-controls',
    ),
    AITESTHUB_RECOVERY_CONTROL_ANCHOR_FILE: join(
      privateRoot,
      'recovery',
      'controls',
      'security-control-anchor.json',
    ),
    AITESTHUB_RESOURCE_POLICY_ANCHOR_FILE: join(
      privateRoot,
      'recovery',
      'controls',
      'resource-policy',
      'anchor.json',
    ),
    AITESTHUB_RESOURCE_POLICY_LOCK_DIRECTORY: join(
      privateRoot,
      'control',
      'resource-policy-writer',
    ),
    AITESTHUB_BACKUP_DIRECTORY: join(privateRoot, 'backups', 'product'),
    AITESTHUB_BACKUP_KEY_FILE: join(
      privateRoot,
      'secrets',
      'backup-encryption-key',
    ),
  })) {
    if (process.env[name] !== undefined)
      assert.equal(resolve(process.env[name]), path);
    process.env[name] = path;
  }
}
async function absent(path) {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}
async function newFile(path, value) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  assert.ok(!(await lstat(directory)).isSymbolicLink());
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function authenticatedAdmin() {
  // Existing independent security controls must reconcile before any credential mutation.
  const controls = await ControlJournal.fromEnvironment(db);
  await controls.initialize();
  identity = new IdentityService(db);
  const password = (
    await readFile(
      join(privateRoot, 'secrets', 'bootstrap-admin-password'),
      'utf8',
    )
  ).trimEnd();
  const login = await identity.login({ account: 'local-admin', password });
  session = login.session;
  assert.equal(login.user.isPlatformAdmin, true);
  return identity.authenticate(session, undefined, randomUUID());
}
const metadataHead = (value) => ({
  revisionId: value.revisionId,
  digest: value.digest,
  activationVersion: value.activationVersion,
});
try {
  requireLocal(); // Before connecting, reading credentials, or creating any directory.
  db = await createDatabaseFromEnvironment();
  const actor = await authenticatedAdmin();
  const platformId = await resourcePolicyPlatformId(db);
  const fence = new LocalPolicyUpgradeFence(directory, platformId);
  const last = (
    await db.query(
      'SELECT version,checksum FROM app.schema_migrations ORDER BY version DESC LIMIT 1',
    )
  ).rows[0];
  const reader = await resourcePolicyReaderFromEnvironment();
  const keyText = (
    await readFile(join(privateRoot, 'secrets', 'recovery-control-key'), 'utf8')
  ).trim();
  assert.match(keyText, /^[a-f0-9]{64}$/i);
  const signature = (permit) =>
    createHmac('sha256', Buffer.from(keyText, 'hex'))
      .update('ath.local-resource-policy-upgrade-permit.v1\0')
      .update(JSON.stringify(permit))
      .digest('hex');
  if (command === 'prepare') {
    assert.deepEqual(last, previousMigration);
    assert.equal(await reader.read(), null);
    const tables = (
      await db.query(`SELECT to_regclass('app.resource_policy_head') h,
      to_regclass('app.resource_policy_revisions') r, to_regclass('app.resource_policy_acceptances') a,
      to_regclass('app.resource_policy_activations') l`)
    ).rows[0];
    assert.ok(Object.values(tables).every((value) => value === null));
    const backupId = z.uuid().parse(args[0]);
    const backup = (
      await db.query(
        'SELECT state,manifest_digest,control_sequence,control_digest,object_count FROM app.product_backups WHERE id=$1',
        [backupId],
      )
    ).rows[0];
    assert.equal(backup?.state, 'complete');
    // Never let a verification-only backup helper create replacement key material.
    assert.match(
      (await readFile(process.env.AITESTHUB_BACKUP_KEY_FILE, 'utf8')).trim(),
      /^[a-f0-9]{64}$/i,
    );
    const archive = await backupFilesFromEnvironment(),
      manifest = await archive.read(backupId);
    await archive.verify(manifest);
    assert.equal(manifest.id, backupId);
    assert.equal(manifest.platformId, platformId);
    const backupManifestDigest = await fileDigest(
      archive.path(backupId, 'manifest.enc'),
    );
    assert.equal(backup.manifest_digest, backupManifestDigest);
    assert.equal(
      String(backup.control_sequence),
      String(manifest.controls.sequence),
    );
    assert.equal(backup.control_digest, manifest.controls.stateDigest);
    assert.equal(BigInt(backup.object_count), BigInt(manifest.objects.length));
    assert.deepEqual(manifest.versions.migrations.at(-1), previousMigration);
    // Accept the reviewed pending or promoted filename, never a different SQL artifact.
    const publishedPath = resolve('packages/persistence/migrations', migration);
    const pendingPath = publishedPath + '.pending';
    const published = !(await absent(publishedPath));
    const migrationChecksum = sha(
      await readFile(published ? publishedPath : pendingPath),
    );
    assert.equal(migrationChecksum, frozenMigrationChecksum);
    if (published && !(await absent(pendingPath)))
      assert.equal(sha(await readFile(pendingPath)), frozenMigrationChecksum);
    const permit = permitSchema.parse({
      schemaVersion: 'ath.local-resource-policy-upgrade-permit.v1',
      id: randomUUID(),
      platformId,
      preparedAt: new Date().toISOString(),
      previousMigration,
      migrationChecksum,
      backupId,
      backupManifestDigest,
      backupObjects: manifest.objects.length,
      head: defaultHead,
    });
    const signedPermit = {
      permit,
      signature: signature(permit),
    };
    await newFile(join(directory, `${permit.id}.json`), signedPermit);
    await fence.bindPermit({
      permitId: permit.id,
      signature: signedPermit.signature,
    });
    evidence.permitId = permit.id;
    evidence.backupId = backupId;
    evidence.backupObjects = manifest.objects.length;
    evidence.migrationChecksum = migrationChecksum;
  } else if (command === 'initialize') {
    const permitId = z.uuid().parse(args[0]),
      path = join(directory, `${permitId}.json`);
    assert.ok(!(await lstat(path)).isSymbolicLink());
    const stored = JSON.parse(await readFile(path, 'utf8')),
      permit = permitSchema.parse(stored.permit);
    assert.equal(permit.id, permitId);
    assert.match(stored.signature, /^[a-f0-9]{64}$/);
    assert.ok(
      timingSafeEqual(
        Buffer.from(stored.signature, 'hex'),
        Buffer.from(signature(permit), 'hex'),
      ),
    );
    assert.equal(platformId, permit.platformId);
    const permitIdentity = { permitId, signature: stored.signature };
    await fence.assertBound(permitIdentity);
    assert.deepEqual(permit.previousMigration, previousMigration);
    assert.deepEqual(permit.head, defaultHead);
    assert.equal(last.version, migration);
    assert.equal(last.checksum, permit.migrationChecksum);
    assert.equal(
      sha(
        await readFile(resolve('packages/persistence/migrations', migration)),
      ),
      permit.migrationChecksum,
    );
    const consumed = join(directory, `${permitId}.consumed.json`);
    const current = await db.transaction((tx) =>
      loadActiveResourcePolicy(tx, runtimeResourceCapabilities),
    );
    assert.deepEqual(metadataHead(current), defaultHead);
    const writer = await resourcePolicyWriterFromEnvironment();
    const { bootstrapAllowed } = await fence.beginInitialization(
      permitIdentity,
      () => reader.read(),
    );
    const service = new ResourcePolicyOperations(
      db,
      writer,
      runtimeResourceCapabilities,
      bootstrapAllowed
        ? { platformId: permit.platformId, head: permit.head }
        : undefined,
    );
    const initialized = await service.initialize(actor);
    const verified = await service.current(actor);
    assert.deepEqual(metadataHead(initialized), metadataHead(verified));
    if (await absent(consumed))
      await newFile(consumed, {
        permitId,
        platformId,
        head: metadataHead(verified),
        consumedAt: new Date().toISOString(),
      });
    evidence.permitId = permitId;
    evidence.platformId = platformId;
    evidence.head = metadataHead(verified);
    evidence.defaultLimits = verified.policy;
  } else {
    const writer = await resourcePolicyWriterFromEnvironment();
    const service = new ResourcePolicyOperations(
      db,
      writer,
      runtimeResourceCapabilities,
    );
    const current = await service.current(actor);
    evidence.platformId = platformId;
    evidence.head = metadataHead(current);
    evidence.defaultLimits = current.policy;
  }
  evidence.passed = true;
} catch (error) {
  evidence.errorCode =
    typeof error?.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(error.code)
      ? error.code
      : 'LOCAL_POLICY_UPGRADE_REJECTED';
  process.exitCode = 1;
} finally {
  if (identity && session)
    await identity.logout(session).catch(() => {
      evidence.sessionCleanupUnconfirmed = true;
      evidence.passed = false;
      process.exitCode = 1;
    });
  await db?.close();
  await mkdir(evidenceDirectory, { recursive: true });
  const path = join(evidenceDirectory, `local-upgrade-${outputId}.json`);
  await writeFile(path, JSON.stringify(evidence, null, 2) + '\n', {
    flag: 'wx',
  });
  console.log({
    passed: evidence.passed,
    command,
    evidencePath: path,
    permitId: evidence.permitId,
    errorCode: evidence.errorCode,
  });
}
