// Read only: explain archived inventory vs currently admissible restored objects.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { createDatabaseFromEnvironment } from '../../../dist/packages/persistence/src/config.js';
import { createStorageFromEnvironment } from '../../../dist/packages/storage/src/s3.js';
import { backupFilesFromEnvironment } from '../../../dist/packages/application/src/recovery/environment.js';
const value = (name) =>
  z
    .uuid()
    .parse(
      process.argv
        .find((arg) => arg.startsWith(`--${name}=`))
        ?.slice(name.length + 3),
    );
const targetId = value('target'),
  backupId = value('backup');
const root =
  process.env.AITESTHUB_LOCAL_ROOT ??
  join(process.env.LOCALAPPDATA, 'AITestHub');
const env = JSON.parse(
  await readFile(
    join(
      root,
      'recovery',
      'isolated',
      targetId,
      'namespace',
      'application-environment.json',
    ),
    'utf8',
  ),
);
assert.equal(env.DB_HOST, '127.0.0.1');
assert.notEqual(String(env.DB_PORT), '55432');
assert.equal(env.DB_NAME, 'aitesthub_restore');
const db = await createDatabaseFromEnvironment(env),
  storage = await createStorageFromEnvironment(env);
const report = {
  id: randomUUID(),
  targetId,
  backupId,
  verifiedAt: new Date().toISOString(),
  readOnly: true,
  productDatabaseChanged: false,
  providerRequests: 0,
  passed: false,
};
try {
  const manifest = await (await backupFilesFromEnvironment()).read(backupId);
  const active = (
    await db.query(
      "SELECT id,storage_key FROM app.file_resources WHERE status='verified' AND deleted_at IS NULL",
    )
  ).rows;
  const ids = new Set(active.map((row) => row.id));
  const excludedIds = manifest.resources
    .filter((row) => !ids.has(row.id))
    .map((row) => row.id);
  const excluded = (
    await db.query(
      `SELECT f.id,f.status,f.created_at,f.deleted_at,f.owner_scope,
    (SELECT count(*)::int FROM app.resource_references r WHERE r.resource_id=f.id) reference_count,
    (SELECT jsonb_agg(jsonb_build_object('reason',g.reason,'state',g.state)) FROM app.operations_file_gc g WHERE g.resource_id=f.id) gc
    FROM app.file_resources f WHERE f.id=ANY($1::uuid[])`,
      [excludedIds],
    )
  ).rows;
  const activeObjects = new Set(
    manifest.resources
      .filter((row) => ids.has(row.id))
      .map((row) => row.objectId),
  );
  const skipped = manifest.objects.filter(
    (object) => !activeObjects.has(object.id),
  );
  const skippedAbsent = [];
  for (const object of skipped)
    skippedAbsent.push({
      objectId: object.id,
      absent: !(await storage.exists(object.storageKey)),
    });
  assert.equal(manifest.objects.length, 97);
  assert.equal(manifest.resources.length, 97);
  assert.equal(activeObjects.size, 96);
  assert.equal(active.length, 96);
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].reference_count, 0);
  assert.ok(excluded[0].deleted_at);
  assert.ok(
    excluded[0].gc.some(
      (job) =>
        job.reason === 'temporaryUnreferenced' && job.state === 'completed',
    ),
  );
  assert.ok(skippedAbsent.every((row) => row.absent));
  Object.assign(report, {
    passed: true,
    archivedObjects: manifest.objects.length,
    archivedResources: manifest.resources.length,
    archiveControlSequence: manifest.controls.sequence,
    restoredActiveObjects: activeObjects.size,
    restoredActiveResources: active.length,
    excluded,
    skippedAbsent,
  });
} catch (error) {
  report.error = error instanceof Error ? error.message : 'inventory failed';
  process.exitCode = 1;
} finally {
  storage.close();
  await db.close();
  await mkdir(resolve('test-results/recovery'), { recursive: true });
  const path = resolve(
    'test-results/recovery',
    `restored-inventory-${targetId}-${report.id}.json`,
  );
  await writeFile(path, JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log({ path, ...report });
}
