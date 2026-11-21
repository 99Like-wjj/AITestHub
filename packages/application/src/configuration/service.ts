import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { QueryResultRow } from 'pg';
import {
  auxiliaryModelInputSchema,
  modelCapabilitiesSchema,
  modelConfigurationInputSchema,
  modelConfigurationUpdateSchema,
  modelCredentialInputSchema,
  modelSelectionInputSchema,
  modelServiceSchema,
  modelVerificationChecksSchema,
  modelVerificationSchema,
  modelDataScopesSchema,
  type ModelConfigurationInput,
  type ModelVerificationChecks,
} from '../../../contracts/src/configuration.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { currentUser, requirePlatformAdmin } from '../access/policy.js';
import { DomainError, stale } from '../errors.js';
import { audit } from '../events.js';
import { SecretBroker, type SecretBinding } from './secrets.js';
import {
  ModelConfigurationV2Service,
  type ModelDiscoveryPort,
} from './v2-service.js';
import { modelSelectionV2Schema } from '../../../contracts/src/model-configuration-v2.js';
import {
  ModelConnectionsService,
  type ModelConnectionProbePort,
} from './model-connections.js';

interface ModelRow extends QueryResultRow {
  allowed_data_scopes?: (
    'syntheticPublicOnly' | 'authorizedRelevantTestData'
  )[];
  id: string;
  name: string;
  provider: 'sensenova' | 'ark';
  base_url: string;
  model_id: string;
  enabled: boolean;
  access_policy: 'restricted' | 'allActive';
  capabilities: unknown;
  effort_values: string[];
  default_effort: string | null;
  context_limit: string | null;
  max_output: string | null;
  credential_ref: string | null;
  config_revision: number;
  row_version: number;
  verification: unknown;
  has_credential: boolean;
}
interface AuxiliaryRow extends QueryResultRow {
  model_service_id: string | null;
  enabled: boolean;
  effort: string | null;
  row_version: number;
}
const selectModels = `SELECT m.*,EXISTS(SELECT 1 FROM app.secret_records s WHERE s.id=m.credential_ref AND s.revoked_at IS NULL) AS has_credential FROM app.model_services m`;
const unverified = { status: 'unverified', checkedAt: null, checks: {} };
const binding = (ownerId: string): SecretBinding => ({
  ownerScope: 'platform',
  ownerId,
  purpose: 'model-api-key',
});

function officialEndpoint(
  input: Pick<ModelConfigurationInput, 'provider' | 'baseUrl'>,
): string {
  const url = new URL(input.baseUrl);
  const canonical = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  const expected =
    input.provider === 'sensenova'
      ? 'https://token.sensenova.cn/v1'
      : 'https://ark.cn-beijing.volces.com/api/v3';
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    canonical !== expected
  ) {
    throw new DomainError(
      'VALIDATION_ERROR',
      '当前适配只允许供应商已登记的标准官方地址。',
      400,
    );
  }
  return canonical;
}

export class ConfigurationService {
  readonly v2: ModelConfigurationV2Service;
  readonly connections: ModelConnectionsService;
  constructor(
    readonly db: Database,
    private readonly broker: SecretBroker,
    options: {
      modelDiscovery?: ModelDiscoveryPort;
      modelConnection?: ModelConnectionProbePort;
    } = {},
  ) {
    this.v2 = new ModelConfigurationV2Service(
      db,
      broker,
      options.modelDiscovery,
    );
    this.connections = new ModelConnectionsService(
      db,
      broker,
      this.v2,
      options.modelConnection,
    );
  }

  /** Current task execution uses the current model selection contract. */
  async resolveRuntimeSelection(actor: ActorContext, raw: unknown) {
    return this.db.transaction((tx) =>
      this.resolveRuntimeSelectionInTransaction(tx, actor, raw),
    );
  }
  private async resolveRuntimeSelectionInTransaction(
    tx: SqlExecutor,
    actor: ActorContext,
    raw: unknown,
    auxiliary = false,
  ) {
    const selection = modelSelectionV2Schema.parse(raw);
    return this.v2.resolveInTransaction(tx, actor, selection, auxiliary);
  }

  async resolveAcceptedAuxiliarySelection(actor: ActorContext, raw: unknown) {
    const selection = modelSelectionV2Schema.parse(raw);
    return this.db.transaction(async (tx) => {
      await currentUser(tx, actor);
      const auxiliary = (
        await tx.query<{
          model_service_id: string | null;
          model_entry_id: string | null;
          enabled: boolean;
          effort: string | null;
        }>(
          'SELECT * FROM app.auxiliary_model_configuration WHERE singleton FOR SHARE',
        )
      ).rows[0];
      if (
        !auxiliary?.enabled ||
        auxiliary.model_service_id !== selection.modelServiceId
      )
        throw new DomainError(
          'MODEL_NOT_CONFIGURED',
          '原系统辅助配置已停用或已改变。',
          422,
        );
      if (auxiliary.model_entry_id !== selection.modelEntryId) stale();
      const selected = await this.v2.resolveInTransaction(
        tx,
        actor,
        { ...selection, effort: auxiliary.effort },
        true,
      );
      if (
        selection.effort !== undefined &&
        selection.effort !== selected.effort
      )
        stale();
      return selected;
    });
  }

  private async grants(
    transaction: SqlExecutor,
    id: string,
  ): Promise<string[]> {
    return (
      await transaction.query<{ user_id: string }>(
        'SELECT user_id FROM app.model_grants WHERE model_service_id=$1 ORDER BY user_id',
        [id],
      )
    ).rows.map((row) => row.user_id);
  }
  private async requireLegacyConfiguration(tx: SqlExecutor) {
    if (
      (
        await tx.query(
          "SELECT 1 FROM app.schema_migrations WHERE version='0035_model_protocols.sql'",
        )
      ).rowCount
    )
      throw new DomainError(
        'UNSUPPORTED_OPERATION',
        '此旧单模型配置入口仅用于35之前的记录/准备；当前操作须使用V2稳定服务与模型行。',
        422,
      );
  }
  private async dto(transaction: SqlExecutor, row: ModelRow) {
    return modelServiceSchema.parse({
      id: row.id,
      name: row.name,
      provider: row.provider,
      baseUrl: row.base_url,
      modelId: row.model_id,
      enabled: row.enabled,
      accessPolicy: row.access_policy,
      allowedUserIds: await this.grants(transaction, row.id),
      capabilities: modelCapabilitiesSchema.parse(row.capabilities),
      effortValues: row.effort_values,
      defaultEffort: row.default_effort,
      contextLimit:
        row.context_limit === null ? null : Number(row.context_limit),
      maxOutput: row.max_output === null ? null : Number(row.max_output),
      credentialRef: row.credential_ref,
      hasCredential: row.has_credential,
      configRevision: row.config_revision,
      rowVersion: row.row_version,
      verification: modelVerificationSchema.parse(row.verification),
      allowedDataScope: 'syntheticPublicOnly',
      allowedDataScopes: row.allowed_data_scopes ?? ['syntheticPublicOnly'],
    });
  }
  private async row(
    transaction: SqlExecutor,
    id: string,
    lock = false,
  ): Promise<ModelRow> {
    const row = (
      await transaction.query<ModelRow>(
        `${selectModels} WHERE m.id=$1 ${lock ? 'FOR UPDATE OF m' : ''}`,
        [id],
      )
    ).rows[0];
    if (!row) throw new DomainError('NOT_FOUND', '模型服务不存在。', 404);
    return row;
  }
  private async validateUsers(
    transaction: SqlExecutor,
    input: Pick<ModelConfigurationInput, 'allowedUserIds'>,
  ) {
    if (!input.allowedUserIds.length) return;
    const users = await transaction.query(
      'SELECT id FROM app.users WHERE id=ANY($1::uuid[]) AND active FOR SHARE',
      [input.allowedUserIds],
    );
    if (users.rowCount !== input.allowedUserIds.length)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '模型开放清单包含失效账号。',
        422,
      );
  }
  private async saveDataPolicy(
    tx: SqlExecutor,
    id: string,
    scopes:
      ('syntheticPublicOnly' | 'authorizedRelevantTestData')[] | undefined,
  ) {
    if (scopes === undefined) return;
    const ready = (
      await tx.query<{ ready: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='app.model_services'::regclass AND attname='allowed_data_scopes' AND NOT attisdropped) ready",
      )
    ).rows[0]?.ready;
    if (!ready) {
      if (scopes.length !== 1 || scopes[0] !== 'syntheticPublicOnly')
        throw new DomainError(
          'DEPENDENCY_UNAVAILABLE',
          '模型资料策略迁移尚未启用；未允许相关内部资料外发。',
          503,
        );
      return;
    }
    await tx.query(
      'UPDATE app.model_services SET allowed_data_scopes=$2 WHERE id=$1',
      [id, modelDataScopesSchema.parse(scopes)],
    );
  }
  private async saveGrants(
    transaction: SqlExecutor,
    id: string,
    users: string[],
  ) {
    await transaction.query(
      'DELETE FROM app.model_grants WHERE model_service_id=$1',
      [id],
    );
    for (const userId of users)
      await transaction.query(
        'INSERT INTO app.model_grants(model_service_id,user_id) VALUES($1,$2)',
        [id, userId],
      );
  }
  private async snapshot(
    transaction: SqlExecutor,
    actor: ActorContext,
    row: ModelRow,
  ) {
    const model = await this.dto(transaction, row);
    await transaction.query(
      'INSERT INTO app.model_service_revisions(model_service_id,revision,snapshot,created_by) VALUES($1,$2,$3,$4)',
      [row.id, row.config_revision, JSON.stringify(model), actor.userId],
    );
    await audit(
      transaction,
      actor,
      'configuration.model-updated',
      row.id,
      null,
      {
        provider: row.provider,
        configRevision: row.config_revision,
        enabled: row.enabled,
        hasCredential: row.has_credential,
      },
    );
    return { model };
  }
  async adminList(actor: ActorContext) {
    return this.db.transaction(async (transaction) => {
      await requirePlatformAdmin(transaction, actor);
      await this.requireLegacyConfiguration(transaction);
      const rows = await transaction.query<ModelRow>(
        `${selectModels} ORDER BY m.created_at,m.id`,
      );
      const models = [];
      for (const row of rows.rows)
        models.push(await this.dto(transaction, row));
      return { models };
    });
  }
  async available(actor: ActorContext) {
    return this.db.transaction(async (transaction) => {
      await currentUser(transaction, actor);
      await this.requireLegacyConfiguration(transaction);
      const rows = await transaction.query<ModelRow>(
        `${selectModels} WHERE m.enabled AND (m.access_policy='allActive' OR EXISTS(
        SELECT 1 FROM app.model_grants g WHERE g.model_service_id=m.id AND g.user_id=$1)) ORDER BY m.created_at,m.id`,
        [actor.userId],
      );
      // User listings do not expose other users' grants or a secret record identifier.
      const models = [];
      for (const row of rows.rows) {
        const model = await this.dto(transaction, row);
        models.push({ ...model, allowedUserIds: [], credentialRef: null });
      }
      return { models };
    });
  }
  async create(actor: ActorContext, raw: unknown) {
    const input = modelConfigurationInputSchema.parse(raw);
    const endpoint = officialEndpoint(input);
    return this.db.transaction(async (transaction) => {
      await requirePlatformAdmin(transaction, actor);
      await this.requireLegacyConfiguration(transaction);
      await this.validateUsers(transaction, input);
      const id = randomUUID();
      await transaction.query(
        `INSERT INTO app.model_services(id,name,provider,base_url,model_id,enabled,access_policy,capabilities,effort_values,default_effort,context_limit,max_output,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          id,
          input.name,
          input.provider,
          endpoint,
          input.modelId,
          input.enabled,
          input.accessPolicy,
          JSON.stringify(input.capabilities),
          input.effortValues,
          input.defaultEffort,
          input.contextLimit,
          input.maxOutput,
          actor.userId,
        ],
      );
      await this.saveDataPolicy(transaction, id, input.allowedDataScopes);
      await this.saveGrants(transaction, id, input.allowedUserIds);
      return this.snapshot(transaction, actor, await this.row(transaction, id));
    });
  }
  async update(actor: ActorContext, id: string, raw: unknown) {
    const input = modelConfigurationUpdateSchema.parse(raw);
    const endpoint = officialEndpoint(input);
    return this.db.transaction(async (transaction) => {
      await requirePlatformAdmin(transaction, actor);
      await this.requireLegacyConfiguration(transaction);
      await this.validateUsers(transaction, input);
      const current = await this.row(transaction, id, true);
      if (current.row_version !== input.rowVersion) stale();
      // Reusing a credential for another provider/endpoint is never implicit.
      if (
        current.credential_ref &&
        (current.provider !== input.provider || current.base_url !== endpoint)
      ) {
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '切换供应商前请撤销旧凭据，再单独配置新凭据。',
          422,
        );
      }
      await transaction.query(
        `UPDATE app.model_services SET name=$2,provider=$3,base_url=$4,model_id=$5,enabled=$6,access_policy=$7,
        capabilities=$8,effort_values=$9,default_effort=$10,context_limit=$11,max_output=$12,config_revision=config_revision+1,row_version=row_version+1,
        verification=$13,updated_at=clock_timestamp() WHERE id=$1`,
        [
          id,
          input.name,
          input.provider,
          endpoint,
          input.modelId,
          input.enabled,
          input.accessPolicy,
          JSON.stringify(input.capabilities),
          input.effortValues,
          input.defaultEffort,
          input.contextLimit,
          input.maxOutput,
          JSON.stringify(unverified),
        ],
      );
      await this.saveDataPolicy(transaction, id, input.allowedDataScopes);
      await this.saveGrants(transaction, id, input.allowedUserIds);
      return this.snapshot(transaction, actor, await this.row(transaction, id));
    });
  }
  async setCredential(actor: ActorContext, id: string, raw: unknown) {
    const input = modelCredentialInputSchema.parse(raw);
    return this.db.transaction(async (transaction) => {
      await requirePlatformAdmin(transaction, actor);
      await this.requireLegacyConfiguration(transaction);
      const current = await this.row(transaction, id, true);
      if (current.row_version !== input.rowVersion) stale();
      const reference = await this.broker.store(
        transaction,
        input.credential,
        binding(id),
      );
      if (current.credential_ref)
        await this.broker.revoke(
          transaction,
          current.credential_ref,
          binding(id),
        );
      await transaction.query(
        `UPDATE app.model_services SET credential_ref=$2,config_revision=config_revision+1,row_version=row_version+1,
        verification=$3,updated_at=clock_timestamp() WHERE id=$1`,
        [id, reference, JSON.stringify(unverified)],
      );
      return this.snapshot(transaction, actor, await this.row(transaction, id));
    });
  }
  async importModelCredentialFile(
    actor: ActorContext,
    id: string,
    path: string,
    rowVersion: number,
  ) {
    // Local setup code supplies only a path. The file value never enters a model/tool response.
    await this.db.transaction(async (transaction) => {
      await requirePlatformAdmin(transaction, actor);
      await this.requireLegacyConfiguration(transaction);
    });
    let credential: string;
    try {
      credential = (await readFile(path, 'utf8')).trim();
    } catch {
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '本地模型凭据文件不可读。',
        422,
      );
    }
    return this.setCredential(actor, id, { credential, rowVersion });
  }
  /** Trusted local operator only; stable command is supplied outside the model and no file route exists. */
  async importModelCredentialFileV2(
    actor: ActorContext,
    id: string,
    path: string,
    rowVersion: number,
    commandId: string,
  ) {
    await this.db.transaction(async (tx) => {
      await requirePlatformAdmin(tx, actor);
      await this.v2.ready(tx);
    });
    let credential: string;
    try {
      credential = (await readFile(path, 'utf8')).trim();
    } catch {
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '本地模型凭据文件不可读。',
        422,
      );
    }
    return this.v2.setCredential(actor, id, {
      commandId,
      rowVersion,
      credential,
    });
  }
  async revokeCredential(actor: ActorContext, id: string, rowVersion: number) {
    return this.db.transaction(async (transaction) => {
      await requirePlatformAdmin(transaction, actor);
      await this.requireLegacyConfiguration(transaction);
      const current = await this.row(transaction, id, true);
      if (current.row_version !== rowVersion) stale();
      if (current.credential_ref)
        await this.broker.revoke(
          transaction,
          current.credential_ref,
          binding(id),
        );
      await transaction.query(
        `UPDATE app.model_services SET credential_ref=NULL,config_revision=config_revision+1,row_version=row_version+1,
        verification=$2,updated_at=clock_timestamp() WHERE id=$1`,
        [id, JSON.stringify(unverified)],
      );
      return this.snapshot(transaction, actor, await this.row(transaction, id));
    });
  }
  private selectEffort(
    row: ModelRow,
    effort: string | null | undefined,
  ): string | null {
    const selected = effort === undefined ? row.default_effort : effort;
    if (selected !== null && !row.effort_values.includes(selected))
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '所选模型不支持此强度，请重新选择。',
        422,
      );
    return selected;
  }
  private selection(row: ModelRow, effort: string | null | undefined) {
    if (!row.enabled || !row.credential_ref || !row.has_credential)
      throw new DomainError(
        'MODEL_NOT_CONFIGURED',
        '所选模型已停用或缺少凭据，请重新选择；不会自动切换模型。',
        422,
      );
    return {
      modelServiceId: row.id,
      configRevision: row.config_revision,
      provider: row.provider,
      baseUrl: row.base_url,
      modelId: row.model_id,
      effort: this.selectEffort(row, effort),
      credentialRef: row.credential_ref,
      capabilities: modelCapabilitiesSchema.parse(row.capabilities),
      contextLimit:
        row.context_limit === null ? null : Number(row.context_limit),
      maxOutput: row.max_output === null ? null : Number(row.max_output),
      allowedDataScope: 'syntheticPublicOnly' as const,
      allowedDataScopes: modelDataScopesSchema.parse(
        row.allowed_data_scopes ?? ['syntheticPublicOnly'],
      ),
    };
  }
  async resolveUserSelection(actor: ActorContext, raw: unknown) {
    const input = modelSelectionInputSchema.parse(raw);
    return this.db.transaction(async (transaction) => {
      await currentUser(transaction, actor);
      await this.requireLegacyConfiguration(transaction);
      const row = await this.row(transaction, input.modelServiceId);
      if (
        row.access_policy !== 'allActive' &&
        !(
          await transaction.query(
            'SELECT 1 FROM app.model_grants WHERE model_service_id=$1 AND user_id=$2',
            [row.id, actor.userId],
          )
        ).rowCount
      ) {
        throw new DomainError('FORBIDDEN', '当前账号没有此模型使用权限。', 403);
      }
      if (row.config_revision !== input.configRevision) stale();
      return this.selection(row, input.effort);
    });
  }
  async getAuxiliary(actor: ActorContext) {
    return this.db.transaction(async (transaction) => {
      await requirePlatformAdmin(transaction, actor);
      await this.requireLegacyConfiguration(transaction);
      const row = (
        await transaction.query<AuxiliaryRow>(
          'SELECT * FROM app.auxiliary_model_configuration WHERE singleton',
        )
      ).rows[0];
      return {
        auxiliary: row
          ? {
              modelServiceId: row.model_service_id,
              enabled: row.enabled,
              effort: row.effort,
              rowVersion: row.row_version,
            }
          : {
              modelServiceId: null,
              enabled: false,
              effort: null,
              rowVersion: 0,
            },
      };
    });
  }
  async setAuxiliary(actor: ActorContext, raw: unknown) {
    const input = auxiliaryModelInputSchema.parse(raw);
    return this.db.transaction(async (transaction) => {
      await requirePlatformAdmin(transaction, actor);
      await this.requireLegacyConfiguration(transaction);
      await transaction.query('SELECT pg_advisory_xact_lock(415948009)');
      const current = (
        await transaction.query<AuxiliaryRow>(
          'SELECT * FROM app.auxiliary_model_configuration WHERE singleton FOR UPDATE',
        )
      ).rows[0];
      if ((current?.row_version ?? 0) !== input.rowVersion) stale();
      if (input.modelServiceId) {
        const model = await this.row(transaction, input.modelServiceId, true);
        // Enabling must be runnable now, not merely a reference to an existing row.
        // Disabling an obsolete binding must remain possible without changing it.
        if (input.enabled) this.selection(model, input.effort);
      }
      await transaction.query(
        `INSERT INTO app.auxiliary_model_configuration(singleton,model_service_id,enabled,effort,updated_by)
        VALUES(true,$1,$2,$3,$4) ON CONFLICT(singleton) DO UPDATE SET model_service_id=EXCLUDED.model_service_id,enabled=EXCLUDED.enabled,
        effort=EXCLUDED.effort,row_version=auxiliary_model_configuration.row_version+1,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()`,
        [input.modelServiceId, input.enabled, input.effort, actor.userId],
      );
      await audit(
        transaction,
        actor,
        'configuration.auxiliary-updated',
        input.modelServiceId ?? actor.userId,
        null,
        { enabled: input.enabled },
      );
      return {
        auxiliary: {
          modelServiceId: input.modelServiceId,
          enabled: input.enabled,
          effort: input.effort,
          rowVersion: input.rowVersion + 1,
        },
      };
    });
  }
  async resolveAuxiliarySelection(actor?: ActorContext) {
    return this.db.transaction((transaction) =>
      this.resolveAuxiliarySelectionInTransaction(transaction, actor),
    );
  }
  async resolveAuxiliarySelectionInTransaction(
    transaction: SqlExecutor,
    actor?: ActorContext,
  ) {
    if (actor) await currentUser(transaction, actor);
    await this.requireLegacyConfiguration(transaction);
    const auxiliary = (
      await transaction.query<AuxiliaryRow>(
        'SELECT * FROM app.auxiliary_model_configuration WHERE singleton',
      )
    ).rows[0];
    if (!auxiliary?.enabled || !auxiliary.model_service_id)
      throw new DomainError(
        'MODEL_NOT_CONFIGURED',
        '系统辅助模型尚未配置或已停用；不会借用聊天模型。',
        422,
      );
    return this.selection(
      await this.row(transaction, auxiliary.model_service_id),
      auxiliary.effort,
    );
  }
  /** Internal probe adapter only; no HTTP/MCP route lets a user assert successful verification. */
  async recordVerification(
    id: string,
    configRevision: number,
    raw: ModelVerificationChecks,
  ) {
    const checks = modelVerificationChecksSchema.parse(raw);
    return this.db.transaction(async (transaction) => {
      await this.requireLegacyConfiguration(transaction);
      const row = await this.row(transaction, id, true);
      if (row.config_revision !== configRevision) stale();
      const statuses = Object.values(checks);
      const declared = modelCapabilitiesSchema.parse(row.capabilities);
      const required: string[] = [
        'text',
        ...Object.entries(declared)
          .filter(([, value]) => value)
          .map(([key]) => key),
      ];
      const observed: Record<string, string | undefined> = checks;
      const status = statuses.includes('failed')
        ? 'failed'
        : required.every((key) => observed[key] === 'passed')
          ? 'verified'
          : statuses.includes('passed')
            ? 'partial'
            : 'unverified';
      const verification = {
        status,
        checkedAt: new Date().toISOString(),
        checks,
      };
      await transaction.query(
        'INSERT INTO app.model_verification_records(model_service_id,config_revision,verification) VALUES($1,$2,$3)',
        [id, configRevision, JSON.stringify(verification)],
      );
      await transaction.query(
        'UPDATE app.model_services SET verification=$2 WHERE id=$1',
        [id, JSON.stringify(verification)],
      );
      return { verification };
    });
  }
}
