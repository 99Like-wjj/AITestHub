import { randomBytes, randomUUID, createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  writeFile,
  chown,
  chmod,
  realpath,
} from 'node:fs/promises';
import { isAbsolute, resolve, dirname, basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const frozenImage =
  'sha256:e136d2033062061e301cb0e99ed7046a175aba4abe05aa2dd7d5fd8012786570';
const secretNames = [
  'postgres-admin-password',
  'postgres-app-password',
  's3-bootstrap-access',
  's3-bootstrap-secret',
  's3-app-access',
  's3-app-secret',
  'platform-master-key',
  'api-worker-bootstrap',
  'recovery-control-key',
  'backup-encryption-key',
  'bootstrap-admin-password',
  'postgres-app-password-pg',
  's3-iam.json',
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function noLink(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw Error('Linked private path refused');
  return stat;
}

/** Creates a new independent runtime; it never imports, rotates or repairs secrets. */
export async function preparePrivate(root, uid, gid) {
  if (
    !isAbsolute(root) ||
    resolve(root) !== root ||
    basename(root) !== 'aitesthub-private' ||
    ![uid, gid].every(
      (v) => Number.isSafeInteger(v) && v > 0 && v <= 4294967294,
    )
  )
    throw Error('Invalid private root or identity');
  if ((await realpath(dirname(root))) !== dirname(root))
    throw Error('Linked parent refused');
  let exists = true;
  try {
    const stat = await noLink(root);
    if (!stat.isDirectory()) throw Error('Private root must be a directory');
  } catch (error) {
    if (error.code === 'ENOENT') exists = false;
    else throw error;
  }
  const marker = join(root, '.cloud-bootstrap.json');
  if (exists && (await readdir(root)).length) {
    if (!(await noLink(marker)).isFile())
      throw Error('Private identity marker must be a regular file');
    const original = JSON.parse(await readFile(marker, 'utf8'));
    if (
      original.schemaVersion !== 'ath.personal-cloud-bootstrap.v1' ||
      original.uid !== uid ||
      original.gid !== gid ||
      original.frozenImage !== frozenImage ||
      !/^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/.test(original.deploymentId) ||
      original.bucket !==
        `aitesthub-personal-${original.deploymentId.replaceAll('-', '').slice(0, 12)}` ||
      JSON.stringify(Object.keys(original.files).sort()) !==
        JSON.stringify(secretNames.map((name) => 'secrets/' + name).sort())
    )
      throw Error('Independent runtime identity mismatch');
    for (const [name, expected] of Object.entries(original.files)) {
      const path = join(root, name);
      if (!path.startsWith(root + '/') && !path.startsWith(root + '\\'))
        throw Error('Invalid inventory path');
      if (
        !(await noLink(path)).isFile() ||
        (await realpath(path)) !== path ||
        hash(await readFile(path)) !== expected
      )
        throw Error('Existing private files changed; no overwrite');
    }
    for (const name of [
      'cloud.env',
      'ops.env',
      'configuration/test-targets.json',
    ])
      if (
        !(await noLink(join(root, name))).isFile() ||
        (await realpath(join(root, name))) !== join(root, name)
      )
        throw Error('Prepared configuration missing or linked');
    return {
      created: false,
      deploymentId: original.deploymentId,
      bucket: original.bucket,
      privateRoot: root,
      secretsPrinted: false,
    };
  }
  if (!exists) await mkdir(root, { mode: 0o700 });
  const directories = [
    'secrets',
    'configuration',
    'control',
    'control/privacy-deletions',
    'control/security-controls',
    'recovery',
    'recovery/controls',
    'backups',
    'backups/product',
    'setup',
    'setup/operations',
  ];
  for (const name of directories)
    await mkdir(join(root, name), { recursive: true, mode: 0o700 });
  const deploymentId = randomUUID(),
    bucket = `aitesthub-personal-${deploymentId.replaceAll('-', '').slice(0, 12)}`;
  const secrets = {};
  for (const name of [
    'postgres-admin-password',
    'postgres-app-password',
    's3-bootstrap-access',
    's3-bootstrap-secret',
    's3-app-access',
    's3-app-secret',
    'platform-master-key',
    'api-worker-bootstrap',
    'recovery-control-key',
    'backup-encryption-key',
    'bootstrap-admin-password',
  ])
    secrets[name] = randomBytes(name.endsWith('-access') ? 10 : 32).toString(
      'hex',
    );
  // A separate mounted copy lets PostgreSQL's own UID initialize; no shared local Key.
  secrets['postgres-app-password-pg'] = secrets['postgres-app-password'];
  secrets['s3-iam.json'] = JSON.stringify({
    identities: [
      {
        name: 'aitesthub-personal-bootstrap',
        credentials: [
          {
            accessKey: secrets['s3-bootstrap-access'],
            secretKey: secrets['s3-bootstrap-secret'],
          },
        ],
        actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'],
      },
      {
        name: 'aitesthub-personal-app',
        credentials: [
          {
            accessKey: secrets['s3-app-access'],
            secretKey: secrets['s3-app-secret'],
          },
        ],
        actions: [
          `Read:${bucket}`,
          `Write:${bucket}`,
          `List:${bucket}`,
          `Tagging:${bucket}`,
        ],
      },
    ],
  });
  const files = {};
  async function save(name, body, mode = 0o400) {
    const path = join(root, name);
    await writeFile(path, body, { flag: 'wx', mode });
    if (process.platform === 'linux') {
      await chown(path, uid, gid);
      await chmod(path, mode);
    }
    if (name.startsWith('secrets/')) files[name] = hash(Buffer.from(body));
  }
  for (const [name, value] of Object.entries(secrets))
    await save(
      `secrets/${name}`,
      value,
      name === 'postgres-admin-password' || name === 'postgres-app-password-pg'
        ? 0o444
        : 0o400,
    );
  await save(
    'configuration/test-targets.json',
    JSON.stringify({ httpOrigins: [], sqlTargets: [] }) + '\n',
  );
  await save(
    'cloud.env',
    `AITESTHUB_PRIVATE_ROOT=${root}\nAITESTHUB_APP_IMAGE=aitesthub:33-e136d203\nAITESTHUB_POSTGRES_IMAGE=aitesthub-postgres:18.6-fixed\nAITESTHUB_SEAWEED_IMAGE=aitesthub-storage:4.53-fixed\nAITESTHUB_RUN_UID=${uid}\nAITESTHUB_RUN_GID=${gid}\nAITESTHUB_S3_BUCKET=${bucket}\nAITESTHUB_PUBLIC_ORIGIN=http://localhost:5300\nAITESTHUB_COOKIE_SECURE=false\n`,
    0o600,
  );
  await save(
    'ops.env',
    `DB_HOST=127.0.0.1\nDB_PORT=55432\nDB_NAME=aitesthub\nDB_USER=aitesthub_app\nAITESTHUB_LOCAL_ROOT=${root}\nAITESTHUB_DB_PASSWORD_FILE=${root}/secrets/postgres-app-password\nAITESTHUB_S3_ENDPOINT=http://127.0.0.1:58333\nAITESTHUB_S3_BUCKET=${bucket}\nAITESTHUB_S3_ACCESS_KEY_FILE=${root}/secrets/s3-app-access\nAITESTHUB_S3_SECRET_KEY_FILE=${root}/secrets/s3-app-secret\nAITESTHUB_MASTER_KEY_FILE=${root}/secrets/platform-master-key\nAITESTHUB_RECOVERY_CONTROL_KEY_FILE=${root}/secrets/recovery-control-key\nAITESTHUB_RECOVERY_CONTROL_DIRECTORY=${root}/control/security-controls\nAITESTHUB_RECOVERY_CONTROL_ANCHOR_FILE=${root}/recovery/controls/security-control-anchor.json\nAITESTHUB_BACKUP_DIRECTORY=${root}/backups/product\nAITESTHUB_BACKUP_KEY_FILE=${root}/secrets/backup-encryption-key\nAITESTHUB_OPERATIONS_STOP_FILE=${root}/setup/operations/stop.request\nAITESTHUB_DOCKER_EXE=/usr/bin/docker\nAITESTHUB_PG_CONTAINER=aitesthub-postgres\nAITESTHUB_OBJECT_CONTAINER=aitesthub-seaweedfs\nAITESTHUB_PG_DUMP_PASSWORD_FILE=/run/secrets/postgres_app_password\n`,
    0o600,
  );
  const original = {
    schemaVersion: 'ath.personal-cloud-bootstrap.v1',
    deploymentId,
    bucket,
    uid,
    gid,
    frozenImage,
    files,
  };
  await writeFile(marker, JSON.stringify(original, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o400,
  });
  if (process.platform === 'linux') {
    for (const name of [root, ...directories.map((name) => join(root, name))]) {
      await chown(name, uid, gid);
      await chmod(name, 0o700);
    }
    await chown(marker, uid, gid);
  }
  return {
    created: true,
    deploymentId,
    bucket,
    privateRoot: root,
    secretFiles: Object.keys(secrets).length,
    secretsPrinted: false,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    if (process.platform !== 'linux' || process.getuid() !== 0)
      throw Error('Linux root preparation required');
    const args = process.argv.slice(2),
      value = (name) =>
        args.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3);
    const root = value('root');
    if (root !== '/srv/aitesthub-private')
      throw Error('Explicit cloud private root required');
    console.log(
      JSON.stringify(
        await preparePrivate(root, Number(value('uid')), Number(value('gid'))),
      ),
    );
  } catch {
    process.stderr.write(
      'AITestHub private preparation refused; existing files were preserved. Inspect the new runtime without printing secrets.\n',
    );
    process.exitCode = 1;
  }
}
