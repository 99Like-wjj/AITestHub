import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ActorContext } from '../../../contracts/src/identity.js';
import * as contracts from '../../../contracts/src/model-configuration-v2.js';
import {
  modelVerificationChecksSchema,
  modelVerificationSchema,
} from '../../../contracts/src/configuration.js';
import type {
  ModelProtocol,
  ModelAuthScheme,
} from '../../../contracts/src/model-protocol.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { currentUser, requirePlatformAdmin } from '../access/policy.js';
import { DomainError, stale } from '../errors.js';
import { audit } from '../events.js';
import {
  canonicalJson,
  OperationService,
  operationRequestHash,
} from '../operations/service.js';
import { recordOperationFence } from '../recovery/fences.js';
import { assertSafeModelInput } from '../security/model-input.js';
import { SecretBroker } from './secrets.js';
import type { RuntimeModelSelectionV2 } from './model-selection.js';

const migration = '0035_model_protocols.sql';
const unverified = { status: 'unverified', checkedAt: null, checks: {} };
const binding = (id: string) => ({
  ownerScope: 'platform' as const,
  ownerId: id,
  purpose: 'model-api-key',
});
const savedSnapshot = z.strictObject({
  schemaVersion: z.literal('ath.model-service.v2'),
  provenance: z.record(z.string(), z.json()),
  credentialRef: z.uuid().nullable(),
  modelService: contracts.modelServiceV2Schema,
});
const unavailable = () =>
  new DomainError(
    'DEPENDENCY_UNAVAILABLE',
    '模型多协议/多模型迁移或完整映射尚未就绪。',
    503,
  );
type ServiceRow = {
  id: string;
  name: string;
  note: string;
  protocol: ModelProtocol;
  auth_scheme: ModelAuthScheme;
  base_url: string;
  enabled: boolean;
  removed_at: Date | null;
  access_policy: 'restricted' | 'allActive';
  allowed_data_scopes: ('syntheticPublicOnly' | 'authorizedRelevantTestData')[];
  credential_ref: string | null;
  has_credential: boolean;
  row_version: number;
  config_revision: number;
};
type EntryRow = {
  id: string;
  model_service_id: string;
  display_name: string;
  model_id: string;
  enabled: boolean;
  removed_at: Date | null;
  context_limit: string | null;
  effort_values: string[];
  default_effort: string | null;
  max_output: string | null;
  verification: unknown;
  position: number;
};

/** Transport is injected only by trusted server composition, never by model/user arguments. */
export interface ModelDiscoveryPort {
  discover(input: {
    protocol: ModelProtocol;
    authScheme: ModelAuthScheme;
    baseUrl: string;
    credential: () => Promise<string>;
  }): Promise<{
    models: { modelId: string; displayName: string | null }[];
  }>;
}

export class ModelConfigurationV2Service {
  readonly operations: OperationService;
  constructor(
    readonly db: Database,
    private readonly broker: SecretBroker,
    private readonly discovery?: ModelDiscoveryPort,
  ) {
    this.operations = new OperationService(db);
  }
  async ready(tx: SqlExecutor) {
    const row = (
      await tx.query<{ ready: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM app.schema_migrations WHERE version=$1)
      AND to_regclass('app.model_entries') IS NOT NULL AND to_regclass('app.model_legacy_bindings') IS NOT NULL
      AND to_regclass('app.model_entry_verifications') IS NOT NULL
      AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='app.model_services'::regclass AND attname='protocol' AND NOT attisdropped)
      AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='app.auxiliary_model_configuration'::regclass AND attname='model_entry_id' AND NOT attisdropped) ready`,
        [migration],
      )
    ).rows[0];
    if (!row?.ready) throw unavailable();
  }
  private async admin(tx: SqlExecutor, actor: ActorContext) {
    await requirePlatformAdmin(tx, actor);
    await this.ready(tx);
  }
  private async row(
    tx: SqlExecutor,
    id: string,
    lock: 'share' | 'update' = 'share',
  ) {
    const row = (
      await tx.query<ServiceRow>(
        `SELECT m.*,EXISTS(SELECT 1 FROM app.secret_records s WHERE s.id=m.credential_ref AND s.revoked_at IS NULL
        AND s.owner_scope='platform' AND s.owner_id=m.id AND s.purpose='model-api-key') has_credential
      FROM app.model_services m WHERE m.id=$1 FOR ${lock === 'update' ? 'UPDATE' : 'SHARE'} OF m`,
        [id],
      )
    ).rows[0];
    if (!row) throw new DomainError('NOT_FOUND', '模型服务不存在。', 404);
    return row;
  }
  private entries(tx: SqlExecutor, id: string) {
    return tx.query<EntryRow>(
      'SELECT * FROM app.model_entries WHERE model_service_id=$1 ORDER BY position,id FOR SHARE',
      [id],
    );
  }
  async dto(
    tx: SqlExecutor,
    row: ServiceRow,
  ): Promise<contracts.ModelServiceV2> {
    const entries = await this.entries(tx, row.id),
      grants = await tx.query<{ user_id: string }>(
        'SELECT user_id FROM app.model_grants WHERE model_service_id=$1 ORDER BY user_id',
        [row.id],
      );
    return contracts.modelServiceV2Schema.parse({
      id: row.id,
      name: row.name,
      note: row.note,
      protocol: row.protocol,
      authScheme: row.auth_scheme,
      baseUrl: row.base_url,
      enabled: row.enabled,
      removedAt: row.removed_at?.toISOString() ?? null,
      accessPolicy: row.access_policy,
      allowedUserIds: grants.rows.map((g) => g.user_id),
      allowedDataScopes: row.allowed_data_scopes,
      hasCredential: row.has_credential,
      rowVersion: row.row_version,
      serviceRevision: row.config_revision,
      models: entries.rows.map((entry) => ({
        id: entry.id,
        displayName: entry.display_name,
        modelId: entry.model_id,
        enabled: entry.enabled,
        removedAt: entry.removed_at?.toISOString() ?? null,
        contextLimit:
          entry.context_limit === null ? null : Number(entry.context_limit),
        effortValues: entry.effort_values,
        defaultEffort: entry.default_effort,
        maxOutput: entry.max_output === null ? null : Number(entry.max_output),
        verification: entry.verification,
      })),
    });
  }
  private active(row: ServiceRow) {
    if (row.removed_at)
      throw new DomainError(
        'MODEL_NOT_CONFIGURED',
        '模型服务已移除，不能重新选择或发送。',
        422,
      );
  }
  private async snapshot(
    tx: SqlExecutor,
    actor: ActorContext,
    id: string,
    provenance: Record<string, z.infer<ReturnType<typeof z.json>>>,
  ) {
    const row = await this.row(tx, id),
      modelService = await this.dto(tx, row);
    await tx.query(
      'INSERT INTO app.model_service_revisions(model_service_id,revision,snapshot,created_by) VALUES($1,$2,$3,$4)',
      [
        id,
        row.config_revision,
        {
          schemaVersion: 'ath.model-service.v2',
          provenance,
          credentialRef: row.credential_ref,
          modelService,
        },
        actor.userId,
      ],
    );
    await audit(tx, actor, 'configuration.model-updated', id, null, {
      protocol: row.protocol,
      serviceRevision: row.config_revision,
      enabled: row.enabled,
      removed: row.removed_at !== null,
      hasCredential: row.has_credential,
    });
    return { modelService };
  }
  private async write<T>(
    actor: ActorContext,
    operation: string,
    key: string,
    input: unknown,
    work: (tx: SqlExecutor) => Promise<T>,
  ) {
    return this.operations.execute(
      actor,
      operation,
      key,
      input,
      (tx) => this.admin(tx, actor),
      async (tx) => {
        const result = await work(tx),
          command = (
            await tx.query<{ id: string }>(
              'SELECT id FROM app.commands WHERE actor_id=$1 AND operation=$2 AND key=$3',
              [actor.userId, operation, key],
            )
          ).rows[0];
        if (!command) throw unavailable();
        await recordOperationFence(tx, {
          actorId: actor.userId,
          operation,
          key,
          requestHash: operationRequestHash(input),
          commandId: command.id,
          projectId: null,
        });
        return result;
      },
    );
  }
  private async validateUsers(tx: SqlExecutor, ids: string[]) {
    if (!ids.length) return;
    const users = await tx.query(
      'SELECT id FROM app.users WHERE id=ANY($1::uuid[]) AND active ORDER BY id FOR SHARE',
      [ids],
    );
    if (users.rowCount !== ids.length)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '开放清单包含失效账号。',
        422,
      );
  }
  private async grants(tx: SqlExecutor, id: string, ids: string[]) {
    await this.validateUsers(tx, ids);
    await tx.query('DELETE FROM app.model_grants WHERE model_service_id=$1', [
      id,
    ]);
    for (const user of ids)
      await tx.query(
        'INSERT INTO app.model_grants(model_service_id,user_id) VALUES($1,$2)',
        [id, user],
      );
  }
  private async insertEntry(
    tx: SqlExecutor,
    id: string,
    input: contracts.ModelServiceCreateV2['models'][number],
    position: number,
  ) {
    const found = (
      await tx.query<{ model_service_id: string }>(
        'SELECT model_service_id FROM app.model_entries WHERE id=$1',
        [input.id],
      )
    ).rows[0];
    if (found)
      throw new DomainError(
        'IDEMPOTENCY_CONFLICT',
        '稳定模型行ID已被使用，不按名称合并。',
        409,
      );
    await tx.query(
      `INSERT INTO app.model_entries(id,model_service_id,display_name,model_id,enabled,position,context_limit,effort_values,default_effort,max_output)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        input.id,
        id,
        input.displayName,
        input.modelId,
        input.enabled,
        position,
        input.contextLimit,
        input.effortValues,
        input.defaultEffort,
        input.maxOutput,
      ],
    );
  }
  async adminList(actor: ActorContext) {
    return this.db.transaction(async (tx) => {
      await this.admin(tx, actor);
      const rows = await tx.query<{ id: string }>(
        'SELECT id FROM app.model_services ORDER BY created_at,id',
      );
      const services = [];
      for (const row of rows.rows)
        services.push(await this.dto(tx, await this.row(tx, row.id)));
      return { services };
    });
  }
  async available(actor: ActorContext) {
    return this.db.transaction(async (tx) => {
      await currentUser(tx, actor);
      await this.ready(tx);
      const rows = await tx.query<{ id: string }>(
        `SELECT m.id FROM app.model_services m WHERE m.enabled AND m.removed_at IS NULL
      AND(m.access_policy='allActive' OR EXISTS(SELECT 1 FROM app.model_grants g WHERE g.model_service_id=m.id AND g.user_id=$1)) ORDER BY m.created_at,m.id`,
        [actor.userId],
      );
      const models: contracts.AvailableModelV2[] = [];
      for (const row of rows.rows) {
        const service = await this.dto(tx, await this.row(tx, row.id));
        for (const entry of service.models)
          if (entry.enabled && entry.removedAt === null) {
            const {
              id,
              enabled: _enabled,
              removedAt: _removed,
              ...model
            } = entry;
            models.push(
              contracts.availableModelV2Schema.parse({
                ...model,
                modelServiceId: service.id,
                modelEntryId: id,
                serviceRevision: service.serviceRevision,
                serviceName: service.name,
                protocol: service.protocol,
                baseUrl: service.baseUrl,
                allowedDataScopes: service.allowedDataScopes,
                available: service.hasCredential,
                unavailableReason: service.hasCredential
                  ? null
                  : 'credentialMissing',
              }),
            );
          }
      }
      return { models };
    });
  }
  async create(actor: ActorContext, raw: unknown) {
    const input = contracts.modelServiceCreateV2Schema.parse(raw);
    return this.write(
      actor,
      'configuration.model-create',
      input.commandId,
      input,
      async (tx) => {
        if (
          (
            await tx.query('SELECT 1 FROM app.model_services WHERE id=$1', [
              input.id,
            ])
          ).rowCount
        )
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            '稳定服务ID已存在，请查询原回执。',
            409,
          );
        await tx.query(
          `INSERT INTO app.model_services(id,name,note,protocol,base_url,auth_scheme,enabled,access_policy,allowed_data_scopes,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            input.id,
            input.name,
            input.note,
            input.protocol,
            input.baseUrl.replace(/\/+$/, ''),
            input.authScheme,
            input.enabled,
            input.accessPolicy,
            input.allowedDataScopes,
            actor.userId,
          ],
        );
        await this.grants(tx, input.id, input.allowedUserIds);
        for (const [position, entry] of input.models.entries())
          await this.insertEntry(tx, input.id, entry, position);
        return this.snapshot(tx, actor, input.id, {
          kind: 'administratorSave',
          commandId: input.commandId,
        });
      },
    );
  }
  async update(actor: ActorContext, id: string, raw: unknown) {
    const input = contracts.modelServiceUpdateV2Schema.parse(raw);
    return this.write(
      actor,
      'configuration.model-update',
      input.commandId,
      { id, ...input },
      async (tx) => {
        const current = await this.row(tx, id, 'update');
        this.active(current);
        if (current.row_version !== input.rowVersion) stale();
        const endpoint = input.baseUrl.replace(/\/+$/, '');
        if (
          current.credential_ref &&
          (current.protocol !== input.protocol ||
            current.base_url !== endpoint ||
            current.auth_scheme !== input.authScheme)
        )
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '目的地址、协议或鉴权方式变化前请明确撤销旧Key，再安全配置新Key。',
            422,
          );
        const existing = (await this.entries(tx, id)).rows,
          kept = new Set(input.models.map((e) => e.id)),
          removed = new Set(input.removedModelEntryIds);
        if (
          existing.some(
            (e) =>
              e.removed_at === null && !kept.has(e.id) && !removed.has(e.id),
          ) ||
          input.removedModelEntryIds.some(
            (entry) =>
              !existing.some((e) => e.id === entry && e.removed_at === null),
          )
        )
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '现有模型行须明确保留或按稳定ID移除，缺席不会隐式删除。',
            422,
          );
        for (const [position, entry] of input.models.entries()) {
          const old = existing.find((e) => e.id === entry.id);
          if (old?.removed_at)
            throw new DomainError(
              'PRECONDITIONS_MISSING',
              '已移除模型行不能复活；请使用新的稳定ID。',
              422,
            );
          if (!old) await this.insertEntry(tx, id, entry, position);
          else
            await tx.query(
              `UPDATE app.model_entries SET display_name=$2,model_id=$3,enabled=$4,position=$5,context_limit=$6,effort_values=$7,default_effort=$8,max_output=$9,verification=$10,updated_at=clock_timestamp() WHERE id=$1`,
              [
                entry.id,
                entry.displayName,
                entry.modelId,
                entry.enabled,
                position,
                entry.contextLimit,
                entry.effortValues,
                entry.defaultEffort,
                entry.maxOutput,
                unverified,
              ],
            );
        }
        await tx.query(
          'UPDATE app.model_entries SET removed_at=clock_timestamp(),enabled=false WHERE model_service_id=$1 AND id=ANY($2::uuid[])',
          [id, input.removedModelEntryIds],
        );
        await tx.query(
          `UPDATE app.model_services SET name=$2,note=$3,protocol=$4,base_url=$5,auth_scheme=$6,enabled=$7,access_policy=$8,allowed_data_scopes=$9,
        config_revision=config_revision+1,row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1`,
          [
            id,
            input.name,
            input.note,
            input.protocol,
            endpoint,
            input.authScheme,
            input.enabled,
            input.accessPolicy,
            input.allowedDataScopes,
          ],
        );
        await this.grants(tx, id, input.allowedUserIds);
        return this.snapshot(tx, actor, id, {
          kind: 'administratorSave',
          commandId: input.commandId,
        });
      },
    );
  }
  async remove(actor: ActorContext, id: string, raw: unknown) {
    const input = contracts.modelServiceCasV2Schema.parse(raw);
    return this.write(
      actor,
      'configuration.model-remove',
      input.commandId,
      { id, ...input },
      async (tx) => {
        const current = await this.row(tx, id, 'update');
        if (current.row_version !== input.rowVersion) stale();
        this.active(current);
        if (current.credential_ref)
          await this.broker.revoke(tx, current.credential_ref, binding(id));
        await tx.query(
          'UPDATE app.model_services SET removed_at=clock_timestamp(),removed_by=$2,enabled=false,credential_ref=NULL,config_revision=config_revision+1,row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1',
          [id, actor.userId],
        );
        return this.snapshot(tx, actor, id, {
          kind: 'logicalRemoval',
          commandId: input.commandId,
        });
      },
    );
  }
  async setCredential(actor: ActorContext, id: string, raw: unknown) {
    const input = contracts.modelCredentialV2Schema.parse(raw),
      safe = {
        id,
        commandId: input.commandId,
        rowVersion: input.rowVersion,
        credentialDigest: this.broker.fingerprint(
          input.credential,
          binding(id),
        ),
      };
    return this.write(
      actor,
      'configuration.model-credential-set',
      input.commandId,
      safe,
      async (tx) => {
        const row = await this.row(tx, id, 'update');
        this.active(row);
        if (row.row_version !== input.rowVersion) stale();
        const ref = await this.broker.store(tx, input.credential, binding(id));
        if (row.credential_ref)
          await this.broker.revoke(tx, row.credential_ref, binding(id));
        await tx.query(
          'UPDATE app.model_services SET credential_ref=$2,config_revision=config_revision+1,row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1',
          [id, ref],
        );
        await tx.query(
          'UPDATE app.model_entries SET verification=$2 WHERE model_service_id=$1',
          [id, unverified],
        );
        return this.snapshot(tx, actor, id, {
          kind: 'credentialReplacement',
          commandId: input.commandId,
        });
      },
    );
  }
  async revokeCredential(actor: ActorContext, id: string, raw: unknown) {
    const input = contracts.modelServiceCasV2Schema.parse(raw);
    return this.write(
      actor,
      'configuration.model-credential-revoke',
      input.commandId,
      { id, ...input },
      async (tx) => {
        const row = await this.row(tx, id, 'update');
        this.active(row);
        if (row.row_version !== input.rowVersion) stale();
        if (row.credential_ref)
          await this.broker.revoke(tx, row.credential_ref, binding(id));
        await tx.query(
          'UPDATE app.model_services SET credential_ref=NULL,config_revision=config_revision+1,row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1',
          [id],
        );
        await tx.query(
          'UPDATE app.model_entries SET verification=$2 WHERE model_service_id=$1',
          [id, unverified],
        );
        return this.snapshot(tx, actor, id, {
          kind: 'credentialRevocation',
          commandId: input.commandId,
        });
      },
    );
  }
  async resolveInTransaction(
    tx: SqlExecutor,
    actor: ActorContext,
    raw: unknown,
    auxiliary = false,
  ): Promise<RuntimeModelSelectionV2> {
    const input = contracts.modelSelectionV2Schema.parse(raw);
    await currentUser(tx, actor);
    await this.ready(tx);
    const row = await this.row(tx, input.modelServiceId);
    this.active(row);
    if (
      !auxiliary &&
      row.access_policy !== 'allActive' &&
      !(
        await tx.query(
          'SELECT 1 FROM app.model_grants WHERE model_service_id=$1 AND user_id=$2',
          [row.id, actor.userId],
        )
      ).rowCount
    )
      throw new DomainError('FORBIDDEN', '当前账号没有此模型的使用权限。', 403);
    if (row.config_revision !== input.serviceRevision) stale();
    const record = (
      await tx.query<{ snapshot: unknown }>(
        'SELECT snapshot FROM app.model_service_revisions WHERE model_service_id=$1 AND revision=$2',
        [row.id, input.serviceRevision],
      )
    ).rows[0];
    const frozen = savedSnapshot.safeParse(record?.snapshot);
    if (!frozen.success) throw unavailable();
    const model = frozen.data.modelService.models.find(
        (entry) => entry.id === input.modelEntryId,
      ),
      entry = (await this.entries(tx, row.id)).rows.find(
        (e) => e.id === input.modelEntryId,
      );
    if (!model || !entry)
      throw new DomainError('NOT_FOUND', '指定模型行不属于此服务。', 404);
    if (
      !row.enabled ||
      !row.has_credential ||
      !row.credential_ref ||
      !model.enabled ||
      model.removedAt ||
      !entry.enabled ||
      entry.removed_at
    )
      throw new DomainError(
        'MODEL_NOT_CONFIGURED',
        '模型、服务或凭据已失效；不会自动选择其他模型。',
        422,
      );
    if (
      model.modelId !== entry.model_id ||
      model.displayName !== entry.display_name ||
      model.contextLimit !==
        (entry.context_limit === null ? null : Number(entry.context_limit)) ||
      model.maxOutput !==
        (entry.max_output === null ? null : Number(entry.max_output)) ||
      model.defaultEffort !== entry.default_effort ||
      canonicalJson(model.effortValues) !==
        canonicalJson(entry.effort_values) ||
      frozen.data.credentialRef !== row.credential_ref ||
      frozen.data.modelService.protocol !== row.protocol ||
      frozen.data.modelService.authScheme !== row.auth_scheme ||
      frozen.data.modelService.baseUrl !== row.base_url ||
      frozen.data.modelService.rowVersion !== row.row_version ||
      frozen.data.modelService.name !== row.name ||
      frozen.data.modelService.note !== row.note ||
      frozen.data.modelService.enabled !== row.enabled ||
      frozen.data.modelService.accessPolicy !== row.access_policy ||
      canonicalJson(frozen.data.modelService.allowedDataScopes) !==
        canonicalJson(row.allowed_data_scopes) ||
      frozen.data.modelService.id !== row.id ||
      frozen.data.modelService.serviceRevision !== row.config_revision
    )
      throw unavailable();
    const effort =
      input.effort === undefined ? model.defaultEffort : input.effort;
    if (effort !== null && !model.effortValues.includes(effort))
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '所选模型行未配置此思考强度。',
        422,
      );
    return {
      runtimeVersion: 'ath.model-selection.v2',
      modelServiceId: row.id,
      modelEntryId: entry.id,
      serviceRevision: row.config_revision,
      configRevision: row.config_revision,
      serviceName: frozen.data.modelService.name,
      modelDisplayName: model.displayName,
      protocol: frozen.data.modelService.protocol,
      authScheme: frozen.data.modelService.authScheme,
      baseUrl: frozen.data.modelService.baseUrl,
      modelId: model.modelId,
      effort,
      contextLimit: model.contextLimit,
      maxOutput: model.maxOutput,
      credentialRef: row.credential_ref,
      allowedDataScope: 'syntheticPublicOnly',
      allowedDataScopes: row.allowed_data_scopes,
    };
  }
  resolve(actor: ActorContext, raw: unknown) {
    return this.db.transaction((tx) =>
      this.resolveInTransaction(tx, actor, raw),
    );
  }
  async getAuxiliary(actor: ActorContext) {
    return this.db.transaction(async (tx) => {
      await this.admin(tx, actor);
      const row = (
        await tx.query<{
          model_service_id: string | null;
          model_entry_id: string | null;
          enabled: boolean;
          effort: string | null;
          row_version: number;
        }>('SELECT * FROM app.auxiliary_model_configuration WHERE singleton')
      ).rows[0];
      return {
        auxiliary: row
          ? {
              modelServiceId: row.model_service_id,
              modelEntryId: row.model_entry_id,
              enabled: row.enabled,
              effort: row.effort,
              rowVersion: row.row_version,
            }
          : {
              modelServiceId: null,
              modelEntryId: null,
              enabled: false,
              effort: null,
              rowVersion: 0,
            },
      };
    });
  }
  async setAuxiliary(actor: ActorContext, raw: unknown) {
    const input = contracts.auxiliaryModelInputV2Schema.parse(raw);
    return this.write(
      actor,
      'configuration.model-auxiliary-set',
      input.commandId,
      input,
      async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(415948009)');
        const old = (
          await tx.query<{ row_version: number }>(
            'SELECT row_version FROM app.auxiliary_model_configuration WHERE singleton FOR UPDATE',
          )
        ).rows[0];
        if ((old?.row_version ?? 0) !== input.rowVersion) stale();
        if (input.modelServiceId && input.modelEntryId) {
          const row = await this.row(tx, input.modelServiceId, 'update');
          if (
            !(await this.entries(tx, row.id)).rows.some(
              (e) => e.id === input.modelEntryId,
            )
          )
            throw new DomainError('NOT_FOUND', '模型行不属于指定服务。', 404);
          if (input.enabled)
            await this.resolveInTransaction(
              tx,
              actor,
              {
                modelServiceId: row.id,
                modelEntryId: input.modelEntryId,
                serviceRevision: row.config_revision,
                effort: input.effort,
              },
              true,
            );
        }
        await tx.query(
          `INSERT INTO app.auxiliary_model_configuration(singleton,model_service_id,model_entry_id,enabled,effort,updated_by) VALUES(true,$1,$2,$3,$4,$5)
        ON CONFLICT(singleton) DO UPDATE SET model_service_id=EXCLUDED.model_service_id,model_entry_id=EXCLUDED.model_entry_id,enabled=EXCLUDED.enabled,effort=EXCLUDED.effort,
        row_version=auxiliary_model_configuration.row_version+1,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()`,
          [
            input.modelServiceId,
            input.modelEntryId,
            input.enabled,
            input.effort,
            actor.userId,
          ],
        );
        await audit(
          tx,
          actor,
          'configuration.auxiliary-updated',
          input.modelServiceId ?? actor.userId,
          null,
          { enabled: input.enabled, modelEntryId: input.modelEntryId },
        );
        return {
          auxiliary: {
            modelServiceId: input.modelServiceId,
            modelEntryId: input.modelEntryId,
            enabled: input.enabled,
            effort: input.effort,
            rowVersion: input.rowVersion + 1,
          },
        };
      },
    );
  }
  async resolveAuxiliaryInTransaction(tx: SqlExecutor, actor: ActorContext) {
    await currentUser(tx, actor);
    await this.ready(tx);
    const row = (
      await tx.query<{
        model_service_id: string | null;
        model_entry_id: string | null;
        enabled: boolean;
        effort: string | null;
      }>(
        'SELECT * FROM app.auxiliary_model_configuration WHERE singleton FOR SHARE',
      )
    ).rows[0];
    if (!row?.enabled || !row.model_service_id || !row.model_entry_id)
      throw new DomainError(
        'MODEL_NOT_CONFIGURED',
        '系统辅助模型未配置或已停用；不会借用聊天模型。',
        422,
      );
    const service = await this.row(tx, row.model_service_id);
    return this.resolveInTransaction(
      tx,
      actor,
      {
        modelServiceId: service.id,
        modelEntryId: row.model_entry_id,
        serviceRevision: service.config_revision,
        effort: row.effort,
      },
      true,
    );
  }
  async commandReceipt(actor: ActorContext, key: string) {
    return this.db.transaction(async (tx) => {
      await this.admin(tx, actor);
      const rows = await tx.query<{
        operation: string;
        status: string;
        response: unknown;
      }>(
        "SELECT operation,status,response FROM app.commands WHERE actor_id=$1 AND key=$2 AND operation LIKE 'configuration.model-%'",
        [actor.userId, key],
      );
      if (rows.rows.length > 1)
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '此标识对应多个配置意图，请按原操作核对。',
          409,
        );
      const row = rows.rows[0];
      if (!row) {
        const fences = (
          await tx.query<{ operation: string }>(
            "SELECT operation FROM app.recovery_operation_fences WHERE actor_id=$1 AND key=$2 AND operation LIKE 'configuration.model-%'",
            [actor.userId, key],
          )
        ).rows;
        if (fences.length > 1)
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '此标识对应多个配置意图，请按原操作核对。',
            409,
          );
        const fence = fences[0];
        if (fence)
          return {
            commandId: key,
            operation: fence.operation,
            status: 'unknown' as const,
            response: null,
          };
        throw new DomainError(
          'NOT_FOUND',
          '尚无此配置意图回执，不能据此断言未执行。',
          404,
        );
      }
      return contracts.modelConfigurationCommandV2Schema.parse({
        commandId: key,
        operation: row.operation,
        status: row.status === 'completed' ? 'succeeded' : 'unknown',
        response: row.status === 'completed' ? row.response : null,
      });
    });
  }
  async discover(actor: ActorContext, id: string, raw: unknown) {
    const input = contracts.modelDiscoveryV2InputSchema.parse(raw);
    const service = await this.db.transaction(async (tx) => {
      await this.admin(tx, actor);
      const row = await this.row(tx, id);
      this.active(row);
      if (row.config_revision !== input.serviceRevision) stale();
      if (!row.credential_ref || !row.has_credential)
        throw new DomainError(
          'MODEL_NOT_CONFIGURED',
          '请先安全配置此服务的Key。',
          422,
        );
      return row;
    });
    if (!this.discovery)
      throw new DomainError(
        'UNSUPPORTED_OPERATION',
        '当前协议模型列表传输尚未接入；请手工添加模型，不会自动换地址或Key。',
        422,
      );
    const protectedValues = new Set<string>();
    const output = await this.discovery
      .discover({
        protocol: service.protocol,
        authScheme: service.auth_scheme,
        baseUrl: service.base_url,
        credential: async () => {
          const row = await this.db.transaction(async (tx) => {
            await this.admin(tx, actor);
            const row = await this.row(tx, id);
            this.active(row);
            if (row.config_revision !== input.serviceRevision) stale();
            return row;
          });
          if (!row.credential_ref || !row.has_credential)
            throw new DomainError(
              'MODEL_NOT_CONFIGURED',
              '服务Key已失效。',
              422,
            );
          const secret = await this.broker.resolve(
            row.credential_ref,
            binding(id),
          );
          protectedValues.add(secret);
          return secret;
        },
      })
      .catch((error: unknown) => {
        if (
          error instanceof DomainError &&
          [
            'UNAUTHENTICATED',
            'FORBIDDEN',
            'STALE_BASE_REVISION',
            'MODEL_NOT_CONFIGURED',
            'UNSUPPORTED_OPERATION',
          ].includes(error.code)
        )
          throw new DomainError(
            error.code,
            '模型列表读取已停止，请核对当前权限、服务修订或手工添加模型。',
            error.status,
          );
        throw new DomainError(
          'DEPENDENCY_UNAVAILABLE',
          '上游模型列表读取未成功；请检查配置或手工添加，不会自动更换地址或Key。',
          503,
        );
      });
    const checked = contracts.modelDiscoveryV2ReceiptSchema.safeParse({
      modelServiceId: id,
      serviceRevision: input.serviceRevision,
      source: 'upstream',
      observedAt: new Date().toISOString(),
      models: output?.models,
    });
    if (!checked.success)
      throw new DomainError(
        'INVALID_MODEL_OUTPUT',
        '上游模型列表不符合受控格式，未导入。',
        422,
      );
    const protectedForms = [...protectedValues].flatMap((secret) => [
      secret,
      encodeURIComponent(secret),
      Buffer.from(secret).toString('base64'),
      Buffer.from(secret).toString('base64url'),
      Buffer.from(secret).toString('hex'),
    ]);
    if (
      checked.data.models.some((model) =>
        protectedForms.some(
          (secret) =>
            model.modelId.includes(secret) ||
            model.displayName?.includes(secret),
        ),
      )
    )
      throw new DomainError(
        'INVALID_MODEL_OUTPUT',
        '模型列表包含受保护内容，未返回。',
        422,
      );
    assertSafeModelInput(checked.data.models);
    await this.db.transaction(async (tx) => {
      await this.admin(tx, actor);
      const current = await this.row(tx, id);
      this.active(current);
      if (current.config_revision !== input.serviceRevision) stale();
    });
    return checked.data;
  }
  async recordVerification(
    id: string,
    entryId: string,
    serviceRevision: number,
    raw: unknown,
  ) {
    const checks = modelVerificationChecksSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await this.ready(tx);
      const row = await this.row(tx, id, 'update');
      this.active(row);
      if (row.config_revision !== serviceRevision) stale();
      if (
        !(await this.entries(tx, id)).rows.some((entry) => entry.id === entryId)
      )
        throw new DomainError('NOT_FOUND', '验证目标模型行不存在。', 404);
      const core = [
        'text',
        'streaming',
        'toolCalling',
        'multiTool',
        'toolResultContinuation',
        'imageInput',
        'fileTextInput',
        'structuredOutput',
        'usage',
        'cancellation',
      ] as const;
      const verification = modelVerificationSchema.parse({
        status: Object.values(checks).includes('failed')
          ? 'failed'
          : core.every((key) => checks[key] === 'passed')
            ? 'verified'
            : Object.values(checks).includes('passed')
              ? 'partial'
              : 'unverified',
        checkedAt: new Date().toISOString(),
        checks,
      });
      await tx.query(
        'INSERT INTO app.model_entry_verifications(id,model_service_id,model_entry_id,service_revision,verification) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(), id, entryId, serviceRevision, verification],
      );
      await tx.query(
        'UPDATE app.model_entries SET verification=$2 WHERE id=$1',
        [entryId, verification],
      );
      tx.noteSecurityControlChange?.({
        action: 'configuration.model-observation',
        objectId: entryId,
        projectId: null,
      });
      return { verification };
    });
  }
}
