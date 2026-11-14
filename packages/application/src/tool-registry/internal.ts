import { z } from 'zod';
import { prepareRequirementVersionResourceInputSchema as prepareRequirementVersionInputSchema } from '../../../contracts/src/preparation.js';
import { registerRequirementStateTools } from './requirement-state.js';
import {
  idSchema,
  commandIdSchema,
  persistedRowVersionSchema,
} from '../../../contracts/src/base.js';
import { updateMemberInputSchema } from '../../../contracts/src/identity.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import {
  createRequirementResourceInputSchema as createRequirementInputSchema,
  addRequirementVersionResourceInputSchema as addRequirementVersionInputSchema,
  requirementParticipantsInputSchema,
} from '../../../contracts/src/requirements.js';
import type { Database } from '../../../persistence/src/database.js';
import { RequirementService } from '../requirements/service.js';
import { ProjectService } from '../projects/service.js';
import { OperationService } from '../operations/service.js';
import { DomainError } from '../errors.js';
import type { BusinessToolRegistry } from './registry.js';

/** These capabilities have their own internal exposure list. They are not added to official MCP. */
export function registerInternalTools(
  registry: BusinessToolRegistry,
  db: Database,
): void {
  const requirements = new RequirementService(db);
  const projects = new ProjectService(db);
  const target = { projectId: idSchema, requirementId: idSchema };
  const description =
    '明确目标项目内查询/维护需求材料、参与和状态；写目标与聊天归属、浏览项目分别处理。';
  const add = <S extends z.ZodType>(
    name: string,
    op: string,
    schema: S,
    access: 'read' | 'write',
    execute: (actor: ActorContext, input: z.infer<S>) => Promise<unknown>,
  ) =>
    registry.add(
      name,
      description,
      op,
      schema,
      access,
      execute,
      undefined,
      true,
    );
  add(
    'ath_requirement_materials',
    'create',
    z.strictObject({
      op: z.literal('create'),
      projectId: idSchema,
      input: createRequirementInputSchema,
    }),
    'write',
    (a, i) => requirements.create(a, i.input),
  );
  add(
    'ath_requirement_materials',
    'commit-version',
    z.strictObject({
      op: z.literal('commit-version'),
      ...target,
      input: addRequirementVersionInputSchema,
    }),
    'write',
    (a, i) => requirements.addVersion(a, i.projectId, i.requirementId, i.input),
  );
  add(
    'ath_requirement_materials',
    'get-manifest',
    z.strictObject({ op: z.literal('get-manifest'), ...target }),
    'read',
    async (a, i) => ({
      versions: (await requirements.detail(a, i.projectId, i.requirementId))
        .versions,
    }),
  );
  add(
    'ath_requirement_membership',
    'get',
    z.strictObject({ op: z.literal('get'), ...target }),
    'read',
    async (a, i) => ({
      participants: (await requirements.detail(a, i.projectId, i.requirementId))
        .participants,
    }),
  );
  add(
    'ath_requirement_membership',
    'set',
    z.strictObject({
      op: z.literal('set'),
      ...target,
      input: requirementParticipantsInputSchema,
    }),
    'write',
    (a, i) =>
      requirements.participants(a, i.projectId, i.requirementId, i.input),
  );
  registerRequirementStateTools(registry, db, true);
  add(
    'ath_requirement_materials',
    'prepare-version',
    z.union(
      prepareRequirementVersionInputSchema.options.map((schema) =>
        schema.extend({ op: z.literal('prepare-version') }),
      ),
    ),
    'read',
    (a, i) => {
      const { op, ...body } = i;
      return requirements.prepareVersion(a, body);
    },
  );
  add(
    'ath_project_members',
    'list',
    z.strictObject({ op: z.literal('list'), projectId: idSchema }),
    'read',
    (a, i) => projects.members(a, i.projectId),
  );
  add(
    'ath_project_members',
    'candidates',
    z.strictObject({
      op: z.literal('candidates'),
      projectId: idSchema,
      search: z.string().trim().min(2).max(200),
    }),
    'read',
    (a, i) => projects.memberCandidates(a, i.projectId, i.search),
  );
  const operations = new OperationService(db);
  const lookup = z.union([
    z.strictObject({ op: z.literal('get'), commandId: idSchema }),
    z.strictObject({
      op: z.literal('get'),
      operation: z.string().regex(/^[a-z][a-z0-9.-]{0,127}$/),
      key: commandIdSchema,
    }),
  ]);
  add('ath_operation_status', 'get', lookup, 'read', async (a, i) => {
    const result = await operations.get(
      a,
      'commandId' in i
        ? { commandId: i.commandId }
        : { operation: i.operation, key: i.key },
    );
    if (
      !result.command.projectId ||
      !/^(?:requirements?|assets?|reviews?|plans?|api-runs?|schedules?|test-configuration|database-connections|ui-executions?|files?|results?|reports?|problems?|issues?|retests?|knowledge)\./.test(
        result.command.operation,
      )
    )
      throw new DomainError(
        'NOT_FOUND',
        '此工具不读取私聊或全局管理命令。',
        404,
      );
    return result;
  });
  // A model can only propose member changes; the platform UI records the actual user's explicit authorization.
  registry.add(
    'ath_project_members',
    '当前管理权限内的项目成员管理；修改需要实际用户明确授权，官方MCP不提供。',
    'set',
    z.strictObject({
      op: z.literal('set'),
      projectId: idSchema,
      userId: idSchema,
      input: updateMemberInputSchema,
    }),
    'write',
    async (a, i) => {
      await projects.updateMember(a, i.projectId, i.userId, i.input);
      return { updated: true, userId: i.userId };
    },
    async (a, i) => ({
      reason: 'human-decision',
      summary: '授权以下精确成员/角色变更；不会改变其他成员或全局设置。',
      scope: { current: await projects.members(a, i.projectId), requested: i },
      links: [`/?projectId=${i.projectId}&page=members`],
    }),
    true,
  );
  registry.add(
    'ath_project_members',
    '当前管理权限内的项目成员管理；修改需要实际用户明确授权，官方MCP不提供。',
    'remove',
    z.strictObject({
      op: z.literal('remove'),
      projectId: idSchema,
      userId: idSchema,
      rowVersion: persistedRowVersionSchema,
    }),
    'write',
    async (a, i) => {
      await projects.removeMember(a, i.projectId, i.userId, i.rowVersion);
      return { removed: true, userId: i.userId };
    },
    async (a, i) => ({
      reason: 'impact',
      summary: '移除此项目成员；立即影响其后续项目访问，已有历史保留。',
      scope: { current: await projects.members(a, i.projectId), requested: i },
      links: [`/?projectId=${i.projectId}&page=members`],
    }),
    true,
  );
}
