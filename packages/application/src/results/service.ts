import { UiArchiveService } from '../ui-executions/archive.js';
import { reportExecutionScopeSchema } from '../../../contracts/src/ui-archives.js';
import { randomUUID } from 'node:crypto';
import {
  resultSubmissionReceiptSchema,
  resultItemSchema,
  resultAmendmentSchema,
} from '../../../contracts/src/domain.js';
import {
  finalAssessmentInputSchema,
  webFinalAssessmentInputSchema,
  supplementaryEvidenceResourceInputSchema as supplementaryEvidenceInputSchema,
} from '../../../contracts/src/ui-results.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { OperationService } from '../operations/service.js';
import { DomainError, stale } from '../errors.js';
import { audit } from '../events.js';
import { readRun, semanticDigest } from '../ui-executions/service.js';
import {
  registerEvidence,
  evidenceIdsForReferences,
  linkEvidence,
  missingFiles,
} from './evidence.js';
import { persistReportRevision } from '../reports/service.js';
import { assertSafeResultContent } from './safety.js';
import { readHumanRetests, recordHumanRetest } from './human-retests.js';
import { ensureFailedProblemInTransaction } from '../issues/problems.js';
import { lockReportResult } from '../issues/review-evidence.js';
import { assertSubmissionFileBudget } from '../files/submission-budget.js';
import { assertReferencedEvidenceFileBudget } from './submission-budget.js';
import {
  fileResourcePolicies,
  fileIntentDigest,
  assertFilePolicyCounts,
  type FileResourcePolicies,
} from '../files/resource-policy.js';
import { assertLocalUiActor } from './delivery-access.js';
import {
  assertResultEvidenceScope,
  assertResultStepEvidenceReferences,
  readResultScope,
} from './result-scope.js';
import {
  uiDeliveryGate,
  deliveryMissingFiles,
  projectUiDelivery,
  bumpUiDeliveryRunMetadata,
} from './delivery-state.js';

interface ResultRow {
  id: string;
  run_id: string;
  run_item_id: string;
  local_result_id: string;
  current_revision_id: string;
  current_assessment_revision_id: string | null;
  content: unknown;
}
export class ResultService {
  get archives() {
    return new UiArchiveService(this.db, this.policies);
  }
  private readonly operations: OperationService;
  constructor(
    readonly db: Database,
    readonly policies: FileResourcePolicies = fileResourcePolicies,
  ) {
    this.operations = new OperationService(db);
  }
  readHumanRetests(actor: ActorContext, projectId: string, raw: unknown) {
    return readHumanRetests(this.db, actor, projectId, raw);
  }

  recordHumanRetest(actor: ActorContext, projectId: string, raw: unknown) {
    return recordHumanRetest(this.operations, actor, projectId, raw);
  }

  async receipt(actor: ActorContext, projectId: string, submissionId: string) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'results.submit');
      const row = (
        await tx.query<{ receipt: unknown; run_id: string }>(
          `SELECT s.receipt,s.run_id FROM app.result_submissions s JOIN app.runs r ON r.id=s.run_id
         WHERE r.project_id=$1 AND s.actor_id=$2 AND s.submission_id=$3`,
          [projectId, actor.userId, submissionId],
        )
      ).rows[0];
      if (!row)
        throw new DomainError(
          'NOT_FOUND',
          '没有此账号在本项目提交的回执。',
          404,
        );
      const run = await readRun(tx, projectId, row.run_id);
      const scope = reportExecutionScopeSchema.parse(run.scope_snapshot);
      const gate = await uiDeliveryGate(tx, run.id);
      const missingFileIds = gate.versioned
        ? await deliveryMissingFiles(tx, run.id)
        : await missingFiles(tx, run.id);
      const count = Number(
        (
          await tx.query<{ count: string }>(
            'SELECT count(*)::text count FROM app.results WHERE run_id=$1',
            [run.id],
          )
        ).rows[0]?.count ?? '0',
      );
      return {
        receipt: resultSubmissionReceiptSchema.parse(row.receipt),
        currentDelivery: {
          missingFileIds,
          status:
            projectUiDelivery(
              gate,
              count,
              scope.items.length,
              missingFileIds.length,
            ) ??
            (count === scope.items.length && missingFileIds.length === 0
              ? 'complete'
              : 'incomplete'),
        },
      };
    });
  }

  async amend(actor: ActorContext, projectId: string, raw: unknown) {
    assertLocalUiActor(actor);
    assertSafeResultContent(raw);
    const input = resultAmendmentSchema.parse(raw);
    return this.operations.execute(
      actor,
      'results.amend',
      input.amendmentId,
      { projectId, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'results.submit');
      },
      async (tx) => {
        const run = await readRun(tx, projectId, input.runId, true);
        if (run.kind !== 'UI')
          throw new DomainError(
            'FORBIDDEN',
            '平台接口原始采集事实不通过本地UI更正通道修改，请使用独立人工最终结论。',
            403,
          );
        const row = await this.result(tx, projectId, input.resultId, true);
        if (
          row.run_id !== input.runId ||
          row.run_item_id !== input.replacement.runItemId
        )
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '更正不能改变结果所属执行或范围项。',
            409,
          );
        if (row.current_revision_id !== input.baseResultRevisionId) stale();
        if (row.local_result_id !== input.replacement.localResultId)
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '更正须保持本地结果标识。',
            409,
          );
        const policy = await this.policies.accept(tx, {
          ownerId: actor.userId,
          projectId,
          namespace: 'results.amend',
          key: input.amendmentId,
          payloadDigest: fileIntentDigest(input),
          existing: false,
        });
        if (run.source === 'uiArchive')
          assertResultStepEvidenceReferences(input.replacement);
        else
          await assertResultEvidenceScope(
            tx,
            projectId,
            row.run_id,
            input.replacement,
          );
        await assertReferencedEvidenceFileBudget(
          tx,
          projectId,
          row.run_id,
          input.replacement.evidenceRefs,
          policy,
        );
        const evidenceIds = await evidenceIdsForReferences(
          tx,
          row.run_id,
          input.replacement.evidenceRefs,
        );
        const previous = (
          await tx.query<{ revision_no: number }>(
            'SELECT revision_no FROM app.result_revisions WHERE id=$1',
            [row.current_revision_id],
          )
        ).rows[0];
        const revisionId = randomUUID();
        await tx.query(
          'INSERT INTO app.result_revisions(id,result_id,revision_no,amendment_id,content,semantic_digest,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            revisionId,
            row.id,
            (previous?.revision_no ?? 0) + 1,
            input.amendmentId,
            JSON.stringify(input.replacement),
            semanticDigest(input.replacement),
            input.reason,
            actor.userId,
          ],
        );
        await tx.query(
          'UPDATE app.results SET current_revision_id=$2 WHERE id=$1',
          [row.id, revisionId],
        );
        await linkEvidence(tx, actor, row.id, evidenceIds, 'original');
        await ensureFailedProblemInTransaction(
          tx,
          actor,
          projectId,
          row.id,
          revisionId,
        );
        await tx.query(
          'UPDATE app.run_items SET outcome=$2,side_effect_certainty=$3,state=$4 WHERE id=$1',
          [
            row.run_item_id,
            input.replacement.originalOutcome,
            input.replacement.sideEffectCertainty,
            input.replacement.originalOutcome === 'notExecuted'
              ? 'notExecuted'
              : 'completed',
          ],
        );
        await bumpUiDeliveryRunMetadata(tx, row.run_id);
        const report = await persistReportRevision(
          tx,
          actor,
          projectId,
          row.run_id,
          'explicit-result-amendment',
        );
        await audit(tx, actor, 'results.amended', row.id, projectId, {
          revisionId,
        });
        return { resultId: row.id, revisionId, reportId: report.reportId };
      },
      projectId,
    );
  }

  async assess(
    actor: ActorContext,
    projectId: string,
    resultId: string,
    raw: unknown,
  ) {
    assertSafeResultContent(raw);
    const input: ReturnType<typeof webFinalAssessmentInputSchema.parse> = (
      actor.entrypoint === 'web'
        ? webFinalAssessmentInputSchema
        : finalAssessmentInputSchema
    ).parse(raw);
    return this.operations.execute(
      actor,
      'results.assess',
      input.commandId,
      { projectId, resultId, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'results.assess');
      },
      async (tx) => {
        const unlocked = await this.result(tx, projectId, resultId);
        await readRun(tx, projectId, unlocked.run_id, true);
        if (input.reportReview) {
          if (
            input.reportReview.resultId !== resultId ||
            input.reportReview.resultRevisionId !== input.baseResultRevisionId
          )
            throw new DomainError(
              'BUSINESS_CONFLICT',
              '人工结论与报告所选结果不匹配。',
              409,
            );
          await lockReportResult(tx, projectId, input.reportReview);
        }
        const row = await this.result(tx, projectId, resultId, true);
        if (
          row.current_assessment_revision_id !== input.baseAssessmentRevisionId
        )
          stale();
        if (row.current_revision_id !== input.baseResultRevisionId) stale();
        const revisionId = randomUUID();
        await tx.query(
          'INSERT INTO app.result_assessments(id,result_id,result_revision_id,base_revision_id,final_outcome,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            revisionId,
            row.id,
            input.baseResultRevisionId,
            input.baseAssessmentRevisionId,
            input.finalOutcome,
            input.reason,
            actor.userId,
          ],
        );
        await tx.query(
          'UPDATE app.results SET current_assessment_revision_id=$2 WHERE id=$1',
          [row.id, revisionId],
        );
        await bumpUiDeliveryRunMetadata(tx, row.run_id);
        const report = await persistReportRevision(
          tx,
          actor,
          projectId,
          row.run_id,
          'manual-final-assessment',
        );
        await audit(tx, actor, 'results.assessed', row.id, projectId, {
          assessmentRevisionId: revisionId,
          finalOutcome: input.finalOutcome,
          ...(input.reportReview ? { reportReview: input.reportReview } : {}),
        });
        return {
          resultId,
          assessmentRevisionId: revisionId,
          reportId: report.reportId,
        };
      },
      projectId,
    );
  }

  async addEvidence(actor: ActorContext, projectId: string, raw: unknown) {
    const input = supplementaryEvidenceInputSchema.parse(raw);
    if (input.reportReview && input.reportReview.resultId !== input.resultId)
      throw new DomainError(
        'VALIDATION_ERROR',
        '补证结果与报告步骤范围不一致。',
        400,
      );
    return this.operations.execute(
      actor,
      'results.evidence-addition',
      input.commandId,
      { projectId, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'results.submit');
      },
      async (tx) => {
        if (input.reportReview)
          await lockReportResult(tx, projectId, input.reportReview);
        const initialRead = await this.result(tx, projectId, input.resultId);
        await readRun(tx, projectId, initialRead.run_id, true);
        const initial = await this.result(tx, projectId, input.resultId, true);
        const manifest = input.evidenceManifest.map((item) => ({
          ...item,
          source: 'manualAddition' as const,
        }));
        const policy = await this.policies.accept(tx, {
          ownerId: actor.userId,
          projectId,
          namespace: 'results.evidence-addition',
          key: input.commandId,
          payloadDigest: fileIntentDigest(input),
          existing: false,
        });
        assertFilePolicyCounts(policy, manifest.length);
        await assertSubmissionFileBudget(
          tx,
          projectId,
          manifest.map((item) => item.fileId),
          policy,
        );
        const evidence = await registerEvidence(
          tx,
          actor,
          projectId,
          initial.run_id,
          manifest,
        );
        const cumulative = (
          await tx.query<{ file_id: string; id: string }>(
            `SELECT e.id,e.file_id FROM app.run_evidence e WHERE e.run_id=$1 AND (e.id=ANY($2::uuid[]) OR EXISTS(SELECT 1 FROM app.result_evidence_links l WHERE l.result_id=$3 AND l.evidence_id=e.id)) ORDER BY e.id FOR SHARE`,
            [initial.run_id, [...evidence.values()], initial.id],
          )
        ).rows;
        if (cumulative.length > 1000)
          throw new DomainError(
            'FILE_TOO_LARGE',
            '单结果累计证据身份超过1000项结构范围。',
            413,
          );
        await assertSubmissionFileBudget(
          tx,
          projectId,
          cumulative.map((row) => row.file_id),
          policy,
          'case',
        );
        const linkedBefore = new Set(
          (
            await tx.query<{ evidence_id: string }>(
              'SELECT evidence_id FROM app.result_evidence_links WHERE result_id=$1 AND evidence_id=ANY($2::uuid[])',
              [initial.id, [...evidence.values()]],
            )
          ).rows.map((item) => item.evidence_id),
        );
        await linkEvidence(
          tx,
          actor,
          initial.id,
          [...evidence.values()],
          'manualAddition',
        );
        const ordinal = input.reportReview?.stepOrdinal;
        let addedStepLinks = false;
        if (ordinal !== undefined) {
          const links = await tx.query(
            'INSERT INTO app.result_step_evidence_links(result_id,evidence_id,result_revision_id,step_ordinal) SELECT $1,id,$2,$3 FROM unnest($4::uuid[]) id ON CONFLICT DO NOTHING',
            [
              initial.id,
              initial.current_revision_id,
              ordinal,
              [...evidence.values()],
            ],
          );
          addedStepLinks = Boolean(links.rowCount);
        }
        if (
          addedStepLinks ||
          [...evidence.values()].some((id) => !linkedBefore.has(id))
        )
          await bumpUiDeliveryRunMetadata(tx, initial.run_id);
        const report = await persistReportRevision(
          tx,
          actor,
          projectId,
          initial.run_id,
          'manual-evidence-addition',
        );
        await audit(
          tx,
          actor,
          'results.evidence-added',
          initial.id,
          projectId,
          { count: evidence.size },
        );
        return {
          resultId: initial.id,
          evidenceAdded: evidence.size,
          resultRevisionId: initial.current_revision_id,
          reportId: report.reportId,
        };
      },
      projectId,
    );
  }

  async detail(actor: ActorContext, projectId: string, resultId: string) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const result = await this.result(tx, projectId, resultId);
      const scopeItem = await readResultScope(
        tx,
        projectId,
        result.run_id,
        result.run_item_id,
      );
      const history = await tx.query<{
        id: string;
        revision_no: number;
        content: unknown;
        reason: string | null;
        actor_id: string;
        created_at: Date;
      }>(
        'SELECT id,revision_no,content,reason,actor_id,created_at FROM app.result_revisions WHERE result_id=$1 ORDER BY revision_no DESC',
        [resultId],
      );
      const assessments = await tx.query<{
        id: string;
        final_outcome: string;
        reason: string;
        actor_id: string;
        created_at: Date;
      }>(
        'SELECT id,final_outcome,reason,actor_id,created_at FROM app.result_assessments WHERE result_id=$1 ORDER BY created_at DESC,id',
        [resultId],
      );
      const evidence = await tx.query<{
        id: string;
        file_id: string;
        manifest: unknown;
        source: string;
      }>(
        `SELECT e.id,e.file_id,e.manifest,l.source FROM app.result_evidence_links l JOIN app.run_evidence e ON e.id=l.evidence_id
         WHERE l.result_id=$1 ORDER BY l.created_at,e.id`,
        [resultId],
      );
      return {
        result: {
          id: result.id,
          runId: result.run_id,
          runItemId: result.run_item_id,
          revisionId: result.current_revision_id,
          assessmentRevisionId: result.current_assessment_revision_id,
          content: resultItemSchema.parse(result.content),
          ...(scopeItem ? { scopeItem } : {}),
          history: history.rows.map((row) => ({
            id: row.id,
            revisionNo: row.revision_no,
            content: resultItemSchema.parse(row.content),
            reason: row.reason,
            actorId: row.actor_id,
            createdAt: row.created_at.toISOString(),
          })),
          assessments: assessments.rows.map((row) => ({
            id: row.id,
            finalOutcome: row.final_outcome,
            reason: row.reason,
            actorId: row.actor_id,
            createdAt: row.created_at.toISOString(),
          })),
          evidence: evidence.rows.map((row) => ({
            id: row.id,
            fileId: row.file_id,
            manifest: row.manifest,
            source: row.source,
          })),
        },
      };
    });
  }

  private async result(
    tx: SqlExecutor,
    projectId: string,
    id: string,
    lock = false,
  ): Promise<ResultRow> {
    const row = (
      await tx.query<ResultRow>(
        `SELECT r.*,v.content FROM app.results r JOIN app.result_revisions v ON v.id=r.current_revision_id
       WHERE r.project_id=$1 AND r.id=$2${lock ? ' FOR UPDATE OF r' : ''}`,
        [projectId, id],
      )
    ).rows[0];
    if (!row) throw new DomainError('NOT_FOUND', '此项目内没有该结果。', 404);
    return row;
  }
}

/**
 * Trusted API-worker archival port only; never register as an HTTP/MCP/AI command.
 * The control plane validates its run grant and source attempt. Already-sent facts must
 * remain recordable after revocation, so this does not require the old actor to stay active.
 */
export async function recordApiCaseInTransaction(
  tx: SqlExecutor,
  actor: ActorContext,
  projectId: string,
  runId: string,
  runItemId: string,
  raw: unknown,
) {
  assertSafeResultContent(raw);
  const item = resultItemSchema.parse(raw);
  const run = await readRun(tx, projectId, runId, true);
  if (
    run.kind !== 'API' ||
    run.created_by !== actor.userId ||
    item.runItemId !== runItemId
  ) {
    throw new DomainError(
      'BUSINESS_CONFLICT',
      '接口事实归属与受控执行不一致。',
      409,
    );
  }
  if (!['passed', 'failed', 'notExecuted'].includes(item.originalOutcome))
    throw new DomainError(
      'VALIDATION_ERROR',
      '接口原始结论仅通过/失败/未执行。',
      400,
    );
  const target = (
    await tx.query(
      'SELECT 1 FROM app.run_items WHERE project_id=$1 AND run_id=$2 AND id=$3 FOR UPDATE',
      [projectId, runId, runItemId],
    )
  ).rowCount;
  if (!target)
    throw new DomainError('NOT_FOUND', '没有此固定接口执行项。', 404);
  const digest = semanticDigest(item);
  const previous = (
    await tx.query<{
      id: string;
      current_revision_id: string;
      semantic_digest: string;
    }>(
      `SELECT r.id,r.current_revision_id,v.semantic_digest FROM app.results r JOIN app.result_revisions v ON v.id=r.current_revision_id
     WHERE r.run_item_id=$1`,
      [runItemId],
    )
  ).rows[0];
  if (previous) {
    if (previous.semantic_digest !== digest)
      throw new DomainError(
        'IDEMPOTENCY_CONFLICT',
        '接口原始事实已落盘，未知窗口不得以新回执覆盖或重放。',
        409,
      );
    return {
      resultId: previous.id,
      revisionId: previous.current_revision_id,
      replayed: true,
    };
  }
  const evidenceIds = await evidenceIdsForReferences(
    tx,
    runId,
    item.evidenceRefs,
  );
  const resultId = randomUUID();
  const revisionId = randomUUID();
  await tx.query(
    'INSERT INTO app.results(id,project_id,run_id,run_item_id,local_result_id,current_revision_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      resultId,
      projectId,
      runId,
      runItemId,
      item.localResultId,
      revisionId,
      actor.userId,
    ],
  );
  await tx.query(
    'INSERT INTO app.result_revisions(id,result_id,revision_no,content,semantic_digest,actor_id) VALUES($1,$2,1,$3,$4,$5)',
    [revisionId, resultId, JSON.stringify(item), digest, actor.userId],
  );
  await linkEvidence(tx, actor, resultId, evidenceIds, 'original');
  await ensureFailedProblemInTransaction(
    tx,
    actor,
    projectId,
    resultId,
    revisionId,
  );
  await tx.query(
    'UPDATE app.run_items SET outcome=$2,side_effect_certainty=$3,state=$4,ended_at=$5 WHERE id=$1',
    [
      runItemId,
      item.originalOutcome,
      item.sideEffectCertainty,
      item.originalOutcome === 'notExecuted' ? 'notExecuted' : 'completed',
      item.endedAt ?? null,
    ],
  );
  await tx.query(
    "UPDATE app.runs SET execution_provenance='platform-api' WHERE id=$1",
    [runId],
  );
  await audit(tx, actor, 'results.api-fact-recorded', resultId, projectId, {
    runId,
    runItemId,
  });
  return { resultId, revisionId, replayed: false };
}
