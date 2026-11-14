import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, isAbsolute, relative, resolve } from 'node:path';
import type { Database } from '../../../persistence/src/database.js';
import type { StoragePort } from '../../../storage/src/port.js';
import { DomainError } from '../errors.js';
import { ControlJournal } from './control-journal.js';
import { BackupFiles } from './backup-files.js';
import { ProductBackupService } from './backup.js';
import { DockerPostgresDump } from './postgres-tools.js';
import { MaintenanceService } from './maintenance.js';
import { FileGarbageCollector } from './garbage.js';
import { CapacityMonitor, DockerObjectCapacity } from './capacity.js';
import { OperationsRuntime } from './runtime.js';

export async function backupFilesFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const root =
      environment.AITESTHUB_LOCAL_ROOT ??
      (environment.LOCALAPPDATA
        ? join(environment.LOCALAPPDATA, 'AITestHub')
        : undefined),
    directory =
      environment.AITESTHUB_BACKUP_DIRECTORY ??
      (root ? join(root, 'backups', 'product') : undefined),
    keyFile =
      environment.AITESTHUB_BACKUP_KEY_FILE ??
      (root ? join(root, 'secrets', 'backup-encryption-key') : undefined);
  if (!directory || !keyFile || !isAbsolute(directory) || !isAbsolute(keyFile))
    throw new DomainError(
      'DEPENDENCY_UNAVAILABLE',
      '产品备份目录/密钥文件尚未安全配置。',
      503,
    );
  const keyRelative = relative(resolve(directory), resolve(keyFile));
  if (
    !keyRelative ||
    (!keyRelative.startsWith('..') && !isAbsolute(keyRelative))
  )
    throw new DomainError(
      'DEPENDENCY_UNAVAILABLE',
      '备份Key必须保存在归档目录外的私有secret文件。',
      503,
    );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(join(keyFile, '..'), { recursive: true, mode: 0o700 });
  try {
    await readFile(keyFile);
  } catch (error: unknown) {
    if (!(
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ))
      throw error;
    const legacy =
      root &&
      resolve(keyFile) ===
        resolve(join(root, 'secrets', 'backup-encryption-key'))
        ? (
            await readdir(join(root, 'backups')).catch(
              (probe: NodeJS.ErrnoException) => {
                if (probe.code === 'ENOENT') return [];
                throw probe;
              },
            )
          ).some((name) => name.endsWith('.athenc'))
        : false;
    if (
      legacy ||
      (await readdir(directory)).some((name) => /^product-/.test(name))
    )
      throw new DomainError(
        'DEPENDENCY_UNAVAILABLE',
        '已有归档但备份密钥缺失；不会覆盖生成新Key。',
        503,
      );
    try {
      await writeFile(keyFile, randomBytes(32).toString('hex'), {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (write: unknown) {
      if (!(
        write &&
        typeof write === 'object' &&
        'code' in write &&
        write.code === 'EEXIST'
      ))
        throw write;
    }
  }
  const text = (await readFile(keyFile, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/i.test(text))
    throw new DomainError(
      'DEPENDENCY_UNAVAILABLE',
      '产品备份密钥格式不可用。',
      503,
    );
  return new BackupFiles(directory, Buffer.from(text, 'hex'));
}
export async function createRecoveryServices(
  db: Database,
  storage: StoragePort,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const controls = await ControlJournal.fromEnvironment(db, environment);
  await controls.initialize();
  const maintenance = new MaintenanceService(db, () =>
      controls.assertCurrentSource(),
    ),
    files = await backupFilesFromEnvironment(environment);
  const docker =
      environment.AITESTHUB_DOCKER_EXE ??
      (environment.LOCALAPPDATA
        ? join(
            environment.LOCALAPPDATA,
            'Programs',
            'DockerDesktop',
            'resources',
            'bin',
            'docker.exe',
          )
        : 'docker'),
    dump = new DockerPostgresDump(
      docker,
      environment.AITESTHUB_PG_CONTAINER ?? 'aitesthub-local-postgres-1',
      environment.DB_NAME ?? 'aitesthub',
      environment.DB_USER ?? 'aitesthub_app',
      environment.AITESTHUB_PG_DUMP_PASSWORD_FILE ??
        '/run/secrets/postgres_app_password',
    );
  const backups = new ProductBackupService(
      db,
      storage,
      dump,
      controls,
      maintenance,
      files,
    ),
    garbage = new FileGarbageCollector(db, storage),
    root =
      environment.AITESTHUB_LOCAL_ROOT ??
      (environment.LOCALAPPDATA
        ? join(environment.LOCALAPPDATA, 'AITestHub')
        : undefined);
  const paths: Partial<Record<'runtime' | 'backups' | 'objects', string>> = {
    backups: files.directory,
  };
  if (root) paths.runtime = root;
  if (environment.AITESTHUB_CAPACITY_OBJECT_DIRECTORY)
    paths.objects = environment.AITESTHUB_CAPACITY_OBJECT_DIRECTORY;
  const capacity = new CapacityMonitor(
      db,
      paths,
      paths.objects
        ? {}
        : {
            objects: new DockerObjectCapacity(
              docker,
              environment.AITESTHUB_OBJECT_CONTAINER ??
                'aitesthub-local-seaweedfs-1',
            ),
          },
    ),
    runtime = new OperationsRuntime(db, backups, garbage, capacity);
  return { controls, maintenance, files, backups, garbage, capacity, runtime };
}
