import { statfs } from 'node:fs/promises';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { DomainError } from '../errors.js';
import { spawn } from 'node:child_process';
import {
  capacityPolicies,
  type CapacityPolicies,
  type CapacityThresholds,
} from './capacity-policy.js';
import type { ResourcePolicySnapshot } from '../../../contracts/src/resource-policy.js';
interface Sample {
  location: string;
  available_bytes: string | null;
  total_bytes: string | null;
  captured_at: Date;
  error_code: string | null;
}
export interface CapacityStatus {
  state: 'unknown' | 'healthy' | 'warning' | 'restricted';
  availableBytes: string | null;
  locations: Sample[];
}
async function statusWithPolicy(
  db: SqlExecutor,
  thresholds: CapacityThresholds,
): Promise<CapacityStatus> {
  if (
    !(
      await db.query<{ ready: boolean }>(
        "SELECT to_regclass('app.operations_capacity_samples') IS NOT NULL ready",
      )
    ).rows[0]?.ready
  )
    return {
      state: 'unknown' as const,
      availableBytes: null,
      locations: [] as Sample[],
    };
  const rows = (
    await db.query<Sample>(
      'SELECT DISTINCT ON(location) location,available_bytes::text,total_bytes::text,captured_at,error_code FROM app.operations_capacity_samples ORDER BY location,captured_at DESC,id DESC',
    )
  ).rows;
  const now = (await db.query<{ now: Date }>('SELECT clock_timestamp() now'))
      .rows[0]!.now,
    known = rows.filter(
      (row) =>
        row.available_bytes !== null &&
        row.error_code === null &&
        now.getTime() >= row.captured_at.getTime() &&
        now.getTime() - row.captured_at.getTime() <= thresholds.sampleMaxAgeMs,
    );
  const available = known.reduce<bigint | null>(
    (minimum, row) =>
      minimum === null || BigInt(row.available_bytes!) < minimum
        ? BigInt(row.available_bytes!)
        : minimum,
    null,
  );
  const state =
    available !== null && available < BigInt(thresholds.restrictBelowBytes)
      ? 'restricted'
      : available !== null && available < BigInt(thresholds.warnBelowBytes)
        ? 'warning'
        : known.length === 3
          ? 'healthy'
          : 'unknown';
  return {
    state,
    availableBytes: available === null ? null : available.toString(),
    locations: rows,
  };
}
export async function capacityStatus(
  db: SqlExecutor,
  policies: CapacityPolicies = capacityPolicies,
): Promise<CapacityStatus> {
  const database = db as SqlExecutor & Partial<Pick<Database, 'transaction'>>;
  if (database.transaction)
    return database.transaction((tx) => capacityStatus(tx, policies));
  return statusWithPolicy(db, await policies.read(db));
}
export async function assertTaskCapacity(
  db: SqlExecutor,
  policies: CapacityPolicies = capacityPolicies,
) {
  if ((await capacityStatus(db, policies)).state === 'restricted')
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '本机剩余空间低于当前容量策略限制，未受理新的执行/AI任务；现有结果、证据与清理仍按原规则接收。',
      503,
    );
}
export async function assertUploadCapacity(
  db: SqlExecutor,
  bytes: bigint,
  existingDelivery = false,
  trustedAdmission?: ResourcePolicySnapshot,
): Promise<void> {
  if (existingDelivery) return;
  const database = db as SqlExecutor & Partial<Pick<Database, 'transaction'>>;
  if (database.transaction)
    return database.transaction((tx) =>
      assertUploadCapacity(tx, bytes, false, trustedAdmission),
    );
  const thresholds =
    trustedAdmission?.policy.capacity ?? (await capacityPolicies.read(db));
  if (
    bytes >= BigInt(thresholds.largeUploadFromBytes) &&
    (await statusWithPolicy(db, thresholds)).state === 'restricted'
  )
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '本机空间低于当前容量策略限制，暂不接收新的大文件；已受理执行的数据交付保留。',
      503,
    );
}
export class CapacityMonitor {
  constructor(
    readonly db: Database,
    readonly paths: Partial<Record<'runtime' | 'backups' | 'objects', string>>,
    readonly probes: Partial<
      Record<
        'runtime' | 'backups' | 'objects',
        { read(): Promise<{ availableBytes: bigint; totalBytes: bigint }> }
      >
    > = {},
  ) {}
  async sample() {
    for (const location of ['runtime', 'backups', 'objects'] as const) {
      const path = this.paths[location];
      try {
        const probe = this.probes[location];
        if (!path && !probe) throw new Error('Location not mounted');
        const info = probe
          ? await probe.read()
          : await statfs(path!, { bigint: true }).then((value) => ({
              availableBytes: value.bavail * value.bsize,
              totalBytes: value.blocks * value.bsize,
            }));
        if (
          info.availableBytes < 0n ||
          info.totalBytes <= 0n ||
          info.availableBytes > info.totalBytes
        )
          throw new Error('Invalid capacity sample');
        await this.db.query(
          'INSERT INTO app.operations_capacity_samples(location,available_bytes,total_bytes) VALUES($1,$2,$3)',
          [
            location,
            info.availableBytes.toString(),
            info.totalBytes.toString(),
          ],
        );
      } catch {
        await this.db.query(
          "INSERT INTO app.operations_capacity_samples(location,error_code) VALUES($1,'CAPACITY_UNAVAILABLE')",
          [location],
        );
      }
    }
    return capacityStatus(this.db);
  }
}
/** Trusted host-only read of the existing object volume; never mounted into the business worker. */
export class DockerObjectCapacity {
  constructor(
    readonly docker: string,
    readonly container: string,
    readonly path = '/data',
  ) {
    if (
      !/^[a-zA-Z0-9_.-]+$/.test(container) ||
      !/^\/[a-zA-Z0-9_/-]+$/.test(path)
    )
      throw new Error('Invalid fixed object capacity adapter configuration');
  }
  async read(): Promise<{ availableBytes: bigint; totalBytes: bigint }> {
    return new Promise((done, reject) => {
      const child = spawn(
        this.docker,
        ['exec', this.container, 'df', '-Pk', this.path],
        {
          windowsHide: true,
          shell: false,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      let output = '',
        failed = false;
      const timer = setTimeout(() => {
        failed = true;
        child.kill();
      }, 5000);
      timer.unref();
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
        if (output.length > 8192) {
          failed = true;
          child.kill();
        }
      });
      const fail = () => new Error('Object capacity sample unavailable');
      child.once('error', () => {
        clearTimeout(timer);
        reject(fail());
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        const line = output.trim().split(/\r?\n/).at(-1) ?? '',
          match = /^\S+\s+(\d+)\s+\d+\s+(\d+)\s+\d+%\s+\S+$/.exec(line);
        if (failed || code !== 0 || !match?.[1] || !match[2]) {
          reject(fail());
          return;
        }
        done({
          totalBytes: BigInt(match[1]) * 1024n,
          availableBytes: BigInt(match[2]) * 1024n,
        });
      });
    });
  }
}
