import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readPinnedContractArtifact } from './source-manifest.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)),
  artifact = await readPinnedContractArtifact(root),
  metadata = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')),
  version = metadata.version,
  publication = JSON.parse(
    await readFile(
      resolve(root, 'contracts', artifact, 'manifest.json'),
      'utf8',
    ),
  ),
  parent = resolve(
    root,
    publication.mainPublished
      ? 'dist/packages/releases'
      : 'dist/packages/candidates',
    version,
  ),
  out = resolve(parent, artifact),
  stageName = `local-client-${version}`,
  stage = resolve(out, stageName),
  tgz = resolve(out, `aitesthub-local-client-${version}.tgz`);
const pnpmCli = process.env.npm_execpath;
if (!pnpmCli || !isAbsolute(pnpmCli))
  throw Error('Run packaging through the pinned pnpm command.');
await mkdir(parent, { recursive: true });
await mkdir(out); // Immutable candidate identity: never overwrite even a prior partial package.
execFileSync(process.execPath, [pnpmCli, 'pack', '--pack-destination', out], {
  cwd: root,
  windowsHide: true,
  stdio: 'inherit',
});
await mkdir(stage);
for (const name of [
  'README.md',
  'LICENSE',
  'NOTICE',
  'pnpm-lock.yaml',
  'verification.md',
])
  await copyFile(resolve(root, name), resolve(stage, name));
await copyFile(tgz, resolve(stage, `aitesthub-local-client-${version}.tgz`));
await copyFile(
  resolve(root, 'contracts', artifact, 'manifest.json'),
  resolve(stage, 'contract-provenance.json'),
);
const zip = resolve(out, `aitesthub-local-client-${version}.zip`),
  tar = process.platform === 'win32' ? 'tar.exe' : 'tar';
execFileSync(tar, ['-a', '-c', '-f', zip, '-C', out, stageName], {
  windowsHide: true,
});
const bytes = await readFile(zip);
if (bytes[0] !== 0x50 || bytes[1] !== 0x4b)
  throw new Error('ZIP-capable packaging host required');
const entries = execFileSync(tar, ['-t', '-f', zip], { encoding: 'utf8' })
  .trim()
  .split(/\r?\n/);
if (entries.some((p) => !p.startsWith(stageName + '/') || p.includes('..')))
  throw new Error('Unexpected ZIP member');
const sha = (b) => createHash('sha256').update(b).digest('hex'),
  evidence = {
    package: '@aitesthub/local-client',
    version,
    candidateIdentity: artifact,
    contractArtifactId: artifact,
    publicationState: publication.publicationState,
    mainPublished: publication.mainPublished,
    artifacts: [
      {
        path: relative(root, tgz).replaceAll('\\', '/'),
        sha256: sha(await readFile(tgz)),
      },
      {
        path: relative(root, zip).replaceAll('\\', '/'),
        sha256: sha(bytes),
      },
    ],
    zipEntries: entries,
    packagingInstalls: 0,
    packagingMainRequests: 0,
  };
await writeFile(
  resolve(out, 'package-verification.json'),
  JSON.stringify(evidence, null, 2) + '\n',
  { flag: 'wx' },
);
console.log(JSON.stringify(evidence));
