import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  startDebugInputSchema,
  debugExecutionScopeSchema,
  debugStartReceiptSchema,
  debugTraceSchema,
  debugReceiptLookupSchema,
} from '../../../contracts/src/api-execution.js';
import {
  apiCaseContentSchema,
  scenarioContentSchema,
} from '../../../contracts/src/domain.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { Database } from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { getAsset, assetDto } from '../assets/repository.js';
import { latestApiRegressionInTransaction } from '../assets/api-regression.js';
import { DomainError } from '../errors.js';
import { audit } from '../events.js';
import { canonicalJson, OperationService } from '../operations/service.js';
import { PlanService } from '../plans/service.js';
import { assertSafeModelInput } from '../security/model-input.js';
import { ExecutionGateway, profileFor } from './gateway.js';

const digest = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
function executable(content: z.infer<typeof apiCaseContentSchema>) {
  return {
    variables: content.variables,
    steps: content.steps,
    cleanup: content.cleanup,
  };
}
function containsBoundSecret(
  value: unknown,
  secrets: readonly string[],
): boolean {
  if (typeof value === 'string')
    return secrets.some(
      (secret) =>
        value === secret || (secret.length >= 8 && value.includes(secret)),
    );
  if (Array.isArray(value))
    return value.some((item) => containsBoundSecret(item, secrets));
  if (value && typeof value === 'object')
    return Object.entries(value).some(
      ([key, item]) =>
        containsBoundSecret(key, secrets) || containsBoundSecret(item, secrets),
    );
  return false;
}
export class ApiDebugService {
  readonly operations: OperationService;
  constructor(
    readonly db: Database,
    readonly plans: PlanService,
    readonly gateway: ExecutionGateway,
    readonly retentionDays = 7,
  ) {
    this.operations = new OperationService(db);
  }
  async start(actor: ActorContext, projectId: string, raw: unknown) {
    const input = startDebugInputSchema.parse(raw);
    try {
      assertSafeModelInput(input.content);
    } catch {
      throw new DomainError(
        'VALIDATION_ERROR',
        '调试内容含疑似明文凭据，请使用用途/认证安全配置引用。',
        400,
      );
    }
    return this.operations.execute(
      actor,
      'api-runs.debug-draft',
      input.commandId,
      input,
      async (transaction) => {
        await requireProject(transaction, actor, projectId, 'runs.organize');
      },
      async (transaction) => {
        const scenario = await getAsset(
          transaction,
          projectId,
          input.content.scenarioId,
        );
        if (scenario.kind !== 'API' || scenario.target_type !== 'scenario')
          throw new DomainError('NOT_FOUND', '此项目没有该接口场景。', 404);
        const set = await getAsset(transaction, projectId, scenario.set_id);
        const selectedScenarioRevision =
          input.scenarioRevisionId ?? scenario.current_revision_id;
        const selected = (
          await transaction.query<{ content: unknown }>(
            'SELECT content FROM app.asset_revisions WHERE id=$1 AND asset_id=$2 AND project_id=$3',
            [selectedScenarioRevision, scenario.id, projectId],
          )
        ).rows[0];
        if (!selected)
          throw new DomainError('NOT_FOUND', '没有该场景上下文修订。', 404);
        const scenarioContent = scenarioContentSchema.parse(selected.content);
        let sourceRevisionId: string | null = null;
        let sourceChanged = false;
        let cleanupApprovalId: string | null = null;
        if (input.sourceCaseId) {
          const source = await getAsset(
            transaction,
            projectId,
            input.sourceCaseId,
          );
          if (
            source.kind !== 'API' ||
            source.target_type !== 'case' ||
            source.parent_id !== scenario.id
          )
            throw new DomainError(
              'NOT_FOUND',
              '调试来源不属于此接口场景。',
              404,
            );
          sourceRevisionId =
            input.sourceCaseRevisionId ?? source.current_revision_id;
          if (
            !(
              await transaction.query(
                'SELECT 1 FROM app.asset_revisions WHERE asset_id=$1 AND id=$2',
                [source.id, sourceRevisionId],
              )
            ).rowCount
          )
            throw new DomainError('NOT_FOUND', '没有该来源用例修订。', 404);
          sourceChanged = source.current_revision_id !== sourceRevisionId;
          try {
            const approved = await latestApiRegressionInTransaction(
              transaction,
              projectId,
              source.id,
            );
            // Cleanup inputs include its data-producing steps/variables, not merely an equal SQL string.
            if (
              canonicalJson(
                executable(
                  apiCaseContentSchema.parse(approved.snapshot.case.content),
                ),
              ) === canonicalJson(executable(input.content))
            )
              cleanupApprovalId = approved.approval.id;
          } catch (error: unknown) {
            if (!(
              error instanceof DomainError &&
              ['PRECONDITIONS_MISSING', 'NOT_FOUND'].includes(error.code)
            ))
              throw error;
          }
        }
        const requests = [
          ...input.content.steps,
          ...(input.content.cleanup.mode === 'none'
            ? []
            : input.content.cleanup.steps.flatMap((step) =>
                step.type === 'http' ? [step.request] : [],
              )),
        ];
        if (
          input.content.cleanup.mode !== 'none' &&
          input.content.cleanup.steps.some(
            (step) =>
              step.type === 'sql' && step.environmentId !== input.environmentId,
          )
        )
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '调试SQL清理须属于所选环境。',
            422,
          );
        const configuration =
          await this.plans.configurations.executionSnapshotInTransaction(
            transaction,
            actor,
            projectId,
            input.environmentId,
            requests.flatMap((step) =>
              step.purposeRef ? [step.purposeRef] : [],
            ),
            input.content.cleanup.mode === 'none'
              ? []
              : input.content.cleanup.steps.flatMap((step) =>
                  step.type === 'sql' ? [step.connectionId] : [],
                ),
            requests.flatMap((step) =>
              step.authProfileRef ? [step.authProfileRef] : [],
            ),
          );
        for (const step of requests) profileFor(configuration, step);
        if (
          containsBoundSecret(
            input.content,
            await this.gateway.protectedValues(configuration, transaction),
          )
        )
          throw new DomainError(
            'VALIDATION_ERROR',
            '调试内容不能硬编码本次绑定的秘密，请使用受控变量或认证引用。',
            400,
          );
        const draftId = randomUUID(),
          runId = randomUUID(),
          runItemId = randomUUID();
        const draftHash = digest({
          sourceCaseId: input.sourceCaseId,
          sourceCaseRevisionId: sourceRevisionId,
          scenarioRevisionId: selectedScenarioRevision,
          environmentRevisionId: configuration.environment.revisionId,
          productBuild: input.productBuild,
          content: input.content,
        });
        const base = {
          schemaVersion: 'ath.debug-execution-scope.v1',
          runId,
          sourceType: 'debug',
          sourceRevisionId: draftId,
          projectId,
          kind: 'API',
          environmentId: input.environmentId,
          environmentRevisionId: configuration.environment.revisionId,
          productBuild: input.productBuild,
          draftHash,
          cleanupApprovalSnapshotId: cleanupApprovalId,
          items: [
            {
              runItemId,
              caseId: input.sourceCaseId,
              approvalSnapshotId: null,
              requirementVersionId: scenario.requirement_version_id,
              setId: scenario.set_id,
              scenarioId: scenario.id,
              scenario: scenarioContent,
              content: input.content,
              ordinal: 0,
              issueIds: [],
            },
          ],
          missingRequirements: [],
        };
        const scope = debugExecutionScopeSchema.parse({
          ...base,
          snapshotDigest: digest(base),
        });
        await transaction.query(
          `INSERT INTO app.runs(id,run_snapshot_id,project_id,kind,source,source_revision_id,environment_id,environment_revision_id,product_build,created_by,
        state,scope_snapshot,scope_digest,internal_configuration,origin_key_id,execution_provenance) VALUES($1,$2,$3,'API','debug',$4,$5,$6,$7,$8,'prepared',$9,$10,$11,$12,'platform-api')`,
          [
            runId,
            randomUUID(),
            projectId,
            draftId,
            input.environmentId,
            configuration.environment.revisionId,
            input.productBuild,
            actor.userId,
            JSON.stringify(scope),
            scope.snapshotDigest,
            JSON.stringify({
              cases: [{ caseId: input.sourceCaseId, configuration }],
            }),
            actor.keyId ?? null,
          ],
        );
        await transaction.query(
          'INSERT INTO app.run_items(id,project_id,run_id,ordinal,case_id,approval_snapshot_id,snapshot,cleanup_state) VALUES($1,$2,$3,0,$4,NULL,$5,$6)',
          [
            runItemId,
            projectId,
            runId,
            input.sourceCaseId,
            JSON.stringify(scope.items[0]),
            input.content.cleanup.mode === 'none' ? 'notConfigured' : 'pending',
          ],
        );
        await transaction.query(
          `INSERT INTO app.api_debug_drafts(id,project_id,run_id,source_case_id,source_case_revision_id,scenario_revision_id,draft_hash,content,cleanup_approval_snapshot_id,created_by,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp()+$11::int*interval '1 day')`,
          [
            draftId,
            projectId,
            runId,
            input.sourceCaseId,
            sourceRevisionId,
            selectedScenarioRevision,
            draftHash,
            JSON.stringify({
              content: input.content,
              scenario: scenarioContent,
              set: assetDto(set),
            }),
            cleanupApprovalId,
            actor.userId,
            this.retentionDays,
          ],
        );
        await audit(
          transaction,
          actor,
          'api-runs.debug-draft-accepted',
          runId,
          projectId,
          {
            draftId,
            draftHash,
            sourceCaseId: input.sourceCaseId,
            formalApproval: false,
          },
        );
        return debugStartReceiptSchema.parse({
          runId,
          state: 'prepared',
          draftHash,
          sourceChanged,
          formal: false,
          approvalSnapshotId: null,
          cleanupApprovalSnapshotId: cleanupApprovalId,
          debugResultUrl: `/api/v1/projects/${projectId}/api-executions/${runId}/debug-result`,
        });
      },
      projectId,
    );
  }
  async cleanupExpired() {
    return this.db.transaction(async (transaction) => {
      if (
        !(
          await transaction.query<{ exists: boolean }>(
            "SELECT to_regclass('app.api_debug_drafts') IS NOT NULL exists",
          )
        ).rows[0]?.exists
      )
        return { cleaned: 0 };
      const expired = await transaction.query<{
        run_id: string;
        project_id: string;
        draft_hash: string;
      }>(`SELECT d.run_id,d.project_id,d.draft_hash FROM app.api_debug_drafts d JOIN app.runs r ON r.id=d.run_id
        WHERE d.expires_at<=clock_timestamp() AND r.source='debug' AND r.scope_snapshot->>'schemaVersion'='ath.debug-execution-scope.v1'
        AND NOT EXISTS(SELECT 1 FROM app.api_regression_qualifications q WHERE q.debug_run_id=d.run_id)
        AND NOT EXISTS(SELECT 1 FROM app.api_worker_grants g WHERE g.run_id=r.id AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp())
        ORDER BY d.expires_at LIMIT 100 FOR UPDATE OF d,r SKIP LOCKED`);
      for (const expiredRun of expired.rows) {
        const items = await transaction.query<{ id: string }>(
          'SELECT id FROM app.run_items WHERE run_id=$1',
          [expiredRun.run_id],
        );
        const ids = items.rows.map((item) => item.id);
        for (const table of [
          'api_auth_tokens',
          'api_protected_values',
          'api_tainted_variables',
        ] as const)
          await transaction.query(
            `DELETE FROM app.${table} WHERE run_item_id=ANY($1::uuid[])`,
            [ids],
          );
        for (const itemId of ids)
          await this.gateway.secrets.destroyExecutionTransient(
            transaction,
            itemId,
          );
        await transaction.query(
          'DELETE FROM app.api_step_attempts WHERE run_id=$1',
          [expiredRun.run_id],
        );
        await transaction.query(
          'DELETE FROM app.api_case_facts WHERE run_id=$1',
          [expiredRun.run_id],
        );
        await transaction.query(
          'UPDATE app.api_worker_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE run_id=$1',
          [expiredRun.run_id],
        );
        await transaction.query(
          "UPDATE app.run_items SET snapshot='{}'::jsonb,state=CASE WHEN state='pending' THEN 'notExecuted' ELSE state END WHERE run_id=$1",
          [expiredRun.run_id],
        );
        await transaction.query(
          `UPDATE app.runs SET scope_snapshot=$2,internal_configuration='{}'::jsonb,product_build=NULL,
          state=CASE WHEN state IN ('prepared','queued','running','stopping') THEN 'terminated' ELSE state END,ended_at=COALESCE(ended_at,clock_timestamp()) WHERE id=$1`,
          [
            expiredRun.run_id,
            JSON.stringify({
              schemaVersion: 'ath.expired-debug.v1',
              draftHash: expiredRun.draft_hash,
            }),
          ],
        );
        await transaction.query(
          'DELETE FROM app.api_debug_drafts WHERE run_id=$1',
          [expiredRun.run_id],
        );
        await transaction.query(
          "INSERT INTO app.api_run_events(run_id,event_type,payload) VALUES($1,'debug.expired',$2)",
          [
            expiredRun.run_id,
            JSON.stringify({
              draftHash: expiredRun.draft_hash,
              bodyRemoved: true,
            }),
          ],
        );
      }
      return { cleaned: expired.rows.length };
    });
  }
  async receipt(actor: ActorContext, projectId: string, commandId: string) {
    const found = await this.operations.get(actor, {
      operation: 'api-runs.debug-draft',
      key: commandId,
    });
    if (found.command.projectId !== projectId)
      throw new DomainError(
        'NOT_FOUND',
        '没有此项目可读的调试提交回执；未查到不代表请求未受理。',
        404,
      );
    return debugReceiptLookupSchema.parse({
      commandId,
      status:
        found.command.status === 'completed'
          ? 'accepted'
          : found.command.status,
      receipt:
        found.command.status === 'completed'
          ? debugStartReceiptSchema.parse(found.command.response)
          : null,
    });
  }
  async trace(actor: ActorContext, projectId: string, runId: string) {
    return this.db.transaction(async (transaction) => {
      await requireProject(transaction, actor, projectId, 'project.read');
      const row = (
        await transaction.query<{
          state: string;
          scope_snapshot: unknown;
          draft_hash: string;
          created_at: Date;
          expires_at: Date;
          retained: boolean;
          qualification_environment: boolean;
        }>(
          `SELECT r.state,r.scope_snapshot,d.draft_hash,d.created_at,d.expires_at,
          EXISTS(SELECT 1 FROM app.api_regression_qualifications q WHERE q.debug_run_id=d.run_id) retained,
          EXISTS(SELECT 1 FROM app.test_configurations c WHERE c.project_id=r.project_id
            AND c.id=r.environment_id AND c.current_revision_id=r.environment_revision_id AND c.active
            AND c.content @> '{"allowApiRegressionQualification":true}') qualification_environment
          FROM app.runs r
        JOIN app.api_debug_drafts d ON d.run_id=r.id WHERE r.id=$1 AND r.project_id=$2`,
          [runId, projectId],
        )
      ).rows[0];
      if (!row || (!row.retained && row.expires_at.getTime() <= Date.now()))
        throw new DomainError(
          'NOT_FOUND',
          '调试诊断不存在或已过临时保留期。',
          404,
        );
      const facts = await transaction.query<{
        run_item_id: string;
        original_outcome: string | null;
        cleanup_state: string;
        side_effect_certainty: string;
        reason: string;
        started_at: Date;
        ended_at: Date | null;
      }>(
        'SELECT run_item_id,original_outcome,cleanup_state,side_effect_certainty,reason,started_at,ended_at FROM app.api_case_facts WHERE run_id=$1',
        [runId],
      );
      const attempts = await transaction.query(
        'SELECT id,phase,step_id,state,outcome,reason,side_effect_certainty FROM app.api_step_attempts WHERE run_id=$1 ORDER BY created_at,id LIMIT 500',
        [runId],
      );
      const fact = facts.rows[0];
      return debugTraceSchema.parse({
        runId,
        state: row.state,
        formal: false,
        approvalSnapshotId: null,
        draftHash: row.draft_hash,
        scope: debugExecutionScopeSchema.parse(row.scope_snapshot),
        evaluationStatus: !fact
          ? 'notStarted'
          : fact.original_outcome === 'notExecuted'
            ? 'notExecuted'
            : !fact.ended_at
              ? 'inProgress'
              : fact.original_outcome === null
                ? 'notConfigured'
                : 'evaluated',
        facts: facts.rows.map((entry) => ({
          runItemId: entry.run_item_id,
          originalOutcome: entry.original_outcome,
          cleanupState: entry.cleanup_state,
          sideEffectCertainty: entry.side_effect_certainty,
          reason: entry.reason,
          startedAt: entry.started_at.toISOString(),
          endedAt: entry.ended_at?.toISOString() ?? null,
        })),
        steps: attempts.rows.map((entry) => ({
          id: entry.id,
          phase: entry.phase,
          stepId: entry.step_id,
          state: entry.state,
          outcome: entry.outcome,
          reason: entry.reason,
          sideEffectCertainty: entry.side_effect_certainty,
        })),
        createdAt: row.created_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        qualificationRetained: row.retained,
        qualificationEnvironment: row.qualification_environment,
      });
    });
  }
}
