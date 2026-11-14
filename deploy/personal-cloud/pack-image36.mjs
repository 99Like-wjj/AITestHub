// Package the already deployed exact local36 image only. No cloud transport.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
assert.equal(
  process.env.AITESTHUB_CLOUD_IMAGE_PACKAGE,
  'explicit-local36-image-only',
);
assert.equal(process.argv.length, 4);
const imageId = process.argv[2],
  proofFile = resolve(process.argv[3]);
assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
const proofBytes = await readFile(proofFile),
  proof = JSON.parse(proofBytes);
assert.equal(proof.schemaVersion, 'ath.cloud-runtime-build.v1');
assert.equal(proof.imageId, imageId);
assert.equal(
  proof.files['packages/persistence/migrations/0036_account_removal.sql'],
  '4bda3515a66053d43f20331626e96efa0ffcddbadda2efd9ab5635ced5d84c3e',
);
const docker = join(
  process.env.LOCALAPPDATA,
  'Programs/DockerDesktop/resources/bin/docker.exe',
);
const read = (args) =>
  execFileSync(docker, ['--context', 'desktop-linux', ...args], {
    windowsHide: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
assert.match(
  read([
    'context',
    'inspect',
    'desktop-linux',
    '--format',
    '{{.Endpoints.docker.Host}}',
  ]),
  /^npipe:\/+\.\/pipe\/dockerDesktopLinuxEngine$/,
);
assert.equal(
  read(['image', 'inspect', imageId, '--format', '{{.Id}}']),
  imageId,
);
assert.equal(
  read(['inspect', 'aitesthub-local-api-1', '--format', '{{.Image}}']),
  imageId,
);
const directory = join(
  process.env.LOCALAPPDATA,
  'AITestHub/setup/personal-cloud',
  'release36-' + imageId.slice(7, 19) + '-' + randomUUID(),
);
assert.ok(isAbsolute(directory));
await mkdir(directory, { recursive: false });
const archive = join(
  directory,
  'aitesthub-36-' + imageId.slice(7, 19) + '-image.tar.gz',
);
const child = spawn(
  docker,
  ['--context', 'desktop-linux', 'image', 'save', imageId],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
);
child.stderr.resume();
const exited = new Promise((done, reject) => {
  child.once('error', reject);
  child.once('exit', (code) =>
    code === 0 ? done() : reject(new Error('EXACT_LOCAL_IMAGE_SAVE_FAILED')),
  );
});
await Promise.all([
  pipeline(
    child.stdout,
    createGzip({ level: 6 }),
    createWriteStream(archive, { flags: 'wx' }),
  ),
  exited,
]);
const hash = createHash('sha256');
for await (const chunk of createReadStream(archive)) hash.update(chunk);
const report = {
  schemaVersion: 'ath.cloud36-local-image-package.v1',
  createdAt: new Date().toISOString(),
  imageId,
  archive: {
    path: archive,
    bytes: (await stat(archive)).size,
    sha256: hash.digest('hex'),
  },
  buildProof: {
    path: proofFile,
    sha256: createHash('sha256').update(proofBytes).digest('hex'),
  },
  cloudWrites: 0,
  cloudUploads: 0,
  providerRequests: 0,
  localVolumesIncluded: false,
  localSecretsIncluded: false,
  sourceWipIncluded: false,
  source:
    'Already running exact local36 image; no rebuild or local database copy',
};
const output = join(directory, 'image-package.json');
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, ...report }));
