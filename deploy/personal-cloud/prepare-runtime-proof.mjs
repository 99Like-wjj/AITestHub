// Read an already built local image with no network, mounts, secrets or DB.
// This does not rebuild, publish, upload, migrate, or operate the cloud host.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
assert.equal(
  process.env.AITESTHUB_CLOUD_RUNTIME_PROOF,
  'explicit-local-image-readonly',
);
assert.equal(process.argv.length, 3);
const imageId = process.argv[2];
assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
const docker = join(
  process.env.LOCALAPPDATA,
  'Programs/DockerDesktop/resources/bin/docker.exe',
);
const exec = (args) =>
  execFileSync(docker, ['--context', 'desktop-linux', ...args], {
    windowsHide: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024,
  });
assert.match(
  exec([
    'context',
    'inspect',
    'desktop-linux',
    '--format',
    '{{.Endpoints.docker.Host}}',
  ]).trim(),
  /^npipe:\/+\.\/pipe\/dockerDesktopLinuxEngine$/,
);
assert.equal(
  exec(['image', 'inspect', imageId, '--format', '{{.Id}}']).trim(),
  imageId,
);
const source = String.raw`const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto');
const sha=x=>c.createHash('sha256').update(x).digest('hex'),files={};
function walk(root,prefix){for(const entry of fs.readdirSync(root,{withFileTypes:true})){const path=p.join(root,entry.name),key=prefix+entry.name;if(entry.isSymbolicLink())throw Error('runtime code symlink');if(entry.isDirectory())walk(path,key+'/');else if(entry.name.endsWith('.js'))files[key]=sha(fs.readFileSync(path));}}
walk('/app/dist','dist/');files['package.json']=sha(fs.readFileSync('/app/package.json'));
for(const name of fs.readdirSync('/app/packages/persistence/migrations').sort())if(/^\d{4}_[a-z0-9_]+\.sql$/.test(name))files['packages/persistence/migrations/'+name]=sha(fs.readFileSync('/app/packages/persistence/migrations/'+name));
process.stdout.write(JSON.stringify({nodeSha256:sha(fs.readFileSync('/usr/local/bin/node')),files}));`;
const actual = JSON.parse(
  exec([
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--entrypoint',
    'node',
    imageId,
    '-e',
    source,
  ]),
);
const migrations = Object.keys(actual.files)
  .filter((path) => path.startsWith('packages/persistence/migrations/'))
  .sort();
assert.equal(migrations.length, 36);
assert.equal(
  actual.files['packages/persistence/migrations/0034_resource_policy.sql'],
  'ac84e64462bea989f009667aeca8b61fc1c973b7ab40f9775e4e279f51d29ea0',
);
assert.equal(
  actual.files['packages/persistence/migrations/0035_model_protocols.sql'],
  '5fc2e12fdc21930ae7b4afe4ba4aabcc61e208976c2506daec841e9882ea534b',
);
assert.equal(
  actual.files['packages/persistence/migrations/0036_account_removal.sql'],
  '4bda3515a66053d43f20331626e96efa0ffcddbadda2efd9ab5635ced5d84c3e',
);
const proof = {
  schemaVersion: 'ath.cloud-runtime-build.v1',
  imageId,
  capturedAt: new Date().toISOString(),
  source: 'exact already-built local image; network none; no mounts or secrets',
  providerRequests: 0,
  cloudWrites: 0,
  ...actual,
};
const directory = resolve(
  'engineering/implementation/evidence/cloud36-upgrade-20261113',
);
await mkdir(directory, { recursive: true });
const file = join(directory, 'build-proof-' + randomUUID() + '.json'),
  bytes = Buffer.from(JSON.stringify(proof, null, 2) + '\n');
await writeFile(file, bytes, { flag: 'wx' });
console.log(
  JSON.stringify({
    file,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    imageId,
    nodeSha256: actual.nodeSha256,
    files: Object.keys(actual.files).length,
    migrations: migrations.length,
    cloudWrites: 0,
  }),
);
