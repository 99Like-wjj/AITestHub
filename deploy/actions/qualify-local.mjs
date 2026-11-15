import { createPrivateKey, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertExternalConfigurationPath,
  deepFreezeConfiguration,
  readReviewedJsonConfiguration,
} from '../../scripts/private-config.mjs';
import { parseReleaseBytes, sha256 } from './release-contract.mjs';
import { resolveImageIdentity } from './image-identity.mjs';

const codeRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const configKeys = [
  'schemaVersion',
  'repository',
  'dockerExecutable',
  'dockerContext',
  'applicationContainers',
  'databaseContainer',
  'databaseUser',
  'databaseName',
  'readyUrl',
  'signingKeyFile',
];
const name = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function rejected(code) {
  return Object.assign(new Error(code), { code });
}

export function validateLocalQualificationConfig(value) {
  const invalid = () => rejected('ACTIONS_LOCAL_CONFIGURATION_INVALID');
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('|') !== [...configKeys].sort().join('|') ||
    value.schemaVersion !== 'ath.actions-local-config.v1' ||
    typeof value.repository !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(
      value.repository,
    ) ||
    typeof value.dockerExecutable !== 'string' ||
    !isAbsolute(value.dockerExecutable) ||
    typeof value.signingKeyFile !== 'string' ||
    !isAbsolute(value.signingKeyFile) ||
    typeof value.dockerContext !== 'string' ||
    !name.test(value.dockerContext) ||
    !Array.isArray(value.applicationContainers) ||
    value.applicationContainers.length === 0 ||
    value.applicationContainers.length > 20 ||
    value.applicationContainers.some(
      (container) => typeof container !== 'string' || !name.test(container),
    ) ||
    new Set(value.applicationContainers).size !==
      value.applicationContainers.length ||
    ['databaseContainer', 'databaseUser', 'databaseName'].some(
      (field) => typeof value[field] !== 'string' || !name.test(value[field]),
    ) ||
    value.applicationContainers.includes(value.databaseContainer)
  )
    throw invalid();
  let ready;
  try {
    ready = new URL(value.readyUrl);
  } catch {
    throw invalid();
  }
  if (
    !['http:', 'https:'].includes(ready.protocol) ||
    !['127.0.0.1', '[::1]'].includes(ready.hostname) ||
    ready.username ||
    ready.password ||
    ready.search ||
    ready.hash ||
    ready.pathname !== '/api/v1/health/ready' ||
    ready.href !== value.readyUrl
  )
    throw invalid();
  assertExternalConfigurationPath(value.signingKeyFile, codeRoot);
  return deepFreezeConfiguration(value);
}

async function readRegularFile(
  file,
  maximum,
  errorCode,
  { external = false } = {},
) {
  if (typeof file !== 'string' || !isAbsolute(file)) throw rejected(errorCode);
  const path = external
    ? assertExternalConfigurationPath(file, codeRoot)
    : resolve(file);
  const item = await lstat(path);
  const actual = await realpath(path);
  const same =
    process.platform === 'win32'
      ? actual.toLowerCase() === path.toLowerCase()
      : actual === path;
  if (
    !item.isFile() ||
    item.isSymbolicLink() ||
    item.nlink !== 1 ||
    item.size === 0 ||
    item.size > maximum ||
    !same
  )
    throw rejected(errorCode);
  const bytes = await readFile(path);
  if (bytes.length === 0 || bytes.length > maximum) throw rejected(errorCode);
  return { bytes, item };
}

async function assertOutputPath(outputFile) {
  if (typeof outputFile !== 'string' || !isAbsolute(outputFile))
    throw rejected('ACTIONS_QUALIFICATION_OUTPUT_INVALID');
  const output = resolve(outputFile);
  const scope = relative(codeRoot, output).replaceAll('\\', '/');
  if (
    scope === '' ||
    (!isAbsolute(scope) &&
      scope !== '..' &&
      !scope.startsWith('../') &&
      !scope.startsWith('.local-build/'))
  )
    throw rejected('ACTIONS_QUALIFICATION_OUTPUT_INVALID');
  const parent = dirname(output);
  const parentItem = await lstat(parent);
  const parentReal = await realpath(parent);
  const same =
    process.platform === 'win32'
      ? parentReal.toLowerCase() === parent.toLowerCase()
      : parentReal === parent;
  if (!parentItem.isDirectory() || parentItem.isSymbolicLink() || !same)
    throw rejected('ACTIONS_QUALIFICATION_OUTPUT_INVALID');
  return output;
}

export async function runLocalDocker(config, args) {
  return new Promise((done, fail) => {
    const child = spawn(
      config.dockerExecutable,
      ['--context', config.dockerContext, ...args],
      { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let settled = false;
    let output = '';
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) fail(error);
      else done(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(rejected('ACTIONS_LOCAL_CHECK_TIMEOUT'));
    }, 30000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.length > 2 * 1024 * 1024) {
        child.kill();
        finish(rejected('ACTIONS_LOCAL_CHECK_REJECTED'));
      }
    });
    child.stderr.resume();
    child.once('error', () => finish(rejected('ACTIONS_LOCAL_CHECK_REJECTED')));
    child.once('close', (code) =>
      code === 0
        ? finish(undefined, output.trim())
        : finish(rejected('ACTIONS_LOCAL_CHECK_REJECTED')),
    );
  });
}

async function readyStatus(url) {
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  await response.body?.cancel();
  return response.status;
}

export async function qualifyLocal(
  {
    configFile,
    configSha256,
    releaseFile,
    evidenceFile,
    outputFile,
    confirmLocalSelftest,
  },
  {
    docker = runLocalDocker,
    ready = readyStatus,
    identity = resolveImageIdentity,
    now = () => new Date(),
  } = {},
) {
  if (confirmLocalSelftest !== true)
    throw rejected('ACTIONS_LOCAL_SELFTEST_CONFIRMATION_REQUIRED');
  const { data: config } = await readReviewedJsonConfiguration(
    { CONFIG_FILE: configFile, CONFIG_SHA256: configSha256 },
    'CONFIG_FILE',
    'CONFIG_SHA256',
    codeRoot,
    validateLocalQualificationConfig,
  );
  const { bytes: releaseBytes } = await readRegularFile(
    releaseFile,
    2 * 1024 * 1024,
    'ACTIONS_RELEASE_INVALID',
  );
  const { release, sha256: releaseSha256 } = parseReleaseBytes(releaseBytes, {
    repository: config.repository,
  });
  const evidence = await readRegularFile(
    evidenceFile,
    32 * 1024 * 1024,
    'ACTIONS_LOCAL_EVIDENCE_REQUIRED',
  );
  const output = await assertOutputPath(outputFile);
  const keyFile = await readRegularFile(
    config.signingKeyFile,
    16384,
    'ACTIONS_QUALIFICATION_KEY_REJECTED',
    { external: true },
  );
  if (process.platform !== 'win32' && (keyFile.item.mode & 0o077) !== 0)
    throw rejected('ACTIONS_QUALIFICATION_KEY_REJECTED');
  let key;
  try {
    key = createPrivateKey(keyFile.bytes);
  } catch {
    throw rejected('ACTIONS_QUALIFICATION_KEY_REJECTED');
  }
  if (key.asymmetricKeyType !== 'ed25519')
    throw rejected('ACTIONS_QUALIFICATION_KEY_REJECTED');
  const image = await identity(release.imageRef, {
    dockerExecutable: config.dockerExecutable,
    dockerContext: config.dockerContext,
  });
  if (
    image.imageId !== release.imageId ||
    image.labels['org.opencontainers.image.revision'] !== release.sourceCommit
  )
    throw rejected('ACTIONS_LOCAL_IMAGE_MISMATCH');
  const applicationState = await docker(config, [
    'inspect',
    '--format',
    '{{json .Image}} {{json .State.Running}}',
    ...config.applicationContainers,
  ]);
  const rows = applicationState.split(/\r?\n/);
  if (
    rows.length !== config.applicationContainers.length ||
    rows.some((row) => row !== JSON.stringify(image.daemonImageId) + ' true')
  )
    throw rejected('ACTIONS_LOCAL_IMAGE_MISMATCH');
  if ((await ready(config.readyUrl)) !== 200)
    throw rejected('ACTIONS_LOCAL_NOT_READY');
  const migrationsOutput = await docker(config, [
    'exec',
    config.databaseContainer,
    'psql',
    '-XqAt',
    '-U',
    config.databaseUser,
    '-d',
    config.databaseName,
    '-c',
    "BEGIN READ ONLY;SELECT coalesce(json_agg(json_build_object('version',version,'checksum',checksum) ORDER BY version),'[]'::json) FROM app.schema_migrations;COMMIT;",
  ]);
  let migrations;
  try {
    migrations = JSON.parse(migrationsOutput);
  } catch {
    throw rejected('ACTIONS_LOCAL_MIGRATIONS_MISMATCH');
  }
  const expected = Object.entries(release.migrations).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (
    !Array.isArray(migrations) ||
    migrations.length !== expected.length ||
    migrations.some(
      (row, index) =>
        row === null ||
        typeof row !== 'object' ||
        Object.keys(row).sort().join('|') !== 'checksum|version' ||
        row.version !== expected[index][0] ||
        row.checksum !== expected[index][1],
    )
  )
    throw rejected('ACTIONS_LOCAL_MIGRATIONS_MISMATCH');
  // Observe the same roles and readiness again after the database read.
  if (
    (await docker(config, [
      'inspect',
      '--format',
      '{{json .Image}} {{json .State.Running}}',
      ...config.applicationContainers,
    ])) !== applicationState ||
    (await ready(config.readyUrl)) !== 200
  )
    throw rejected('ACTIONS_LOCAL_STATE_CHANGED');
  const payload = {
    schemaVersion: 'ath.actions-qualification.v1',
    repository: release.repository,
    sourceCommit: release.sourceCommit,
    runId: release.runId,
    runAttempt: release.runAttempt,
    imageRef: release.imageRef,
    imageId: release.imageId,
    releaseSha256,
    checkedAt: now().toISOString(),
    evidenceSha256: sha256(evidence.bytes),
    checks: {
      applicationRolesMatched: true,
      ready: true,
      migrationsMatched: true,
      localSelfTestConfirmed: true,
    },
  };
  const payloadBytes = Buffer.from(JSON.stringify(payload));
  const qualification = {
    payload: payloadBytes.toString('base64'),
    signature: sign(null, payloadBytes, key).toString('base64'),
  };
  const bytes = Buffer.from(JSON.stringify(qualification, null, 2) + '\n');
  await writeFile(output, bytes, { flag: 'wx', mode: 0o600 });
  return {
    qualification,
    summary: {
      qualified: true,
      repository: release.repository,
      sourceCommit: release.sourceCommit,
      runId: release.runId,
      runAttempt: release.runAttempt,
      imageId: release.imageId,
      releaseSha256,
      qualificationSha256: sha256(bytes),
    },
  };
}

const help = `Qualify an Actions candidate after explicit local self-testing.

node deploy/actions/qualify-local.mjs \
  --config ABSOLUTE_EXTERNAL_CONFIG --config-sha256 REVIEWED_SHA256 \
  --release ABSOLUTE_RELEASE_JSON --evidence ABSOLUTE_LOCAL_TEST_EVIDENCE \
  --output ABSOLUTE_NEW_RECEIPT_JSON --confirm-local-selftest [--print]

The external configuration pins the local Docker context, application roles,
database, loopback readiness URL and external Ed25519 private key. Evidence is
hashed locally; its contents and the private key are never uploaded. This
command observes deployed images, readiness and SQL history. The confirmation
asserts that the operator has completed the applicable local self-tests; this
command does not run or certify the full test suite. Existing receipts are
never overwritten. --print emits the signed, non-secret envelope as Base64 for
the manual deployment workflow input.
`;

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(help);
    return;
  }
  const options = {};
  const names = {
    '--config': 'configFile',
    '--config-sha256': 'configSha256',
    '--release': 'releaseFile',
    '--evidence': 'evidenceFile',
    '--output': 'outputFile',
  };
  let print = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--confirm-local-selftest') {
      if (options.confirmLocalSelftest)
        throw rejected('ACTIONS_QUALIFICATION_ARGUMENTS_INVALID');
      options.confirmLocalSelftest = true;
    } else if (argument === '--print') {
      if (print) throw rejected('ACTIONS_QUALIFICATION_ARGUMENTS_INVALID');
      print = true;
    } else {
      const field = names[argument];
      const value = args[index + 1];
      if (
        !field ||
        Object.hasOwn(options, field) ||
        !value ||
        value.startsWith('--')
      )
        throw rejected('ACTIONS_QUALIFICATION_ARGUMENTS_INVALID');
      options[field] = value;
      index += 1;
    }
  }
  if (Object.values(names).some((field) => !Object.hasOwn(options, field)))
    throw rejected('ACTIONS_QUALIFICATION_ARGUMENTS_INVALID');
  const result = await qualifyLocal(options);
  process.stdout.write(JSON.stringify(result.summary) + '\n');
  if (print)
    process.stdout.write(
      Buffer.from(JSON.stringify(result.qualification)).toString('base64') +
        '\n',
    );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    const code =
      typeof error?.code === 'string' && /^ACTIONS_[A-Z_]+$/.test(error.code)
        ? error.code
        : 'ACTIONS_QUALIFICATION_FAILED';
    process.stderr.write(code + '\n');
    process.exitCode = 1;
  });
