import { randomUUID } from 'node:crypto';
import type {
  ActorContext,
  Capability,
} from '../../../contracts/src/identity.js';
import {
  saveTestConfigurationInputSchema,
  projectCredentialInputSchema,
  testConfigurationContentSchema,
  type ConfigurationKind,
  type TestConfigurationContent,
  type TestConfigurationView,
} from '../../../contracts/src/test-configuration.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { DomainError, forbidden, stale } from '../errors.js';
import { audit } from '../events.js';
import { OperationService } from '../operations/service.js';
import type { SecretBroker } from '../configuration/secrets.js';

interface ConfigurationRow {
  id: string;
  project_id: string;
  kind: ConfigurationKind;
  name: string;
  active: boolean;
  content: unknown;
  credential_ref: string | null;
  current_revision_id: string;
  row_version: number;
}

const capability = (kind: ConfigurationKind): Capability =>
  kind === 'databaseConnection'
    ? 'database-connections.write'
    : 'test-configuration.write';
const secretBinding = (id: string) => ({
  ownerScope: 'project' as const,
  ownerId: id,
  purpose: 'test-target-credential',
});
function safeContent(content: TestConfigurationContent): void {
  if (
    content.kind === 'environment' &&
    Object.keys(content.variables).some((key) =>
      /password|secret|token|api.?key|authorization|cookie/i.test(key),
    )
  ) {
    throw new DomainError(
      'VALIDATION_ERROR',
      '秘密值须使用受保护的账号或认证配置，不能放入公共变量。',
      400,
    );
  }
  if (
    content.kind === 'authProfile' &&
    content.authentication.mode === 'login'
  ) {
    for (const [name, value] of Object.entries(
      content.authentication.headers,
    )) {
      if (
        /authorization|cookie|api.?key/i.test(name) &&
        !/\{\{(account|credential)\.[A-Za-z_]+\}\}/.test(value)
      ) {
        throw new DomainError(
          'VALIDATION_ERROR',
          '认证头必须引用受保护凭据，不得内嵌秘密。',
          400,
        );
      }
    }
    const inspect = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(inspect);
        return;
      }
      if (value && typeof value === 'object')
        for (const [key, item] of Object.entries(value)) {
          if (
            /password|secret|token|api.?key|authorization|cookie|username/i.test(
              key,
            ) &&
            !(
              typeof item === 'string' &&
              /\{\{(account|credential)\.[A-Za-z_]+\}\}/.test(item)
            )
          ) {
            throw new DomainError(
              'VALIDATION_ERROR',
              '登录材料须引用受保护凭据，不得保存明文账号或秘密。',
              400,
            );
          }
          inspect(item);
        }
    };
    inspect(content.authentication.bodyTemplate);
    if (content.authentication.path.startsWith('//'))
      throw new DomainError(
        'VALIDATION_ERROR',
        '登录路径不能改变已配置服务目标。',
        400,
      );
  }
}
function internalDto(row: ConfigurationRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    content: testConfigurationContentSchema.parse(row.content),
    rowVersion: row.row_version,
    revisionId: row.current_revision_id,
    hasCredential: row.credential_ref !== null,
  };
}

export class TestConfigurationService {
  private readonly operations: OperationService;
  constructor(
    readonly db: Database,
    private readonly secrets: SecretBroker,
  ) {
    this.operations = new OperationService(db);
  }

  async list(actor: ActorContext, projectId: string, kind?: ConfigurationKind) {
    return this.db.transaction(async (tx) => {
      const member = await requireProject(
        tx,
        actor,
        projectId,
        kind === 'databaseConnection'
          ? 'database-connections.metadata.read'
          : 'test-configuration.read',
      );
      const full =
        member.isAdmin ||
        member.roles.includes('tester') ||
        member.roles.includes('developer');
      const result = await tx.query<ConfigurationRow>(
        'SELECT * FROM app.test_configurations WHERE project_id=$1 AND ($2::text IS NULL OR kind=$2) ORDER BY kind,name,id LIMIT 200',
        [projectId, kind ?? null],
      );
      return {
        configurations: result.rows.flatMap<TestConfigurationView>((row) => {
          if (full) return [internalDto(row)];
          const content = testConfigurationContentSchema.parse(row.content);
          if (content.kind === 'environment')
            return [
              {
                id: row.id,
                projectId,
                rowVersion: row.row_version,
                revisionId: row.current_revision_id,
                content: {
                  kind: content.kind,
                  name: content.name,
                  description: content.description,
                  active: content.active,
                },
              },
            ];
          if (content.kind === 'databaseConnection')
            return [
              {
                id: row.id,
                projectId,
                rowVersion: row.row_version,
                revisionId: row.current_revision_id,
                content: {
                  kind: content.kind,
                  name: content.name,
                  driver: content.driver,
                  environmentId: content.environmentId,
                },
              },
            ];
          return [];
        }),
      };
    });
  }

  async save(
    actor: ActorContext,
    projectId: string,
    id: string | undefined,
    raw: unknown,
  ) {
    const input = saveTestConfigurationInputSchema.parse(raw);
    safeContent(input.content);
    return this.operations.execute(
      actor,
      'test-configuration.save',
      input.commandId,
      { projectId, id: id ?? null, ...input },
      async (tx) => {
        await requireProject(
          tx,
          actor,
          projectId,
          capability(input.content.kind),
        );
      },
      async (tx) => {
        const previous = id
          ? await this.row(tx, projectId, id, true)
          : undefined;
        if ((previous?.row_version ?? 0) !== input.rowVersion) stale();
        if (previous && previous.kind !== input.content.kind)
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '不能改变配置对象类型。',
            409,
          );
        await this.validateReferences(tx, projectId, input.content);
        const content = input.content;
        const entityId = id ?? randomUUID();
        const revisionId = randomUUID();
        const environmentId =
          'environmentId' in content ? content.environmentId : null;
        const purposeId = content.kind === 'binding' ? content.purposeId : null;
        const accountId = content.kind === 'binding' ? content.accountId : null;
        const profileId =
          content.kind === 'binding' ? content.authProfileId : null;
        if (content.kind === 'binding' && content.active) {
          await tx.query(
            'SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',
            [projectId, `${environmentId}:${purposeId}`],
          );
          if (
            (
              await tx.query(
                `SELECT 1 FROM app.test_configurations WHERE project_id=$1 AND kind='binding' AND active AND environment_id=$2
             AND purpose_id=$3 AND id<>$4`,
                [projectId, environmentId, purposeId, entityId],
              )
            ).rowCount
          )
            throw new DomainError(
              'BUSINESS_CONFLICT',
              '同一环境与用途已有有效账号绑定，请明确修改原绑定。',
              409,
            );
        }
        if (!previous)
          await tx.query(
            `INSERT INTO app.test_configurations(id,project_id,kind,name,active,content,environment_id,purpose_id,account_id,auth_profile_id,current_revision_id,created_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [
              entityId,
              projectId,
              content.kind,
              content.name,
              content.active,
              JSON.stringify(content),
              environmentId,
              purposeId,
              accountId,
              profileId,
              revisionId,
              actor.userId,
            ],
          );
        else
          await tx.query(
            `UPDATE app.test_configurations SET name=$3,active=$4,content=$5,environment_id=$6,purpose_id=$7,account_id=$8,
           auth_profile_id=$9,current_revision_id=$10,row_version=row_version+1,updated_at=clock_timestamp() WHERE project_id=$1 AND id=$2`,
            [
              projectId,
              entityId,
              content.name,
              content.active,
              JSON.stringify(content),
              environmentId,
              purposeId,
              accountId,
              profileId,
              revisionId,
            ],
          );
        await this.revision(tx, actor, await this.row(tx, projectId, entityId));
        await audit(
          tx,
          actor,
          'test-configuration.saved',
          entityId,
          projectId,
          { kind: content.kind, revisionId },
        );
        return {
          configuration: internalDto(await this.row(tx, projectId, entityId)),
        };
      },
      projectId,
    );
  }

  async get(
    actor: ActorContext,
    projectId: string,
    id: string,
    expectedKind?: ConfigurationKind,
  ) {
    return this.db.transaction(async (tx) => {
      const member = await requireProject(
        tx,
        actor,
        projectId,
        expectedKind === 'databaseConnection'
          ? 'database-connections.metadata.read'
          : 'test-configuration.read',
      );
      const row = await this.row(tx, projectId, id);
      if (expectedKind && row.kind !== expectedKind)
        throw new DomainError('NOT_FOUND', '没有此类型的项目配置。', 404);
      if (
        member.isAdmin ||
        member.roles.includes('tester') ||
        member.roles.includes('developer')
      )
        return { configuration: internalDto(row) };
      const content = testConfigurationContentSchema.parse(row.content);
      if (content.kind === 'environment')
        return {
          configuration: {
            id: row.id,
            projectId,
            rowVersion: row.row_version,
            revisionId: row.current_revision_id,
            content: {
              kind: content.kind,
              name: content.name,
              description: content.description,
              active: content.active,
            },
          },
        };
      if (content.kind === 'databaseConnection')
        return {
          configuration: {
            id: row.id,
            projectId,
            rowVersion: row.row_version,
            revisionId: row.current_revision_id,
            content: {
              kind: content.kind,
              name: content.name,
              driver: content.driver,
              environmentId: content.environmentId,
            },
          },
        };
      forbidden();
    });
  }

  async setCredential(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    const input = projectCredentialInputSchema.parse(raw);
    if (actor.entrypoint !== 'web') forbidden();
    const serialized = JSON.stringify(input.credential);
    return this.operations.execute(
      actor,
      'test-configuration.credential',
      input.commandId,
      {
        projectId,
        id,
        rowVersion: input.rowVersion,
        credentialFingerprint: this.secrets.fingerprint(
          serialized,
          secretBinding(id),
        ),
      },
      async (tx) => {
        const row = await this.row(tx, projectId, id);
        await requireProject(tx, actor, projectId, capability(row.kind));
      },
      async (tx) => {
        const row = await this.row(tx, projectId, id, true);
        if (row.row_version !== input.rowVersion) stale();
        const content = testConfigurationContentSchema.parse(row.content);
        const valid =
          (['account', 'databaseConnection'].includes(row.kind) &&
            'username' in input.credential) ||
          (content.kind === 'authProfile' &&
            content.authentication.mode === 'token' &&
            'value' in input.credential);
        if (!valid)
          throw new DomainError(
            'VALIDATION_ERROR',
            '凭据输入与配置类型不匹配。',
            400,
          );
        if (row.credential_ref)
          await this.secrets.revoke(tx, row.credential_ref, secretBinding(id));
        const ref = await this.secrets.store(tx, serialized, secretBinding(id));
        await tx.query(
          `UPDATE app.test_configurations SET credential_ref=$3,current_revision_id=$4,row_version=row_version+1,
           updated_at=clock_timestamp() WHERE project_id=$1 AND id=$2`,
          [projectId, id, ref, randomUUID()],
        );
        const updated = await this.row(tx, projectId, id);
        await this.revision(tx, actor, updated);
        await audit(
          tx,
          actor,
          'test-configuration.credential-replaced',
          id,
          projectId,
        );
        return { configuration: internalDto(updated) };
      },
      projectId,
    );
  }

  /** Internal application/runner port only: opaque references are never public DTO fields. */
  async executionSnapshot(
    actor: ActorContext,
    projectId: string,
    environmentId: string,
    purposeIds: string[],
    connectionIds: string[],
    authProfileIds: string[] = [],
  ) {
    return this.db.transaction((tx) =>
      this.executionSnapshotInTransaction(
        tx,
        actor,
        projectId,
        environmentId,
        purposeIds,
        connectionIds,
        authProfileIds,
      ),
    );
  }

  async executionSnapshotInTransaction(
    tx: SqlExecutor,
    actor: ActorContext,
    projectId: string,
    environmentId: string,
    purposeIds: string[],
    connectionIds: string[],
    authProfileIds: string[] = [],
  ) {
    await requireProject(tx, actor, projectId, 'runs.organize');
    const environment = await this.typed(
      tx,
      projectId,
      environmentId,
      'environment',
    );
    const bindings = [];
    for (const purposeId of new Set(purposeIds)) {
      const purpose = await this.typed(tx, projectId, purposeId, 'purpose');
      const binding = (
        await tx.query<ConfigurationRow>(
          `SELECT * FROM app.test_configurations WHERE project_id=$1 AND kind='binding' AND active AND environment_id=$2 AND purpose_id=$3 FOR SHARE`,
          [projectId, environmentId, purposeId],
        )
      ).rows[0];
      if (!binding)
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '所选环境缺少明确用途绑定，不会自动换用其他账号。',
          422,
        );
      const content = testConfigurationContentSchema.parse(binding.content);
      if (content.kind !== 'binding') throw new Error('Invalid binding record');
      const account = await this.typed(
        tx,
        projectId,
        content.accountId,
        'account',
      );
      if (!account.credential_ref)
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '用途账号缺少受保护凭据。',
          422,
        );
      const profile = content.authProfileId
        ? await this.typed(tx, projectId, content.authProfileId, 'authProfile')
        : null;
      if (profile) {
        const definition = testConfigurationContentSchema.parse(
          profile.content,
        );
        if (
          definition.kind === 'authProfile' &&
          definition.authentication.mode === 'token' &&
          !profile.credential_ref
        ) {
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '认证配置缺少受保护Token。',
            422,
          );
        }
      }
      bindings.push({
        purpose: internalDto(purpose),
        binding: internalDto(binding),
        account: internalDto(account),
        accountCredentialRef: account.credential_ref,
        profile: profile ? internalDto(profile) : null,
        profileCredentialRef: profile?.credential_ref ?? null,
      });
    }
    const connections = [];
    for (const id of new Set(connectionIds)) {
      const row = await this.typed(tx, projectId, id, 'databaseConnection');
      const content = testConfigurationContentSchema.parse(row.content);
      if (
        content.kind !== 'databaseConnection' ||
        content.environmentId !== environmentId ||
        !row.credential_ref
      ) {
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '清理连接必须属于所选环境并具有受保护凭据。',
          422,
        );
      }
      connections.push({
        ...internalDto(row),
        credentialRef: row.credential_ref,
      });
    }
    const profiles = [];
    for (const id of new Set(authProfileIds)) {
      const profile = await this.typed(tx, projectId, id, 'authProfile');
      const content = testConfigurationContentSchema.parse(profile.content);
      if (content.kind !== 'authProfile')
        throw new Error('Invalid profile record');
      if (content.authentication.mode === 'token' && !profile.credential_ref) {
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '直接引用的认证配置缺少受保护Token。',
          422,
        );
      }
      if (content.authentication.mode === 'login' && purposeIds.length === 0) {
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '登录认证必须明确引用本环境用途绑定，不会自动借用账号。',
          422,
        );
      }
      profiles.push({
        ...internalDto(profile),
        credentialRef: profile.credential_ref,
      });
    }
    return {
      environment: internalDto(environment),
      bindings,
      connections,
      profiles,
    };
  }

  async resolveTargetCredential(
    reference: string,
    configurationId: string,
  ): Promise<string> {
    return this.resolveTargetCredentialInTransaction(
      this.db,
      reference,
      configurationId,
    );
  }
  async resolveTargetCredentialInTransaction(
    tx: SqlExecutor,
    reference: string,
    configurationId: string,
  ): Promise<string> {
    if (
      !(
        await tx.query(
          'SELECT 1 FROM app.test_configurations WHERE id=$1 AND active AND credential_ref=$2',
          [configurationId, reference],
        )
      ).rowCount
    ) {
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '目标配置或凭据已停用，不再注入旧凭据。',
        422,
      );
    }
    return this.secrets.resolveInTransaction(
      tx,
      reference,
      secretBinding(configurationId),
    );
  }

  private async validateReferences(
    tx: SqlExecutor,
    projectId: string,
    content: TestConfigurationContent,
  ): Promise<void> {
    if ('environmentId' in content)
      await this.typed(
        tx,
        projectId,
        content.environmentId,
        'environment',
        content.active,
      );
    if (content.kind === 'binding') {
      await this.typed(
        tx,
        projectId,
        content.purposeId,
        'purpose',
        content.active,
      );
      await this.typed(
        tx,
        projectId,
        content.accountId,
        'account',
        content.active,
      );
      if (content.authProfileId)
        await this.typed(
          tx,
          projectId,
          content.authProfileId,
          'authProfile',
          content.active,
        );
    }
  }
  private async typed(
    tx: SqlExecutor,
    projectId: string,
    id: string,
    kind: ConfigurationKind,
    requireActive = true,
  ) {
    const row = await this.row(tx, projectId, id, 'share');
    if (row.kind !== kind || (requireActive && !row.active))
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '配置类型不匹配或已停用。',
        422,
      );
    return row;
  }
  private async row(
    tx: SqlExecutor,
    projectId: string,
    id: string,
    lock: boolean | 'share' = false,
  ): Promise<ConfigurationRow> {
    const row = (
      await tx.query<ConfigurationRow>(
        `SELECT * FROM app.test_configurations WHERE project_id=$1 AND id=$2${lock === 'share' ? ' FOR SHARE' : lock ? ' FOR UPDATE' : ''}`,
        [projectId, id],
      )
    ).rows[0];
    if (!row) throw new DomainError('NOT_FOUND', '此项目内没有该配置。', 404);
    return row;
  }
  private async revision(
    tx: SqlExecutor,
    actor: ActorContext,
    row: ConfigurationRow,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO app.test_configuration_revisions(id,configuration_id,project_id,kind,revision_no,content,credential_ref,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        row.current_revision_id,
        row.id,
        row.project_id,
        row.kind,
        row.row_version,
        JSON.stringify(row.content),
        row.credential_ref,
        actor.userId,
      ],
    );
  }
}
