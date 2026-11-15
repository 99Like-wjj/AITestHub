import { createHash, createPublicKey, KeyObject, verify } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

const digest = /^[a-f0-9]{64}$/;
const imageDigest = /^sha256:[a-f0-9]{64}$/;
const repositoryName =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const releaseKeys = [
  'schemaVersion',
  'repository',
  'sourceCommit',
  'runId',
  'runAttempt',
  'imageRef',
  'imageId',
  'files',
  'migrations',
  'nodeSha256',
];
const qualificationKeys = [
  'schemaVersion',
  'repository',
  'sourceCommit',
  'runId',
  'runAttempt',
  'imageRef',
  'imageId',
  'releaseSha256',
  'checkedAt',
  'evidenceSha256',
  'checks',
];
const checkKeys = [
  'applicationRolesMatched',
  'ready',
  'migrationsMatched',
  'localSelfTestConfirmed',
];

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function rejected(code) {
  return Object.assign(new Error(code), { code });
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join('|') === [...keys].sort().join('|')
  );
}

function validRuntimePath(value) {
  if (
    typeof value !== 'string' ||
    value.length > 512 ||
    !value.split('/').every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))
  )
    return false;
  return (
    value === 'package.json' ||
    value.startsWith('dist/') ||
    value.startsWith('apps/web/dist/') ||
    /^packages\/persistence\/migrations\/[0-9]{4}_[a-z][a-z0-9_]*\.sql$/.test(
      value,
    )
  );
}

export function validateRelease(value, { repository } = {}) {
  const invalid = () => rejected('ACTIONS_RELEASE_INVALID');
  if (
    !exactKeys(value, releaseKeys) ||
    value.schemaVersion !== 'ath.actions-release.v1' ||
    !repositoryName.test(value.repository ?? '') ||
    (repository !== undefined && value.repository !== repository) ||
    !/^[a-f0-9]{40}$/.test(value.sourceCommit ?? '') ||
    typeof value.runId !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(value.runId) ||
    typeof value.runAttempt !== 'string' ||
    !/^[1-9][0-9]{0,9}$/.test(value.runAttempt) ||
    !imageDigest.test(value.imageId ?? '') ||
    !digest.test(value.nodeSha256 ?? '') ||
    typeof value.imageRef !== 'string'
  )
    throw invalid();
  const namespace = 'ghcr.io/' + value.repository.toLowerCase() + '@';
  if (
    !value.imageRef.startsWith(namespace) ||
    !imageDigest.test(value.imageRef.slice(namespace.length))
  )
    throw invalid();
  for (const name of ['files', 'migrations'])
    if (
      value[name] === null ||
      typeof value[name] !== 'object' ||
      Array.isArray(value[name])
    )
      throw invalid();
  const files = Object.entries(value.files);
  if (
    files.length < 8 ||
    files.length > 10000 ||
    files.some(
      ([path, checksum]) =>
        !validRuntimePath(path) ||
        typeof checksum !== 'string' ||
        !digest.test(checksum),
    ) ||
    !Object.hasOwn(value.files, 'package.json') ||
    !Object.hasOwn(value.files, 'dist/apps/api/src/main.js') ||
    !Object.hasOwn(value.files, 'dist/apps/api-worker/src/main.js') ||
    !Object.hasOwn(value.files, 'dist/apps/ai-worker/src/main.js') ||
    !Object.hasOwn(value.files, 'dist/scripts/operations-worker.js') ||
    !Object.hasOwn(
      value.files,
      'dist/packages/application/src/recovery/crypto.js',
    ) ||
    !Object.hasOwn(value.files, 'apps/web/dist/index.html')
  )
    throw invalid();
  const migrations = Object.entries(value.migrations).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (
    migrations.length === 0 ||
    migrations.length > 1000 ||
    migrations.some(
      ([name, checksum], index) =>
        !/^[0-9]{4}_[a-z][a-z0-9_]*\.sql$/.test(name) ||
        Number(name.slice(0, 4)) !== index + 1 ||
        typeof checksum !== 'string' ||
        !digest.test(checksum) ||
        value.files['packages/persistence/migrations/' + name] !== checksum,
    ) ||
    files.filter(([path]) =>
      path.startsWith('packages/persistence/migrations/'),
    ).length !== migrations.length
  )
    throw invalid();
  return value;
}

export function parseReleaseBytes(input, options) {
  const bytes = Buffer.from(input);
  if (bytes.length === 0 || bytes.length > 2 * 1024 * 1024)
    throw rejected('ACTIONS_RELEASE_INVALID');
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const release = validateRelease(JSON.parse(text), options);
    return { release, bytes, sha256: sha256(bytes) };
  } catch {
    throw rejected('ACTIONS_RELEASE_INVALID');
  }
}

export async function readRelease(path, options) {
  const file = resolve(path);
  const item = await lstat(file);
  const actual = await realpath(file);
  if (
    !item.isFile() ||
    item.isSymbolicLink() ||
    item.nlink !== 1 ||
    item.size === 0 ||
    item.size > 2 * 1024 * 1024 ||
    (process.platform === 'win32'
      ? actual.toLowerCase() !== file.toLowerCase()
      : actual !== file)
  )
    throw rejected('ACTIONS_RELEASE_INVALID');
  return parseReleaseBytes(await readFile(file), options);
}

function decodeBase64(value, minimum, maximum) {
  if (
    typeof value !== 'string' ||
    value.length > Math.ceil(maximum / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw rejected('ACTIONS_QUALIFICATION_INVALID');
  const bytes = Buffer.from(value, 'base64');
  if (
    bytes.length < minimum ||
    bytes.length > maximum ||
    bytes.toString('base64') !== value
  )
    throw rejected('ACTIONS_QUALIFICATION_INVALID');
  return bytes;
}

export function validateQualificationEnvelope(envelope) {
  if (!exactKeys(envelope, ['payload', 'signature']))
    throw rejected('ACTIONS_QUALIFICATION_INVALID');
  const payloadBytes = decodeBase64(envelope.payload, 1, 16384);
  const signature = decodeBase64(envelope.signature, 64, 64);
  let payload;
  try {
    payload = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes),
    );
  } catch {
    throw rejected('ACTIONS_QUALIFICATION_INVALID');
  }
  if (
    !exactKeys(payload, qualificationKeys) ||
    payload.schemaVersion !== 'ath.actions-qualification.v1' ||
    !digest.test(payload.releaseSha256 ?? '') ||
    !digest.test(payload.evidenceSha256 ?? '') ||
    typeof payload.checkedAt !== 'string' ||
    !Number.isFinite(Date.parse(payload.checkedAt)) ||
    new Date(payload.checkedAt).toISOString() !== payload.checkedAt ||
    !exactKeys(payload.checks, checkKeys) ||
    Object.values(payload.checks).some((value) => value !== true)
  )
    throw rejected('ACTIONS_QUALIFICATION_INVALID');
  return { payload, payloadBytes, signature };
}

export function verifyQualification(
  envelope,
  releaseBytes,
  publicKey,
  { repository, now = Date.now() } = {},
) {
  const { release, sha256: releaseSha256 } = parseReleaseBytes(releaseBytes, {
    repository,
  });
  const { payload, payloadBytes, signature } =
    validateQualificationEnvelope(envelope);
  if (
    payload.releaseSha256 !== releaseSha256 ||
    [
      'repository',
      'sourceCommit',
      'runId',
      'runAttempt',
      'imageRef',
      'imageId',
    ].some((field) => payload[field] !== release[field]) ||
    !Number.isFinite(now) ||
    Date.parse(payload.checkedAt) > now + 5 * 60 * 1000
  )
    throw rejected('ACTIONS_QUALIFICATION_INVALID');
  try {
    const key =
      publicKey instanceof KeyObject && publicKey.type === 'public'
        ? publicKey
        : createPublicKey(publicKey);
    if (
      key.asymmetricKeyType !== 'ed25519' ||
      !verify(null, payloadBytes, key, signature)
    )
      throw rejected('ACTIONS_QUALIFICATION_INVALID');
  } catch {
    throw rejected('ACTIONS_QUALIFICATION_INVALID');
  }
  return payload;
}
