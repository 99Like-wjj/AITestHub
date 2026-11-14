import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deepFreezeConfiguration,
  readReviewedJsonConfiguration,
} from '../../scripts/private-config.mjs';

const codeRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const image = /^sha256:[a-f0-9]{64}$/;
const slug = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const invalid = () =>
  Object.assign(new Error('Deployment profile is invalid.'), {
    code: 'DEPLOYMENT_PROFILE_INVALID',
  });
const expectedKeys = [
  'schemaVersion',
  'platformId',
  'origin',
  'host',
  'hostKeyFingerprint',
  'root',
  'releaseRoot',
  'account',
  'sshUser',
  'sshGroup',
  'oldImage',
  'legacyModels',
  'containers',
  'opsUnit',
  'policyMigration',
  'previousMigration',
];

function absoluteDirectory(value) {
  return (
    typeof value === 'string' &&
    /^\/[a-zA-Z0-9_./-]+$/.test(value) &&
    posix.isAbsolute(value) &&
    value !== '/' &&
    posix.normalize(value) === value &&
    !value.endsWith('/')
  );
}
export function validateDeploymentProfile(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('|') !==
      [...expectedKeys].sort().join('|') ||
    value.schemaVersion !== 'aitesthub.deployment-profile.v1' ||
    !uuid.test(value.platformId ?? '') ||
    !absoluteDirectory(value.root) ||
    !absoluteDirectory(value.releaseRoot) ||
    !slug.test(value.account ?? '') ||
    !slug.test(value.sshUser ?? '') ||
    !slug.test(value.sshGroup ?? '') ||
    !image.test(value.oldImage ?? '') ||
    !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(value.hostKeyFingerprint ?? '') ||
    !slug.test(value.opsUnit ?? '') ||
    !value.opsUnit.endsWith('.service')
  )
    throw invalid();
  let origin;
  try {
    origin = new URL(value.origin);
  } catch {
    throw invalid();
  }
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== value.origin ||
    origin.username ||
    origin.password ||
    origin.hostname !== value.host ||
    !value.host ||
    !/^[a-zA-Z0-9.[\]:-]+$/.test(value.host)
  )
    throw invalid();
  const a = posix.relative(value.root, value.releaseRoot),
    b = posix.relative(value.releaseRoot, value.root);
  const outside = (relativePath) =>
    relativePath === '..' ||
    relativePath.startsWith('../') ||
    posix.isAbsolute(relativePath);
  if (!outside(a) || !outside(b)) throw invalid();
  if (
    !value.containers ||
    Object.keys(value.containers).sort().join('|') !==
      'aiWorker|api|apiWorker|database' ||
    Object.values(value.containers).some(
      (x) => typeof x !== 'string' || !slug.test(x),
    ) ||
    new Set(Object.values(value.containers)).size !== 4
  )
    throw invalid();
  if (
    !Array.isArray(value.legacyModels) ||
    value.legacyModels.length > 1000 ||
    value.legacyModels.some(
      (x) =>
        !x ||
        Object.keys(x).sort().join('|') !== 'id|revision' ||
        !uuid.test(x.id ?? '') ||
        !Number.isSafeInteger(x.revision) ||
        x.revision < 1,
    ) ||
    new Set(value.legacyModels.map((x) => x.id)).size !==
      value.legacyModels.length
  )
    throw invalid();
  for (const [key, version, checksum] of [
    [
      'policyMigration',
      '0034_resource_policy.sql',
      'ac84e64462bea989f009667aeca8b61fc1c973b7ab40f9775e4e279f51d29ea0',
    ],
    [
      'previousMigration',
      '0033_ui_delivery.sql',
      '436ea1cc48958f2d8d537d8b58bc9b86f0a53d33b2c754f53bdd9a8a451b2744',
    ],
  ])
    if (
      !value[key] ||
      Object.keys(value[key]).sort().join('|') !== 'checksum|version' ||
      value[key].version !== version ||
      value[key].checksum !== checksum
    )
      throw invalid();
  return deepFreezeConfiguration(value);
}

export function deploymentPaths(profile) {
  const root = validateDeploymentProfile(profile).root;
  const suffixes = {
    AITESTHUB_DB_PASSWORD_FILE: 'secrets/postgres-app-password',
    AITESTHUB_MASTER_KEY_FILE: 'secrets/platform-master-key',
    AITESTHUB_RECOVERY_CONTROL_KEY_FILE: 'secrets/recovery-control-key',
    AITESTHUB_RECOVERY_CONTROL_DIRECTORY: 'control/security-controls',
    AITESTHUB_RECOVERY_CONTROL_ANCHOR_FILE:
      'recovery/controls/security-control-anchor.json',
    AITESTHUB_RESOURCE_POLICY_ANCHOR_FILE:
      'recovery/controls/resource-policy/anchor.json',
    AITESTHUB_RESOURCE_POLICY_LOCK_DIRECTORY: 'control/resource-policy-writer',
    AITESTHUB_BACKUP_DIRECTORY: 'backups/product',
    AITESTHUB_BACKUP_KEY_FILE: 'secrets/backup-encryption-key',
  };
  return Object.freeze(
    Object.fromEntries(
      Object.entries(suffixes).map(([key, suffix]) => [
        key,
        posix.join(root, suffix),
      ]),
    ),
  );
}

export function readDeploymentProfile(environment = process.env) {
  return readReviewedJsonConfiguration(
    environment,
    'AITESTHUB_DEPLOYMENT_PROFILE_FILE',
    'AITESTHUB_DEPLOYMENT_PROFILE_SHA256',
    codeRoot,
    validateDeploymentProfile,
  );
}
