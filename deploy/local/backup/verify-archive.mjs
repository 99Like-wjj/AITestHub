// Read and authenticate an existing product archive. No plaintext or secrets are printed.
import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { backupFilesFromEnvironment } from '../../../dist/packages/application/src/recovery/environment.js';
const id = z
  .uuid()
  .parse(process.argv.find((arg) => arg.startsWith('--backup='))?.slice(9));
const archive = await backupFilesFromEnvironment();
const manifest = await archive.read(id);
await archive.verify(manifest);
const evidence = {
  schemaVersion: 'ath.existing-archive-verification.v1',
  backupId: id,
  verifiedAt: new Date().toISOString(),
  passed: true,
  authenticatedEncryptedComponents: true,
  resourceCount: manifest.resources.length,
  objectCount: manifest.objects.length,
  controlSequence: manifest.controls.sequence,
  migrations: manifest.versions.migrations,
  restoredToDatabase: false,
};
const directory = resolve('test-results/recovery');
await mkdir(directory, { recursive: true });
const path = join(directory, `verified-product-archive-${id}.json`);
await writeFile(path, JSON.stringify(evidence, null, 2) + '\n');
console.log({
  passed: true,
  backupId: id,
  objectCount: evidence.objectCount,
  resourceCount: evidence.resourceCount,
  evidencePath: path,
});
