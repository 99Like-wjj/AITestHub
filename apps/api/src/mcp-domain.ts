import type { McpServer, CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  idSchema,
  commandIdSchema,
  persistedRowVersionSchema,
} from '../../../packages/contracts/src/base.js';
import type { ActorContext } from '../../../packages/contracts/src/identity.js';
import { fileRegistrationSchema } from '../../../packages/contracts/src/domain.js';
import {
  createRequirementResourceInputSchema as createRequirementInputSchema,
  addRequirementVersionResourceInputSchema as addRequirementVersionInputSchema,
  requirementParticipantsInputSchema,
} from '../../../packages/contracts/src/requirements.js';
import {
  configurationKindSchema,
  saveTestConfigurationInputSchema,
} from '../../../packages/contracts/src/test-configuration.js';
import type { Database } from '../../../packages/persistence/src/database.js';
import { RequirementService } from '../../../packages/application/src/requirements/service.js';
import type { FilesService } from '../../../packages/application/src/files/service.js';
import type { TestConfigurationService } from '../../../packages/application/src/test-configuration/service.js';
import { DomainError } from '../../../packages/application/src/errors.js';
import type { BusinessServices } from '../../../packages/application/src/tool-registry/business.js';
import {
  prepareRequirementVersionResourceInputSchema as prepareRequirementVersionInputSchema,
  missingFileTransfersInputSchema,
} from '../../../packages/contracts/src/preparation.js';
import {
  fileCapabilityQuerySchema,
  submissionCapabilityQuerySchema,
} from '../../../packages/contracts/src/file-resources.js';

export interface DomainMcpServices extends BusinessServices {
  files?: FilesService;
  testConfiguration?: TestConfigurationService;
}
type SecureCall = (work: () => Promise<unknown>) => Promise<CallToolResult>;
const target = { projectId: idSchema, requirementId: idSchema };
const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Transport mapping only. Current authorization, versions and idempotency remain in application services. */
export function registerDomainTools(
  server: McpServer,
  db: Database,
  actor: ActorContext,
  call: SecureCall,
  services: DomainMcpServices,
) {
  const requirements = new RequirementService(db);
  server.registerTool(
    'ath_requirement_materials',
    {
      description:
        '读取材料清单或幂等提交新需求/新版本。材料必须已完整上传；不接受本地路径或二进制。',
      inputSchema: z.union([
        prepareRequirementVersionInputSchema.options[0].extend({
          op: z.literal('prepare-version'),
        }),
        prepareRequirementVersionInputSchema.options[1].extend({
          op: z.literal('prepare-version'),
        }),
        z.strictObject({
          op: z.literal('get-manifest'),
          ...target,
          requirementVersionId: idSchema.optional(),
        }),
        z.strictObject({
          op: z.literal('commit-version'),
          target: z.literal('new'),
          input: createRequirementInputSchema,
        }),
        z.strictObject({
          op: z.literal('commit-version'),
          target: z.literal('existing'),
          ...target,
          input: addRequirementVersionInputSchema,
        }),
      ]),
      annotations: writeAnnotations,
    },
    async (input) =>
      call(async () => {
        if (input.op === 'prepare-version') {
          const { op, ...body } = input;
          return requirements.prepareVersion(actor, body);
        }
        if (input.op === 'get-manifest') {
          const detail = await requirements.detail(
            actor,
            input.projectId,
            input.requirementId,
          );
          if (
            input.requirementVersionId &&
            !detail.versions.some(
              (version) => version.id === input.requirementVersionId,
            )
          ) {
            throw new DomainError('NOT_FOUND', '此需求内没有该材料版本。', 404);
          }
          return {
            versions: input.requirementVersionId
              ? detail.versions.filter(
                  (version) => version.id === input.requirementVersionId,
                )
              : detail.versions,
          };
        }
        return input.target === 'new'
          ? requirements.create(actor, input.input)
          : requirements.addVersion(
              actor,
              input.projectId,
              input.requirementId,
              input.input,
            );
      }),
  );
  server.registerTool(
    'ath_requirement_membership',
    {
      description: '本项目需求参与名单。修改名单不增加角色，不刷新业务活跃。',
      inputSchema: z.discriminatedUnion('op', [
        z.strictObject({ op: z.literal('get'), ...target }),
        z.strictObject({
          op: z.literal('set'),
          ...target,
          input: requirementParticipantsInputSchema,
        }),
      ]),
      annotations: writeAnnotations,
    },
    async (input) =>
      call(async () => {
        if (input.op === 'set')
          return requirements.participants(
            actor,
            input.projectId,
            input.requirementId,
            input.input,
          );
        const detail = await requirements.detail(
          actor,
          input.projectId,
          input.requirementId,
        );
        return {
          requirementId: detail.requirement.id,
          rowVersion: detail.requirement.rowVersion,
          participants: detail.participants,
        };
      }),
  );
  // ath_requirement_state is registered through the common business registry so permanent
  // deletion uses the same durable impact/MRTR confirmation as native AI, never a model boolean.

  const files = services.files;
  if (files)
    server.registerTool(
      'ath_file_transfers',
      {
        description:
          '登记整文件上传或查询验证回执。返回独立字节通道路径，未验证前不视为可引用。',
        inputSchema: z.discriminatedUnion('op', [
          z.strictObject({
            op: z.literal('capabilities'),
            input: fileCapabilityQuerySchema,
          }),
          z.strictObject({
            op: z.literal('submission-capabilities'),
            input: submissionCapabilityQuerySchema,
          }),
          z.strictObject({
            op: z.literal('prepare-ticket'),
            input: fileRegistrationSchema,
          }),
          z.strictObject({ op: z.literal('receipt'), fileId: idSchema }),
          z.strictObject({ op: z.literal('verify'), fileId: idSchema }),
          missingFileTransfersInputSchema.extend({ op: z.literal('missing') }),
        ]),
        annotations: writeAnnotations,
      },
      async (input) =>
        call(async () => {
          if (
            input.op === 'capabilities' ||
            input.op === 'submission-capabilities'
          )
            return files.capabilities(actor, input.input);
          if (input.op === 'missing')
            return files.missing(actor, { fileIds: input.fileIds });
          const result =
            input.op === 'prepare-ticket'
              ? await files.register(actor, input.input)
              : await files.metadata(actor, input.fileId);
          return {
            ...result,
            fullUploadPath: `/api/v1/files/${result.file.id}/content`,
            downloadPath: `/api/v1/files/${result.file.id}/content`,
            verified: result.file.status === 'verified',
            binaryThroughMcp: false,
          };
        }),
    );

  const configuration = services.testConfiguration;
  if (!configuration) return;
  const configurationInput = z.discriminatedUnion('op', [
    z.strictObject({
      op: z.literal('list'),
      projectId: idSchema,
      kind: configurationKindSchema.optional(),
    }),
    z.strictObject({ op: z.literal('get'), projectId: idSchema, id: idSchema }),
    z.strictObject({
      op: z.literal('create'),
      projectId: idSchema,
      input: saveTestConfigurationInputSchema,
    }),
    z.strictObject({
      op: z.literal('update'),
      projectId: idSchema,
      id: idSchema,
      input: saveTestConfigurationInputSchema,
    }),
    z.strictObject({
      op: z.literal('disable'),
      projectId: idSchema,
      id: idSchema,
      input: z.strictObject({
        commandId: commandIdSchema,
        rowVersion: persistedRowVersionSchema,
      }),
    }),
  ]);
  server.registerTool(
    'ath_test_configuration',
    {
      description:
        '维护项目环境/用途/账号/绑定/认证的非秘密配置；凭据只在网页安全输入，SQL不在此执行。',
      inputSchema: configurationInput,
      annotations: writeAnnotations,
    },
    async (input) =>
      call(async () => {
        if (input.op === 'list')
          return configuration.list(actor, input.projectId, input.kind);
        if (input.op === 'get')
          return configuration.get(actor, input.projectId, input.id);
        if (input.op === 'disable') {
          const current = await configuration.get(
            actor,
            input.projectId,
            input.id,
          );
          return configuration.save(actor, input.projectId, input.id, {
            ...input.input,
            content: { ...current.configuration.content, active: false },
          });
        }
        return configuration.save(
          actor,
          input.projectId,
          input.op === 'update' ? input.id : undefined,
          input.input,
        );
      }),
  );
  server.registerTool(
    'ath_database_connections',
    {
      description:
        '读取/维护本项目数据库连接非秘密定义，权限按业务角色，不能执行任意SQL或读取凭据。',
      inputSchema: z.discriminatedUnion('op', [
        z.strictObject({ op: z.literal('list'), projectId: idSchema }),
        z.strictObject({
          op: z.literal('metadata'),
          projectId: idSchema,
          id: idSchema,
        }),
        z.strictObject({
          op: z.literal('create'),
          projectId: idSchema,
          input: saveTestConfigurationInputSchema,
        }),
        z.strictObject({
          op: z.literal('update'),
          projectId: idSchema,
          id: idSchema,
          input: saveTestConfigurationInputSchema,
        }),
        z.strictObject({
          op: z.literal('disable'),
          projectId: idSchema,
          id: idSchema,
          input: z.strictObject({
            commandId: commandIdSchema,
            rowVersion: persistedRowVersionSchema,
          }),
        }),
      ]),
      annotations: writeAnnotations,
    },
    async (input) =>
      call(async () => {
        if (input.op === 'list')
          return configuration.list(
            actor,
            input.projectId,
            'databaseConnection',
          );
        if (input.op === 'metadata') {
          const result = await configuration.get(
            actor,
            input.projectId,
            input.id,
            'databaseConnection',
          );
          if (result.configuration.content.kind !== 'databaseConnection')
            throw new DomainError('NOT_FOUND', '没有此数据库连接。', 404);
          return result;
        }
        if (input.op === 'disable') {
          const current = await configuration.get(
            actor,
            input.projectId,
            input.id,
            'databaseConnection',
          );
          return configuration.save(actor, input.projectId, input.id, {
            ...input.input,
            content: { ...current.configuration.content, active: false },
          });
        }
        if (input.input.content.kind !== 'databaseConnection')
          throw new DomainError(
            'VALIDATION_ERROR',
            '此工具仅维护数据库连接定义。',
            400,
          );
        return configuration.save(
          actor,
          input.projectId,
          input.op === 'update' ? input.id : undefined,
          input.input,
        );
      }),
  );
}
