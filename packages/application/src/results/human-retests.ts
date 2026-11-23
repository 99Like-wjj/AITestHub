import { randomUUID } from 'node:crypto';
import {
  reportProblemReviewScopeSchema,
  resultRetestInputSchema,
} from '../../../contracts/src/issues.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { Database } from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { DomainError, stale } from '../errors.js';
import { audit } from '../events.js';
import {
  linkReviewImages,
  lockReportResult,
  projectResultRetest,
  type ReviewHistoryEvent,
} from '../issues/review-evidence.js';
import { OperationService } from '../operations/service.js';
import { assertSafeResultContent } from './safety.js';

export function readHumanRetests(
  db: Database,
  actor: ActorContext,
  projectId: string,
  raw: unknown,
) {
  const scope = reportProblemReviewScopeSchema.parse(raw);
  return db.transaction(async (tx) => {
    await requireProject(tx, actor, projectId, 'project.read');
    const report = (
      await tx.query<{ created_at: Date; current: boolean }>(
        `SELECT v.created_at,q.current_revision_id=v.id AS current
         FROM app.reports q JOIN app.report_revisions v ON v.report_id=q.id AND v.id=$3
         JOIN app.results r ON r.run_id=q.run_id AND r.project_id=q.project_id AND r.id=$4
         JOIN app.result_revisions rv ON rv.result_id=r.id AND rv.id=$5
         WHERE q.project_id=$1 AND q.id=$2`,
        [
          projectId,
          scope.reportId,
          scope.reportRevisionId,
          scope.resultId,
          scope.resultRevisionId,
        ],
      )
    ).rows[0];
    if (!report)
      throw new DomainError(
        'NOT_FOUND',
        '没有匹配报告和结果修订的人工复测范围。',
        404,
      );
    const rows = (
      await tx.query<ReviewHistoryEvent>(
        `SELECT id,action,actor_id,created_at,payload FROM app.audit_events
         WHERE project_id=$1 AND object_id=$2 AND action='result.human-retest'
           AND payload#>>'{reportReview,resultRevisionId}'=$3
           AND ($4 OR created_at<=$5 OR payload#>>'{reportReview,reportRevisionId}'=$6)
         ORDER BY seq DESC`,
        [
          projectId,
          scope.resultId,
          scope.resultRevisionId,
          report.current,
          report.created_at,
          scope.reportRevisionId,
        ],
      )
    ).rows;
    const retests = [];
    for (const event of rows)
      retests.push(await projectResultRetest(tx, projectId, event));
    return { retests };
  });
}

export function recordHumanRetest(
  operations: OperationService,
  actor: ActorContext,
  projectId: string,
  raw: unknown,
) {
  assertSafeResultContent(raw);
  const {
    commandId,
    baseRetestId,
    reportReview: scope,
    ...fields
  } = resultRetestInputSchema.parse(raw);
  return operations.execute(
    actor,
    'results.human-retest',
    commandId,
    { projectId, scope, baseRetestId, ...fields },
    async (tx) => {
      await requireProject(tx, actor, projectId, 'results.assess');
    },
    async (tx) => {
      await lockReportResult(tx, projectId, scope);
      await tx.query('SELECT id FROM app.results WHERE id=$1 FOR UPDATE', [
        scope.resultId,
      ]);
      const previous = (
        await tx.query<{ id: string }>(
          `SELECT payload->>'id' id FROM app.audit_events
           WHERE project_id=$1 AND object_id=$2 AND action='result.human-retest'
             AND payload#>>'{reportReview,resultRevisionId}'=$3 ORDER BY seq DESC LIMIT 1`,
          [projectId, scope.resultId, scope.resultRevisionId],
        )
      ).rows[0];
      if ((previous?.id ?? null) !== baseRetestId) stale();
      const id = randomUUID();
      await linkReviewImages(
        tx,
        actor,
        projectId,
        id,
        fields.reviewAttachmentFileIds,
      );
      const payload = { id, reportReview: scope, ...fields };
      await audit(
        tx,
        actor,
        'result.human-retest',
        scope.resultId,
        projectId,
        payload,
      );
      const stored = (
        await tx.query<
          Pick<ReviewHistoryEvent, 'actor_id' | 'created_at' | 'payload'>
        >(
          `SELECT actor_id,created_at,payload FROM app.audit_events
           WHERE project_id=$1 AND object_id=$2 AND action='result.human-retest'
             AND payload->>'id'=$3`,
          [projectId, scope.resultId, id],
        )
      ).rows[0];
      if (!stored) throw new Error('Human retest audit receipt missing');
      return { retest: await projectResultRetest(tx, projectId, stored) };
    },
    projectId,
  );
}
