import { z } from 'zod';
import { prepareRequirementVersionResourceInputSchema as prepareRequirementVersionInputSchema } from '../../../contracts/src/preparation.js';
import { registerRequirementStateTools } from './requirement-state.js';
import { idSchema, commandIdSchema } from '../../../contracts/src/base.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import {
  createRequirementResourceInputSchema as createRequirementInputSchema,
  addRequirementVersionResourceInputSchema as addRequirementVersionInputSchema,
} from '../../../contracts/src/requirements.js';
import type { Database } from '../../../persistence/src/database.js';
import {
  RequirementService,
  type RequirementNameAdmission,
} from '../requirements/service.js';
import { OperationService } from '../operations/service.js';
import { DomainError } from '../errors.js';
import type { BusinessToolRegistry } from './registry.js';

/** These capabilities have their own internal exposure list. They are not added to official MCP. */
export function registerInternalTools(
  registry: BusinessToolRegistry,
  db: Database,
  admitRequirementName?: RequirementNameAdmission,
): void {
  const requirements = new RequirementService(
    db,
    undefined,
    admitRequirementName,
  );
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
    z.strictObject({
      op: z.literal('get-manifest'),
      ...target,
      requirementVersionId: idSchema.optional(),
    }),
    'read',
    (a, i) =>
      requirements.manifest(
        a,
        i.projectId,
        i.requirementId,
        i.requirementVersionId,
      ),
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
}
