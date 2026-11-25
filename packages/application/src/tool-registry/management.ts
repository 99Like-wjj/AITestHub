import { z } from 'zod';
import {
  idSchema,
  persistedRowVersionSchema,
} from '../../../contracts/src/base.js';
import {
  createProjectInputSchema,
  updateMemberInputSchema,
  adminUpdateUserInputSchema,
  removeAccountInputSchema,
  adminUserPageQuerySchema,
  type ActorContext,
} from '../../../contracts/src/identity.js';
import {
  modelServiceUpdateV2Schema,
  auxiliaryModelInputV2Schema,
} from '../../../contracts/src/model-configuration-v2.js';
import { externalServiceUpdateSchema } from '../../../contracts/src/external-mcp.js';
import type { Database } from '../../../persistence/src/database.js';
import {
  requireBusinessAdministrator,
  requireProject,
} from '../access/policy.js';
import { DomainError } from '../errors.js';
import { IdentityService } from '../identity/service.js';
import { ProjectService } from '../projects/service.js';
import type { ConfigurationService } from '../configuration/service.js';
import type { ExternalMcpService } from '../external-mcp/service.js';
import { humanConfirmationExecutionInTransaction } from './human-confirmation.js';
import type { BusinessToolRegistry } from './registry.js';

export interface ManagementServices {
  configuration?: ConfigurationService;
  externalMcp?: ExternalMcpService;
}

const project = { projectId: idSchema };

export function registerManagementTools(
  registry: BusinessToolRegistry,
  db: Database,
  services: ManagementServices,
) {
  const identity = new IdentityService(db);
  const projects = new ProjectService(db);
  const add = registry.add.bind(registry);
  const members =
    '按已授权项目查看成员。set/remove 为精确成员和角色提案，须管理范围和本人网页确认。';
  add(
    'ath_project_members',
    members,
    'list',
    z.strictObject({ op: z.literal('list'), ...project }),
    'read',
    (actor, args) => projects.members(actor, args.projectId),
  );
  add(
    'ath_project_members',
    members,
    'candidates',
    z.strictObject({
      op: z.literal('candidates'),
      ...project,
      search: z.string().trim().min(1).max(100),
    }),
    'read',
    async (actor, args) => {
      const result = await projects.members(actor, args.projectId);
      const query = args.search.toLocaleLowerCase();
      return {
        candidates: result.members.filter(
          (member) =>
            member.active &&
            member.displayName !== member.account &&
            member.displayName.toLocaleLowerCase().includes(query),
        ),
      };
    },
  );
  add(
    'ath_project_members',
    members,
    'set',
    z.strictObject({
      op: z.literal('set'),
      ...project,
      userId: idSchema,
      input: updateMemberInputSchema,
    }),
    'write',
    async (actor, args) => {
      await projects.updateMember(
        actor,
        args.projectId,
        args.userId,
        args.input,
      );
      return { updated: true, userId: args.userId };
    },
    async (actor, args) => {
      await db.transaction((tx) =>
        requireProject(tx, actor, args.projectId, 'project.members.manage'),
      );
      const current = (
        await projects.members(actor, args.projectId)
      ).members.find((member) => member.userId === args.userId);
      return {
        reason: 'human-decision',
        summary: '确认指定项目的成员或角色变更。',
        scope: { current: current ?? null, requested: args },
        links: [],
      };
    },
  );
  add(
    'ath_project_members',
    members,
    'remove',
    z.strictObject({
      op: z.literal('remove'),
      ...project,
      userId: idSchema,
      rowVersion: persistedRowVersionSchema,
    }),
    'write',
    async (actor, args) => {
      await projects.removeMember(
        actor,
        args.projectId,
        args.userId,
        args.rowVersion,
      );
      return { removed: true, userId: args.userId };
    },
    async (actor, args) => {
      await db.transaction((tx) =>
        requireProject(tx, actor, args.projectId, 'project.members.manage'),
      );
      const current = (
        await projects.members(actor, args.projectId)
      ).members.find((member) => member.userId === args.userId);
      return {
        reason: 'impact',
        summary: '确认移除该项目成员，影响其后续项目访问。',
        scope: { current: current ?? null, requested: args },
        links: [],
      };
    },
  );

  const adminName = 'ath_platform_admin';
  const description =
    '仅平台代理当前平台管理员。读取人员和配置的脱敏状态，提出明确管理变更，写入须由本人通过网页确认。';
  async function authorizedWebActor(actor: ActorContext, op?: string) {
    return db.transaction(async (tx) => {
      await requireBusinessAdministrator(tx, actor);
      if (op) {
        const proof = await humanConfirmationExecutionInTransaction(tx, actor);
        if (
          proof?.toolName !== adminName ||
          proof.op !== op ||
          proof.resolutionSource !== 'web-user-event'
        )
          throw new DomainError(
            'FORBIDDEN',
            '此操作须由原提案本人通过网页确认。',
            403,
          );
      }
      return { ...actor, entrypoint: 'web' as const };
    });
  }
  const adminWrite = <S extends z.ZodType>(
    op: string,
    schema: S,
    summary: string,
    execute: (actor: ActorContext, value: z.infer<S>) => Promise<unknown>,
  ) =>
    add(
      adminName,
      description,
      op,
      schema,
      'write',
      async (actor, input) =>
        execute(await authorizedWebActor(actor, op), input),
      async (actor, input) => {
        await db.transaction((tx) => requireBusinessAdministrator(tx, actor));
        return { reason: 'human-decision', summary, scope: input, links: [] };
      },
      false,
      'platform',
    );

  add(
    adminName,
    description,
    'users',
    z.strictObject({ op: z.literal('users'), input: adminUserPageQuerySchema }),
    'read',
    async (actor, args) =>
      identity.businessUserPage(await authorizedWebActor(actor), args.input),
  );
  adminWrite(
    'create-project',
    z.strictObject({
      op: z.literal('create-project'),
      input: createProjectInputSchema,
    }),
    '确认创建项目及初始管理员。',
    (actor, args) => projects.create(actor, args.input),
  );
  adminWrite(
    'update-user',
    z.strictObject({
      op: z.literal('update-user'),
      id: idSchema,
      input: adminUpdateUserInputSchema,
    }),
    '确认变更此账号的有效状态或平台管理角色。',
    (actor, args) => identity.updateUser(actor, args.id, args.input),
  );
  adminWrite(
    'remove-user',
    z.strictObject({
      op: z.literal('remove-user'),
      id: idSchema,
      input: removeAccountInputSchema,
    }),
    '确认移除此账号并检查业务历史保护。',
    (actor, args) => identity.removeUser(actor, args.id, args.input),
  );
  if (services.configuration) {
    const v2 = services.configuration.v2;
    add(
      adminName,
      description,
      'model-status',
      z.strictObject({ op: z.literal('model-status') }),
      'read',
      async (actor) => {
        const { services } = await v2.adminList(
          await authorizedWebActor(actor),
        );
        return {
          services: services.map(({ id, name, enabled, rowVersion }) => ({
            id,
            name,
            enabled,
            rowVersion,
          })),
        };
      },
    );
    add(
      adminName,
      description,
      'auxiliary-status',
      z.strictObject({ op: z.literal('auxiliary-status') }),
      'read',
      async (actor) => v2.getAuxiliary(await authorizedWebActor(actor)),
    );
    adminWrite(
      'update-model',
      z.strictObject({
        op: z.literal('update-model'),
        id: idSchema,
        input: modelServiceUpdateV2Schema,
      }),
      '确认修改所选模型服务的非秘密配置。',
      (actor, args) => v2.update(actor, args.id, args.input),
    );
    adminWrite(
      'update-auxiliary',
      z.strictObject({
        op: z.literal('update-auxiliary'),
        input: auxiliaryModelInputV2Schema,
      }),
      '确认修改辅助模型配置。',
      (actor, args) => v2.setAuxiliary(actor, args.input),
    );
  }
  if (services.externalMcp) {
    const external = services.externalMcp;
    add(
      adminName,
      description,
      'external-status',
      z.strictObject({ op: z.literal('external-status') }),
      'read',
      async (actor) => {
        const { services } = await external.listAdmin(
          await authorizedWebActor(actor),
        );
        return {
          services: services.map(({ id, name, enabled, rowVersion }) => ({
            id,
            name,
            enabled,
            rowVersion,
          })),
        };
      },
    );
    adminWrite(
      'update-external',
      z.strictObject({
        op: z.literal('update-external'),
        id: idSchema,
        input: externalServiceUpdateSchema,
      }),
      '确认修改所选外部 MCP 服务的非秘密配置。',
      (actor, args) => external.save(actor, args.id, args.input),
    );
  }
}
