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
import { DomainError } from '../errors.js';
import type { BusinessToolRegistry } from './registry.js';

/** Non-secret project configuration only. No broker, credential write/read, global models or personal keys. */
export function registerInternalConfigurationTools(
  registry: BusinessToolRegistry,
  configuration: TestConfigurationService,
): void {
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
      undefined,
      true,
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
      undefined,
      true,
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
        undefined,
        true,
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
      undefined,
      true,
    );
  }
}
