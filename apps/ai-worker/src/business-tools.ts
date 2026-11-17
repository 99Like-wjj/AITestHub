import { randomUUID } from 'node:crypto';
import { tool } from 'langchain';
import { z } from 'zod';
import type { ActorContext } from '../../../packages/contracts/src/identity.js';
import type {
  OperationTarget,
  AiToolSourceReference,
} from '../../../packages/contracts/src/conversations.js';
import type { Database } from '../../../packages/persistence/src/database.js';
import {
  createBusinessRegistry,
  type BusinessServices,
} from '../../../packages/application/src/tool-registry/business.js';
import { registerInternalTools } from '../../../packages/application/src/tool-registry/internal.js';
import { ActionIntents } from '../../../packages/application/src/tool-registry/action-intents.js';
import { DomainError } from '../../../packages/application/src/errors.js';
import type { AiHostEvent } from './host.js';
import { assertSourceProjectAllowed } from '../../../packages/application/src/conversations/source-projects.js';
import { recoveryFencesReady } from '../../../packages/application/src/recovery/fences.js';
import { assertTaskCapability } from '../../../packages/application/src/conversations/task-capabilities.js';
import { requirementCandidatesInputSchema } from '../../../packages/contracts/src/requirements.js';

const officeRequirementFindSchema = z.union([
  requirementCandidatesInputSchema.safeExtend({ op: z.literal('find') }),
  z.strictObject({
    op: z.literal('find'),
    input: requirementCandidatesInputSchema,
  }),
]);
// Only reviewed read handlers belong here. A registry "read" label alone does
// not establish absence of platform writes, even during prepare. New operations
// stay closed until reviewed. This projection serves schemas and dispatch.
const reviewedOfficeReadOperations: ReadonlySet<string> = new Set([
  'ath_api_runs.attempt-detail',
  'ath_api_runs.debug-trace',
  'ath_api_runs.events',
  'ath_api_runs.status',
  'ath_assets.auxiliary-by-command',
  'ath_assets.auxiliary-status',
  'ath_assets.get',
  'ath_assets.list',
  'ath_database_connections.get',
  'ath_database_connections.list',
  'ath_issues.auxiliary-by-command',
  'ath_issues.auxiliary-status',
  'ath_issues.get',
  'ath_issues.list',
  'ath_knowledge.export',
  'ath_knowledge.get',
  'ath_knowledge.history',
  'ath_knowledge.list-index',
  'ath_knowledge.search',
  'ath_knowledge.spaces',
  'ath_knowledge_changes.get-comparison',
  'ath_knowledge_changes.get-selection-receipts',
  'ath_operation_status.get',
  'ath_plans.get',
  'ath_plans.list',
  'ath_problems.get',
  'ath_problems.list',
  'ath_project_members.candidates',
  'ath_project_members.list',
  'ath_reports.get',
  'ath_reports.get-revision',
  'ath_reports.list',
  'ath_reports.list-executions',
  'ath_reports.search-in-scope',
  'ath_requirement_materials.get-manifest',
  'ath_requirement_materials.prepare-version',
  'ath_requirement_membership.get',
  'ath_requirement_state.deletion-receipt',
  'ath_requirements.auxiliary-by-command',
  'ath_requirements.auxiliary-status',
  'ath_requirements.find',
  'ath_requirements.get',
  'ath_requirements.list',
  'ath_requirements.list-page',
  'ath_results.get',
  'ath_results.prepare',
  'ath_results.receipt',
  'ath_results.resource-capabilities',
  'ath_results.ui-batch-receipt',
  'ath_results.ui-delivery-status',
  'ath_retests.get',
  'ath_retests.group',
  'ath_retests.list',
  'ath_retests.start-preview',
  'ath_reviews.opinions',
  'ath_schedules.get',
  'ath_schedules.list',
  'ath_schedules.occurrences',
  'ath_schedules.preview',
  'ath_test_configuration.get',
  'ath_test_configuration.list',
  'ath_ui_executions.get-close-progress-batch',
  'ath_ui_executions.get-scope',
  'ath_ui_executions.prepare',
  'ath_ui_executions.preview-close-progress-batch',
  'ath_ui_executions.resume',
  'ath_ui_executions.status',
]);
function officeBusinessOperationSchema(
  name: string,
  op: string,
  operation: { access: 'read' | 'write'; schema: z.ZodType },
): z.ZodType | null {
  if (
    operation.access !== 'read' ||
    !reviewedOfficeReadOperations.has(`${name}.${op}`)
  )
    return null;
  return name === 'ath_requirements' && op === 'find'
    ? officeRequirementFindSchema
    : operation.schema;
}

/** Fixed names, no filesystem, shell, arbitrary network/SQL, execute or subagent entry. */
export const AI_BUSINESS_TOOL_NAMES = [
  'ath_assets',
  'ath_reviews',
  'ath_plans',
  'ath_api_runs',
  'ath_ui_executions',
  'ath_results',
  'ath_reports',
  'ath_issues',
  'ath_problems',
  'ath_retests',
  'ath_issue_lifecycle',
  'ath_requirements',
  'ath_requirement_materials',
  'ath_requirement_membership',
  'ath_requirement_state',
  'ath_project_members',
  'ath_operation_status',
  'ath_test_configuration',
  'ath_database_connections',
  'ath_knowledge',
  'ath_knowledge_changes',
  'ath_schedules',
] as const;

async function assertWriteTarget(
  db: Database,
  name: string,
  input: unknown,
  fixed: OperationTarget | null | undefined,
): Promise<void> {
  if (!fixed)
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '本条消息没有明确写入目标，请由用户设置；不会从当前浏览项目推断。',
      422,
    );
  const args = z.object({ projectId: z.string() }).parse(input);
  if (args.projectId !== fixed.projectId)
    throw new DomainError(
      'BUSINESS_CONFLICT',
      '写入项目与本条消息的固定操作目标不一致。',
      409,
    );
  if (!fixed.requirementId && !fixed.objectIds?.length) return;
  const envelope = z
    .object({
      id: z.string().optional(),
      entryId: z.string().optional(),
      spaceId: z.string().optional(),
      runId: z.string().optional(),
      requirementId: z.string().optional(),
      input: z.record(z.string(), z.unknown()).optional(),
    })
    .parse(input);
  const body = envelope.input ?? {};
  const batchRuns =
    name === 'ath_ui_executions' &&
    z.object({ op: z.literal('close-progress-batch') }).safeParse(input).success
      ? (
          z.array(z.object({ runId: z.string() })).safeParse(body.items).data ??
          []
        ).map((item) => item.runId)
      : [];
  const ids = [
    envelope.id,
    envelope.entryId,
    envelope.spaceId,
    envelope.runId,
    ...batchRuns,
    ...['objectIds', 'sourceIds'].flatMap(
      (key) => z.array(z.string()).safeParse(body[key]).data ?? [],
    ),
    ...['masterId'].map((key) =>
      typeof body[key] === 'string' ? body[key] : undefined,
    ),
    ...(typeof body.sourceCaseId === 'string' ? [body.sourceCaseId] : []),
  ].filter((id): id is string => id !== undefined);
  if (
    fixed.objectIds?.length &&
    (!ids.length || ids.some((id) => !fixed.objectIds?.includes(id)))
  )
    throw new DomainError(
      'BUSINESS_CONFLICT',
      '写入对象超出用户为本条消息固定的对象集合。',
      409,
    );
  if (!fixed.requirementId) return;
  const expected = fixed.requirementId;
  if (envelope.requirementId && envelope.requirementId !== expected)
    throw new DomainError(
      'BUSINESS_CONFLICT',
      '写入需求与消息固定目标不一致。',
      409,
    );
  const version =
    body.requirementVersionId ??
    (typeof body.content === 'object' &&
    body.content !== null &&
    'requirementVersionId' in body.content
      ? body.content.requirementVersionId
      : undefined);
  if (typeof version === 'string') {
    if (
      !(
        await db.query(
          'SELECT 1 FROM app.requirement_versions WHERE id=$1 AND project_id=$2 AND requirement_id=$3',
          [version, fixed.projectId, expected],
        )
      ).rowCount
    )
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '材料/资产版本不属于消息固定需求。',
        409,
      );
    return;
  }
  if (name === 'ath_requirement_materials' && !envelope.requirementId)
    throw new DomainError(
      'BUSINESS_CONFLICT',
      '当前消息固定已有需求，不能静默改为新建其他需求。',
      409,
    );
  if (name.startsWith('ath_requirement') && envelope.requirementId === expected)
    return;
  const assetIds = [
    ...ids,
    ...['scenarioId', 'setId'].map((key) =>
      typeof body[key] === 'string' ? body[key] : undefined,
    ),
    ...(body.content &&
    typeof body.content === 'object' &&
    'scenarioId' in body.content &&
    typeof body.content.scenarioId === 'string'
      ? [body.content.scenarioId]
      : []),
  ].filter((id): id is string => id !== undefined);
  if (
    (name === 'ath_assets' ||
      name === 'ath_reviews' ||
      (name === 'ath_api_runs' && body.content !== undefined)) &&
    assetIds.length
  ) {
    const count = await db.query(
      `SELECT a.id FROM app.test_assets a JOIN app.requirement_versions v ON v.id=a.requirement_version_id WHERE a.id=ANY($1::uuid[]) AND a.project_id=$2 AND v.requirement_id=$3`,
      [assetIds, fixed.projectId, expected],
    );
    if (count.rowCount === new Set(assetIds).size) return;
  }
  if (name === 'ath_plans' || name === 'ath_api_runs') {
    const caseIds = [
      ...(z.array(z.string()).safeParse(body.caseIds).data ?? []),
      ...(z.array(z.string()).safeParse(body.selectedCaseIds).data ?? []),
    ];
    if (caseIds.length) {
      const count = await db.query(
        `SELECT a.id FROM app.test_assets a JOIN app.requirement_versions v ON v.id=a.requirement_version_id WHERE a.id=ANY($1::uuid[]) AND a.project_id=$2 AND v.requirement_id=$3`,
        [caseIds, fixed.projectId, expected],
      );
      if (count.rowCount === new Set(caseIds).size) return;
    }
  }
  if (
    (name === 'ath_api_runs' || name === 'ath_ui_executions') &&
    (envelope.runId || batchRuns.length)
  ) {
    const runIds = [
      ...new Set([...(envelope.runId ? [envelope.runId] : []), ...batchRuns]),
    ];
    const runs = (
      await db.query<{
        scope_snapshot: { items?: { requirementVersionId?: string }[] };
      }>(
        'SELECT scope_snapshot FROM app.runs WHERE id=ANY($1::uuid[]) AND project_id=$2',
        [runIds, fixed.projectId],
      )
    ).rows;
    const versions = [
      ...new Set(
        runs
          .flatMap((run) => run.scope_snapshot.items ?? [])
          ?.map((item) => item.requirementVersionId)
          .filter((id): id is string => id !== undefined),
      ),
    ];
    if (
      runs.length === runIds.length &&
      versions.length &&
      (
        await db.query(
          'SELECT id FROM app.requirement_versions WHERE id=ANY($1::uuid[]) AND project_id=$2 AND requirement_id=$3',
          [versions, fixed.projectId, expected],
        )
      ).rowCount === versions.length
    )
      return;
  }
  if (
    (name === 'ath_issues' ||
      name === 'ath_issue_lifecycle' ||
      name === 'ath_retests') &&
    ids.length
  ) {
    const count = await db.query(
      'SELECT id FROM app.issues WHERE id=ANY($1::uuid[]) AND project_id=$2 AND requirement_id=$3',
      [ids, fixed.projectId, expected],
    );
    if (count.rowCount === new Set(ids).size) return;
  }
  if (name === 'ath_results' && envelope.id) {
    if (
      (
        await db.query(
          `SELECT r.id FROM app.results r JOIN app.run_items i ON i.id=r.run_item_id
      JOIN app.requirement_versions v ON v.id=(i.snapshot->>'requirementVersionId')::uuid
      WHERE r.id=$1 AND r.project_id=$2 AND v.requirement_id=$3`,
          [envelope.id, fixed.projectId, expected],
        )
      ).rowCount
    )
      return;
  }
  if (typeof body.requirementId === 'string' && body.requirementId === expected)
    return;
  // Unknown target shapes cannot silently widen an already fixed requirement selection.
  throw new DomainError(
    'BUSINESS_CONFLICT',
    '此操作无法在本条消息固定需求内证明完整范围，请用明确项目范围的新消息。',
    409,
  );
}

export function createAiBusinessTools(
  db: Database,
  actor: ActorContext,
  options: {
    services?: BusinessServices;
    taskId?: string;
    conversationId: string;
    operationTarget?: OperationTarget | null;
    allowedSourceProjectIds?: readonly string[];
    assertActive: () => Promise<void>;
    assertEffectsSettled?: () => void | Promise<void>;
    readOnly?: boolean;
    emit: (event: AiHostEvent) => void;
  },
) {
  const registry = createBusinessRegistry(db, options.services);
  registerInternalTools(registry, db);
  const confirmations = new ActionIntents(db, registry);
  const entries = [...registry.tools.values()].filter((entry) =>
    AI_BUSINESS_TOOL_NAMES.some((name) => name === entry.name),
  );
  for (const entry of entries) {
    if (options.readOnly)
      for (const [op, operation] of entry.operations) {
        const schema = officeBusinessOperationSchema(entry.name, op, operation);
        if (!schema) entry.operations.delete(op);
        else operation.schema = schema;
      }
    // Platform AI may prepare/read local UI scope. It cannot manufacture local observations or result facts.
    if (entry.name === 'ath_ui_executions')
      for (const op of ['claim', 'progress', 'declare-end', 'declare-resume'])
        entry.operations.delete(op);
    if (entry.name === 'ath_results')
      for (const op of [
        'commit',
        'explicit-amendment',
        'submit-file',
        'prepare-ui-batch',
        'receive-ui-batch',
        'receive-ui-batch-file',
        'seal-ui-delivery',
      ])
        entry.operations.delete(op);
  }
  return entries
    .filter((entry) => entry.operations.size > 0)
    .map((entry) => {
      return tool(
        async (raw: unknown) => {
          const invocationId = randomUUID();
          let writeStarted = false;
          options.emit({
            type: 'tool',
            invocationId,
            name: entry.name,
            state: 'started',
          });
          try {
            await options.assertActive();
            const requested = z.object({ op: z.string() }).parse(raw);
            const operation = entry.operations.get(requested.op);
            const assertPolicy = async () => {
              let officePolicy = options.readOnly === true;
              if (!options.taskId) {
                if (options.readOnly)
                  throw new DomainError(
                    'FORBIDDEN',
                    '只读办公工具须关联原任务。',
                    403,
                  );
              } else {
                const persisted = await db.transaction((tx) =>
                  assertTaskCapability(
                    tx,
                    actor,
                    {
                      taskId: options.taskId!,
                      conversationId: options.conversationId,
                    },
                    operation?.access === 'write'
                      ? 'businessWrite'
                      : 'businessRead',
                    { active: true },
                  ),
                );
                officePolicy ||= persisted.executionPolicy === 'officeOnly';
              }
              const schema =
                operation &&
                officeBusinessOperationSchema(
                  entry.name,
                  requested.op,
                  operation,
                );
              if (officePolicy && (!schema || !schema.safeParse(raw).success))
                throw new DomainError(
                  'FORBIDDEN',
                  '定时办公任务只读取既有业务资料，不创建业务快照、提案或辅助任务。',
                  403,
                );
            };
            await assertPolicy();
            const prepared = await registry.prepare(actor, entry.name, raw);
            if (options.allowedSourceProjectIds !== undefined) {
              let sourceProjectId = prepared.projectId;
              if (!sourceProjectId && entry.name === 'ath_operation_status') {
                const lookup = z
                  .union([
                    z.object({ commandId: z.uuid() }),
                    z.object({ operation: z.string(), key: z.string() }),
                  ])
                  .parse(prepared.input);
                let row = (
                  'commandId' in lookup
                    ? await db.query<{ project_id: string | null }>(
                        'SELECT project_id FROM app.commands WHERE id=$1 AND actor_id=$2',
                        [lookup.commandId, actor.userId],
                      )
                    : await db.query<{ project_id: string | null }>(
                        'SELECT project_id FROM app.commands WHERE operation=$1 AND key=$2 AND actor_id=$3',
                        [lookup.operation, lookup.key, actor.userId],
                      )
                ).rows[0];
                if (!row && (await recoveryFencesReady(db)))
                  row = (
                    'commandId' in lookup
                      ? await db.query<{ project_id: string | null }>(
                          'SELECT project_id FROM app.recovery_operation_fences WHERE command_id=$1 AND actor_id=$2',
                          [lookup.commandId, actor.userId],
                        )
                      : await db.query<{ project_id: string | null }>(
                          'SELECT project_id FROM app.recovery_operation_fences WHERE operation=$1 AND key=$2 AND actor_id=$3',
                          [lookup.operation, lookup.key, actor.userId],
                        )
                  ).rows[0];
                sourceProjectId = row?.project_id ?? undefined;
              }
              assertSourceProjectAllowed(
                sourceProjectId,
                options.allowedSourceProjectIds,
              );
            }
            if (entry.operations.get(prepared.op)?.access === 'write') {
              await options.assertEffectsSettled?.();
              await assertWriteTarget(
                db,
                entry.name,
                prepared.input,
                options.operationTarget,
              );
            }
            if (prepared.confirmation) {
              await assertPolicy();
              if (!options.taskId)
                throw new DomainError(
                  'PRECONDITIONS_MISSING',
                  '人工决策需要持久消息任务，未执行。',
                  422,
                );
              const pending = await confirmations.propose(actor, prepared, {
                taskId: options.taskId,
                conversationId: options.conversationId,
              });
              const waiting = pending.status === 'waitingConfirmation';
              options.emit({
                type: 'tool',
                invocationId,
                name: entry.name,
                state: waiting
                  ? 'waitingConfirmation'
                  : pending.status === 'completed' ||
                      pending.status === 'declined'
                    ? 'completed'
                    : 'failed',
                confirmationId: pending.id,
                ...(pending.status === 'unknown'
                  ? { unknownEffect: true }
                  : {}),
                ...(prepared.projectId
                  ? {
                      sourceRefs: [
                        {
                          kind: 'projectAccess' as const,
                          projectId: prepared.projectId,
                        },
                      ],
                    }
                  : {}),
              });
              return JSON.stringify({
                status: pending.status,
                actionIntent: pending,
                statusPath: `/api/v1/me/conversations/${options.conversationId}/action-intents/${pending.id}`,
                humanActionRequired: waiting,
                interaction: 'inline-action-card',
                instruction: waiting
                  ? '请用户在本条回复的执行卡点击执行或取消；文字确认无效。'
                  : '读取原卡状态，不重新执行。',
              });
            }
            writeStarted =
              entry.operations.get(prepared.op)?.access === 'write';
            await assertPolicy();
            const result = await prepared.execute();
            const sourceRefs: AiToolSourceReference[] = prepared.projectId
              ? [{ kind: 'projectAccess', projectId: prepared.projectId }]
              : [];
            if (
              entry.name === 'ath_knowledge' ||
              entry.name === 'ath_knowledge_changes'
            ) {
              const selected = z
                .object({
                  entry: z.object({ id: z.string(), deleted: z.boolean() }),
                  revision: z.object({ id: z.string() }),
                })
                .safeParse(result);
              if (selected.success && !selected.data.entry.deleted)
                sourceRefs.push({
                  kind: 'knowledge',
                  entryId: selected.data.entry.id,
                  revisionId: selected.data.revision.id,
                });
              if (prepared.op === 'list-index' || prepared.op === 'search') {
                const indexed = z
                  .object({
                    entries: z.array(
                      z.object({
                        id: z.string(),
                        revisionId: z.string(),
                        deleted: z.boolean(),
                      }),
                    ),
                  })
                  .parse(result);
                for (const item of indexed.entries)
                  if (!item.deleted)
                    sourceRefs.push({
                      kind: 'knowledge',
                      entryId: item.id,
                      revisionId: item.revisionId,
                    });
              }
            }
            options.emit({
              type: 'tool',
              invocationId,
              name: entry.name,
              state: 'completed',
              ...(sourceRefs.length ? { sourceRefs } : {}),
            });
            return JSON.stringify(result);
          } catch (error: unknown) {
            const failure =
              error instanceof DomainError
                ? error
                : new DomainError(
                    'INTERNAL_ERROR',
                    '工具结果未知，请查原command；不会自动重放。',
                    500,
                  );
            options.emit({
              type: 'tool',
              invocationId,
              name: entry.name,
              state: 'failed',
              ...(writeStarted &&
              [
                'OPERATION_RESULT_UNKNOWN',
                'INTERNAL_ERROR',
                'DEPENDENCY_UNAVAILABLE',
              ].includes(failure.code)
                ? { unknownEffect: true }
                : {}),
            });
            return JSON.stringify({
              error: { code: failure.code, message: failure.message },
              recovery: 'status-lookup-required',
            });
          }
        },
        {
          name: entry.name,
          description: entry.description,
          schema: registry.schema(entry),
        },
      );
    });
}
