import { z } from 'zod';
import { idSchema } from '../../../contracts/src/base.js';
import { resultItemSchema } from '../../../contracts/src/domain.js';
import {
  problemReviewImageMediaTypeSchema,
  problemReviewImageSchema,
  problemReviewRetestSchema,
  reportProblemReviewScopeSchema,
  resultRetestSchema,
  type ReportProblemReviewScope,
} from '../../../contracts/src/issues.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { DomainError, stale } from '../errors.js';

const reviewRetestFactSchema = problemReviewRetestSchema.omit({
  actorId: true,
  createdAt: true,
  images: true,
});
export const resultRetestFactSchema = resultRetestSchema.omit({
  actorId: true,
  createdAt: true,
  images: true,
});

const confirmationFactSchema = z.object({
  problemId: idSchema,
  sourceResultId: idSchema.nullable(),
  sourceResultRevisionId: idSchema.nullable(),
  review: z.strictObject({
    id: idSchema,
    note: z.string(),
    reviewAttachmentFileIds: z.array(idSchema),
    retestId: idSchema.optional(),
    reportReview: reportProblemReviewScopeSchema.optional(),
  }),
});

type ReviewRetestFact = z.infer<typeof reviewRetestFactSchema>;

export async function reviewImages(
  tx: SqlExecutor,
  projectId: string,
  reviewId: string,
) {
  const rows = await tx.query<{
    id: string;
    original_name: string;
    media_type: string;
    status: string;
    deleted_at: Date | null;
  }>(
    `SELECT f.id,f.original_name,f.media_type,f.status,f.deleted_at
     FROM app.resource_references e JOIN app.file_resources f ON f.id=e.resource_id AND f.project_id=e.project_id
     WHERE e.project_id=$1 AND e.reference_type='evidence' AND e.reference_id=$2
     ORDER BY e.created_at,e.id`,
    [projectId, reviewId],
  );
  return rows.rows.map((file) =>
    problemReviewImageSchema.parse({
      fileId: file.id,
      originalName: file.original_name,
      mediaType: file.media_type,
      fileAvailable: file.status === 'verified' && file.deleted_at === null,
      downloadPath: `/api/v1/files/${file.id}/content`,
    }),
  );
}

export async function linkReviewImages(
  tx: SqlExecutor,
  actor: ActorContext,
  projectId: string,
  reviewId: string,
  fileIds: readonly string[],
) {
  for (const fileId of [...fileIds].sort()) {
    const file = (
      await tx.query<{ media_type: string }>(
        `SELECT media_type FROM app.file_resources WHERE project_id=$1 AND id=$2
       AND owner_scope='project' AND owner_user_id=$3 AND run_id IS NULL
       AND status='verified' AND deleted_at IS NULL FOR SHARE`,
        [projectId, fileId, actor.userId],
      )
    ).rows[0];
    if (
      !file ||
      !problemReviewImageMediaTypeSchema.safeParse(file.media_type).success
    )
      throw new DomainError(
        'FILE_NOT_READY',
        '复核截图须是本人上传到本项目且已验证的 PNG、JPEG 或 WebP 图片。',
        422,
      );
    await tx.query(
      `INSERT INTO app.resource_references(resource_id,project_id,reference_type,reference_id,created_by)
       VALUES($1,$2,'evidence',$3,$4)`,
      [fileId, projectId, reviewId, actor.userId],
    );
  }
}

export type ReviewHistoryEvent = {
  id: string;
  action: string;
  actor_id: string;
  payload: unknown;
  created_at: Date;
};

export async function projectResultRetest(
  tx: SqlExecutor,
  projectId: string,
  event: Pick<ReviewHistoryEvent, 'actor_id' | 'created_at' | 'payload'>,
) {
  const fact = resultRetestFactSchema.parse(event.payload);
  return resultRetestSchema.parse({
    ...fact,
    actorId: event.actor_id,
    createdAt: event.created_at.toISOString(),
    images: await reviewImages(tx, projectId, fact.id),
  });
}

export async function savedReviewRetests(
  tx: SqlExecutor,
  projectId: string,
  history: readonly ReviewHistoryEvent[],
) {
  const retests = [];
  for (const event of history) {
    if (event.action !== 'problem.review-retest') continue;
    retests.push(await projectReviewRetest(tx, projectId, event));
  }
  return retests;
}

export async function projectReviewRetest(
  tx: SqlExecutor,
  projectId: string,
  event: Pick<ReviewHistoryEvent, 'actor_id' | 'created_at' | 'payload'>,
) {
  const fact = reviewRetestFactSchema.parse(event.payload);
  return problemReviewRetestSchema.parse({
    ...fact,
    actorId: event.actor_id,
    createdAt: event.created_at.toISOString(),
    images: await reviewImages(tx, projectId, fact.id),
  });
}

export async function issueConfirmationEvidence(
  tx: SqlExecutor,
  projectId: string,
  events: readonly ReviewHistoryEvent[],
) {
  const reviews = [];
  for (const event of events) {
    if (event.action === 'report-source-linked') {
      const fact = z
        .strictObject({
          reportReview: reportProblemReviewScopeSchema,
          retestId: idSchema.optional(),
        })
        .parse(event.payload);
      const retest = fact.retestId
        ? await readResultRetestFact(
            tx,
            projectId,
            fact.reportReview,
            fact.retestId,
          )
        : undefined;
      reviews.push({
        eventId: event.id,
        problemId: null,
        resultId: fact.reportReview.resultId,
        resultRevisionId: fact.reportReview.resultRevisionId,
        note: retest?.reproduction ?? '',
        ...(retest ? { retestNote: retest.note } : {}),
        reportReview: fact.reportReview,
        actorId: event.actor_id,
        createdAt: event.created_at.toISOString(),
        images: retest ? await reviewImages(tx, projectId, retest.id) : [],
      });
      continue;
    }
    if (
      event.action !== 'problem-confirmed' ||
      !event.payload ||
      typeof event.payload !== 'object' ||
      !('review' in event.payload)
    )
      continue;
    const fact = confirmationFactSchema.parse(event.payload);
    const images = await reviewImages(tx, projectId, fact.review.id);
    let retestNote;
    if (fact.review.retestId) {
      const saved = await reviewImages(tx, projectId, fact.review.retestId);
      const seen = new Set(images.map((image) => image.fileId));
      images.push(...saved.filter((image) => !seen.has(image.fileId)));
      const retest = (
        await tx.query<{ payload: unknown }>(
          `SELECT payload FROM app.audit_events
           WHERE project_id=$1 AND object_id=$2 AND action='problem.review-retest'
             AND payload->>'id'=$3`,
          [projectId, fact.problemId, fact.review.retestId],
        )
      ).rows[0];
      retestNote = retest && reviewRetestFactSchema.parse(retest.payload).note;
    }
    reviews.push({
      eventId: event.id,
      problemId: fact.problemId,
      resultId: fact.review.reportReview?.resultId ?? fact.sourceResultId,
      resultRevisionId:
        fact.review.reportReview?.resultRevisionId ??
        fact.sourceResultRevisionId,
      note: fact.review.note,
      ...(fact.review.reportReview
        ? { reportReview: fact.review.reportReview }
        : {}),
      ...(retestNote ? { retestNote } : {}),
      actorId: event.actor_id,
      createdAt: event.created_at.toISOString(),
      images,
    });
  }
  return reviews;
}

export async function readResultRetestFact(
  tx: SqlExecutor,
  projectId: string,
  source: ReportProblemReviewScope,
  retestId: string,
) {
  const row = (
    await tx.query<{ payload: unknown }>(
      `SELECT payload FROM app.audit_events
       WHERE project_id=$1 AND object_id=$2 AND action='result.human-retest'
         AND payload->>'id'=$3 AND payload#>>'{reportReview,resultRevisionId}'=$4
         AND payload#>>'{reportReview,reportId}'=$5`,
      [
        projectId,
        source.resultId,
        retestId,
        source.resultRevisionId,
        source.reportId,
      ],
    )
  ).rows[0];
  return row ? resultRetestFactSchema.parse(row.payload) : undefined;
}

/** Serialize against result correction and report capture on the same run. */
export async function lockCurrentReport(
  tx: SqlExecutor,
  projectId: string,
  scope: Pick<ReportProblemReviewScope, 'reportId' | 'reportRevisionId'>,
) {
  const run = (
    await tx.query<{ id: string }>(
      `SELECT u.id FROM app.reports q JOIN app.runs u ON u.id=q.run_id AND u.project_id=q.project_id
     WHERE q.project_id=$1 AND q.id=$2 FOR SHARE OF u`,
      [projectId, scope.reportId],
    )
  ).rows[0];
  if (!run) throw new DomainError('NOT_FOUND', '此项目内没有该执行报告。', 404);
  // A separate statement reads the current pointer after any competing run writer completes.
  const report = (
    await tx.query<{ current_revision_id: string }>(
      'SELECT current_revision_id FROM app.reports WHERE project_id=$1 AND id=$2 AND run_id=$3',
      [projectId, scope.reportId, run.id],
    )
  ).rows[0];
  if (report?.current_revision_id !== scope.reportRevisionId) stale();
  return run.id;
}

export async function lockReportResult(
  tx: SqlExecutor,
  projectId: string,
  scope: ReportProblemReviewScope,
) {
  const runId = await lockCurrentReport(tx, projectId, scope);
  const source = (
    await tx.query<{
      current_revision_id: string;
      content: unknown;
      snapshot: unknown;
    }>(
      `SELECT r.current_revision_id,v.content,i.snapshot
     FROM app.results r JOIN app.result_revisions v ON v.result_id=r.id AND v.id=r.current_revision_id
     JOIN app.run_items i ON i.id=r.run_item_id AND i.run_id=r.run_id AND i.project_id=r.project_id
     WHERE r.project_id=$1 AND r.run_id=$2 AND r.id=$3`,
      [projectId, runId, scope.resultId],
    )
  ).rows[0];
  if (!source)
    throw new DomainError('NOT_FOUND', '此报告没有所选用例结果。', 404);
  if (source.current_revision_id !== scope.resultRevisionId) stale();
  const content = resultItemSchema.parse(source.content);
  if (scope.stepOrdinal !== undefined) {
    const snapshot = z
      .object({ content: z.object({ steps: z.array(z.unknown()) }) })
      .safeParse(source.snapshot);
    const knownStep =
      content.stepObservations?.some(
        (step) => step.ordinal === scope.stepOrdinal,
      ) ||
      Number(content.actualActions?.length ?? 0) >= scope.stepOrdinal ||
      (snapshot.success &&
        snapshot.data.content.steps.length >= scope.stepOrdinal);
    if (!knownStep)
      throw new DomainError('NOT_FOUND', '所选步骤不属于当前用例结果。', 404);
  }
  return { runId, content, snapshot: source.snapshot };
}

export async function lockReportReview(
  tx: SqlExecutor,
  projectId: string,
  problemId: string,
  scope: ReportProblemReviewScope,
) {
  const source = await lockReportResult(tx, projectId, scope);
  const linked = (
    await tx.query<{ source_revision_id: string }>(
      `SELECT source_revision_id FROM app.problem_result_links
       WHERE project_id=$1 AND problem_id=$2 AND result_id=$3`,
      [projectId, problemId, scope.resultId],
    )
  ).rows[0];
  if (!linked)
    throw new DomainError(
      'NOT_FOUND',
      '候选问题与本轮报告的用例结果不匹配。',
      404,
    );
  return { ...source, originalRevisionId: linked.source_revision_id };
}

export async function latestReviewRetest(
  tx: SqlExecutor,
  projectId: string,
  problemId: string,
): Promise<ReviewRetestFact | null> {
  const previous = (
    await tx.query<{ payload: unknown }>(
      `SELECT payload FROM app.audit_events
       WHERE project_id=$1 AND object_id=$2 AND action='problem.review-retest'
       ORDER BY seq DESC LIMIT 1`,
      [projectId, problemId],
    )
  ).rows[0];
  return previous ? reviewRetestFactSchema.parse(previous.payload) : null;
}

export async function assertReportConfirmation(
  tx: SqlExecutor,
  projectId: string,
  problemId: string,
  scope: ReportProblemReviewScope,
  source: Awaited<ReturnType<typeof lockReportReview>>,
  bulk: boolean,
  suppliedImages = false,
) {
  const retest = await latestReviewRetest(tx, projectId, problemId);
  if (bulk && (source.originalRevisionId !== scope.resultRevisionId || retest))
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '已改判或已有人工复测的用例须逐条复核。',
      422,
    );
  if (retest) {
    if (
      retest.outcome === 'reproduced' &&
      retest.reportReview.resultId === scope.resultId &&
      retest.reportReview.resultRevisionId === scope.resultRevisionId
    )
      return retest;
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '请先登记当前结果的复现结论，或保留候选供继续核对。',
      422,
    );
  }
  if (source.content.originalOutcome !== 'failed' && !suppliedImages)
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '当前用例未判为失败，请先复测确认现场。',
      422,
    );
  if (!suppliedImages && !source.content.actualObservations.trim()) {
    const hasEvidence = (
      await tx.query(
        `SELECT 1 FROM app.run_evidence e
       JOIN app.file_resources f ON f.id=e.file_id AND f.project_id=e.project_id
       JOIN app.result_evidence_links l ON l.evidence_id=e.id
       JOIN app.results r ON r.id=l.result_id AND r.project_id=e.project_id AND r.run_id=e.run_id
       WHERE r.project_id=$1 AND r.id=$2 AND f.status='verified' AND f.deleted_at IS NULL LIMIT 1`,
        [projectId, scope.resultId],
      )
    ).rowCount;
    if (!hasEvidence)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '执行结果缺少可复核的现场资料，请逐条处理。',
        422,
      );
  }
  return null;
}
