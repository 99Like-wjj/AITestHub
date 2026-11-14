// Build a self-contained operator archive; instance configuration stays external.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { readDeploymentProfile } from './deployment-profile.mjs';

assert.equal(
  process.env.AITESTHUB_CLOUD_OPERATOR_PACKAGE,
  'explicit-reviewed-local36-operator',
);
assert.equal(process.argv.length, 3);
const configured = await readDeploymentProfile();
const profile = configured.data;
const imagePackage = JSON.parse(
  await readFile(resolve(process.argv[2]), 'utf8'),
);
assert.equal(imagePackage.schemaVersion, 'ath.cloud36-local-image-package.v1');
assert.match(imagePackage.imageId, /^sha256:[a-f0-9]{64}$/);
const id = randomUUID();
const directory = join(
  process.env.LOCALAPPDATA,
  'AITestHub/setup/personal-cloud',
  'operator36-' + id,
);
const stage = join(directory, 'public');
await mkdir(directory);
await mkdir(stage);
await mkdir(join(stage, 'operator'));
const sourceFiles = {
  'operator/upgrade-33-to-36.mjs': 'deploy/personal-cloud/upgrade-33-to-36.mjs',
  'operator/deployment-profile.mjs':
    'deploy/personal-cloud/deployment-profile.mjs',
  'operator/private-config.mjs': 'scripts/private-config.mjs',
  'operator/policy34-checkpoint.mjs':
    'deploy/personal-cloud/policy34-checkpoint.mjs',
  'operator/resource-policy-upgrade-fence.mjs':
    'deploy/personal-cloud/resource-policy-upgrade-fence.mjs',
  'operator/compose36.overlay.yaml':
    'deploy/personal-cloud/compose36.overlay.yaml',
  'operator/stage-runtime.py': 'deploy/personal-cloud/stage-runtime.py',
  'operator/README.md': 'deploy/personal-cloud/CONFIGURATION.md',
  'build-proof.json': imagePackage.buildProof.path,
};
const files = {};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
for (const [name, source] of Object.entries(sourceFiles)) {
  let bytes = await readFile(resolve(source));
  // Bundle this sole internal import beside its implementation, with a recorded hash.
  if (name === 'operator/deployment-profile.mjs') {
    bytes = Buffer.from(
      bytes
        .toString('utf8')
        .replace('../../scripts/private-config.mjs', './private-config.mjs'),
    );
  }
  await writeFile(join(stage, name), bytes, { flag: 'wx' });
  files[name] = sha(bytes);
}
assert.equal(files['build-proof.json'], imagePackage.buildProof.sha256);
const prefix = imagePackage.imageId.slice(7, 19);
const archive = join(
  directory,
  'aitesthub-36-' + prefix + '-operator-' + id + '.tar.gz',
);
execFileSync(
  'tar.exe',
  ['-czf', archive, '-C', stage, 'build-proof.json', 'operator'],
  { windowsHide: true, stdio: 'pipe' },
);
const hash = createHash('sha256');
for await (const chunk of createReadStream(archive)) hash.update(chunk);
const plan = {
  schemaVersion: 'ath.cloud36-operator-package.v1',
  id,
  createdAt: new Date().toISOString(),
  imageId: imagePackage.imageId,
  platformId: profile.platformId,
  releaseRoot: profile.releaseRoot + '/36-' + prefix,
  profile,
  profileSha256: configured.sha256,
  imageArchive: {
    name: basename(imagePackage.archive.path),
    sha256: imagePackage.archive.sha256,
    bytes: imagePackage.archive.bytes,
    localPath: imagePackage.archive.path,
  },
  operatorArchive: {
    name: basename(archive),
    sha256: hash.digest('hex'),
    bytes: (await stat(archive)).size,
    localPath: archive,
  },
  files,
  buildProofSha256: files['build-proof.json'],
  exportContainerName: 'aitesthub-export36-' + id.slice(0, 8),
  cloudWrites: 0,
  cloudUploads: 0,
};
const planFile = join(directory, 'operator-package.json');
await writeFile(planFile, JSON.stringify(plan, null, 2) + '\n', {
  flag: 'wx',
  mode: 0o600,
});
await copyFile(
  'deploy/personal-cloud/stage-runtime.py',
  join(directory, 'stage-runtime.py'),
);
console.log(
  JSON.stringify({
    planFile,
    planSha256: sha(await readFile(planFile)),
    imageId: plan.imageId,
    operatorArchive: plan.operatorArchive,
    cloudWrites: 0,
    cloudUploads: 0,
  }),
);
