import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256, validateRelease } from './release-contract.mjs';
import { resolveImageIdentity } from './image-identity.mjs';

const imageProbe = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const files = {};
let count = 0, bytes = 0;
function add(file, key) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('UNSAFE_RUNTIME_FILE');
  count += 1; bytes += stat.size;
  if (count > 20000 || bytes > 256 * 1024 * 1024) throw Error('RUNTIME_PROOF_TOO_LARGE');
  files[key] = digest(fs.readFileSync(file));
}
function walk(root, prefix) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const file = path.join(root, entry.name), key = prefix + entry.name;
    if (entry.isSymbolicLink()) throw Error('UNSAFE_RUNTIME_SYMLINK');
    if (entry.isDirectory()) walk(file, key + '/');
    else if (entry.isFile()) add(file, key);
    else throw Error('UNSAFE_RUNTIME_ENTRY');
  }
}
walk('/app/dist', 'dist/');
walk('/app/apps/web/dist', 'apps/web/dist/');
add('/app/package.json', 'package.json');
for (const name of fs.readdirSync('/app/packages/persistence/migrations').sort()) {
  if (!/^[0-9]{4}_[a-z0-9_]+[.]sql$/.test(name)) throw Error('UNEXPECTED_MIGRATION_ARTIFACT');
  add('/app/packages/persistence/migrations/' + name, 'packages/persistence/migrations/' + name);
}
const forbidden = new Set(['tests', 'test-results', 'design', 'review', 'engineering', 'evidence', '.local-build', '.git']);
const patterns = [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /ath_session_[A-Za-z0-9_-]{32,}/, /ath_key_[A-Za-z0-9_-]{32,}/, /sk-[A-Za-z0-9_-]{24,}/];
function audit(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (root === '/app' && entry.name === 'node_modules') continue;
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw Error('UNSAFE_PROJECT_SYMLINK');
    if (entry.isDirectory()) {
      if (forbidden.has(entry.name)) throw Error('PRIVATE_PROJECT_DIRECTORY_IN_IMAGE');
      audit(file);
    } else if (entry.isFile()) {
      if (/AGENTS[.]local[.]md$|HANDOFF/i.test(entry.name) || /[.](?:env|pem|key|p12|pfx)$/i.test(entry.name)) throw Error('PRIVATE_FILE_CANDIDATE_IN_IMAGE');
      const stat = fs.lstatSync(file);
      if (stat.size < 5000000) {
        const content = fs.readFileSync(file, 'utf8');
        if (patterns.some(pattern => pattern.test(content))) throw Error('SENSITIVE_LITERAL_CANDIDATE_IN_IMAGE');
      }
    }
  }
}
audit('/app');
process.stdout.write(JSON.stringify({ files, nodeSha256: digest(fs.readFileSync('/usr/local/bin/node')) }));
`;

function docker(
  args,
  { input, dockerExecutable = 'docker', dockerContext, timeout = 120000 } = {},
) {
  if (dockerContext !== undefined) {
    assert.match(dockerContext, /^[A-Za-z0-9_.-]+$/);
    args = ['--context', dockerContext, ...args];
  }
  return new Promise((done, reject) => {
    const child = spawn(dockerExecutable, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('RELEASE_DOCKER_COMMAND_TIMED_OUT'));
    }, timeout);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.length > 4 * 1024 * 1024) {
        child.kill();
        reject(new Error('RELEASE_DOCKER_OUTPUT_TOO_LARGE'));
      }
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('RELEASE_DOCKER_COMMAND_UNAVAILABLE'));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) done(output.trim());
      else reject(new Error('RELEASE_DOCKER_COMMAND_FAILED'));
    });
    child.stdin.end(input);
  });
}

export async function probeImageRuntime(imageId, options = {}) {
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  const name = 'aitesthub-release-proof-' + randomUUID();
  try {
    const proof = JSON.parse(
      await docker(
        [
          'run',
          '--rm',
          '--name',
          name,
          '--network',
          'none',
          '--read-only',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--entrypoint',
          'node',
          '-i',
          imageId,
          '--input-type=commonjs',
          '-',
        ],
        { ...options, input: imageProbe },
      ),
    );
    assert.ok(proof && typeof proof === 'object' && !Array.isArray(proof));
    assert.deepEqual(Object.keys(proof).sort(), ['files', 'nodeSha256']);
    return proof;
  } catch (error) {
    await docker(['rm', '--force', name], options).catch(() => {});
    throw error;
  }
}

export function createReleaseManifest(identity, proof) {
  const migrations = Object.fromEntries(
    Object.entries(proof.files)
      .filter(([name]) => name.startsWith('packages/persistence/migrations/'))
      .map(([name, hash]) => [name.slice(name.lastIndexOf('/') + 1), hash]),
  );
  const manifest = {
    schemaVersion: 'ath.actions-release.v1',
    ...identity,
    files: proof.files,
    migrations,
    nodeSha256: proof.nodeSha256,
  };
  validateRelease(manifest, { repository: identity.repository });
  return manifest;
}

function githubIdentity(environment) {
  const { GITHUB_REPOSITORY: repository, GITHUB_SHA: sourceCommit } =
    environment;
  assert.match(repository ?? '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(sourceCommit ?? '', /^[a-f0-9]{40}$/);
  assert.match(environment.GITHUB_RUN_ID ?? '', /^[1-9][0-9]*$/);
  assert.match(environment.GITHUB_RUN_ATTEMPT ?? '', /^[1-9][0-9]*$/);
  assert.equal(environment.GITHUB_ACTIONS, 'true');
  assert.equal(environment.GITHUB_REF, 'refs/heads/main');
  assert.ok(
    ['push', 'workflow_dispatch'].includes(environment.GITHUB_EVENT_NAME),
  );
  assert.equal(environment.GITHUB_SERVER_URL, 'https://github.com');
  assert.equal(environment.GITHUB_API_URL, 'https://api.github.com');
  return {
    repository,
    sourceCommit,
    runId: environment.GITHUB_RUN_ID,
    runAttempt: environment.GITHUB_RUN_ATTEMPT,
  };
}

async function githubJson(path, token) {
  assert.ok(typeof token === 'string' && token.length > 0);
  const response = await fetch('https://api.github.com' + path, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404) {
    await response.arrayBuffer();
    return null;
  }
  assert.equal(response.status, 200, 'RELEASE_GITHUB_METADATA_UNAVAILABLE');
  return response.json();
}

export async function checkPrivateDestination(identity, token, allowMissing) {
  const [owner, name] = identity.repository.split('/');
  const repository = await githubJson(`/repos/${owner}/${name}`, token);
  assert.equal(
    repository?.full_name?.toLowerCase(),
    identity.repository.toLowerCase(),
  );
  assert.equal(
    typeof repository?.private,
    'boolean',
    'RELEASE_REPOSITORY_UNVERIFIED',
  );
  assert.ok(['User', 'Organization'].includes(repository.owner?.type));
  const kind = repository.owner.type === 'Organization' ? 'orgs' : 'users';
  const entry = await githubJson(
    `/${kind}/${owner}/packages/container/${encodeURIComponent(name.toLowerCase())}`,
    token,
  );
  if (!entry) {
    assert.ok(
      repository.private,
      'EXISTING_PRIVATE_PACKAGE_REQUIRED_FOR_PUBLIC_SOURCE',
    );
    assert.ok(allowMissing, 'RELEASE_PACKAGE_METADATA_REQUIRED');
  } else {
    assert.equal(
      entry.visibility,
      'private',
      'RELEASE_PACKAGE_MUST_BE_PRIVATE',
    );
    if (entry.repository || !repository.private) {
      assert.equal(
        entry.repository?.full_name?.toLowerCase(),
        identity.repository.toLowerCase(),
        'RELEASE_PACKAGE_REPOSITORY_MISMATCH',
      );
    }
  }
}

async function verifySourceMigrations(workspace, manifest) {
  const directory = join(workspace, 'packages/persistence/migrations');
  const names = (await readdir(directory)).sort();
  assert.deepEqual(names, Object.keys(manifest.migrations).sort());
  for (const name of names) {
    const file = join(directory, name);
    const stat = await lstat(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    assert.equal(sha256(await readFile(file)), manifest.migrations[name]);
  }
}

async function main(environment = process.env) {
  assert.equal(process.argv.length, 3);
  const command = process.argv[2];
  assert.ok(['prepare', 'manifest'].includes(command));
  const identity = githubIdentity(environment);
  const imageName = 'ghcr.io/' + identity.repository.toLowerCase();
  if (command === 'prepare') {
    await checkPrivateDestination(identity, environment.GITHUB_TOKEN, true);
    assert.ok(environment.GITHUB_OUTPUT);
    await appendFile(
      environment.GITHUB_OUTPUT,
      `tag=${imageName}:source-${identity.sourceCommit}-run-${identity.runId}-${identity.runAttempt}\n`,
    );
    return;
  }
  await checkPrivateDestination(identity, environment.GITHUB_TOKEN, false);
  const digest = environment.AITESTHUB_RELEASE_DIGEST;
  assert.match(digest ?? '', /^sha256:[a-f0-9]{64}$/);
  const imageRef = imageName + '@' + digest;
  await docker(['pull', '--platform', 'linux/amd64', imageRef]);
  const image = await resolveImageIdentity(imageRef);
  assert.equal(image.os, 'linux');
  assert.equal(image.architecture, 'amd64');
  assert.equal(
    image.labels?.['org.opencontainers.image.revision'],
    identity.sourceCommit,
  );
  assert.equal(
    image.labels?.['org.opencontainers.image.source'],
    'https://github.com/' + identity.repository,
  );
  const proof = await probeImageRuntime(image.daemonImageId);
  const manifest = createReleaseManifest(
    { ...identity, imageRef, imageId: image.imageId },
    proof,
  );
  assert.ok(environment.GITHUB_WORKSPACE);
  await verifySourceMigrations(resolve(environment.GITHUB_WORKSPACE), manifest);
  assert.ok(environment.RUNNER_TEMP && environment.GITHUB_STEP_SUMMARY);
  const directory = join(resolve(environment.RUNNER_TEMP), 'aitesthub-release');
  await mkdir(directory);
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(directory, 'release.json'), bytes, { flag: 'wx' });
  await appendFile(
    environment.GITHUB_STEP_SUMMARY,
    `### Private release candidate\n\nSource: \`${identity.sourceCommit}\`\n\nBuild run: \`${identity.runId}\` (attempt ${identity.runAttempt})\n\nImage: \`${imageRef}\`\n\nRelease manifest SHA-256: \`${sha256(bytes)}\`\n\nRuntime files: ${Object.keys(manifest.files).length}; SQL files: ${Object.keys(manifest.migrations).length}.\n\nThe image is a candidate. Complete local Docker validation before manually running Deploy Cloud.\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const reason =
      error?.code === 'ERR_ASSERTION' &&
      /^(?:RELEASE_[A-Z_]+|EXISTING_PRIVATE_PACKAGE_REQUIRED_FOR_PUBLIC_SOURCE)$/.test(
        error.message,
      )
        ? `: ${error.message}`
        : '';
    process.stderr.write(`ACTIONS_RELEASE_BUILD_REJECTED${reason}\n`);
    process.exitCode = 1;
  });
}
