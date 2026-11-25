import { z } from 'zod';
import { idSchema } from '../../../contracts/src/base.js';
import { profileUpdateInputSchema } from '../../../contracts/src/identity.js';
import {
  requirementParticipantDeltaInputSchema,
  requirementParticipantsInputSchema,
} from '../../../contracts/src/requirements.js';
import type { Database } from '../../../persistence/src/database.js';
import { personalActor } from '../conversations/common.js';
import { IdentityService } from '../identity/service.js';
import { RequirementService } from '../requirements/service.js';
import type { BusinessToolRegistry } from './registry.js';

export function registerParticipationTools(
  registry: BusinessToolRegistry,
  db: Database,
) {
  const requirements = new RequirementService(db);
  const identity = new IdentityService(db);
  const target = { projectId: idSchema, requirementId: idSchema };
  const description =
    '需求参与人。get 取当前名单及基准，candidates 按本项目显示名查成员，add/remove 增量修改。includeSelf 由认证主体解析。set 仅用于明确替换整份名单。';
  const add = registry.add.bind(registry);
  add(
    'ath_requirement_membership',
    description,
    'get',
    z.strictObject({ op: z.literal('get'), ...target }),
    'read',
    async (actor, input) => {
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
    },
  );
  add(
    'ath_requirement_membership',
    description,
    'candidates',
    z.strictObject({
      op: z.literal('candidates'),
      ...target,
      search: z.string().trim().min(1).max(100),
    }),
    'read',
    (actor, input) =>
      requirements.participantCandidates(
        actor,
        input.projectId,
        input.requirementId,
        input.search,
      ),
  );
  for (const op of ['add', 'remove'] as const)
    add(
      'ath_requirement_membership',
      description,
      op,
      z.strictObject({
        op: z.literal(op),
        ...target,
        input: requirementParticipantDeltaInputSchema,
      }),
      'write',
      (actor, input) =>
        requirements.changeParticipants(
          actor,
          input.projectId,
          input.requirementId,
          op,
          input.input,
        ),
    );
  add(
    'ath_requirement_membership',
    description,
    'set',
    z.strictObject({
      op: z.literal('set'),
      ...target,
      input: requirementParticipantsInputSchema,
    }),
    'write',
    (actor, input) =>
      requirements.participants(
        actor,
        input.projectId,
        input.requirementId,
        input.input,
      ),
  );

  const identityDescription =
    'get-self 查当前认证操作者的安全显示名、内部引用、主题和修订。update-self 修改本人的显示名和主题。';
  add(
    'ath_identity',
    identityDescription,
    'get-self',
    z.strictObject({
      op: z.literal('get-self'),
      projectId: idSchema.optional(),
    }),
    'read',
    (actor, input) => identity.businessSelf(actor, input.projectId),
    undefined,
    false,
    'personal',
  );
  add(
    'ath_identity',
    identityDescription,
    'update-self',
    z.strictObject({
      op: z.literal('update-self'),
      input: profileUpdateInputSchema,
    }),
    'write',
    async (actor, input) => {
      await db.transaction((tx) => personalActor(tx, actor));
      return identity.updateProfile(actor, input.input);
    },
    undefined,
    false,
    'personal',
  );
}
