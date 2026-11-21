// Trusted local recovery infrastructure only. No product volume, container, credential or network is reused.
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { finished } from 'node:stream/promises';
import { mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { z } from 'zod';
import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

const workspace = resolve(import.meta.dirname, '../../..');
const descriptorSchema = z.strictObject({
  schemaVersion: z.literal('ath.isolated-restore-target.v1'),
  id: z.uuid(),
  directory: z.string(),
  baseDirectory: z.string(),
  state: z.enum(['provisioning', 'ready']),
  networks: z.array(z.string()).length(2),
  volumes: z.array(z.string()).length(2),
  postgres: z.strictObject({
    container: z.string(),
    host: z.literal('127.0.0.1'),
    port: z.number().int().positive().nullable(),
    database: z.literal('aitesthub_restore'),
    user: z.literal('aitesthub_app'),
    passwordFile: z.string(),
    adminPasswordFile: z.string(),
  }),
  s3: z.strictObject({
    container: z.string(),
    endpoint: z.string().nullable(),
    bucket: z.literal('aitesthub-restore'),
    accessKeyFile: z.string(),
    secretKeyFile: z.string(),
    adminAccessFile: z.string(),
    adminSecretFile: z.string(),
  }),
  probes: z.strictObject({ postgres: z.boolean(), s3: z.boolean() }),
});
const fail = (stage) =>
  new Error(
    `Isolated recovery target failed: ${stage}; no credentials printed.`,
  );
const docker =
  process.platform === 'win32'
    ? join(
        process.env.LOCALAPPDATA ?? '',
        'Programs',
        'DockerDesktop',
        'resources',
        'bin',
        'docker.exe',
      )
    : 'docker';
async function command(args, input) {
  return new Promise((done, reject) => {
    const child = spawn(docker, args, {
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        PATH: `${dirname(docker)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      if (output.length < 1048576) output += chunk.toString();
    });
    child.once('error', () => reject(fail(args[0])));
    child.once('close', (code) => done({ code, output: output.trim() }));
    child.stdin.once('error', () => {});
    child.stdin.end(input);
  });
}
async function required(args, input) {
  const result = await command(args, input);
  if (result.code !== 0) throw fail(args[0]);
  return result.output;
}
async function privateRoot() {
  const value =
    process.env.AITESTHUB_LOCAL_ROOT ??
    (process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'AITestHub')
      : undefined);
  if (!value || !isAbsolute(value)) throw fail('private root');
  return realpath(value);
}
async function checkedBase(value) {
  const root = await privateRoot(),
    path = resolve(value ?? join(root, 'recovery', 'isolated')),
    inside = relative(root, path),
    repo = relative(workspace, path);
  if (
    !inside ||
    inside.startsWith('..') ||
    isAbsolute(inside) ||
    !['recovery', 'setup'].includes(inside.split(/[\\/]/)[0]) ||
    (!repo.startsWith('..') && !isAbsolute(repo))
  )
    throw fail('private target scope');
  await mkdir(path, { recursive: true, mode: 0o700 });
  const actual = await realpath(path),
    actualInside = relative(root, actual);
  if (
    !actualInside ||
    actualInside.startsWith('..') ||
    isAbsolute(actualInside)
  )
    throw fail('private target scope');
  return actual;
}
async function secret(path) {
  return (await readFile(path, 'utf8')).trim();
}
async function save(target) {
  await writeFile(
    join(target.directory, 'target.json'),
    JSON.stringify(target, null, 2) + '\n',
    { mode: 0o600 },
  );
}
function expectedNames(id) {
  const suffix = id.replaceAll('-', '');
  return {
    postgres: `ath-restore-pg-${suffix}`,
    s3: `ath-restore-s3-${suffix}`,
    networks: [`ath-restore-internal-${suffix}`, `ath-restore-admin-${suffix}`],
    volumes: [`ath_restore_pg_${suffix}`, `ath_restore_s3_${suffix}`],
  };
}
async function verifyLabel(kind, name, id) {
  const result = await command([
    'inspect',
    ...(kind === 'volume'
      ? ['--type', 'volume']
      : kind === 'network'
        ? ['--type', 'network']
        : []),
    '--format',
    '{{index .Labels "aitesthub.restore.id"}}',
    name,
  ]);
  if (kind === 'container') {
    const container = await command([
      'inspect',
      '--format',
      '{{index .Config.Labels "aitesthub.restore.id"}}',
      name,
    ]);
    if (container.code !== 0) return false;
    if (container.output !== id) throw fail('container ownership');
    return true;
  }
  if (result.code !== 0) return false;
  if (result.output !== id) throw fail(`${kind} ownership`);
  return true;
}
export async function createIsolatedTarget(options = {}) {
  const id = z.uuid().parse(options.id ?? randomUUID()),
    baseDirectory = await checkedBase(options.rootDirectory),
    directory = join(baseDirectory, id),
    names = expectedNames(id);
  await mkdir(directory, { mode: 0o700 });
  const secrets = join(directory, 'secrets');
  await mkdir(secrets, { mode: 0o700 });
  const target = {
    schemaVersion: 'ath.isolated-restore-target.v1',
    id,
    directory,
    baseDirectory,
    state: 'provisioning',
    networks: names.networks,
    volumes: names.volumes,
    postgres: {
      container: names.postgres,
      host: '127.0.0.1',
      port: null,
      database: 'aitesthub_restore',
      user: 'aitesthub_app',
      passwordFile: join(secrets, 'postgres-app-password'),
      adminPasswordFile: join(secrets, 'postgres-admin-password'),
    },
    s3: {
      container: names.s3,
      endpoint: null,
      bucket: 'aitesthub-restore',
      accessKeyFile: join(secrets, 's3-app-access'),
      secretKeyFile: join(secrets, 's3-app-secret'),
      adminAccessFile: join(secrets, 's3-admin-access'),
      adminSecretFile: join(secrets, 's3-admin-secret'),
    },
    probes: { postgres: false, s3: false },
  };
  try {
    for (const file of [
      target.postgres.passwordFile,
      target.postgres.adminPasswordFile,
      target.s3.accessKeyFile,
      target.s3.secretKeyFile,
      target.s3.adminAccessFile,
      target.s3.adminSecretFile,
    ])
      await writeFile(file, randomBytes(32).toString('hex'), {
        flag: 'wx',
        mode: 0o600,
      });
    const iam = join(secrets, 's3-iam.json');
    await writeFile(
      iam,
      JSON.stringify({
        identities: [
          {
            name: 'restore-admin',
            credentials: [
              {
                accessKey: await secret(target.s3.adminAccessFile),
                secretKey: await secret(target.s3.adminSecretFile),
              },
            ],
            actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'],
          },
          {
            name: 'restore-app',
            credentials: [
              {
                accessKey: await secret(target.s3.accessKeyFile),
                secretKey: await secret(target.s3.secretKeyFile),
              },
            ],
            actions: [
              `Read:${target.s3.bucket}`,
              `Write:${target.s3.bucket}`,
              `List:${target.s3.bucket}`,
              `Tagging:${target.s3.bucket}`,
            ],
          },
        ],
      }),
      { flag: 'wx', mode: 0o600 },
    );
    await save(target);
    const images = JSON.parse(
      await readFile(
        join(workspace, 'deploy', 'local', 'images.lock.json'),
        'utf8',
      ),
    );
    const postgres = images.postgres,
      seaweed = images.seaweedfs ?? images.seaweed;
    if (typeof postgres !== 'string' || typeof seaweed !== 'string')
      throw fail('approved images');
    for (const volume of names.volumes)
      await required([
        'volume',
        'create',
        '--label',
        `aitesthub.restore.id=${id}`,
        volume,
      ]);
    await required([
      'network',
      'create',
      '--internal',
      '--label',
      `aitesthub.restore.id=${id}`,
      names.networks[0],
    ]);
    await required([
      'network',
      'create',
      '--label',
      `aitesthub.restore.id=${id}`,
      names.networks[1],
    ]);
    const common = [
      '--label',
      `aitesthub.restore.id=${id}`,
      '--security-opt',
      'no-new-privileges:true',
      '--cpus',
      '1',
      '--pids-limit',
      '128',
    ];
    await required([
      'create',
      '--name',
      names.postgres,
      '--network',
      names.networks[1],
      ...common,
      '--memory',
      '512m',
      '--publish',
      '127.0.0.1::5432',
      '--env',
      'POSTGRES_USER=restore_admin',
      '--env',
      'POSTGRES_DB=aitesthub_restore',
      '--env',
      'POSTGRES_PASSWORD_FILE=/run/secrets/postgres_admin_password',
      '--env',
      'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256',
      '--mount',
      `type=volume,source=${names.volumes[0]},target=/var/lib/postgresql`,
      '--mount',
      `type=bind,source=${target.postgres.adminPasswordFile},target=/run/secrets/postgres_admin_password,readonly`,
      '--mount',
      `type=bind,source=${target.postgres.passwordFile},target=/run/secrets/postgres_app_password,readonly`,
      postgres,
      'postgres',
      '-c',
      'shared_buffers=32MB',
      '-c',
      'max_connections=30',
    ]);
    await required([
      'network',
      'connect',
      '--alias',
      'restore-postgres',
      names.networks[0],
      names.postgres,
    ]);
    await required(['start', names.postgres]);
    let pgReady = false;
    for (let index = 0; index < 60; index++) {
      if (
        (
          await command([
            'exec',
            names.postgres,
            'pg_isready',
            '-h',
            '127.0.0.1',
            '-U',
            'restore_admin',
            '-d',
            'aitesthub_restore',
          ])
        ).code === 0
      ) {
        pgReady = true;
        break;
      }
      await new Promise((done) => setTimeout(done, 250));
    }
    if (!pgReady) throw fail('PostgreSQL readiness');
    await required(
      [
        'exec',
        '-i',
        names.postgres,
        'psql',
        '-U',
        'restore_admin',
        '-d',
        'aitesthub_restore',
        '-v',
        'ON_ERROR_STOP=1',
      ],
      `CREATE ROLE aitesthub_app LOGIN PASSWORD '${await secret(target.postgres.passwordFile)}' NOSUPERUSER NOCREATEDB NOCREATEROLE;\nALTER DATABASE aitesthub_restore OWNER TO aitesthub_app;\n`,
    );
    const published = await required(['port', names.postgres, '5432/tcp']),
      port = /^127\.0\.0\.1:(\d+)$/.exec(published)?.[1];
    if (!port) throw fail('loopback PG port');
    target.postgres.port = Number(port);
    target.probes.postgres = true;
    await required([
      'create',
      '--name',
      names.s3,
      '--network',
      names.networks[1],
      ...common,
      '--cap-drop',
      'ALL',
      '--cap-add',
      'SETUID',
      '--cap-add',
      'SETGID',
      '--cap-add',
      'CHOWN',
      '--memory',
      '512m',
      '--read-only',
      '--tmpfs',
      '/tmp:size=32m,noexec,nosuid',
      '--workdir',
      '/data',
      '--publish',
      '127.0.0.1::8333',
      '--mount',
      `type=volume,source=${names.volumes[1]},target=/data`,
      '--mount',
      `type=bind,source=${iam},target=/run/secrets/s3_iam,readonly`,
      seaweed,
      'server',
      '-dir=/data',
      '-ip=restore-seaweed',
      '-ip.bind=0.0.0.0',
      '-s3',
      '-s3.config=/run/secrets/s3_iam',
      '-s3.port=8333',
      '-s3.port.iceberg=0',
      '-s3.port.lance=0',
      '-master.volumeSizeLimitMB=1024',
      '-volume.max=32',
      '-volume.minFreeSpace=2GiB',
    ]);
    await required([
      'network',
      'connect',
      '--alias',
      'restore-seaweed',
      names.networks[0],
      names.s3,
    ]);
    await required(['start', names.s3]);
    const s3Published = await required(['port', names.s3, '8333/tcp']),
      s3Port = /^127\.0\.0\.1:(\d+)$/.exec(s3Published)?.[1];
    if (!s3Port) throw fail('loopback S3 port');
    target.s3.endpoint = `http://127.0.0.1:${s3Port}`;
    const admin = new S3Client({
      endpoint: target.s3.endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      maxAttempts: 1,
      requestHandler: {
        connectionTimeout: 1000,
        requestTimeout: 5000,
        throwOnRequestTimeout: true,
      },
      credentials: {
        accessKeyId: await secret(target.s3.adminAccessFile),
        secretAccessKey: await secret(target.s3.adminSecretFile),
      },
    });
    let s3Ready = false;
    for (let index = 0; index < 60; index++) {
      try {
        await admin.send(new CreateBucketCommand({ Bucket: target.s3.bucket }));
        s3Ready = true;
        break;
      } catch {
        await new Promise((done) => setTimeout(done, 250));
      }
    }
    admin.destroy();
    if (!s3Ready) throw fail('S3 bucket readiness');
    await new Promise((done) => setTimeout(done, 1500));
    const app = new S3Client({
      endpoint: target.s3.endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      maxAttempts: 1,
      requestHandler: {
        connectionTimeout: 1000,
        requestTimeout: 30000,
        throwOnRequestTimeout: true,
      },
      credentials: {
        accessKeyId: await secret(target.s3.accessKeyFile),
        secretAccessKey: await secret(target.s3.secretKeyFile),
      },
    });
    try {
      const key = `recovery-probe/${id}`,
        bytes = Buffer.from(`isolated-s3-${id}`);
      await app.send(
        new PutObjectCommand({
          Bucket: target.s3.bucket,
          Key: key,
          Body: bytes,
        }),
      );
      const result = await app.send(
        new GetObjectCommand({ Bucket: target.s3.bucket, Key: key }),
      );
      const actual = Buffer.from(await result.Body.transformToByteArray());
      if (
        createHash('sha256').update(actual).digest('hex') !==
        createHash('sha256').update(bytes).digest('hex')
      )
        throw fail('S3 actual bytes');
      await app.send(
        new DeleteObjectCommand({ Bucket: target.s3.bucket, Key: key }),
      );
      target.probes.s3 = true;
    } finally {
      app.destroy();
    }
    target.state = 'ready';
    await save(target);
    return descriptorSchema.parse(target);
  } catch (error) {
    if (!options.keepFailed) await removeIsolatedTarget(target).catch(() => {});
    else await save(target).catch(() => {});
    throw error;
  }
}
export function targetEnvironment(raw) {
  const target = descriptorSchema.parse(raw);
  if (target.state !== 'ready' || !target.postgres.port || !target.s3.endpoint)
    throw fail('target not verified');
  return {
    DB_HOST: target.postgres.host,
    DB_PORT: String(target.postgres.port),
    DB_NAME: target.postgres.database,
    DB_USER: target.postgres.user,
    AITESTHUB_DB_PASSWORD_FILE: target.postgres.passwordFile,
    AITESTHUB_S3_ENDPOINT: target.s3.endpoint,
    AITESTHUB_S3_BUCKET: target.s3.bucket,
    AITESTHUB_S3_ACCESS_KEY_FILE: target.s3.accessKeyFile,
    AITESTHUB_S3_SECRET_KEY_FILE: target.s3.secretKeyFile,
  };
}
export async function restoreDatabase(raw, input) {
  const target = descriptorSchema.parse(raw);
  if (
    target.state !== 'ready' ||
    !(await verifyLabel('container', target.postgres.container, target.id))
  )
    throw fail('restore ownership');
  const script =
    'PGPASSWORD="$(cat /run/secrets/postgres_app_password)"; export PGPASSWORD; exec pg_restore -h 127.0.0.1 -U aitesthub_app -d aitesthub_restore --no-owner --no-privileges --single-transaction --exit-on-error';
  const child = spawn(
    docker,
    ['exec', '-i', target.postgres.container, 'sh', '-c', script],
    { windowsHide: true, shell: false, stdio: ['pipe', 'ignore', 'ignore'] },
  );
  const inputFinished = finished(input).then(
    () => true,
    () => {
      child.stdin.destroy();
      child.kill();
      return false;
    },
  );
  const drain = () => {
    input.unpipe(child.stdin);
    input.resume();
  };
  child.stdin.once('error', drain);
  const processFinished = new Promise((done) => {
    child.once('error', () => {
      input.destroy();
      done(false);
    });
    child.once('close', (code) => {
      drain();
      done(code === 0);
    });
  });
  const timer = setTimeout(() => {
    input.destroy();
    child.kill();
  }, 120000);
  timer.unref();
  input.pipe(child.stdin);
  try {
    const [complete, restored] = await Promise.all([
      inputFinished,
      processFinished,
    ]);
    if (!complete || !restored) throw fail('PG restore');
  } finally {
    clearTimeout(timer);
  }
}
export async function removeIsolatedTarget(raw) {
  const target = descriptorSchema.parse(raw),
    names = expectedNames(target.id);
  if (
    target.postgres.container !== names.postgres ||
    target.s3.container !== names.s3 ||
    JSON.stringify(target.networks) !== JSON.stringify(names.networks) ||
    JSON.stringify(target.volumes) !== JSON.stringify(names.volumes)
  )
    throw fail('cleanup names');
  const base = await checkedBase(target.baseDirectory),
    directory = resolve(target.directory);
  if (directory !== join(base, target.id)) throw fail('cleanup directory');
  for (const name of [names.postgres, names.s3])
    if (await verifyLabel('container', name, target.id))
      await required(['rm', '--force', name]);
  for (const name of names.volumes)
    if (await verifyLabel('volume', name, target.id))
      await required(['volume', 'rm', name]);
  for (const name of names.networks)
    if (await verifyLabel('network', name, target.id))
      await required(['network', 'rm', name]);
  const actual = await realpath(directory),
    inside = relative(base, actual);
  if (inside !== target.id || isAbsolute(inside) || inside.startsWith('..'))
    throw fail('cleanup real directory');
  await rm(actual, { recursive: true });
}
