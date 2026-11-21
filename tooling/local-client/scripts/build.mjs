import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const root = await realpath(resolve(import.meta.dirname, '..'));
const workspace = await realpath(resolve(root, '../..'));
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const temporaryRoot = join(workspace, '.local-build');
await mkdir(temporaryRoot, { recursive: true });
assert.equal(
  relative(workspace, await realpath(temporaryRoot)),
  '.local-build',
);
const stage = await mkdtemp(join(temporaryRoot, 'sdk-contract-'));
const stageName = relative(workspace, await realpath(stage));
assert.match(stageName, /^\.local-build[\\/]sdk-contract-[a-zA-Z0-9]+$/);

try {
  execFileSync(
    process.execPath,
    [
      require.resolve('typescript/bin/tsc'),
      '-p',
      join(root, 'tsconfig.catalog.json'),
      '--outDir',
      stage,
    ],
    { cwd: workspace, windowsHide: true, stdio: 'inherit' },
  );
  // Resolve the MCP handler and compiled factory against the same workspace SDK instance.
  const collector = join(stage, 'collect-contract.mjs');
  await copyFile(join(import.meta.dirname, 'collect-contract.mjs'), collector);
  const bytes = execFileSync(
    process.execPath,
    [collector, stage, metadata.version],
    { cwd: workspace, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
  );
  const contract = JSON.parse(bytes.toString('utf8'));
  const destination = join(root, 'dist', 'contracts');
  await mkdir(destination, { recursive: true });
  const artifactId = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(stage, 'current.json'), bytes, { flag: 'wx' });
  await rename(join(stage, 'current.json'), join(destination, 'current.json'));
  const runtime = await import(
    pathToFileURL(join(root, 'dist/src/contracts.js')).href
  );
  assert.equal(runtime.contractArtifactId, artifactId);
  assert.equal(runtime.contractVersion, metadata.version);
  assert.equal(runtime.contractProtocolVersion, contract.protocolVersion);
  console.log(
    JSON.stringify({
      artifactId,
      tools: contract.tools.length,
      components: Object.keys(contract.components).length,
      bytes: bytes.length,
    }),
  );
} finally {
  assert.equal(relative(workspace, await realpath(stage)), stageName);
  await rm(stage, { recursive: true });
}
