import { z } from 'zod';
import {
  idSchema,
  commandIdSchema,
  persistedRowVersionSchema,
} from '../../../contracts/src/base.js';
import {
  configurationKindSchema,
  saveTestConfigurationInputSchema,
} from '../../../contracts/src/test-configuration.js';
import type { TestConfigurationService } from '../test-configuration/service.js';
import { requireProject } from '../access/policy.js';
import { canonicalJson } from '../operations/service.js';
import { DomainError } from '../errors.js';
import type { BusinessToolRegistry } from './registry.js';

/** Non-secret project configuration only. No broker, credential write/read, global models or personal keys. */
export function registerInternalConfigurationTools(
  registry: BusinessToolRegistry,
  configuration: TestConfigurationService,
): void {
  const requireWrite = (
    actor: Parameters<TestConfigurationService['get']>[0],
    projectId: string,
    database: boolean,
  ) =>
    configuration.db.transaction((tx) =>
      requireProject(
        tx,
        actor,
        projectId,
        database ? 'database-connections.write' : 'test-configuration.write',
      ),
    );
  for (const name of [
    'ath_test_configuration',
    'ath_database_connections',
  ] as const) {
    const databaseOnly = name === 'ath_database_connections';
    const description = databaseOnly
      ? '项目数据库连接非秘密定义；绝不执行任意SQL或读取凭据。'
      : '项目环境/用途/绑定/认证的非秘密配置；凭据通过网页安全输入。';
    registry.add(
      name,
      description,
      'list',
      z.strictObject({
        op: z.literal('list'),
        projectId: idSchema,
        kind: configurationKindSchema.optional(),
      }),
      'read',
      (a, i) =>
        configuration.list(
          a,
          i.projectId,
          databaseOnly ? 'databaseConnection' : i.kind,
        ),
    );
    registry.add(
      name,
      description,
      'get',
      z.strictObject({
        op: z.literal('get'),
        projectId: idSchema,
        id: idSchema,
      }),
      'read',
      (a, i) =>
        configuration.get(
          a,
          i.projectId,
          i.id,
          databaseOnly ? 'databaseConnection' : undefined,
        ),
    );
    if (databaseOnly)
      registry.add(
        name,
        description,
        'metadata',
        z.strictObject({
          op: z.literal('metadata'),
          projectId: idSchema,
          id: idSchema,
        }),
        'read',
        (a, i) => configuration.get(a, i.projectId, i.id, 'databaseConnection'),
      );
    for (const op of ['create', 'update'] as const)
      registry.add(
        name,
        description,
        op,
        z.strictObject({
          op: z.literal(op),
          projectId: idSchema,
          id: op === 'update' ? idSchema : idSchema.optional(),
          input: saveTestConfigurationInputSchema,
        }),
        'write',
        (a, i) => {
          if (databaseOnly && i.input.content.kind !== 'databaseConnection')
            throw new DomainError(
              'VALIDATION_ERROR',
              '此工具只维护数据库连接定义。',
              400,
            );
          return configuration.save(
            a,
            i.projectId,
            op === 'update' ? i.id : undefined,
            i.input,
          );
        },
        async (a, i) => {
          if (op !== 'update' || !i.id) return;
          const { configuration: current } = await configuration.get(
            a,
            i.projectId,
            i.id,
            databaseOnly ? 'databaseConnection' : undefined,
          );
          const {
            name: _beforeName,
            description: _beforeDescription,
            ...before
          } = current.content;
          const {
            name: _afterName,
            description: _afterDescription,
            ...after
          } = i.input.content;
          if (canonicalJson(before) === canonicalJson(after)) return;
          await requireWrite(
            a,
            i.projectId,
            current.content.kind === 'databaseConnection',
          );
          return {
            reason: 'impact',
            summary: '确认项目执行配置的变化及其生效范围。',
            scope: { id: i.id, rowVersion: current.rowVersion, before, after },
            links: [],
          };
        },
      );
    registry.add(
      name,
      description,
      'disable',
      z.strictObject({
        op: z.literal('disable'),
        projectId: idSchema,
        id: idSchema,
        input: z.strictObject({
          commandId: commandIdSchema,
          rowVersion: persistedRowVersionSchema,
        }),
      }),
      'write',
      async (a, i) => {
        const current = await configuration.get(
          a,
          i.projectId,
          i.id,
          databaseOnly ? 'databaseConnection' : undefined,
        );
        return configuration.save(a, i.projectId, i.id, {
          ...i.input,
          content: { ...current.configuration.content, active: false },
        });
      },
      async (a, i) => {
        const { configuration: current } = await configuration.get(
          a,
          i.projectId,
          i.id,
          databaseOnly ? 'databaseConnection' : undefined,
        );
        await requireWrite(
          a,
          i.projectId,
          current.content.kind === 'databaseConnection',
        );
        return {
          reason: 'impact',
          summary: '确认停用此项目测试配置。',
          scope: {
            id: i.id,
            rowVersion: current.rowVersion,
            name: current.content.name,
            kind: current.content.kind,
            active: current.content.active,
          },
          links: [],
        };
      },
    );
  }
}
