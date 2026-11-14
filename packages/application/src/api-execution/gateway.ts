import { z } from 'zod';
import type {
  ApiPhase,
  HttpTransport,
  JsonValue,
  RuntimeVariables,
  SqlTransport,
} from '../../../contracts/src/api-execution.js';
import {
  apiCaseContentSchema,
  apiRequestStepSchema,
  cleanupSqlStepSchema,
} from '../../../contracts/src/domain.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { SecretBroker } from '../configuration/secrets.js';
import { TestConfigurationService } from '../test-configuration/service.js';
import { DomainError } from '../errors.js';
import { contextVariables, interpolate } from './expressions.js';
import { compileCleanupSql } from './sql.js';
import type { FrozenConfiguration } from './types.js';

export interface TargetPolicy {
  httpOrigins: readonly string[];
  sqlTargets: readonly {
    driver: 'postgresql' | 'mysql';
    host: string;
    port: number;
    database: string;
  }[];
}
export const targetPolicySchema = z.strictObject({
  httpOrigins: z
    .array(
      z.url().refine((value) => {
        const url = new URL(value);
        return (
          ['http:', 'https:'].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          (url.pathname === '/' || url.pathname === '') &&
          ![
            'api',
            'postgres',
            'seaweedfs',
            '169.254.169.254',
            '169.254.170.2',
            'metadata.google.internal',
          ].includes(url.hostname) &&
          !(
            ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
            ['5300', '55432', '58333'].includes(url.port)
          )
        );
      }),
    )
    .max(2000),
  sqlTargets: z
    .array(
      z.strictObject({
        driver: z.enum(['postgresql', 'mysql']),
        host: z.string().regex(/^[A-Za-z0-9_.:-]+$/),
        port: z.number().int().min(1).max(65535),
        database: z.string().min(1).max(128),
      }),
    )
    .max(2000),
});
export const localTargetPolicy: TargetPolicy = {
  httpOrigins: ['http://synthetic-api:8080', 'http://127.0.0.1:59995'],
  sqlTargets: [
    {
      driver: 'postgresql',
      host: 'target-postgres',
      port: 5432,
      database: 'aitesthub_target',
    },
    {
      driver: 'postgresql',
      host: '127.0.0.1',
      port: 55434,
      database: 'aitesthub_target',
    },
    {
      driver: 'mysql',
      host: 'target-mysql',
      port: 3306,
      database: 'aitesthub_target',
    },
    {
      driver: 'mysql',
      host: '127.0.0.1',
      port: 53306,
      database: 'aitesthub_target',
    },
  ],
};
const credentialSchema = z.union([
  z.strictObject({ username: z.string(), password: z.string() }),
  z.strictObject({ value: z.string() }),
]);
const forbiddenHeader =
  /^(host|connection|content-length|transfer-encoding|proxy-.*|forwarded|x-forwarded-.*)$/i;
export function publicEnvironment(
  configuration: FrozenConfiguration,
): Record<string, JsonValue> {
  const content = configuration.environment.content;
  if (content.kind !== 'environment')
    throw new Error('Frozen environment type mismatch');
  return { ...content.variables, baseUrls: content.baseUrls };
}
function scalar(value: unknown): string {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return String(value);
  throw new DomainError(
    'PRECONDITIONS_MISSING',
    '请求字段缺少明确标量变量。',
    422,
  );
}
export function requestFor(
  content: z.infer<typeof apiCaseContentSchema>,
  phase: ApiPhase,
  stepId: string,
) {
  if (phase === 'business') {
    const step = content.steps.find((item) => item.stepId === stepId);
    if (step) return step;
  }
  if (phase === 'cleanupHttp' && content.cleanup.mode !== 'none') {
    const step = content.cleanup.steps.find(
      (item) => item.cleanupStepId === stepId,
    );
    if (step?.type === 'http') return step.request;
  }
  throw new DomainError('NOT_FOUND', '没有该快照内的请求步骤。', 404);
}
export function profileFor(
  configuration: FrozenConfiguration,
  step: z.infer<typeof apiRequestStepSchema>,
) {
  const binding = step.purposeRef
    ? configuration.bindings.find(
        (binding) => binding.purpose.id === step.purposeRef,
      )
    : undefined;
  if (step.purposeRef && !binding)
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '本轮缺少该用途的固定账号绑定。',
      422,
    );
  const profile = step.authProfileRef
    ? configuration.profiles.find(
        (profile) => profile.id === step.authProfileRef,
      )
    : binding?.profile;
  if (step.authProfileRef && !profile)
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '本轮缺少明确认证配置。',
      422,
    );
  if (profile && profile.content.kind !== 'authProfile')
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '固定认证配置类型不匹配。',
      422,
    );
  if (
    step.authProfileRef &&
    binding &&
    binding.profile?.id !== step.authProfileRef
  )
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '认证配置与用途绑定不一致。',
      422,
    );
  if (
    profile?.content.kind === 'authProfile' &&
    profile.content.authentication.mode === 'login' &&
    !binding
  )
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '登录认证必须明确当前请求自身用途。',
      422,
    );
  const credentialRef: string | null =
    profile &&
    'credentialRef' in profile &&
    typeof profile.credentialRef === 'string'
      ? profile.credentialRef
      : (binding?.profileCredentialRef ?? null);
  return {
    binding,
    profile,
    credentialRef,
    cacheKey: profile ? `${profile.id}:${step.purposeRef ?? 'direct'}` : null,
  };
}
export class ExecutionGateway {
  constructor(
    readonly configurations: TestConfigurationService,
    readonly secrets: SecretBroker,
    readonly policy: TargetPolicy = localTargetPolicy,
  ) {}
  actionConfiguration(
    configuration: FrozenConfiguration,
    step?: z.infer<typeof apiRequestStepSchema>,
    connectionId?: string,
  ): FrozenConfiguration {
    return {
      environment: configuration.environment,
      bindings: step?.purposeRef
        ? configuration.bindings.filter(
            (binding) => binding.purpose.id === step.purposeRef,
          )
        : [],
      profiles: step?.authProfileRef
        ? configuration.profiles.filter(
            (profile) => profile.id === step.authProfileRef,
          )
        : [],
      connections: connectionId
        ? configuration.connections.filter(
            (connection) => connection.id === connectionId,
          )
        : [],
    };
  }
  async validateConfiguration(
    transaction: SqlExecutor,
    projectId: string,
    configuration: FrozenConfiguration,
  ) {
    const expected = [
      configuration.environment,
      ...configuration.bindings.flatMap((binding) => [
        binding.purpose,
        binding.binding,
        binding.account,
        ...(binding.profile ? [binding.profile] : []),
      ]),
      ...configuration.connections,
      ...configuration.profiles,
    ];
    const rows = await transaction.query<{
      id: string;
      active: boolean;
      credential_ref: string | null;
    }>(
      'SELECT id,active,credential_ref FROM app.test_configurations WHERE project_id=$1 AND id=ANY($2::uuid[]) FOR SHARE',
      [projectId, [...new Set(expected.map((entry) => entry.id))]],
    );
    const current = new Map(rows.rows.map((entry) => [entry.id, entry]));
    for (const entry of expected)
      if (!current.get(entry.id)?.active)
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '本轮目标环境或绑定配置已停用，不再访问。',
          422,
        );
    const references = [
      ...configuration.bindings.flatMap((binding) => [
        { id: binding.account.id, ref: binding.accountCredentialRef },
        ...(binding.profileCredentialRef && binding.profile
          ? [{ id: binding.profile.id, ref: binding.profileCredentialRef }]
          : []),
      ]),
      ...configuration.connections.map((connection) => ({
        id: connection.id,
        ref: connection.credentialRef,
      })),
      ...configuration.profiles.flatMap((profile) =>
        profile.credentialRef
          ? [{ id: profile.id, ref: profile.credentialRef }]
          : [],
      ),
    ];
    for (const entry of references)
      if (current.get(entry.id)?.credential_ref !== entry.ref)
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '本轮凭据已撤销或被替换，不会注入新账号/凭据。',
          422,
        );
  }
  private credential(reference: string, id: string, transaction?: SqlExecutor) {
    return transaction
      ? this.configurations.resolveTargetCredentialInTransaction(
          transaction,
          reference,
          id,
        )
      : this.configurations.resolveTargetCredential(reference, id);
  }
  async protectedValues(
    configuration: FrozenConfiguration,
    transaction?: SqlExecutor,
  ): Promise<string[]> {
    const entries = [
      ...configuration.bindings.flatMap((binding) => [
        { id: binding.account.id, ref: binding.accountCredentialRef },
        ...(binding.profileCredentialRef && binding.profile
          ? [{ id: binding.profile.id, ref: binding.profileCredentialRef }]
          : []),
      ]),
      ...configuration.connections.map((connection) => ({
        id: connection.id,
        ref: connection.credentialRef,
      })),
      ...configuration.profiles.flatMap((profile) =>
        profile.credentialRef
          ? [{ id: profile.id, ref: profile.credentialRef }]
          : [],
      ),
    ];
    const values: string[] = [];
    for (const entry of entries) {
      try {
        const raw = await this.credential(entry.ref, entry.id, transaction);
        const credential = credentialSchema.parse(JSON.parse(raw) as unknown);
        values.push(...Object.values(credential));
      } catch {
        /* Revoked secrets are never injected; caller validates before sends. */
      }
    }
    return [...new Set(values)].filter(Boolean);
  }
  private safeDestination(url: URL, configuration: FrozenConfiguration): void {
    const environment = configuration.environment.content;
    if (environment.kind !== 'environment')
      throw new Error('Environment missing');
    const bases = Object.values(environment.baseUrls).map(
      (value) => new URL(value),
    );
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      !this.policy.httpOrigins.includes(url.origin) ||
      !bases.some(
        (base) =>
          url.origin === base.origin &&
          (base.pathname === '/' ||
            url.pathname === base.pathname ||
            url.pathname.startsWith(`${base.pathname.replace(/\/$/, '')}/`)),
      )
    ) {
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '请求目的地不在本轮环境及部署允许清单中，未发送。',
        422,
      );
    }
  }
  private url(value: string, configuration: FrozenConfiguration): URL {
    const environment = configuration.environment.content;
    if (environment.kind !== 'environment')
      throw new Error('Environment missing');
    const bases = Object.values(environment.baseUrls);
    let url: URL;
    try {
      url =
        value.startsWith('/') && !value.startsWith('//') && bases.length === 1
          ? new URL(value, bases[0])
          : new URL(value);
    } catch {
      throw new DomainError(
        'VALIDATION_ERROR',
        '请求URL无效或存在不明确的环境基地址。',
        400,
      );
    }
    this.safeDestination(url, configuration);
    return url;
  }
  async http(
    configuration: FrozenConfiguration,
    step: z.infer<typeof apiRequestStepSchema>,
    variables: RuntimeVariables,
    token?: string,
    transaction?: SqlExecutor,
  ): Promise<HttpTransport> {
    const context = await this.runtimeContext(
      configuration,
      step,
      variables,
      token,
      transaction,
    );
    const url = this.url(scalar(interpolate(step.url, context)), configuration);
    for (const field of step.query)
      url.searchParams.append(
        field.name,
        scalar(interpolate(field.value, context)),
      );
    const headers: Record<string, string> = {};
    for (const header of step.headers) {
      const name = header.name.toLowerCase();
      const value = scalar(interpolate(header.value, context));
      if (
        forbiddenHeader.test(name) ||
        /[\r\n\0]/.test(name + value) ||
        headers[name] !== undefined
      )
        throw new DomainError(
          'VALIDATION_ERROR',
          '请求头重复或包含受限传输字段。',
          400,
        );
      headers[name] = value;
    }
    const selected = profileFor(configuration, step);
    if (selected.profile?.content.kind === 'authProfile') {
      const auth = selected.profile.content.authentication;
      let value = token;
      if (auth.mode === 'token') {
        if (!selected.credentialRef)
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '缺少本轮固定Token凭据。',
            422,
          );
        const credential = credentialSchema.parse(
          JSON.parse(
            await this.credential(
              selected.credentialRef,
              selected.profile.id,
              transaction,
            ),
          ) as unknown,
        );
        if (!('value' in credential))
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            'Token凭据类型不匹配。',
            422,
          );
        value = credential.value;
      }
      if (value === undefined)
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '本用例尚未取得明确登录Token。',
          422,
        );
      const injected = auth.destination.prefix + value;
      if (/[\r\n\0]/.test(injected))
        throw new DomainError(
          'VALIDATION_ERROR',
          '认证值不能包含传输控制字符。',
          400,
        );
      if (
        auth.destination.location === 'header' &&
        forbiddenHeader.test(auth.destination.name)
      )
        throw new DomainError(
          'VALIDATION_ERROR',
          '认证配置不能覆盖受限传输头。',
          400,
        );
      if (auth.destination.location === 'query')
        url.searchParams.set(auth.destination.name, injected);
      else if (auth.destination.location === 'cookie')
        headers.cookie = `${auth.destination.name}=${encodeURIComponent(injected)}`;
      else headers[auth.destination.name.toLowerCase()] = injected;
    }
    let body: string | null = null;
    if (step.body.format === 'json') {
      body = JSON.stringify(interpolate(step.body.value, context));
      headers['content-type'] ??= 'application/json';
    } else if (step.body.format === 'text') {
      body = scalar(interpolate(step.body.value, context));
      headers['content-type'] ??= step.body.mediaType;
    } else if (step.body.format === 'form') {
      const fields = new URLSearchParams();
      for (const field of step.body.fields)
        fields.append(field.name, scalar(interpolate(field.value, context)));
      body = fields.toString();
      headers['content-type'] ??= 'application/x-www-form-urlencoded';
    }
    if (['GET', 'HEAD'].includes(step.method) && body !== null)
      throw new DomainError(
        'VALIDATION_ERROR',
        'GET/HEAD不能携带此传输body。',
        400,
      );
    return {
      type: 'http',
      url: url.href,
      method: step.method,
      headers,
      body,
      timeoutMs: step.timeoutMs ?? 30000,
    };
  }
  private async runtimeContext(
    configuration: FrozenConfiguration,
    step: z.infer<typeof apiRequestStepSchema>,
    variables: RuntimeVariables,
    token?: string,
    transaction?: SqlExecutor,
  ) {
    const selected = profileFor(configuration, step);
    const auth: Record<string, JsonValue> = {};
    if (selected.binding) {
      const credential = credentialSchema.parse(
        JSON.parse(
          await this.credential(
            selected.binding.accountCredentialRef,
            selected.binding.account.id,
            transaction,
          ),
        ) as unknown,
      );
      if ('username' in credential) {
        auth.username = credential.username;
        auth.password = credential.password;
      }
    }
    if (token !== undefined) auth.token = token;
    if (
      selected.profile?.content.kind === 'authProfile' &&
      selected.profile.content.authentication.mode === 'token' &&
      selected.credentialRef
    ) {
      const credential = credentialSchema.parse(
        JSON.parse(
          await this.credential(
            selected.credentialRef,
            selected.profile.id,
            transaction,
          ),
        ) as unknown,
      );
      if ('value' in credential) auth.token = credential.value;
    }
    return {
      ...contextVariables(publicEnvironment(configuration), variables),
      auth,
    };
  }
  async runtimeAssertions(
    configuration: FrozenConfiguration,
    step: z.infer<typeof apiRequestStepSchema>,
    variables: RuntimeVariables,
    token?: string,
    transaction?: SqlExecutor,
  ) {
    const context = await this.runtimeContext(
      configuration,
      step,
      variables,
      token,
      transaction,
    );
    return step.assertions.map((assertion) => ({
      ...assertion,
      ...(assertion.expected === undefined
        ? {}
        : { expected: interpolate(assertion.expected, context) }),
    }));
  }
  async login(
    configuration: FrozenConfiguration,
    step: z.infer<typeof apiRequestStepSchema>,
    transaction?: SqlExecutor,
  ): Promise<{
    transport: HttpTransport;
    extractor: { source: 'json' | 'header' | 'body'; path: string };
  }> {
    const selected = profileFor(configuration, step);
    const profile = selected.profile;
    if (
      !selected.binding ||
      profile?.content.kind !== 'authProfile' ||
      profile.content.authentication.mode !== 'login'
    )
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '请求没有明确的本轮登录用途。',
        422,
      );
    const definition = profile.content.authentication;
    const credential = credentialSchema.parse(
      JSON.parse(
        await this.credential(
          selected.binding.accountCredentialRef,
          selected.binding.account.id,
          transaction,
        ),
      ) as unknown,
    );
    if (!('username' in credential))
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '账号凭据类型不匹配。',
        422,
      );
    const environment = configuration.environment.content;
    if (environment.kind !== 'environment')
      throw new Error('Environment missing');
    const base = environment.baseUrls[definition.baseUrlName];
    if (!base)
      throw new DomainError('PRECONDITIONS_MISSING', '登录服务地址缺失。', 422);
    const url = new URL(definition.path, base);
    this.safeDestination(url, configuration);
    const context = { account: credential, credential };
    const headers = Object.fromEntries(
      Object.entries(definition.headers).map(([name, value]) => [
        name.toLowerCase(),
        scalar(interpolate(value, context)),
      ]),
    );
    if (
      Object.entries(headers).some(
        ([name, value]) =>
          forbiddenHeader.test(name) || /[\r\n\0]/.test(name + value),
      )
    )
      throw new DomainError(
        'VALIDATION_ERROR',
        '登录请求头包含受限内容。',
        400,
      );
    headers['content-type'] ??= 'application/json';
    const body = interpolate(definition.bodyTemplate, context);
    if (definition.method === 'GET') {
      if (body === null || typeof body !== 'object' || Array.isArray(body))
        throw new DomainError(
          'VALIDATION_ERROR',
          'GET登录参数须为明确键值材料。',
          400,
        );
      for (const [name, value] of Object.entries(body))
        url.searchParams.append(name, scalar(value));
    }
    return {
      transport: {
        type: 'http',
        url: url.href,
        method: definition.method,
        headers,
        body: definition.method === 'GET' ? null : JSON.stringify(body),
        timeoutMs: 30000,
      },
      extractor: definition.extractor,
    };
  }
  async sql(
    configuration: FrozenConfiguration,
    step: z.infer<typeof cleanupSqlStepSchema>,
    variables: RuntimeVariables,
    transaction?: SqlExecutor,
  ): Promise<SqlTransport> {
    const connection = configuration.connections.find(
      (entry) => entry.id === step.connectionId,
    );
    if (!connection || connection.content.kind !== 'databaseConnection')
      throw new DomainError('PRECONDITIONS_MISSING', '本轮无该清理连接。', 422);
    const target = connection.content;
    if (
      step.environmentId !== configuration.environment.id ||
      step.driver !== target.driver ||
      target.database === 'aitesthub' ||
      !this.policy.sqlTargets.some(
        (allowed) =>
          allowed.driver === target.driver &&
          allowed.host === target.host &&
          allowed.port === target.port &&
          allowed.database === target.database,
      )
    )
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        'SQL目标不在部署允许的独立测试库范围，平台业务库不可选。',
        422,
      );
    const compiled = compileCleanupSql(
      step.driver,
      step.statement,
      step.parameters,
      step.requiredTargets,
      contextVariables(publicEnvironment(configuration), variables),
    );
    const credential = credentialSchema.parse(
      JSON.parse(
        await this.credential(
          connection.credentialRef,
          connection.id,
          transaction,
        ),
      ) as unknown,
    );
    if (!('username' in credential))
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '清理连接凭据类型不匹配。',
        422,
      );
    return {
      type: 'sql',
      driver: step.driver,
      host: target.host,
      port: target.port,
      database: target.database,
      tls: target.tls,
      username: credential.username,
      password: credential.password,
      statement: compiled.statement,
      values: compiled.values,
      timeoutMs: 15000,
    };
  }
}
