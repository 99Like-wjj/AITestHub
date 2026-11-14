import { createHash, randomUUID } from 'node:crypto';
import {
  executionScopeSchema,
  uiProgressInputSchema,
} from '../../../contracts/src/domain.js';
import {
  claimLocalExecutionInputSchema,
  closeUiProgressInputSchema,
} from '../../../contracts/src/ui-results.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { canonicalJson, OperationService } from '../operations/service.js';
import type { PlanService } from '../plans/service.js';
import { DomainError, forbidden } from '../errors.js';
import { audit } from '../events.js';
import { recordBusinessActivity } from '../requirements/service.js';
import { missingFiles } from '../results/evidence.js';
import { RetestService } from '../retests/service.js';
import { UiProgressBatchService } from './progress-batch.js';
import { assertLocalUiActor } from '../results/delivery-access.js';
import {
  uiDeliveryGate,
  deliveryMissingFiles,
  projectUiDelivery,
} from '../results/delivery-state.js';

export interface RunRow {
  id: string;
  project_id: string;
  kind: 'UI' | 'API';
  created_by: string;
  scope_snapshot: unknown;
  scope_digest: string;
  state: string;
  delivery_status: 'notSubmitted' | 'receiving' | 'incomplete' | 'complete';
  cleanup_state: string;
  progress_closed_at: Date | null;
  last_progress_at: Date | null;
  progress_sequence: string;
  completed_items: number;
  row_version: number;
  execution_provenance:
    'local-ai' | 'protocol-synthetic' | 'unknown' | 'platform-api';
}
export async function readRun(
  tx: SqlExecutor,
  projectId: string,
  runId: string,
  lock: boolean | 'share' = false,
): Promise<RunRow> {
  const row = (
    await tx.query<RunRow>(
      `SELECT * FROM app.runs WHERE project_id=$1 AND id=$2${lock === 'share' ? ' FOR SHARE' : lock ? ' FOR UPDATE' : ''}`,
      [projectId, runId],
    )
  ).rows[0];
  if (!row) throw new DomainError('NOT_FOUND', '此项目内没有该执行。', 404);
  return row;
}
export const semanticDigest = (input: unknown): string =>
  createHash('sha256').update(canonicalJson(input)).digest('hex');

export class UiExecutionService {
  private readonly operations: OperationService;
  private readonly progressBatches: UiProgressBatchService;
  constructor(
    readonly db: Database,
    private readonly plans: PlanService,
    private readonly retests = new RetestService(db, plans),
  ) {
    this.operations = new OperationService(db);
    this.progressBatches = new UiProgressBatchService(db);
  }
  previewCloseProgressBatch(
    actor: ActorContext,
    projectId: string,
    raw: unknown,
  ) {
    return this.progressBatches.preview(actor, projectId, raw);
  }
  closeProgressBatch(actor: ActorContext, projectId: string, raw: unknown) {
    return this.progressBatches.close(actor, projectId, raw);
  }
  closeProgressBatchReceipt(
    actor: ActorContext,
    projectId: string,
    key: string,
  ) {
    return this.progressBatches.receipt(actor, projectId, key);
  }

  async claim(actor: ActorContext, projectId: string, raw: unknown) {
    assertLocalUiActor(actor);
    const input = claimLocalExecutionInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      `ui-executions.claim.${input.sourceRevisionId}`,
      input.localExecutionId,
      { projectId, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'runs.organize');
      },
      async (tx) => {
        const prior = (
          await tx.query<RunRow>(
            `SELECT * FROM app.runs WHERE project_id=$1 AND created_by=$2 AND source_revision_id=$3
           AND local_execution_id=$4 AND kind='UI' FOR UPDATE`,
            [
              projectId,
              actor.userId,
              input.sourceRevisionId,
              input.localExecutionId,
            ],
          )
        ).rows[0];
        if (prior)
          return {
            runId: prior.id,
            scope: executionScopeSchema.parse(prior.scope_snapshot),
            executionProvenance: prior.execution_provenance,
          };
        const group =
          input.sourceType === 'retestPreparation'
            ? await this.retests.groupInTransaction(
                tx,
                actor,
                projectId,
                input.sourceRevisionId,
              )
            : null;
        if (group && group.scope.kind !== 'UI')
          throw new DomainError(
            'NOT_FOUND',
            '此固定分组不是本地 UI 复测。',
            404,
          );
        const source = group
          ? {
              plan: {
                id: null,
                environmentId: group.scope.environment.id,
                productBuild: group.scope.productBuild,
              },
              scope: {
                environment: group.scope.environment,
                items: group.scope.items,
              },
            }
          : await this.plans.getUiScopeInTransaction(
              tx,
              actor,
              projectId,
              input.sourceRevisionId,
            );
        const runId = randomUUID();
        const withoutDigest = {
          schemaVersion: 'ath.execution-scope.v1',
          runId,
          sourceType: input.sourceType,
          sourceRevisionId: input.sourceRevisionId,
          projectId,
          kind: 'UI',
          environmentId: source.plan.environmentId,
          environmentRevisionId: source.scope.environment.revisionId,
          productBuild: source.plan.productBuild,
          items: source.scope.items.map((item) => ({
            ...item,
            runItemId: randomUUID(),
          })),
          missingRequirements: group?.scope.missingRequirements ?? [],
          ...(group ? { retestContext: group.scope.context } : {}),
        };
        const scope = executionScopeSchema.parse({
          ...withoutDigest,
          snapshotDigest: semanticDigest(withoutDigest),
        });
        await tx.query(
          `INSERT INTO app.runs(id,run_snapshot_id,project_id,kind,source,source_revision_id,plan_id,environment_id,environment_revision_id,
           product_build,created_by,state,scope_snapshot,scope_digest,local_execution_id,execution_provenance,started_at)
           VALUES($1,$2,$3,'UI','localUi',$4,$5,$6,$7,$8,$9,'running',$10,$11,$12,$13,clock_timestamp())`,
          [
            runId,
            randomUUID(),
            projectId,
            input.sourceRevisionId,
            source.plan.id,
            scope.environmentId,
            scope.environmentRevisionId,
            scope.productBuild,
            actor.userId,
            JSON.stringify(scope),
            scope.snapshotDigest,
            input.localExecutionId,
            input.executionProvenance,
          ],
        );
        for (const item of scope.items)
          await tx.query(
            `INSERT INTO app.run_items(id,project_id,run_id,ordinal,case_id,approval_snapshot_id,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [
              item.runItemId,
              projectId,
              runId,
              item.ordinal,
              item.caseId,
              item.approvalSnapshotId,
              JSON.stringify(item),
            ],
          );
        if (group)
          await tx.query(
            'INSERT INTO app.retest_group_runs(project_id,group_id,run_id) VALUES($1,$2,$3)',
            [projectId, group.row.id, runId],
          );
        await audit(tx, actor, 'ui-execution.claimed', runId, projectId, {
          sourceRevisionId: input.sourceRevisionId,
          executionProvenance: input.executionProvenance,
        });
        return { runId, scope, executionProvenance: input.executionProvenance };
      },
      projectId,
    );
  }

  async scope(actor: ActorContext, projectId: string, runId: string) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'runs.organize');
      const row = await readRun(tx, projectId, runId);
      if (row.kind !== 'UI')
        throw new DomainError('NOT_FOUND', '没有此本地UI执行。', 404);
      return {
        runId,
        scope: executionScopeSchema.parse(row.scope_snapshot),
        executionProvenance: row.execution_provenance,
      };
    });
  }

  async progress(actor: ActorContext, projectId: string, raw: unknown) {
    assertLocalUiActor(actor);
    const input = uiProgressInputSchema.parse(raw);
    const digest = semanticDigest(input);
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'runs.organize');
      const run = await readRun(tx, projectId, input.runId, true);
      if (run.kind !== 'UI' || run.created_by !== actor.userId) forbidden();
      const scope = executionScopeSchema.parse(run.scope_snapshot);
      if (input.completedItems > scope.items.length)
        throw new DomainError(
          'VALIDATION_ERROR',
          '已完成数量不能超过固定范围。',
          400,
        );
      const previous = (
        await tx.query<{ semantic_digest: string }>(
          'SELECT semantic_digest FROM app.ui_progress_events WHERE run_id=$1 AND sequence=$2',
          [run.id, input.sequence],
        )
      ).rows[0];
      if (previous) {
        if (previous.semantic_digest !== digest)
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            '同一进度序号已用于不同内容。',
            409,
          );
        return {
          accepted: true,
          sequence: input.sequence,
          progressClosedAt: run.progress_closed_at?.toISOString() ?? null,
        };
      }
      if (
        BigInt(input.sequence) <= BigInt(run.progress_sequence) ||
        input.completedItems < run.completed_items
      ) {
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '进度序号或完成数量落后，请先查询当前状态。',
          409,
        );
      }
      await tx.query(
        'INSERT INTO app.ui_progress_events(run_id,sequence,semantic_digest,payload,actor_id) VALUES($1,$2,$3,$4,$5)',
        [run.id, input.sequence, digest, JSON.stringify(input), actor.userId],
      );
      await tx.query(
        `UPDATE app.runs SET progress_sequence=$2,last_progress_at=clock_timestamp(),completed_items=$3,row_version=row_version+1 WHERE id=$1`,
        [run.id, input.sequence, input.completedItems],
      );
      if (input.completedItems > 0)
        for (const versionId of new Set(
          scope.items.map((item) => item.requirementVersionId),
        ))
          await recordBusinessActivity(tx, projectId, versionId);
      await audit(
        tx,
        actor,
        'ui-execution.progress-received',
        run.id,
        projectId,
        { sequence: input.sequence, completedItems: input.completedItems },
      );
      return {
        accepted: true,
        sequence: input.sequence,
        progressClosedAt: run.progress_closed_at?.toISOString() ?? null,
      };
    });
  }

  async closeProgress(
    actor: ActorContext,
    projectId: string,
    runId: string,
    raw: unknown,
  ) {
    const input = closeUiProgressInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'ui-executions.close-progress',
      input.commandId,
      { projectId, runId },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'runs.organize');
      },
      async (tx) => {
        const run = await readRun(tx, projectId, runId, true);
        if (run.kind !== 'UI')
          throw new DomainError('NOT_FOUND', '没有此本地UI进度。', 404);
        const row = (
          await tx.query<{ progress_closed_at: Date }>(
            `UPDATE app.runs SET progress_closed_at=COALESCE(progress_closed_at,clock_timestamp()),
           progress_closed_by=COALESCE(progress_closed_by,$2),row_version=row_version+1 WHERE id=$1 RETURNING progress_closed_at`,
            [runId, actor.userId],
          )
        ).rows[0];
        await audit(
          tx,
          actor,
          'ui-execution.progress-closed',
          runId,
          projectId,
        );
        return {
          runId,
          progressClosedAt: row?.progress_closed_at.toISOString() ?? null,
          localExecutionStopped: false,
        };
      },
      projectId,
    );
  }

  async status(actor: ActorContext, projectId: string, runId: string) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const run = await readRun(tx, projectId, runId, 'share');
      const report = (
        await tx.query<{ id: string }>(
          'SELECT id FROM app.reports WHERE project_id=$1 AND run_id=$2',
          [projectId, runId],
        )
      ).rows[0];
      const scope = executionScopeSchema.parse(run.scope_snapshot);
      const gate =
        run.kind === 'UI' ? await uiDeliveryGate(tx, runId) : undefined;
      const resultCount =
        report || gate?.versioned
          ? Number(
              (
                await tx.query<{ count: string }>(
                  'SELECT count(*)::text count FROM app.results WHERE run_id=$1',
                  [runId],
                )
              ).rows[0]?.count ?? '0',
            )
          : 0;
      const missing =
        report || gate?.versioned
          ? gate?.versioned
            ? await deliveryMissingFiles(tx, runId)
            : await missingFiles(tx, runId)
          : [];
      const deliveryStatus = report
        ? resultCount === scope.items.length && missing.length === 0
          ? ('complete' as const)
          : ('incomplete' as const)
        : run.delivery_status;
      return {
        runId,
        projectId,
        kind: run.kind,
        state: run.state,
        deliveryStatus:
          projectUiDelivery(
            gate,
            resultCount,
            scope.items.length,
            missing.length,
          ) ?? deliveryStatus,
        progressClosedAt: run.progress_closed_at?.toISOString() ?? null,
        lastProgressAt: run.last_progress_at?.toISOString() ?? null,
        progressSequence: run.progress_sequence,
        completedItems: run.completed_items,
        totalItems: scope.items.length,
        executionProvenance: run.execution_provenance,
        rowVersion: run.row_version,
        reportId: report?.id ?? null,
        scope,
      };
    });
  }
}
