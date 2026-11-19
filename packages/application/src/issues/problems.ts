import { randomUUID } from 'node:crypto';
import {
  problemSchema,
  problemListQuerySchema,
  problemListResponseSchema,
  problemDetailSchema,
  reportProblemInputSchema,
  confirmProblemInputSchema,
  dismissProblemInputSchema,
  problemConfirmationReceiptSchema,
  problemDismissalReceiptSchema,
  previewProblemBatchInputSchema,
  commitProblemBatchInputSchema,
  problemBatchPreviewSchema,
  problemBatchReceiptSchema,
  type Problem,
} from '../../../contracts/src/issues.js';
import {
  resultItemSchema,
  scopeItemSchema,
} from '../../../contracts/src/domain.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { OperationService, canonicalJson } from '../operations/service.js';
import { DomainError, stale } from '../errors.js';
import { audit } from '../events.js';
import { assertSafeResultContent } from '../results/safety.js';
import { recordRequirementActivity } from '../requirements/service.js';
import { createIssueInTransaction } from './service.js';
import {
  issueRow,
  issueDto,
  issueEvent,
  lockIssueProject,
  requireRequirement,
  requireAssignee,
  evidenceDtos,
} from './common.js';
import { semanticDigest } from '../ui-executions/service.js';

interface ProblemRow {
  id: string;
  project_id: string;
  requirement_id: string;
  requirement_version_id: string | null;
  run_id: string;
  source_result_id: string | null;
  source_result_revision_id: string | null;
  title: string;
  description: string;
  suggested_severity: 'severe' | 'normal' | 'minor';
  source: 'uiResult' | 'apiResult' | 'extraFinding';
  state: 'pendingConfirmation' | 'confirmed' | 'dismissed';
  created_by: string;
  row_version: number;
  decision_note: string;
  created_at: Date;
  updated_at: Date;
  issue_id: string | null;
  execution_provenance:
    'local-ai' | 'protocol-synthetic' | 'unknown' | 'platform-api';
}
const problemSelect = `SELECT p.*,l.issue_id,r.execution_provenance FROM app.problem_candidates p JOIN app.runs r ON r.id=p.run_id LEFT JOIN app.issue_problem_links l ON l.problem_id=p.id`;
const dto = (row: ProblemRow): Problem =>
  problemSchema.parse({
    id: row.id,
    projectId: row.project_id,
    requirementId: row.requirement_id,
    requirementVersionId: row.requirement_version_id,
    runId: row.run_id,
    sourceResultId: row.source_result_id,
    sourceResultRevisionId: row.source_result_revision_id,
    title: row.title,
    description: row.description,
    suggestedSeverity: row.suggested_severity,
    source: row.source,
    state: row.state,
    createdBy: row.created_by,
    rowVersion: row.row_version,
    decisionNote: row.decision_note,
    confirmedIssueId: row.issue_id,
    sourceExecutionProvenance: row.execution_provenance,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
async function problemRow(
  tx: SqlExecutor,
  projectId: string,
  id: string,
  lock = false,
): Promise<ProblemRow> {
  if (
    lock &&
    !(
      await tx.query(
        'SELECT id FROM app.problem_candidates WHERE project_id=$1 AND id=$2 FOR UPDATE',
        [projectId, id],
      )
    ).rowCount
  )
    throw new DomainError('NOT_FOUND', '此项目内没有该待确认问题。', 404);
  const row = (
    await tx.query<ProblemRow>(
      `${problemSelect} WHERE p.project_id=$1 AND p.id=$2`,
      [projectId, id],
    )
  ).rows[0];
  if (!row)
    throw new DomainError('NOT_FOUND', '此项目内没有该待确认问题。', 404);
  return row;
}
async function linkProblemResults(
  tx: SqlExecutor,
  projectId: string,
  problemId: string,
  resultIds: readonly string[],
  runId?: string,
): Promise<void> {
  for (const resultId of [...new Set(resultIds)].sort()) {
    const result = (
      await tx.query<{ current_revision_id: string; run_id: string }>(
        'SELECT current_revision_id,run_id FROM app.results WHERE project_id=$1 AND id=$2',
        [projectId, resultId],
      )
    ).rows[0];
    if (!result || (runId && result.run_id !== runId))
      throw new DomainError(
        'NOT_FOUND',
        '关联结果须属于此项目及明确来源执行。',
        404,
      );
    await tx.query(
      'INSERT INTO app.problem_result_links(project_id,problem_id,result_id,source_revision_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [projectId, problemId, resultId, result.current_revision_id],
    );
    await tx.query(
      `INSERT INTO app.problem_evidence_links(project_id,problem_id,evidence_id) SELECT $1,$2,evidence_id FROM app.result_evidence_links WHERE result_id=$3 ON CONFLICT DO NOTHING`,
      [projectId, problemId, resultId],
    );
  }
}

/** Only known failed formal facts create a pending candidate; never an official issue or a manual verdict. */
export async function ensureFailedProblemInTransaction(
  tx: SqlExecutor,
  actor: ActorContext,
  projectId: string,
  resultId: string,
  revisionId: string,
): Promise<string | null> {
  const source = (
    await tx.query<{
      run_id: string;
      kind: 'UI' | 'API';
      scope_snapshot: { schemaVersion?: string };
      snapshot: unknown;
      content: unknown;
    }>(
      `SELECT a.run_id,r.kind,r.scope_snapshot,i.snapshot,v.content FROM app.results a JOIN app.result_revisions v ON v.id=$3 AND v.result_id=a.id
    JOIN app.run_items i ON i.id=a.run_item_id JOIN app.runs r ON r.id=a.run_id WHERE a.project_id=$1 AND a.id=$2`,
      [projectId, resultId, revisionId],
    )
  ).rows[0];
  if (!source)
    throw new DomainError('NOT_FOUND', '失败事实的来源修订不存在。', 404);
  const content = resultItemSchema.parse(source.content);
  if (
    content.originalOutcome !== 'failed' ||
    source.scope_snapshot.schemaVersion !== 'ath.execution-scope.v1'
  )
    return null;
  const item = scopeItemSchema.parse(source.snapshot);
  const version = (
    await tx.query<{ requirement_id: string }>(
      'SELECT requirement_id FROM app.requirement_versions WHERE project_id=$1 AND id=$2',
      [projectId, item.requirementVersionId],
    )
  ).rows[0];
  if (!version)
    throw new DomainError(
      'BUSINESS_CONFLICT',
      '固定失败范围缺少实际需求版本，未伪造问题归属。',
      409,
    );
  const id = randomUUID();
  const inserted = (
    await tx.query<{ id: string }>(
      `INSERT INTO app.problem_candidates(id,project_id,requirement_id,requirement_version_id,run_id,source_result_id,source_result_revision_id,title,description,suggested_severity,source,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'normal',$10,$11) ON CONFLICT(source_result_id) WHERE source_result_id IS NOT NULL DO NOTHING RETURNING id`,
      [
        id,
        projectId,
        version.requirement_id,
        item.requirementVersionId,
        source.run_id,
        resultId,
        revisionId,
        item.content.title,
        content.actualObservations ||
          '此原始结果判断为失败，但未提供观察正文；只登记待确认，不推断正式缺陷。',
        source.kind === 'API' ? 'apiResult' : 'uiResult',
        actor.userId,
      ],
    )
  ).rows[0];
  if (!inserted)
    return (
      (
        await tx.query<{ id: string }>(
          'SELECT id FROM app.problem_candidates WHERE source_result_id=$1',
          [resultId],
        )
      ).rows[0]?.id ?? null
    );
  await tx.query(
    'INSERT INTO app.problem_result_links(project_id,problem_id,result_id,source_revision_id) VALUES($1,$2,$3,$4)',
    [projectId, id, resultId, revisionId],
  );
  await tx.query(
    `INSERT INTO app.problem_evidence_links(project_id,problem_id,evidence_id) SELECT $1,$2,evidence_id FROM app.result_evidence_links WHERE result_id=$3 ON CONFLICT DO NOTHING`,
    [projectId, id, resultId],
  );
  await audit(tx, actor, 'problem.pending-from-result', id, projectId, {
    resultId,
    sourceRevisionId: revisionId,
    runId: source.run_id,
  });
  return id;
}

export class ProblemService {
  readonly operations: OperationService;
  constructor(readonly db: Database) {
    this.operations = new OperationService(db);
  }
  async list(actor: ActorContext, projectId: string, raw: unknown = {}) {
    const input = problemListQuerySchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const rows = await tx.query<ProblemRow>(
        `${problemSelect} WHERE p.project_id=$1 AND ($2::text IS NULL OR p.state=$2) AND ($3::uuid IS NULL OR p.requirement_id=$3) AND ($4::uuid IS NULL OR p.run_id=$4)
      AND (NOT $5 OR EXISTS(SELECT 1 FROM app.requirement_participants rp WHERE rp.requirement_id=p.requirement_id AND rp.user_id=$6 AND rp.active)) AND ($7='' OR position(lower($7) in lower(p.title||' '||p.description))>0) AND ($8 OR NOT EXISTS(SELECT 1 FROM app.requirements ar WHERE ar.id=p.requirement_id AND ar.project_id=p.project_id AND ar.archived_at IS NOT NULL)) AND ($9::text IS NULL OR ($9='unspecified' AND p.requirement_version_id IS NULL) OR p.requirement_version_id::text = $9) AND (NOT $10::boolean OR p.state<>'pendingConfirmation') ORDER BY p.created_at DESC,p.id LIMIT 200`,
        [
          projectId,
          input.state ?? null,
          input.requirementId ?? null,
          input.runId ?? null,
          input.participationOnly,
          actor.userId,
          input.search,
          input.includeArchivedRequirements,
          input.requirementVersion ?? null,
          input.decidedOnly ?? false,
        ],
      );
      return problemListResponseSchema.parse({ problems: rows.rows.map(dto) });
    });
  }
  async detail(actor: ActorContext, projectId: string, id: string) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const problem = await problemRow(tx, projectId, id);
      const results = await tx.query<{
        result_id: string;
        source_revision_id: string;
        run_id: string;
        current_revision_id: string;
        source_content: unknown;
        current_content: unknown;
        final_outcome: unknown;
      }>(
        `SELECT l.result_id,l.source_revision_id,r.run_id,r.current_revision_id,s.content source_content,v.content current_content,a.final_outcome FROM app.problem_result_links l JOIN app.results r ON r.id=l.result_id
        JOIN app.result_revisions s ON s.id=l.source_revision_id JOIN app.result_revisions v ON v.id=r.current_revision_id LEFT JOIN app.result_assessments a ON a.id=r.current_assessment_revision_id WHERE l.project_id=$1 AND l.problem_id=$2 ORDER BY r.created_at,r.id`,
        [projectId, id],
      );
      const evidence = await tx.query<{ evidence_id: string }>(
        'SELECT evidence_id FROM app.problem_evidence_links WHERE project_id=$1 AND problem_id=$2',
        [projectId, id],
      );
      const history = await tx.query<{
        id: string;
        action: string;
        actor_id: string;
        payload: unknown;
        created_at: Date;
      }>(
        "SELECT id,action,actor_id,payload,created_at FROM app.audit_events WHERE project_id=$1 AND object_id=$2 AND action IN ('problem.pending-from-result','problem.extra-reported','problem.dismissed','problem.decision-history','problem.confirmed') ORDER BY created_at,id",
        [projectId, id],
      );
      return problemDetailSchema.parse({
        problem: dto(problem),
        results: results.rows.map((row) => ({
          resultId: row.result_id,
          revisionId: row.source_revision_id,
          runId: row.run_id,
          currentRevisionId: row.current_revision_id,
          sourceOutcome: resultItemSchema.parse(row.source_content)
            .originalOutcome,
          currentReportedOutcome: resultItemSchema.parse(row.current_content)
            .originalOutcome,
          finalOutcome: row.final_outcome,
        })),
        evidence: await evidenceDtos(
          tx,
          projectId,
          evidence.rows.map((row) => row.evidence_id),
        ),
        history: history.rows.map((event) => ({
          id: event.id,
          action: event.action,
          actorId: event.actor_id,
          payload: event.payload,
          createdAt: event.created_at.toISOString(),
        })),
      });
    });
  }
  async report(actor: ActorContext, projectId: string, raw: unknown) {
    assertSafeResultContent(raw);
    const input = reportProblemInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'problems.report-extra',
      input.commandId,
      { projectId, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'results.submit');
      },
      async (tx) => {
        await requireRequirement(
          tx,
          projectId,
          input.requirementId,
          input.requirementVersionId,
        );
        const run = (
          await tx.query<{ scope_snapshot: { schemaVersion?: string } }>(
            'SELECT scope_snapshot FROM app.runs WHERE id=$1 AND project_id=$2',
            [input.runId, projectId],
          )
        ).rows[0];
        if (
          !run ||
          !['ath.execution-scope.v1', 'ath.ui-archive-scope.v1'].includes(
            run.scope_snapshot.schemaVersion ?? '',
          )
        )
          throw new DomainError(
            'NOT_FOUND',
            '额外发现须关联此项目的正式执行或独立 UI 归档。',
            404,
          );
        const archive =
          run.scope_snapshot.schemaVersion === 'ath.ui-archive-scope.v1';
        const archivedResultId = archive ? input.resultIds[0] : undefined;
        let archivedRevisionId: string | null = null;
        if (archive) {
          if (!archivedResultId || input.resultIds.length !== 1)
            throw new DomainError(
              'PRECONDITIONS_MISSING',
              '独立归档登记问题时须选一条真实结果。',
              422,
            );
          const source = (
            await tx.query<{
              current_revision_id: string;
              req: string;
              ver: string | null;
            }>(
              `SELECT r.current_revision_id, i.snapshot->>'requirementId' req, i.snapshot->>'requirementVersionId' ver
              FROM app.results r JOIN app.run_items i ON i.id=r.run_item_id
              WHERE r.project_id=$1 AND r.run_id=$2 AND r.id=$3 FOR SHARE OF r`,
              [projectId, input.runId, archivedResultId],
            )
          ).rows[0];
          if (
            !source ||
            source.req !== input.requirementId ||
            source.ver !== input.requirementVersionId
          )
            throw new DomainError(
              'BUSINESS_CONFLICT',
              '所选归档条目的需求归属与登记不一致。',
              409,
            );
          archivedRevisionId = source.current_revision_id;
        }
        const id = randomUUID();
        const inserted = await tx.query(
          `INSERT INTO app.problem_candidates(id,project_id,requirement_id,requirement_version_id,run_id,title,description,suggested_severity,source,created_by,source_result_id,source_result_revision_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'extraFinding',$9,$10,$11)
          ON CONFLICT(source_result_id) WHERE source_result_id IS NOT NULL DO NOTHING RETURNING id`,
          [
            id,
            projectId,
            input.requirementId,
            input.requirementVersionId,
            input.runId,
            input.title,
            input.description,
            input.suggestedSeverity,
            actor.userId,
            archivedResultId ?? null,
            archivedRevisionId,
          ],
        );
        if (!inserted.rowCount && archivedResultId) {
          const prior = (
            await tx.query<{ id: string }>(
              'SELECT id FROM app.problem_candidates WHERE project_id=$1 AND source_result_id=$2',
              [projectId, archivedResultId],
            )
          ).rows[0];
          if (prior)
            return { problem: dto(await problemRow(tx, projectId, prior.id)) };
        }
        await linkProblemResults(
          tx,
          projectId,
          id,
          input.resultIds,
          input.runId,
        );
        for (const localId of new Set(input.localEvidenceIds)) {
          const evidence = (
            await tx.query<{ id: string }>(
              'SELECT id FROM app.run_evidence WHERE run_id=$1 AND project_id=$2 AND local_evidence_id=$3',
              [input.runId, projectId, localId],
            )
          ).rows[0];
          if (!evidence)
            throw new DomainError(
              'NOT_FOUND',
              '额外发现引用的证据标识不属于此执行；本地路径不等于已提交证据。',
              404,
            );
          await tx.query(
            'INSERT INTO app.problem_evidence_links(project_id,problem_id,evidence_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
            [projectId, id, evidence.id],
          );
        }
        await recordRequirementActivity(tx, projectId, input.requirementId);
        await audit(tx, actor, 'problem.extra-reported', id, projectId, {
          runId: input.runId,
          resultCount: input.resultIds.length,
        });
        return { problem: dto(await problemRow(tx, projectId, id)) };
      },
      projectId,
    );
  }
  private async confirmInTransaction(
    tx: SqlExecutor,
    actor: ActorContext,
    projectId: string,
    id: string,
    input: ReturnType<typeof confirmProblemInputSchema.parse>,
    deferExistingTouch = false,
  ) {
    const row = await problemRow(tx, projectId, id, true);
    if (row.state === 'confirmed') {
      if (!row.issue_id)
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '问题确认关联缺失，不能重复造缺陷。',
          409,
        );
      if (input.target === 'existing' && input.issueId !== row.issue_id)
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '此问题已确认到另一个正式缺陷，不能重新分配或重复创建。',
          409,
        );
      return problemConfirmationReceiptSchema.parse({
        problem: dto(row),
        issue: issueDto(await issueRow(tx, projectId, row.issue_id)),
        alreadyConfirmed: true,
      });
    }
    if (row.row_version !== input.rowVersion) stale();
    if (row.state === 'dismissed') {
      const previous = (
        await tx.query<{ actor_id: string; created_at: Date }>(
          "SELECT actor_id,created_at FROM app.audit_events WHERE project_id=$1 AND object_id=$2 AND action='problem.dismissed' ORDER BY created_at DESC,id DESC LIMIT 1",
          [projectId, id],
        )
      ).rows[0];
      await audit(tx, actor, 'problem.decision-history', id, projectId, {
        previousState: 'dismissed',
        previousNote: row.decision_note,
        previousActorId: previous?.actor_id ?? null,
        previousDecidedAt:
          previous?.created_at.toISOString() ?? row.updated_at.toISOString(),
        transition: 'confirmed',
      });
    }
    let issue;
    if (input.target === 'new')
      issue = await createIssueInTransaction(tx, actor, projectId, {
        ...input,
        source: 'confirmedProblem',
        resultIds: [],
      });
    else {
      const target = await issueRow(tx, projectId, input.issueId, true);
      if (target.row_version !== input.issueRowVersion) stale();
      issue = issueDto(target);
    }
    await tx.query(
      'INSERT INTO app.issue_problem_links(project_id,issue_id,problem_id) VALUES($1,$2,$3)',
      [projectId, issue.id, id],
    );
    // Preserve the exact original problem/result source revision, even if raw reporting was later amended.
    await tx.query(
      `INSERT INTO app.issue_result_links(project_id,issue_id,result_id,source_revision_id) SELECT project_id,$1,result_id,source_revision_id FROM app.problem_result_links WHERE problem_id=$2 ON CONFLICT DO NOTHING`,
      [issue.id, id],
    );
    await tx.query(
      "UPDATE app.problem_candidates SET state='confirmed',decision_note='',row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1",
      [id],
    );
    if (input.target === 'existing' && !deferExistingTouch)
      await tx.query(
        'UPDATE app.issues SET row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1',
        [issue.id],
      );
    const target = await issueRow(tx, projectId, issue.id);
    await issueEvent(
      tx,
      actor,
      target,
      'problem-confirmed',
      target.assignee_id,
      target.assignee_id,
      { problemId: id, sourceResultId: row.source_result_id },
    );
    await recordRequirementActivity(tx, projectId, row.requirement_id);
    await audit(tx, actor, 'problem.confirmed', id, projectId, {
      issueId: issue.id,
      sourceResultId: row.source_result_id,
      previousState: row.state,
    });
    return problemConfirmationReceiptSchema.parse({
      problem: dto(await problemRow(tx, projectId, id)),
      issue: issueDto(target),
      alreadyConfirmed: false,
    });
  }
  async confirm(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    assertSafeResultContent(raw);
    const input = confirmProblemInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'problems.confirm',
      input.commandId,
      { projectId, id, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'reviews.approve');
        await lockIssueProject(tx, projectId);
      },
      (tx) => this.confirmInTransaction(tx, actor, projectId, id, input),
      projectId,
    );
  }
  async dismiss(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    assertSafeResultContent(raw);
    const input = dismissProblemInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'problems.dismiss',
      input.commandId,
      { projectId, id, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'reviews.approve');
        await lockIssueProject(tx, projectId);
      },
      async (tx) => {
        const row = await problemRow(tx, projectId, id, true);
        if (row.state === 'confirmed')
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '已确认的正式缺陷使用独立生命周期，不通过非缺陷操作抹去原确认。',
            409,
          );
        if (row.state === 'dismissed')
          return problemDismissalReceiptSchema.parse({
            problem: dto(row),
            alreadyDecided: true,
          });
        if (row.row_version !== input.rowVersion) stale();
        await tx.query(
          "UPDATE app.problem_candidates SET state='dismissed',decision_note=$2,row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1",
          [id, input.note],
        );
        await audit(tx, actor, 'problem.dismissed', id, projectId, {
          state: 'dismissed',
          note: input.note,
        });
        await recordRequirementActivity(tx, projectId, row.requirement_id);
        return problemDismissalReceiptSchema.parse({
          problem: dto(await problemRow(tx, projectId, id)),
          alreadyDecided: false,
        });
      },
      projectId,
    );
  }
  async previewBatch(actor: ActorContext, projectId: string, raw: unknown) {
    assertSafeResultContent(raw);
    const input = previewProblemBatchInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'problems.preview-confirm',
      input.commandId,
      { projectId, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'reviews.approve');
      },
      async (tx) => {
        const items = [];
        for (const requested of input.decisions) {
          const row = await problemRow(tx, projectId, requested.problemId);
          let reason =
            row.state === 'confirmed'
              ? '此问题已确认到正式缺陷。'
              : row.row_version !== requested.decision.rowVersion
                ? '问题基准已变化。'
                : '';
          if (requested.decision.target === 'existing') {
            const target = await issueRow(
              tx,
              projectId,
              requested.decision.issueId,
            );
            if (target.row_version !== requested.decision.issueRowVersion)
              reason = '目标正式缺陷基准已变化。';
          } else {
            try {
              await requireRequirement(
                tx,
                projectId,
                requested.decision.requirementId,
                requested.decision.requirementVersionId,
              );
              await requireAssignee(
                tx,
                projectId,
                requested.decision.assigneeId,
              );
            } catch (error: unknown) {
              if (!(error instanceof DomainError)) throw error;
              reason = error.message;
            }
          }
          items.push({
            problem: dto(row),
            decision: requested.decision,
            eligible: !reason,
            reason,
          });
        }
        const createdAt = new Date().toISOString();
        const scopeDigest = semanticDigest({ projectId, items });
        return problemBatchPreviewSchema.parse({
          previewId: input.commandId,
          scopeDigest,
          items,
          createdAt,
        });
      },
      projectId,
    );
  }
  async batchPreview(
    actor: ActorContext,
    projectId: string,
    previewId: string,
  ) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'reviews.approve');
      const row = (
        await tx.query<{ response: unknown }>(
          "SELECT response FROM app.commands WHERE actor_id=$1 AND project_id=$2 AND operation='problems.preview-confirm' AND key=$3 AND status='completed'",
          [actor.userId, projectId, previewId],
        )
      ).rows[0];
      if (!row)
        throw new DomainError(
          'NOT_FOUND',
          '没有本人在此项目的原问题确认预览。',
          404,
        );
      return problemBatchPreviewSchema.parse(row.response);
    });
  }
  async batchSelectionPreview(
    actor: ActorContext,
    projectId: string,
    raw: unknown,
  ) {
    const input = commitProblemBatchInputSchema.parse(raw);
    const preview = await this.batchPreview(actor, projectId, input.previewId);
    if (
      preview.scopeDigest !== input.scopeDigest ||
      canonicalJson([...input.problemIds].sort()) !==
        canonicalJson(preview.items.map((item) => item.problem.id).sort())
    )
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '提交不是原预览的精确问题集合。',
        409,
      );
    return preview;
  }
  async confirmBatch(actor: ActorContext, projectId: string, raw: unknown) {
    const input = commitProblemBatchInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'problems.confirm-batch',
      input.commandId,
      { projectId, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'reviews.approve');
        await lockIssueProject(tx, projectId);
      },
      async (tx) => {
        const stored = (
          await tx.query<{ response: unknown }>(
            "SELECT response FROM app.commands WHERE actor_id=$1 AND project_id=$2 AND operation='problems.preview-confirm' AND key=$3 AND status='completed'",
            [actor.userId, projectId, input.previewId],
          )
        ).rows[0];
        if (!stored)
          throw new DomainError('NOT_FOUND', '没有本人原问题确认预览。', 404);
        const preview = problemBatchPreviewSchema.parse(stored.response);
        if (
          preview.scopeDigest !== input.scopeDigest ||
          canonicalJson([...input.problemIds].sort()) !==
            canonicalJson(preview.items.map((item) => item.problem.id).sort())
        )
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '提交不是原预览的精确问题集合；未扩大筛选。',
            409,
          );
        const results = [];
        const touchedIssues = new Set<string>();
        for (const [index, item] of preview.items.entries()) {
          if (!item.eligible) {
            results.push({
              problemId: item.problem.id,
              status: 'skipped' as const,
              issue: null,
              code: 'NOT_ELIGIBLE',
            });
            continue;
          }
          await tx.query(`SAVEPOINT problem_item_${index}`);
          try {
            const receipt = await this.confirmInTransaction(
              tx,
              actor,
              projectId,
              item.problem.id,
              { ...item.decision, commandId: input.commandId },
              true,
            );
            if (
              item.decision.target === 'existing' &&
              !receipt.alreadyConfirmed
            )
              touchedIssues.add(receipt.issue.id);
            results.push({
              problemId: item.problem.id,
              status: receipt.alreadyConfirmed
                ? ('alreadyConfirmed' as const)
                : ('confirmed' as const),
              issue: receipt.issue,
              code: null,
            });
            await tx.query(`RELEASE SAVEPOINT problem_item_${index}`);
          } catch (error: unknown) {
            await tx.query(`ROLLBACK TO SAVEPOINT problem_item_${index}`);
            if (!(error instanceof DomainError)) throw error;
            results.push({
              problemId: item.problem.id,
              status: 'conflict' as const,
              issue: null,
              code: error.code,
            });
          }
        }
        for (const id of touchedIssues)
          await tx.query(
            'UPDATE app.issues SET row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1',
            [id],
          );
        for (const result of results)
          if (result.issue && touchedIssues.has(result.issue.id))
            result.issue = issueDto(
              await issueRow(tx, projectId, result.issue.id),
            );
        return problemBatchReceiptSchema.parse({
          previewId: preview.previewId,
          scopeDigest: preview.scopeDigest,
          results,
        });
      },
      projectId,
    );
  }
}
