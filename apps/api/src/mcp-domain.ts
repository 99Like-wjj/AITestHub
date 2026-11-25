import type { McpServer, CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { idSchema } from '../../../packages/contracts/src/base.js';
import type { ActorContext } from '../../../packages/contracts/src/identity.js';
import { fileRegistrationSchema } from '../../../packages/contracts/src/domain.js';
import {
  createRequirementResourceInputSchema as createRequirementInputSchema,
  addRequirementVersionResourceInputSchema as addRequirementVersionInputSchema,
} from '../../../packages/contracts/src/requirements.js';
import type { Database } from '../../../packages/persistence/src/database.js';
import { RequirementService } from '../../../packages/application/src/requirements/service.js';
import type { FilesService } from '../../../packages/application/src/files/service.js';
import type { TestConfigurationService } from '../../../packages/application/src/test-configuration/service.js';
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
  const requirements = new RequirementService(
    db,
    undefined,
    services.auxiliary?.requirementNameAdmission(),
  );
  server.registerTool(
    'ath_requirement_materials',
    {
      description:
        '读取现行资料或固定历史修订，幂等新建需求或编辑未锁定资料。材料必须已完整上传；不接受本地路径或二进制。',
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
        if (input.op === 'get-manifest')
          return requirements.manifest(
            actor,
            input.projectId,
            input.requirementId,
            input.requirementVersionId,
          );
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
}
