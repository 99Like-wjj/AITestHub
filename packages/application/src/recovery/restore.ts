import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { Readable } from 'node:stream';
import type { Database } from '../../../persistence/src/database.js';
import type { StoragePort } from '../../../storage/src/port.js';
import { DomainError } from '../errors.js';
import { SecretBroker } from '../configuration/secrets.js';
import { TestConfigurationService } from '../test-configuration/service.js';
import { PlanService } from '../plans/service.js';
import { ApiExecutionControlService } from '../api-execution/control.js';
import { BackupFiles, type BackupManifest } from './backup-files.js';
import { ControlJournal } from './control-journal.js';
import { applyLatestSecurity } from './reapply.js';
import { FileGarbageCollector } from './garbage.js';
import { prepareLegacyModelUpgradeFromControls } from '../configuration/restore-upgrade.js';

export interface IsolatedRestorePort {
  id: string;
  db: Database;
  storage: StoragePort;
  assertFresh(): Promise<void>;
  restoreDatabase(input: Readable): Promise<void>;
  migrate(): Promise<void>;
  initializeNamespace(
    platformId: string,
    masterFingerprint: string,
  ): Promise<unknown>;
}
const blocked = (
  message = '隔离恢复校验未通过，目标保持不可读，不切换主库。',
) => new DomainError('DEPENDENCY_UNAVAILABLE', message, 503);
export async function verifyApprovedMigrations(
  migrations: { version: string; checksum: string }[],
  directory = resolve('packages/persistence/migrations'),
) {
  for (const migration of migrations) {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(migration.version)) throw blocked();
    let bytes: Buffer;
    try {
      bytes = await readFile(join(directory, migration.version));
    } catch {
      throw blocked(
        '当前应用缺少备份/最新控制所需的批准迁移，请先使用匹配版本；未尝试导入。',
      );
    }
    if (createHash('sha256').update(bytes).digest('hex') !== migration.checksum)
      throw blocked('迁移字节与归档不一致，未用不同模式解释历史。');
  }
}
export class ProductRestoreService {
  constructor(
    readonly files: BackupFiles,
    readonly controls: ControlJournal,
    private readonly platformMasterFingerprint: string,
    readonly migrationDirectory = resolve('packages/persistence/migrations'),
    readonly brokerEnvironment: NodeJS.ProcessEnv = process.env,
  ) {}
  private async latest(manifest: BackupManifest) {
    const latest = await this.controls.latest(),
      committed = latest.head.committed;
    if (
      !committed ||
      latest.head.platformId !== manifest.platformId ||
      committed.sequence < manifest.controls.sequence ||
      (committed.sequence === manifest.controls.sequence &&
        committed.stateDigest !== manifest.controls.stateDigest)
    )
      throw blocked('独立最新控制水位缺失或不属于该平台，不能开放旧个人内容。');
    if (
      latest.state.platformMasterFingerprint !== this.platformMasterFingerprint
    )
      throw blocked('最新密文配置所需平台密钥不匹配，目标保持隔离。');
    await verifyApprovedMigrations(
      latest.state.migrations,
      this.migrationDirectory,
    );
    return latest;
  }
  async restore(backupId: string, target: IsolatedRestorePort) {
    const manifest = await this.files.read(backupId);
    await this.files.verify(manifest);
    await verifyApprovedMigrations(
      manifest.versions.migrations,
      this.migrationDirectory,
    );
    let latest = await this.latest(manifest);
    await target.assertFresh();
    await target.restoreDatabase(
      await this.files.databaseStream(backupId, manifest.database),
    );
    if (
      latest.state.migrations.some(
        (row) => row.version === '0035_model_protocols.sql',
      )
    ) {
      await target.db.query(
        "UPDATE app.maintenance_state SET phase='restoreQuarantine',operation_id=$1,reason='ISOLATED_MODEL_SCHEMA_PREPARATION',started_at=clock_timestamp(),updated_at=clock_timestamp() WHERE singleton",
        [target.id],
      );
      await prepareLegacyModelUpgradeFromControls(
        target.db,
        this.controls,
        manifest.platformId,
      );
    }
    await target.migrate();
    await target.db.query(
      "UPDATE app.maintenance_state SET phase='restoreQuarantine',operation_id=$1,reason='ISOLATED_RESTORE_VALIDATION',started_at=clock_timestamp(),updated_at=clock_timestamp() WHERE singleton",
      [target.id],
    );
    await target.db.query(
      "INSERT INTO app.product_restore_checks(id,backup_id,state) VALUES($1,$2,'verifying')",
      [target.id, backupId],
    );
    let copied = 0;
    const restoredObjects = new Set<string>();
    try {
      let verified = false,
        securityResult:
          Awaited<ReturnType<typeof applyLatestSecurity>> | undefined;
      for (let pass = 0; pass < 4; pass++) {
        await target.db.transaction((tx) =>
          applyLatestSecurity(tx, latest.state, { runtimeSafety: false }),
        );
        // Projection from old receipts/intent only. No bootstrap, grant claim or HTTP/SQL business send is invoked.
        const broker = await SecretBroker.fromEnvironment(
            target.db,
            this.brokerEnvironment,
          ),
          configurations = new TestConfigurationService(target.db, broker),
          plans = new PlanService(target.db, configurations);
        await target.db.query(
          'UPDATE app.api_worker_grants SET expires_at=clock_timestamp() WHERE revoked_at IS NULL',
        );
        await new ApiExecutionControlService(
          target.db,
          plans,
          broker,
          '0'.repeat(64),
        ).reconcileExpired();
        securityResult = await target.db.transaction((tx) =>
          applyLatestSecurity(tx, latest.state),
        );
        await new FileGarbageCollector(target.db, target.storage).plan(true);
        for (const object of manifest.objects) {
          const resourceIds = manifest.resources
            .filter((resource) => resource.objectId === object.id)
            .map((resource) => resource.id);
          const needed = (
            await target.db.query(
              "SELECT 1 FROM app.file_resources WHERE id=ANY($1::uuid[]) AND status='verified' AND deleted_at IS NULL LIMIT 1",
              [resourceIds],
            )
          ).rowCount;
          if (!needed) {
            if (restoredObjects.has(object.id)) {
              await target.storage.delete(object.storageKey);
              if (
                !target.storage.exists ||
                (await target.storage.exists(object.storageKey))
              )
                throw blocked('最新删除对象尚未证实回收，目标继续隔离。');
              restoredObjects.delete(object.id);
            }
            continue;
          }
          if (!restoredObjects.has(object.id)) {
            await target.storage.put(
              object.storageKey,
              await this.files.objectStream(backupId, object.id, object.sealed),
              object.sealed.plaintextBytes,
              object.mediaType,
            );
            restoredObjects.add(object.id);
            copied++;
          }
          const body = await target.storage.get(object.storageKey),
            hash = createHash('sha256');
          let bytes = 0;
          try {
            for await (const chunk of body) {
              bytes += chunk.length;
              hash.update(chunk);
            }
          } finally {
            body.destroy();
          }
          if (
            bytes !== object.sealed.plaintextBytes ||
            hash.digest('hex') !== object.sealed.plaintextSha256
          )
            throw blocked(
              '恢复对象实际字节/hash不匹配，未相信数据库verified标记。',
            );
        }
        const current = await this.latest(manifest);
        if (current.head.committed!.id === latest.head.committed!.id) {
          verified = true;
          break;
        }
        latest = current;
      }
      if (!verified)
        throw blocked(
          '安全控制在校验期间持续变化，请在明确窗口重新核对；未开放目标。',
        );
      await new FileGarbageCollector(target.db, target.storage).collect(
        100,
        true,
      );
      const count = Number(
        (
          await target.db.query<{ count: string }>(
            "SELECT count(*)::text count FROM app.file_resources WHERE status='verified' AND deleted_at IS NULL",
          )
        ).rows[0]!.count,
      );
      const included = new Set(
        manifest.resources.map((resource) => resource.id),
      );
      const active = await target.db.query<{ id: string }>(
        "SELECT id FROM app.file_resources WHERE status='verified' AND deleted_at IS NULL",
      );
      if (active.rows.some((row) => !included.has(row.id)))
        throw blocked('恢复库有不在有效对象清单中的verified资源，未标完整。');
      const platformId = randomUUID();
      await target.db.transaction(async (tx) => {
        await tx.query(
          'UPDATE app.recovery_control_state SET platform_id=$1,control_sequence=0,state_digest=NULL,updated_at=clock_timestamp() WHERE singleton',
          [platformId],
        );
        await tx.query(
          "UPDATE app.product_backups SET state='failed',error_code='RESTORED_HISTORY_NOT_REPLAYED' WHERE state IN ('queued','preparing')",
        );
      });
      const namespace = await target.initializeNamespace(
        platformId,
        this.platformMasterFingerprint,
      );
      await target.db.transaction(async (tx) => {
        await tx.query(
          "UPDATE app.product_restore_checks SET state='verified',control_sequence=$2,checked_objects=$3,details=$4,finished_at=clock_timestamp() WHERE id=$1",
          [
            target.id,
            latest.head.committed!.sequence,
            restoredObjects.size,
            JSON.stringify({
              sourcePlatformId: manifest.platformId,
              isolatedPlatformId: platformId,
              resourceCount: count,
              ...securityResult,
            }),
          ],
        );
        await tx.query(
          "UPDATE app.maintenance_state SET phase='readOnly',reason='ISOLATED_RESTORE_VERIFIED_READ_ONLY',updated_at=clock_timestamp() WHERE singleton",
        );
      });
      return {
        restoreId: target.id,
        backupId,
        state: 'verified' as const,
        mode: 'readOnly' as const,
        checkedObjects: restoredObjects.size,
        copiedObjects: copied,
        controlSequence: latest.head.committed!.sequence,
        namespace,
      };
    } catch (error: unknown) {
      await target.db
        .query(
          "UPDATE app.product_restore_checks SET state='quarantined',error_code=$2,finished_at=clock_timestamp() WHERE id=$1",
          [
            target.id,
            error instanceof DomainError ? error.code : 'RESTORE_FAILED',
          ],
        )
        .catch(() => {});
      throw error instanceof DomainError ? error : blocked();
    }
  }
}
