import { z } from 'zod';
import { idSchema, commandIdSchema } from '../../../contracts/src/base.js';
import {
  requirementStateInputSchema,
  requirementArchiveInputSchema,
} from '../../../contracts/src/requirements.js';
import { requirementDeletionInputSchema } from '../../../contracts/src/requirement-deletion.js';
import type { Database } from '../../../persistence/src/database.js';
import { RequirementService } from '../requirements/service.js';
import type { BusinessToolRegistry } from './registry.js';

/** One application service for Web, native AI and official MCP. Delete always uses impact confirmation. */
export function registerRequirementStateTools(
  registry: BusinessToolRegistry,
  db: Database,
  internalOnly = false,
) {
  if (registry.tools.has('ath_requirement_state')) return;
  const requirements = new RequirementService(db),
    target = { projectId: idSchema, requirementId: idSchema },
    name = 'ath_requirement_state',
    description =
      '管理当前项目需求归档/恢复；长期未活跃只由服务派生不可手工设置；状态与归档入口都要求测试归档权限；永久删除仅限无受保护历史且已核对精确影响的需求。';
  registry.add(
    name,
    description,
    'lifecycle',
    z.strictObject({
      op: z.literal('lifecycle'),
      ...target,
      input: requirementStateInputSchema,
    }),
    'write',
    (a, i) => requirements.setState(a, i.projectId, i.requirementId, i.input),
    undefined,
    internalOnly,
  );
  registry.add(
    name,
    description,
    'archive',
    z.strictObject({
      op: z.literal('archive'),
      ...target,
      input: requirementArchiveInputSchema,
    }),
    'write',
    (a, i) => requirements.archive(a, i.projectId, i.requirementId, i.input),
    undefined,
    internalOnly,
  );
  registry.add(
    name,
    description,
    'delete-preview',
    z.strictObject({ op: z.literal('delete-preview'), ...target }),
    'read',
    (a, i) => requirements.previewDeletion(a, i.projectId, i.requirementId),
    undefined,
    internalOnly,
  );
  registry.add(
    name,
    description,
    'deletion-receipt',
    z.strictObject({
      op: z.literal('deletion-receipt'),
      ...target,
      commandId: commandIdSchema,
    }),
    'read',
    (a, i) =>
      requirements.deletionReceipt(
        a,
        i.projectId,
        i.requirementId,
        i.commandId,
      ),
    undefined,
    internalOnly,
  );
  registry.add(
    name,
    description,
    'delete-if-no-history',
    z.strictObject({
      op: z.literal('delete-if-no-history'),
      ...target,
      input: requirementDeletionInputSchema,
    }),
    'write',
    (a, i) =>
      requirements.deleteUnused(a, i.projectId, i.requirementId, i.input),
    (a, i) =>
      requirements.deletions.confirmation(
        a,
        i.projectId,
        i.requirementId,
        i.input,
      ),
    internalOnly,
  );
}
