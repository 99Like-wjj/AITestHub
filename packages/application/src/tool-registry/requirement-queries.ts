import { fullRequirementFindInputSchema } from '../../../contracts/src/automatic-auxiliary.js';
import type { AuxiliaryService } from '../auxiliary/service.js';
import { FullRequirementFindService } from '../auxiliary/full-requirement-find.js';
import { DomainError } from '../errors.js';
import { z } from 'zod';
import { idSchema } from '../../../contracts/src/base.js';
import {
  requirementCandidatesInputSchema,
  requirementPageQuerySchema,
} from '../../../contracts/src/requirements.js';
import type { Database } from '../../../persistence/src/database.js';
import { RequirementService } from '../requirements/service.js';
import type { BusinessToolRegistry } from './registry.js';
export function registerRequirementQueryTools(
  registry: BusinessToolRegistry,
  db: Database,
  auxiliary?: AuxiliaryService,
) {
  const service = new RequirementService(db),
    description =
      '按明确项目及当前权限查询需求、候选与版本；模型辅助任务另行明确许可。';
  registry.add(
    'ath_requirements',
    description,
    'list',
    z.strictObject({
      op: z.literal('list'),
      projectId: idSchema,
      archived: z.boolean().default(false),
    }),
    'read',
    (a, i) => service.list(a, i.projectId, i.archived),
  );
  registry.add(
    'ath_requirements',
    description,
    'get',
    z.strictObject({
      op: z.literal('get'),
      projectId: idSchema,
      requirementId: idSchema,
    }),
    'read',
    (a, i) => service.detail(a, i.projectId, i.requirementId),
  );
  registry.add(
    'ath_requirements',
    description,
    'history',
    z.strictObject({
      op: z.literal('history'),
      projectId: idSchema,
      requirementId: idSchema,
    }),
    'read',
    (a, i) => service.history(a, i.projectId, i.requirementId),
  );
  registry.add(
    'ath_requirements',
    description,
    'list-page',
    z.strictObject({
      op: z.literal('list-page'),
      projectId: idSchema,
      query: requirementPageQuerySchema,
    }),
    'read',
    (a, i) => service.listPage(a, i.projectId, i.query),
  );
  registry.add(
    'ath_requirements',
    description,
    'find',
    z.union([
      fullRequirementFindInputSchema.safeExtend({ op: z.literal('find') }),
      z.strictObject({
        op: z.literal('find'),
        input: fullRequirementFindInputSchema,
      }),
      requirementCandidatesInputSchema.safeExtend({ op: z.literal('find') }),
      z.strictObject({
        op: z.literal('find'),
        input: requirementCandidatesInputSchema,
      }),
    ]),
    'read',
    (a, i) => {
      const { op: _, ...flat } = i,
        raw = 'input' in i ? i.input : flat,
        full = fullRequirementFindInputSchema.safeParse(raw);
      if (full.success) {
        if (!auxiliary)
          throw new DomainError(
            'DEPENDENCY_UNAVAILABLE',
            '自动辅助服务未部署；未调用模型。',
            503,
          );
        return new FullRequirementFindService(auxiliary).find(a, full.data);
      }
      return service.candidates(a, raw);
    },
    async (a, i) => {
      const { op: _, ...flat } = i,
        raw = 'input' in i ? i.input : flat,
        full = fullRequirementFindInputSchema.safeParse(raw);
      return full.success && auxiliary
        ? new FullRequirementFindService(auxiliary).confirmation(a, full.data)
        : undefined;
    },
  );
}
