import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { z } from 'zod';
import {
  externalApprovedToolSchema,
  externalServiceInputSchema,
  externalServiceUpdateSchema,
  externalServiceSchema,
  externalPersonalKeyInputSchema,
  externalPersonalKeyRevokeSchema,
  externalConnectionSchema,
  externalCatalogSchema,
  externalManagementLookupSchema,
  externalManagementStatusSchema,
} from '../../../contracts/src/external-mcp.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { currentUser, requirePlatformAdmin } from '../access/policy.js';
import { DomainError, forbidden, stale } from '../errors.js';
import { audit } from '../events.js';
import { OperationService } from '../operations/service.js';
import { SecretBroker, type SecretBinding } from '../configuration/secrets.js';
import {
  boundedExternalJson,
  externalDigest,
  normalizedExternalEndpoint,
  validateApprovedDefinition,
  credentialAbsent,
} from './safety.js';
import {
  withExternalMcpSession,
  ExternalMcpTransportError,
  type ExternalMcpSession,
} from './transport.js';
import { validatePublicSearchBinding } from './public-search.js';

export interface ExternalServiceRow extends QueryResultRow {
  id: string;
  name: string;
  endpoint: string;
  enabled: boolean;
  access_policy: 'restricted' | 'allActive';
  protocol_mode: 'auto' | 'modern' | 'legacy';
  approved_tools: unknown;
  config_revision: number;
  row_version: number;
  created_by: string;
  updated_at: Date;
}
export interface ExternalConnectionRow extends QueryResultRow {
  id: string;
  service_id: string;
  user_id: string;
  credential_ref: string | null;
  credential_version: number;
  row_version: number;
  status: 'unverified' | 'ready' | 'authRequired' | 'revoked';
  current_catalog_id: string | null;
}
export interface ExternalConnectionPin {
  connectionId: string;
  configRevision: number;
  credentialVersion: number;
}
const binding = (userId: string, serviceId: string): SecretBinding => ({
  ownerScope: 'user',
  ownerId: userId.toLowerCase(),
  purpose: `external-mcp-key:${serviceId.toLowerCase()}`,
});
export class ExternalMcpService {
  readonly operations: OperationService;
  constructor(
    readonly db: Database,
    private readonly broker: SecretBroker,
    readonly options: { allowedTestEndpoints?: readonly string[] } = {},
  ) {
    this.operations = new OperationService(db);
  }
  private allowed(actor: ActorContext) {
    if (actor.entrypoint === 'official-mcp') forbidden();
  }
  private web(actor: ActorContext) {
    if (actor.entrypoint !== 'web') forbidden();
  }
  private async rejectModelCredential(tx: SqlExecutor, value: string) {
    const known = await tx.query<{ id: string; credential_ref: string }>(
      'SELECT m.id,m.credential_ref FROM app.model_services m JOIN app.secret_records r ON r.id=m.credential_ref WHERE r.revoked_at IS NULL',
    );
    for (const row of known.rows) {
      const modelKey = await this.broker.resolveInTransaction(
        tx,
        row.credential_ref,
        { ownerScope: 'platform', ownerId: row.id, purpose: 'model-api-key' },
      );
      if (modelKey === value)
        throw new DomainError(
          'VALIDATION_ERROR',
          '外部MCP个人凭据不能复用平台已登记的模型凭据。',
          400,
          { reason: 'MODEL_CREDENTIAL_REUSE' },
        );
    }
  }
  async operationStatus(actor: ActorContext, raw: unknown) {
    this.web(actor);
    const input = externalManagementLookupSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      if (input.operation.startsWith('external-mcp.service.'))
        await requirePlatformAdmin(tx, actor);
      else await currentUser(tx, actor);
      const bound = {
        query: tx.query.bind(tx),
        transaction: <T>(work: (sql: SqlExecutor) => Promise<T>) => work(tx),
      };
      return externalManagementStatusSchema.parse(
        await new OperationService(bound).get(actor, input),
      );
    });
  }
  async serviceRow(tx: SqlExecutor, id: string, lock = false) {
    const row = (
      await tx.query<ExternalServiceRow>(
        `SELECT * FROM app.external_mcp_services WHERE id=$1${lock ? ' FOR UPDATE' : ' FOR SHARE'}`,
        [id],
      )
    ).rows[0];
    if (!row) throw new DomainError('NOT_FOUND', '没有该外部MCP服务。', 404);
    return row;
  }
  async serviceAccess(tx: SqlExecutor, actor: ActorContext, id: string) {
    this.allowed(actor);
    await currentUser(tx, actor);
    const row = await this.serviceRow(tx, id);
    const grant =
      row.access_policy === 'allActive' ||
      Boolean(
        (
          await tx.query(
            'SELECT 1 FROM app.external_mcp_grants WHERE service_id=$1 AND user_id=$2',
            [id, actor.userId],
          )
        ).rowCount,
      );
    if (!row.enabled || !grant)
      throw new DomainError(
        'FORBIDDEN',
        '该外部MCP服务当前未向本人开放。',
        403,
      );
    return row;
  }
  private async dto(tx: SqlExecutor, row: ExternalServiceRow) {
    const users = await tx.query<{ user_id: string }>(
      'SELECT user_id FROM app.external_mcp_grants WHERE service_id=$1 ORDER BY user_id',
      [row.id],
    );
    return externalServiceSchema.parse({
      id: row.id,
      name: row.name,
      endpoint: row.endpoint,
      enabled: row.enabled,
      accessPolicy: row.access_policy,
      allowedUserIds: users.rows.map((item) => item.user_id),
      protocolMode: row.protocol_mode,
      tools: row.approved_tools,
      configRevision: row.config_revision,
      rowVersion: row.row_version,
      createdBy: row.created_by,
      updatedAt: row.updated_at.toISOString(),
    });
  }
  async listAdmin(actor: ActorContext) {
    return this.db.transaction(async (tx) => {
      await requirePlatformAdmin(tx, actor);
      const rows = await tx.query<ExternalServiceRow>(
        'SELECT * FROM app.external_mcp_services ORDER BY updated_at,id',
      );
      const services = [];
      for (const row of rows.rows) services.push(await this.dto(tx, row));
      return { services };
    });
  }
  async save(actor: ActorContext, id: string | undefined, raw: unknown) {
    const input = id
      ? externalServiceUpdateSchema.parse(raw)
      : externalServiceInputSchema.parse(raw);
    const endpoint = normalizedExternalEndpoint(
      input.endpoint,
      this.options.allowedTestEndpoints,
    );
    boundedExternalJson(input, 512 * 1024);
    for (const tool of input.tools) {
      validateApprovedDefinition(tool);
      validatePublicSearchBinding(tool);
    }
    return this.operations.execute(
      actor,
      id ? 'external-mcp.service.revise' : 'external-mcp.service.create',
      input.commandId,
      { id: id ?? null, ...input, endpoint },
      (tx) => requirePlatformAdmin(tx, actor),
      async (tx) => {
        if (input.allowedUserIds.length) {
          const users = await tx.query(
            'SELECT id FROM app.users WHERE id=ANY($1::uuid[]) AND active ORDER BY id FOR SHARE',
            [input.allowedUserIds],
          );
          if (users.rowCount !== input.allowedUserIds.length)
            throw new DomainError(
              'VALIDATION_ERROR',
              '开放用户中存在已失效账号。',
              400,
            );
        }
        const target = id ?? randomUUID();
        if (id) {
          const old = await this.serviceRow(tx, id, true);
          if (!('rowVersion' in input) || old.row_version !== input.rowVersion)
            stale();
          await tx.query(
            'UPDATE app.external_mcp_services SET name=$2,endpoint=$3,enabled=$4,access_policy=$5,protocol_mode=$6,approved_tools=$7,config_revision=config_revision+1,row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1',
            [
              id,
              input.name,
              endpoint,
              input.enabled,
              input.accessPolicy,
              input.protocolMode,
              JSON.stringify(input.tools),
            ],
          );
        } else
          await tx.query(
            'INSERT INTO app.external_mcp_services(id,name,endpoint,enabled,access_policy,protocol_mode,approved_tools,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
            [
              target,
              input.name,
              endpoint,
              input.enabled,
              input.accessPolicy,
              input.protocolMode,
              JSON.stringify(input.tools),
              actor.userId,
            ],
          );
        await tx.query(
          'DELETE FROM app.external_mcp_grants WHERE service_id=$1',
          [target],
        );
        for (const userId of [...input.allowedUserIds].sort())
          await tx.query(
            'INSERT INTO app.external_mcp_grants(service_id,user_id) VALUES($1,$2)',
            [target, userId],
          );
        const service = await this.dto(tx, await this.serviceRow(tx, target));
        await tx.query(
          'INSERT INTO app.external_mcp_service_revisions(service_id,revision,snapshot,created_by) VALUES($1,$2,$3,$4)',
          [
            target,
            service.configRevision,
            JSON.stringify(service),
            actor.userId,
          ],
        );
        await audit(
          tx,
          actor,
          'configuration.external-mcp-updated',
          target,
          null,
          {
            configRevision: service.configRevision,
            enabled: service.enabled,
            toolNames: service.tools.map((tool) => tool.name),
          },
        );
        tx.noteSecurityControlChange?.({
          action: 'configuration.external-mcp-updated',
          objectId: target,
          projectId: null,
        });
        return { service };
      },
    );
  }
  async connectionRow(
    tx: SqlExecutor,
    actor: ActorContext,
    id: string,
    lock = false,
  ) {
    const row = (
      await tx.query<ExternalConnectionRow>(
        `SELECT * FROM app.external_mcp_connections WHERE id=$1 AND user_id=$2${lock ? ' FOR UPDATE' : ' FOR SHARE'}`,
        [id, actor.userId],
      )
    ).rows[0];
    if (!row) throw new DomainError('NOT_FOUND', '没有本人的该外部连接。', 404);
    return row;
  }
  async authorizedConnection(
    tx: SqlExecutor,
    actor: ActorContext,
    id: string,
    pin?: ExternalConnectionPin,
  ) {
    this.allowed(actor);
    await currentUser(tx, actor);
    const locator = (
      await tx.query<{ service_id: string }>(
        'SELECT service_id FROM app.external_mcp_connections WHERE id=$1 AND user_id=$2',
        [id, actor.userId],
      )
    ).rows[0];
    if (!locator)
      throw new DomainError('NOT_FOUND', '没有本人的该外部连接。', 404);
    const service = await this.serviceAccess(tx, actor, locator.service_id),
      connection = await this.connectionRow(tx, actor, id);
    if (
      !connection.credential_ref ||
      connection.status === 'revoked' ||
      !(
        await tx.query(
          'SELECT 1 FROM app.secret_records WHERE id=$1 AND revoked_at IS NULL',
          [connection.credential_ref],
        )
      ).rowCount
    )
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '本人外部MCP Key尚未配置或已撤销。',
        422,
      );
    if (
      pin &&
      (pin.connectionId !== id ||
        pin.configRevision !== service.config_revision ||
        pin.credentialVersion !== connection.credential_version)
    )
      stale();
    return {
      connection,
      service,
      tools: z.array(externalApprovedToolSchema).parse(service.approved_tools),
    };
  }
  private async connectionDto(
    tx: SqlExecutor,
    connection: ExternalConnectionRow,
    service: ExternalServiceRow,
    accessGranted: boolean,
  ) {
    const catalog = connection.current_catalog_id
      ? (
          await tx.query<{
            id: string;
            config_revision: number;
            credential_version: number;
            catalog_digest: string;
            observed_at: Date;
          }>(
            'SELECT id,config_revision,credential_version,catalog_digest,observed_at FROM app.external_mcp_catalogs WHERE id=$1 AND connection_id=$2',
            [connection.current_catalog_id, connection.id],
          )
        ).rows[0]
      : undefined;
    const current =
      catalog?.config_revision === service.config_revision &&
      catalog.credential_version === connection.credential_version;
    const hasCredential =
      connection.credential_ref !== null &&
      Boolean(
        (
          await tx.query(
            'SELECT 1 FROM app.secret_records WHERE id=$1 AND revoked_at IS NULL',
            [connection.credential_ref],
          )
        ).rowCount,
      );
    return externalConnectionSchema.parse({
      id: connection.id,
      serviceId: service.id,
      name: service.name,
      endpoint: service.endpoint,
      enabled: service.enabled,
      accessGranted,
      hasCredential,
      credentialVersion: connection.credential_version,
      rowVersion: connection.row_version,
      status:
        connection.status === 'ready' && !current
          ? 'unverified'
          : connection.status,
      configRevision: service.config_revision,
      catalogId: current ? catalog.id : null,
      catalogDigest: current ? catalog.catalog_digest : null,
      checkedAt: current ? catalog.observed_at.toISOString() : null,
    });
  }
  async personalServices(actor: ActorContext) {
    this.web(actor);
    return this.db.transaction(async (tx) => {
      await currentUser(tx, actor);
      const rows = await tx.query<
        ExternalServiceRow & { access_granted: boolean }
      >(
        `SELECT s.*,(s.enabled AND (s.access_policy='allActive' OR EXISTS(SELECT 1 FROM app.external_mcp_grants g WHERE g.service_id=s.id AND g.user_id=$1))) access_granted
        FROM app.external_mcp_services s WHERE (s.enabled AND (s.access_policy='allActive' OR EXISTS(SELECT 1 FROM app.external_mcp_grants g WHERE g.service_id=s.id AND g.user_id=$1)))
        OR EXISTS(SELECT 1 FROM app.external_mcp_connections c WHERE c.service_id=s.id AND c.user_id=$1) ORDER BY s.name,s.id`,
        [actor.userId],
      );
      const services = [];
      for (const row of rows.rows) {
        const connection = (
          await tx.query<ExternalConnectionRow>(
            'SELECT * FROM app.external_mcp_connections WHERE service_id=$1 AND user_id=$2',
            [row.id, actor.userId],
          )
        ).rows[0];
        services.push({
          id: row.id,
          name: row.name,
          endpoint: row.endpoint,
          enabled: row.enabled,
          connection: connection
            ? await this.connectionDto(tx, connection, row, row.access_granted)
            : null,
        });
      }
      return { services };
    });
  }
  async savePersonalKey(actor: ActorContext, serviceId: string, raw: unknown) {
    this.web(actor);
    const input = externalPersonalKeyInputSchema.parse(raw),
      keyBinding = binding(actor.userId, serviceId);
    return this.operations.execute(
      actor,
      'external-mcp.personal-key.replace',
      input.commandId,
      {
        serviceId,
        rowVersion: input.rowVersion,
        keyFingerprint: this.broker.fingerprint(input.key, keyBinding),
      },
      async (tx) => {
        await this.serviceAccess(tx, actor, serviceId);
        await this.rejectModelCredential(tx, input.key);
      },
      async (tx) => {
        const service = await this.serviceAccess(tx, actor, serviceId);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `external-key:${actor.userId}:${serviceId}`,
        ]);
        const prior = (
          await tx.query<ExternalConnectionRow>(
            'SELECT * FROM app.external_mcp_connections WHERE service_id=$1 AND user_id=$2 FOR UPDATE',
            [serviceId, actor.userId],
          )
        ).rows[0];
        if (
          prior
            ? prior.row_version !== input.rowVersion
            : input.rowVersion !== 0
        )
          stale();
        const reference = await this.broker.store(tx, input.key, keyBinding),
          id = prior?.id ?? randomUUID();
        if (prior) {
          if (prior.credential_ref)
            await this.broker.revoke(tx, prior.credential_ref, keyBinding);
          await tx.query(
            "UPDATE app.external_mcp_connections SET credential_ref=$2,credential_version=credential_version+1,row_version=row_version+1,status='unverified',current_catalog_id=NULL,updated_at=clock_timestamp() WHERE id=$1",
            [id, reference],
          );
        } else
          await tx.query(
            "INSERT INTO app.external_mcp_connections(id,service_id,user_id,credential_ref,status) VALUES($1,$2,$3,$4,'unverified')",
            [id, serviceId, actor.userId, reference],
          );
        await audit(tx, actor, 'external-mcp.credential-replaced', id, null, {
          serviceId,
        });
        tx.noteSecurityControlChange?.({
          action: 'external-mcp.credential-replaced',
          objectId: id,
          projectId: null,
        });
        return {
          connection: await this.connectionDto(
            tx,
            await this.connectionRow(tx, actor, id),
            service,
            true,
          ),
        };
      },
    );
  }
  async revokePersonalKey(actor: ActorContext, id: string, raw: unknown) {
    this.web(actor);
    const input = externalPersonalKeyRevokeSchema.parse(raw);
    return this.operations.execute(
      actor,
      'external-mcp.personal-key.revoke',
      input.commandId,
      { id, ...input },
      async (tx) => {
        await currentUser(tx, actor);
        const locator = (
          await tx.query<{ service_id: string }>(
            'SELECT service_id FROM app.external_mcp_connections WHERE id=$1 AND user_id=$2',
            [id, actor.userId],
          )
        ).rows[0];
        if (!locator)
          throw new DomainError('NOT_FOUND', '没有本人的该外部连接。', 404);
        await this.serviceRow(tx, locator.service_id);
        await this.connectionRow(tx, actor, id);
      },
      async (tx) => {
        const connection = await this.connectionRow(tx, actor, id, true);
        if (connection.row_version !== input.rowVersion) stale();
        if (connection.credential_ref)
          await this.broker.revoke(
            tx,
            connection.credential_ref,
            binding(actor.userId, connection.service_id),
          );
        await tx.query(
          "UPDATE app.external_mcp_connections SET credential_ref=NULL,credential_version=credential_version+1,row_version=row_version+1,status='revoked',current_catalog_id=NULL,updated_at=clock_timestamp() WHERE id=$1",
          [id],
        );
        const service = await this.serviceRow(tx, connection.service_id);
        await audit(tx, actor, 'external-mcp.credential-revoked', id, null, {
          serviceId: service.id,
        });
        tx.noteSecurityControlChange?.({
          action: 'external-mcp.credential-revoked',
          objectId: id,
          projectId: null,
        });
        return {
          connection: await this.connectionDto(
            tx,
            await this.connectionRow(tx, actor, id),
            service,
            false,
          ),
        };
      },
    );
  }
  async withSession<T>(
    actor: ActorContext,
    id: string,
    pin: ExternalConnectionPin | undefined,
    work: (session: ExternalMcpSession) => Promise<T>,
    hooks: {
      beforeToolDispatch?: () => Promise<void>;
      signal?: AbortSignal;
    } = {},
  ) {
    const selected = await this.db.transaction((tx) =>
      this.authorizedConnection(tx, actor, id, pin),
    );
    const fixed = {
      connectionId: id,
      configRevision: selected.service.config_revision,
      credentialVersion: selected.connection.credential_version,
    };
    const credential = await this.broker.resolve(
      selected.connection.credential_ref!,
      binding(actor.userId, selected.service.id),
    );
    try {
      return await withExternalMcpSession(
        {
          endpoint: selected.service.endpoint,
          credential,
          protocolMode: selected.service.protocol_mode,
          principal: `${actor.userId}:${id}`,
          allowedTestEndpoints: this.options.allowedTestEndpoints ?? [],
          beforeRequest: async () => {
            await this.db.transaction((tx) =>
              this.authorizedConnection(tx, actor, id, fixed),
            );
            await this.db.transaction((tx) =>
              this.rejectModelCredential(tx, credential),
            );
          },
          ...hooks,
        },
        async (session) => {
          credentialAbsent(session.tools, credential);
          await this.db.transaction((tx) =>
            this.assertDataSafe(tx, actor, id, session.tools, 1024 * 1024),
          );
          return work(session);
        },
      );
    } catch (error) {
      if (
        error instanceof DomainError &&
        error.details?.reason === 'MODEL_CREDENTIAL_REUSE'
      )
        await this.db.query(
          "UPDATE app.external_mcp_connections SET status='unverified',updated_at=clock_timestamp() WHERE id=$1 AND credential_version=$2",
          [id, fixed.credentialVersion],
        );
      if (
        error instanceof ExternalMcpTransportError &&
        error.code === 'EXTERNAL_UNAUTHORIZED'
      )
        await this.db.query(
          "UPDATE app.external_mcp_connections SET status='authRequired',updated_at=clock_timestamp() WHERE id=$1 AND credential_version=$2",
          [id, fixed.credentialVersion],
        );
      throw error;
    }
  }
  async assertDataSafe(
    tx: SqlExecutor,
    actor: ActorContext,
    id: string,
    value: unknown,
    maxBytes = 64 * 1024,
  ) {
    const selected = await this.authorizedConnection(tx, actor, id);
    const credential = await this.broker.resolveInTransaction(
      tx,
      selected.connection.credential_ref!,
      binding(actor.userId, selected.service.id),
    );
    boundedExternalJson(value, maxBytes);
    credentialAbsent(value, credential);
    const models = await tx.query<{ id: string; credential_ref: string }>(
      'SELECT m.id,m.credential_ref FROM app.model_services m JOIN app.secret_records r ON r.id=m.credential_ref WHERE r.revoked_at IS NULL',
    );
    for (const model of models.rows) {
      const known = await this.broker.resolveInTransaction(
        tx,
        model.credential_ref,
        { ownerScope: 'platform', ownerId: model.id, purpose: 'model-api-key' },
      );
      try {
        credentialAbsent(value, known);
      } catch {
        throw new DomainError(
          'VALIDATION_ERROR',
          '外部资料或输出含平台已登记的模型凭据，已阻止发送或返回。',
          400,
        );
      }
    }
  }
  async invalidateCatalog(
    actor: ActorContext,
    id: string,
    pin: ExternalConnectionPin,
    observedDigest: string,
  ) {
    return this.db.transaction(async (tx) => {
      const selected = await this.authorizedConnection(tx, actor, id, pin);
      const changed = await tx.query(
        "UPDATE app.external_mcp_connections SET status='unverified',updated_at=clock_timestamp() WHERE id=$1 AND status='ready' RETURNING id",
        [id],
      );
      if (changed.rowCount)
        await audit(tx, actor, 'external-mcp.catalog-changed', id, null, {
          serviceId: selected.service.id,
          observedDigest,
          configRevision: pin.configRevision,
          credentialVersion: pin.credentialVersion,
        });
    });
  }
  async probe(actor: ActorContext, id: string) {
    this.web(actor);
    const before = await this.db.transaction((tx) =>
      this.authorizedConnection(tx, actor, id),
    );
    const pin = {
      connectionId: id,
      configRevision: before.service.config_revision,
      credentialVersion: before.connection.credential_version,
    };
    const observed = await this.withSession(
      actor,
      id,
      pin,
      async (session) => session.tools,
    );
    const tools = observed.map((tool) => {
      const approved = before.tools.find((item) => item.name === tool.name);
      const matches =
        approved !== undefined &&
        externalDigest({
          name: approved.name,
          description: approved.description,
          inputSchema: approved.inputSchema,
          ...(approved.outputSchema
            ? { outputSchema: approved.outputSchema }
            : {}),
          metadata: approved.metadata,
        }) === externalDigest(tool);
      return {
        ...tool,
        schemaDigest: externalDigest(tool),
        approved: matches,
        effect: matches ? approved.effect : null,
        projectAction: matches ? approved.projectAction : null,
        ...(matches && approved.publicSearch
          ? { publicSearch: approved.publicSearch }
          : {}),
      };
    });
    return this.db.transaction(async (tx) => {
      await this.serviceAccess(tx, actor, before.service.id);
      await this.connectionRow(tx, actor, id, true);
      await this.authorizedConnection(tx, actor, id, pin);
      const catalogId = randomUUID(),
        catalogDigest = externalDigest(observed);
      const inserted = await tx.query<{ observed_at: Date }>(
        'INSERT INTO app.external_mcp_catalogs(id,connection_id,config_revision,credential_version,tools,catalog_digest) VALUES($1,$2,$3,$4,$5,$6) RETURNING observed_at',
        [
          catalogId,
          id,
          pin.configRevision,
          pin.credentialVersion,
          JSON.stringify(tools),
          catalogDigest,
        ],
      );
      await tx.query(
        "UPDATE app.external_mcp_connections SET current_catalog_id=$2,status='ready',updated_at=clock_timestamp() WHERE id=$1",
        [id, catalogId],
      );
      await audit(tx, actor, 'external-mcp.catalog-observed', id, null, {
        catalogId,
        catalogDigest,
        configRevision: pin.configRevision,
        credentialVersion: pin.credentialVersion,
        toolCount: tools.length,
        approvedCount: tools.filter((tool) => tool.approved).length,
      });
      return externalCatalogSchema.parse({
        catalogId,
        connectionId: id,
        configRevision: pin.configRevision,
        credentialVersion: pin.credentialVersion,
        catalogDigest,
        tools,
        observedAt: inserted.rows[0]!.observed_at.toISOString(),
      });
    });
  }
  async catalog(actor: ActorContext, id: string) {
    return this.db.transaction(async (tx) => {
      const selected = await this.authorizedConnection(tx, actor, id);
      const catalog = (
        await tx.query<{
          id: string;
          config_revision: number;
          credential_version: number;
          catalog_digest: string;
          tools: unknown;
          observed_at: Date;
        }>(
          'SELECT * FROM app.external_mcp_catalogs WHERE id=$1 AND connection_id=$2',
          [selected.connection.current_catalog_id, id],
        )
      ).rows[0];
      if (
        !catalog ||
        catalog.config_revision !== selected.service.config_revision ||
        catalog.credential_version !== selected.connection.credential_version ||
        selected.connection.status !== 'ready'
      )
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '请先由本人检查当前连接；配置或Key变化后不能沿用旧工具目录。',
          422,
        );
      const parsed = externalCatalogSchema.parse({
        catalogId: catalog.id,
        connectionId: id,
        configRevision: catalog.config_revision,
        credentialVersion: catalog.credential_version,
        catalogDigest: catalog.catalog_digest,
        tools: catalog.tools,
        observedAt: catalog.observed_at.toISOString(),
      });
      return {
        ...parsed,
        tools: parsed.tools.map((tool) => {
          const copy = { ...tool };
          delete copy.publicSearch;
          const approved = selected.tools.find(
            (item) => item.name === tool.name,
          );
          if (tool.approved && approved?.publicSearch)
            copy.publicSearch = approved.publicSearch;
          return copy;
        }),
      };
    });
  }
  async availableTools(actor: ActorContext) {
    this.allowed(actor);
    const ids = await this.db.transaction(async (tx) => {
      await currentUser(tx, actor);
      return (
        await tx.query<{ id: string }>(
          "SELECT id FROM app.external_mcp_connections WHERE user_id=$1 AND credential_ref IS NOT NULL AND status='ready' ORDER BY id",
          [actor.userId],
        )
      ).rows.map((item) => item.id);
    });
    const connections = [];
    for (const id of ids) {
      try {
        const catalog = await this.catalog(actor, id);
        const current = await this.db.transaction((tx) =>
          this.authorizedConnection(tx, actor, id),
        );
        await this.db.transaction((tx) =>
          this.assertDataSafe(tx, actor, id, catalog.tools, 1024 * 1024),
        );
        connections.push({
          connectionId: id,
          name: current.service.name,
          configRevision: catalog.configRevision,
          credentialVersion: catalog.credentialVersion,
          catalogId: catalog.catalogId,
          catalogDigest: catalog.catalogDigest,
          tools: catalog.tools.filter((tool) => tool.approved),
        });
      } catch (error) {
        if (
          error instanceof DomainError &&
          [403, 404, 412, 422].includes(error.status)
        )
          continue;
        throw error;
      }
    }
    return { connections };
  }
}
