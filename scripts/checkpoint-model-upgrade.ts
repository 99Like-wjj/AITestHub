import { lstat, open, readFile } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createDatabaseFromEnvironment } from '../packages/persistence/src/config.js';
import { ControlJournal } from '../packages/application/src/recovery/control-journal.js';
import { canonicalJson } from '../packages/application/src/operations/service.js';
import {
  captureModelUpgradeBeforeProof,
  checkpointModelUpgrade,
  modelUpgradeBeforeProofSchema,
} from '../packages/application/src/configuration/upgrade-checkpoint.js';

const rejected = () =>
  Object.assign(new Error('EXPLICIT_LOCAL_MODEL_CHECKPOINT_REQUIRED'), {
    code: 'EXPLICIT_LOCAL_MODEL_CHECKPOINT_REQUIRED',
  });
/** Pure operator argument guard. No filesystem or database access occurs here. */
export function parseModelCheckpointArguments(
  args: string[],
  environment: NodeJS.ProcessEnv,
) {
  if (
    environment.AITESTHUB_MAIN_MODEL_CHECKPOINT !==
      'explicit-local-model-upgrade' ||
    environment.DB_HOST !== '127.0.0.1' ||
    environment.DB_PORT !== '55432' ||
    environment.DB_NAME !== 'aitesthub' ||
    environment.DB_USER !== 'aitesthub_app'
  )
    throw rejected();
  const entries = new Map<string, string>();
  for (const arg of args) {
    if (arg === '--explicit-local-deployment') {
      if (entries.has('explicit')) throw rejected();
      entries.set('explicit', 'true');
      continue;
    }
    const match = /^--(mode|proof|platform-id)=(.+)$/.exec(arg);
    if (!match?.[1] || !match[2] || entries.has(match[1])) throw rejected();
    entries.set(match[1], match[2]);
  }
  if (entries.get('explicit') !== 'true' || entries.size !== 4)
    throw rejected();
  const mode = z.enum(['before', 'execute']).parse(entries.get('mode')),
    platformId = z.uuid().parse(entries.get('platform-id'));
  const root =
    environment.AITESTHUB_LOCAL_ROOT ??
    (environment.LOCALAPPDATA
      ? join(environment.LOCALAPPDATA, 'AITestHub')
      : undefined);
  if (!root || !isAbsolute(root)) throw rejected();
  const proof = entries.get('proof')!;
  if (!isAbsolute(proof)) throw rejected();
  const scope = relative(
    resolve(root, 'setup', 'model-upgrade'),
    resolve(proof),
  );
  if (
    !scope ||
    scope.startsWith('..') ||
    isAbsolute(scope) ||
    !/^before-[a-f0-9-]{36}\.json$/i.test(scope)
  )
    throw rejected();
  return { mode, platformId, proof: resolve(proof), root: resolve(root) };
}
function equalPath(left: string, right: string) {
  const a = resolve(left),
    b = resolve(right);
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}
async function assertExistingPrivateControl(
  root: string,
  env: NodeJS.ProcessEnv,
) {
  const paths = {
    AITESTHUB_RECOVERY_CONTROL_DIRECTORY: join(
      root,
      'control',
      'security-controls',
    ),
    AITESTHUB_RECOVERY_CONTROL_ANCHOR_FILE: join(
      root,
      'recovery',
      'controls',
      'security-control-anchor.json',
    ),
    AITESTHUB_RECOVERY_CONTROL_KEY_FILE: join(
      root,
      'secrets',
      'recovery-control-key',
    ),
    AITESTHUB_MASTER_KEY_FILE: join(root, 'secrets', 'platform-master-key'),
    AITESTHUB_BACKUP_DIRECTORY: join(root, 'backups', 'product'),
  };
  for (const [name, expected] of Object.entries(paths))
    if (env[name] !== undefined && !equalPath(env[name]!, expected))
      throw rejected();
  for (const [name, path] of Object.entries(paths)) {
    if (name === 'AITESTHUB_BACKUP_DIRECTORY') continue;
    const item = await lstat(path);
    if (
      item.isSymbolicLink() ||
      (name === 'AITESTHUB_RECOVERY_CONTROL_DIRECTORY'
        ? !item.isDirectory()
        : !item.isFile())
    )
      throw rejected();
  }
  const head = await lstat(
    join(paths.AITESTHUB_RECOVERY_CONTROL_DIRECTORY, 'head.json'),
  );
  if (!head.isFile() || head.isSymbolicLink() || head.size > 16384)
    throw rejected();
}
async function main() {
  const input = parseModelCheckpointArguments(
    process.argv.slice(2),
    process.env,
  );
  await assertExistingPrivateControl(input.root, process.env);
  const parent = await lstat(resolve(input.proof, '..'));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw rejected();
  const db = await createDatabaseFromEnvironment();
  try {
    // The trusted journal internally loads its existing control/master keys. No
    // model Key is read/resolved, and no replacement key/head is generated here.
    const controls = await ControlJournal.fromEnvironment(db),
      directory = resolve('packages/persistence/migrations');
    if (input.mode === 'before') {
      const proof = await captureModelUpgradeBeforeProof(
          db,
          controls,
          input.platformId,
          directory,
        ),
        bytes = Buffer.from(canonicalJson(proof) + '\n');
      const file = await open(input.proof, 'wx', 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      process.stdout.write(
        JSON.stringify({
          mode: 'before',
          platformId: proof.platformId,
          sourceSequence: proof.sourceHead.sequence,
          proofSha256: createHash('sha256').update(bytes).digest('hex'),
        }) + '\n',
      );
    } else {
      const item = await lstat(input.proof);
      if (!item.isFile() || item.isSymbolicLink() || item.size > 65536)
        throw rejected();
      const bytes = await readFile(input.proof);
      if (bytes.length > 65536) throw rejected();
      const proof = modelUpgradeBeforeProofSchema.parse(
        JSON.parse(bytes.toString('utf8')),
      );
      if (
        proof.platformId !== input.platformId ||
        !bytes.equals(Buffer.from(canonicalJson(proof) + '\n'))
      )
        throw rejected();
      const result = await checkpointModelUpgrade(
        db,
        controls,
        proof,
        directory,
        { explicit: true },
      );
      process.stdout.write(
        JSON.stringify({ mode: 'execute', ...result }) + '\n',
      );
    }
  } finally {
    await db.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const code =
      error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^[A-Z_]{3,80}$/.test(error.code)
        ? error.code
        : 'MODEL_UPGRADE_CHECKPOINT_REJECTED';
    process.stderr.write(code + '\n');
    process.exitCode = 1;
  });
}
