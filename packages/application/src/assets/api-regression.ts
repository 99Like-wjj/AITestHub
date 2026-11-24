import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import {
  apiRegressionQualificationSchema,
  apiRegressionSaveReceiptSchema,
  apiRegressionSaveStatusSchema,
  apiRegressionWithdrawReceiptSchema,
  debugExecutionScopeSchema,
  saveApiRegressionInputSchema,
  withdrawApiRegressionInputSchema,
} from '../../../contracts/src/api-execution.js';
import { apiProjectQualificationSnapshotSchema } from '../../../contracts/src/api-automation.js';
import {
  apiCaseContentSchema,
  approvalSnapshotSchema,
  type ApiCaseContent,
} from '../../../contracts/src/domain.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { DomainError, stale } from '../errors.js';
import { audit } from '../events.js';
import { canonicalJson, OperationService } from '../operations/service.js';
import { recordBusinessActivity } from '../requirements/service.js';
import {
  getApiProjectAsset,
  getApiProjectCase,
  reviseApiProjectCase,
} from './api-automation.js';

const saveOperation = 'api-regression.save';
const withdrawOperation = 'api-regression.withdraw';

interface RegressionRow extends QueryResultRow {
  id: string;
  project_id: string;
  case_id: string;
  case_revision_id: string;
  revision_no: number;
  scenario_revision_id: string | null;
  set_revision_id: null;
  opinion_context_digest: string;
  snapshot: unknown;
  approved_by: string;
  approved_at: Date;
  debug_run_id: string | null;
  environment_id: string | null;
}

interface DebugCandidateRow extends QueryResultRow {
  state: string;
  scope_snapshot: unknown;
  source_case_id: string | null;
  source_case_revision_id: string | null;
  scenario_revision_id: string | null;
  draft_hash: string;
  authored_content: unknown;
  expires_at: Date;
  saved_snapshot_id: string | null;
}

const regressionSelect = `SELECT s.*,v.revision_no,q.debug_run_id,r.environment_id
    FROM app.approval_snapshots s
    JOIN app.test_assets a ON a.id=s.case_id
    JOIN app.asset_revisions v ON v.id=s.case_revision_id
    JOIN app.api_regression_qualifications q ON q.snapshot_id=s.id
    JOIN app.runs r ON r.id=q.debug_run_id
    WHERE s.project_id=$1 AND s.kind='API' AND s.set_id IS NULL AND a.set_id IS NULL AND a.removed_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM app.api_regression_withdrawals w WHERE w.snapshot_id=s.id)`;

function qualification(row: RegressionRow) {
  return apiRegressionQualificationSchema.parse({
    snapshotId: row.id,
    caseId: row.case_id,
    revisionId: row.case_revision_id,
    revisionNo: row.revision_no,
    source: 'debugPassed',
    debugRunId: row.debug_run_id,
    environmentId: row.environment_id,
    savedAt: row.approved_at.toISOString(),
  });
}

export async function latestApiRegressionInTransaction(
  tx: SqlExecutor,
  projectId: string,
  caseId: string,
) {
  await getApiProjectCase(tx, projectId, caseId);
  const row = (
    await tx.query<RegressionRow>(
      `${regressionSelect} AND s.case_id=$2 ORDER BY s.approval_sequence DESC LIMIT 1`,
      [projectId, caseId],
    )
  ).rows[0];
  if (!row)
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '此接口用例没有有效的可回归修订。',
      422,
    );
  return {
    approval: approvalSnapshotSchema.parse({
      id: row.id,
      projectId: row.project_id,
      kind: 'API',
      caseId: row.case_id,
      caseRevisionId: row.case_revision_id,
      scenarioRevisionId: row.scenario_revision_id,
      setRevisionId: row.set_revision_id,
      opinionContextDigest: row.opinion_context_digest,
      approvedBy: row.approved_by,
      approvedAt: row.approved_at.toISOString(),
    }),
    snapshot: apiProjectQualificationSnapshotSchema.parse(row.snapshot),
    qualification: qualification(row),
  };
}

function unavailable(message: string): never {
  throw new DomainError('PRECONDITIONS_MISSING', message, 422);
}

async function requireQualificationEnvironment(
  tx: SqlExecutor,
  projectId: string,
  environmentId: string,
  environmentRevisionId: string,
) {
  const allowed = (
    await tx.query(
      `SELECT c.id FROM app.test_configurations c
       WHERE c.project_id=$1 AND c.id=$2 AND c.kind='environment'
         AND c.current_revision_id=$3 AND c.active
         AND c.content @> '{"allowApiRegressionQualification":true}'
       FOR SHARE OF c`,
      [projectId, environmentId, environmentRevisionId],
    )
  ).rowCount;
  if (!allowed) unavailable('请在项目认可的环境取得当前配置下的完整调试回执。');
}

async function requireCompleteDebug(
  tx: SqlExecutor,
  projectId: string,
  runId: string,
  itemId: string,
  content: ApiCaseContent,
) {
  const fact = (
    await tx.query(
      `SELECT 1 FROM app.api_case_facts
       WHERE project_id=$1 AND run_id=$2 AND run_item_id=$3
         AND original_outcome='passed' AND side_effect_certainty<>'unknown'
         AND ended_at IS NOT NULL AND permission_lost_at IS NULL AND completion_digest IS NOT NULL
         AND cleanup_state=$4`,
      [
        projectId,
        runId,
        itemId,
        content.cleanup.mode === 'none' ? 'notConfigured' : 'succeeded',
      ],
    )
  ).rowCount;
  if (!fact)
    unavailable('当前调试未完成全部断言、必要清理，或执行结果仍待核实。');
  const steps = (
    await tx.query<{ step_id: string; has_assertions: boolean }>(
      `SELECT step_id,jsonb_array_length(assertions_safe)>0 has_assertions
        FROM app.api_step_attempts
        WHERE project_id=$1 AND run_id=$2 AND run_item_id=$3 AND phase='business'
          AND state='completed' AND outcome='passed' AND side_effect_certainty<>'unknown'`,
      [projectId, runId, itemId],
    )
  ).rows;
  if (!steps.some((step) => step.has_assertions))
    unavailable('调试回执未覆盖候选修订的全部业务步骤及有效断言。');
}

export class ApiRegressionService {
  readonly operations: OperationService;
  constructor(readonly db: Database) {
    this.operations = new OperationService(db);
  }

  async list(actor: ActorContext, projectId: string) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const rows = (
        await tx.query<RegressionRow>(
          `SELECT DISTINCT ON (available.case_id) available.*
           FROM (${regressionSelect}) available
           ORDER BY available.case_id,available.approval_sequence DESC`,
          [projectId],
        )
      ).rows;
      return { qualifications: rows.map(qualification) };
    });
  }

  async save(actor: ActorContext, projectId: string, raw: unknown) {
    const input = saveApiRegressionInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      saveOperation,
      input.commandId,
      { projectId, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'assets.write');
      },
      async (tx) => {
        const current = await getApiProjectCase(tx, projectId, input.caseId, {
          lock: true,
        });
        if (
          current.revisionId !== input.baseRevisionId ||
          current.rowVersion !== input.rowVersion
        )
          stale();
        const scenario = current.parentId
          ? await getApiProjectAsset(tx, projectId, current.parentId, {
              lock: true,
            })
          : null;
        if (scenario && scenario.targetType !== 'scenario')
          throw new DomainError('NOT_FOUND', '此项目没有对应接口场景。', 404);
        // The run and draft locks serialize promotion against temporary trace cleanup.
        const debug = (
          await tx.query<DebugCandidateRow>(
            `SELECT r.state,r.scope_snapshot,d.source_case_id,d.source_case_revision_id,
                d.scenario_revision_id,
                d.draft_hash,d.expires_at,d.content->'content' authored_content,q.snapshot_id saved_snapshot_id
              FROM app.api_debug_drafts d
              JOIN app.runs r ON r.id=d.run_id AND r.project_id=d.project_id
              LEFT JOIN app.api_regression_qualifications q ON q.debug_run_id=d.run_id
              WHERE d.project_id=$1 AND d.run_id=$2 AND r.source='debug'
              FOR UPDATE OF r,d`,
            [projectId, input.debugRunId],
          )
        ).rows[0];
        if (!debug || debug.expires_at.getTime() <= Date.now())
          unavailable('原调试回执不存在或已过暂存期限。');
        if (debug.saved_snapshot_id)
          unavailable('此调试回执已用于保存资格，请查阅原保存回执。');
        if (
          debug.source_case_id !== current.id ||
          debug.source_case_revision_id !== current.revisionId ||
          debug.scenario_revision_id !== (scenario?.revisionId ?? null) ||
          debug.draft_hash !== input.draftHash
        )
          stale();
        const scope = debugExecutionScopeSchema.parse(debug.scope_snapshot);
        if (scope.diagnosticStepId !== undefined)
          unavailable(
            '单步诊断只用于定位问题，须使用完整用例调试回执建立回归资格。',
          );
        if (debug.state !== 'completed')
          unavailable('原调试尚未完整结束，请查看原轮次。');
        if (
          scope.items.some((item) => item.caseId !== current.id) ||
          scope.draftHash !== input.draftHash ||
          input.content.scenarioId !== (scenario?.id ?? null) ||
          canonicalJson(debug.authored_content) !== canonicalJson(input.content)
        )
          stale();
        await requireQualificationEnvironment(
          tx,
          projectId,
          scope.environmentId,
          scope.environmentRevisionId,
        );
        const content = apiCaseContentSchema.parse(debug.authored_content);
        for (const item of scope.items)
          await requireCompleteDebug(
            tx,
            projectId,
            scope.runId,
            item.runItemId,
            item.content,
          );
        const qualifiedDataRowIds = [
          ...new Set(
            scope.items.flatMap(({ dataRow }) => (dataRow ? [dataRow.id] : [])),
          ),
        ];
        const asset =
          canonicalJson(current.content) === canonicalJson(content)
            ? current
            : await reviseApiProjectCase(
                tx,
                actor,
                projectId,
                current.id,
                {
                  baseRevisionId: current.revisionId,
                  rowVersion: current.rowVersion,
                },
                content,
              );
        const existing = (
          await tx.query<RegressionRow>(
            `${regressionSelect} AND s.case_id=$2 AND s.case_revision_id=$3
              AND s.scenario_revision_id IS NOT DISTINCT FROM $4::uuid
              AND s.snapshot->'qualifiedDataRowIds'=$5::jsonb
              AND q.debug_run_id IS NOT NULL ORDER BY s.approval_sequence DESC LIMIT 1`,
            [
              projectId,
              asset.id,
              asset.revisionId,
              scenario?.revisionId ?? null,
              JSON.stringify(qualifiedDataRowIds),
            ],
          )
        ).rows[0];
        if (existing)
          return apiRegressionSaveReceiptSchema.parse({
            asset,
            qualification: qualification(existing),
          });
        const snapshot = apiProjectQualificationSnapshotSchema.parse({
          case: asset,
          scenario,
          qualifiedDataRowIds,
        });
        const contextDigest = createHash('sha256')
          .update(canonicalJson(snapshot))
          .digest('hex');
        const inserted = (
          await tx.query<{ id: string; approved_at: Date }>(
            `INSERT INTO app.approval_snapshots
                (project_id,kind,set_id,case_id,case_revision_id,scenario_id,scenario_revision_id,set_revision_id,opinion_context_digest,snapshot,approved_by)
              VALUES ($1,'API',NULL,$2,$3,$4,$5,NULL,$6,$7,$8) RETURNING id,approved_at`,
            [
              projectId,
              asset.id,
              asset.revisionId,
              scenario?.id ?? null,
              scenario?.revisionId ?? null,
              contextDigest,
              JSON.stringify(snapshot),
              actor.userId,
            ],
          )
        ).rows[0];
        if (!inserted)
          throw new Error('API regression snapshot was not inserted');
        await tx.query(
          'INSERT INTO app.api_regression_qualifications(snapshot_id,project_id,debug_run_id) VALUES($1,$2,$3)',
          [inserted.id, projectId, scope.runId],
        );
        if (asset.requirementVersionId)
          await recordBusinessActivity(
            tx,
            projectId,
            asset.requirementVersionId,
          );
        await audit(tx, actor, saveOperation, asset.id, projectId, {
          snapshotId: inserted.id,
          revisionId: asset.revisionId,
          runId: scope.runId,
        });
        return apiRegressionSaveReceiptSchema.parse({
          asset,
          qualification: {
            snapshotId: inserted.id,
            caseId: asset.id,
            revisionId: asset.revisionId,
            revisionNo: asset.revisionNo,
            source: 'debugPassed',
            debugRunId: scope.runId,
            environmentId: scope.environmentId,
            savedAt: inserted.approved_at.toISOString(),
          },
        });
      },
      projectId,
    );
  }

  async saveReceipt(actor: ActorContext, projectId: string, commandId: string) {
    const found = await this.operations.get(actor, {
      operation: saveOperation,
      key: commandId,
    });
    if (found.command.projectId !== projectId)
      throw new DomainError('NOT_FOUND', '当前项目中未取得该保存回执。', 404);
    return apiRegressionSaveStatusSchema.parse({
      commandId,
      status: found.command.status,
      response:
        found.command.status === 'completed' ? found.command.response : null,
    });
  }

  async withdraw(actor: ActorContext, projectId: string, raw: unknown) {
    const input = withdrawApiRegressionInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      withdrawOperation,
      input.commandId,
      { projectId, ...input },
      (tx) =>
        requireProject(tx, actor, projectId, 'assets.write').then(
          () => undefined,
        ),
      async (tx) => {
        const row = (
          await tx.query<{ case_id: string }>(
            "SELECT case_id FROM app.approval_snapshots WHERE id=$1 AND project_id=$2 AND kind='API' AND set_id IS NULL",
            [input.snapshotId, projectId],
          )
        ).rows[0];
        if (!row)
          throw new DomainError('NOT_FOUND', '此项目没有该可回归快照。', 404);
        await getApiProjectCase(tx, projectId, row.case_id, {
          lock: true,
          includeArchived: true,
        });
        const stored = (
          await tx.query<{ withdrawn_at: Date }>(
            'INSERT INTO app.api_regression_withdrawals(snapshot_id,actor_id,reason) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING withdrawn_at',
            [input.snapshotId, actor.userId, input.reason],
          )
        ).rows[0];
        const withdrawn =
          stored ??
          (
            await tx.query<{ withdrawn_at: Date }>(
              'SELECT withdrawn_at FROM app.api_regression_withdrawals WHERE snapshot_id=$1',
              [input.snapshotId],
            )
          ).rows[0];
        if (!withdrawn)
          throw new Error('API regression withdrawal was not recorded');
        if (stored)
          await audit(tx, actor, withdrawOperation, row.case_id, projectId, {
            snapshotId: input.snapshotId,
          });
        return apiRegressionWithdrawReceiptSchema.parse({
          snapshotId: input.snapshotId,
          withdrawnAt: withdrawn.withdrawn_at.toISOString(),
        });
      },
      projectId,
    );
  }
}
