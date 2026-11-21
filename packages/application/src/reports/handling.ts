import type { SqlExecutor } from '../../../persistence/src/database.js';
import {
  reportHandlingSchema,
  type ReportHandling,
} from '../../../contracts/src/report-handling.js';

/** The caller checks current project access; no private conversations or full source bodies are read. */
export async function reportHandling(
  tx: SqlExecutor,
  projectId: string,
  runId: string,
): Promise<ReportHandling> {
  const row = (
    await tx.query<{ problems: unknown; issues: unknown; captured_at: Date }>(
      `
    WITH run_results AS (
      SELECT id FROM app.results WHERE project_id=$1 AND run_id=$2
    ), problems AS (
      SELECT p.* FROM app.problem_candidates p WHERE p.project_id=$1 AND (
        p.run_id=$2 OR EXISTS (SELECT 1 FROM app.problem_result_links l
          JOIN run_results r ON r.id=l.result_id WHERE l.problem_id=p.id AND l.project_id=$1))
    ), review_retests AS (
      SELECT DISTINCT ON (a.object_id) a.object_id,a.payload,a.created_at FROM app.audit_events a
      JOIN problems p ON p.id=a.object_id WHERE a.project_id=$1 AND a.action='problem.review-retest'
      ORDER BY a.object_id,a.seq DESC
    ), scope_issues AS (
      SELECT jsonb_array_elements_text(COALESCE(item->'issueIds','[]'::jsonb)) id
      FROM app.runs u CROSS JOIN LATERAL jsonb_array_elements(u.scope_snapshot->'items') item
      WHERE u.project_id=$1 AND u.id=$2
    ), issues AS (
      SELECT i.* FROM app.issues i WHERE i.project_id=$1 AND (
        EXISTS (SELECT 1 FROM app.issue_result_links l JOIN run_results r ON r.id=l.result_id
          WHERE l.issue_id=i.id AND l.project_id=$1)
        OR EXISTS (SELECT 1 FROM app.issue_problem_links l JOIN problems p ON p.id=l.problem_id
          WHERE l.issue_id=i.id AND l.project_id=$1)
        OR EXISTS (SELECT 1 FROM scope_issues s WHERE s.id=i.id::text)
        OR EXISTS (SELECT 1 FROM app.issue_verifications v WHERE v.issue_id=i.id AND v.project_id=$1 AND v.run_id=$2))
    )
    SELECT clock_timestamp() captured_at,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id',p.id,'requirementId',p.requirement_id,'title',p.title,'state',p.state,
        'suggestedSeverity',p.suggested_severity,'rowVersion',p.row_version,'updatedAt',p.updated_at,
        'sourceResultId',p.source_result_id,'sourceResultRevisionId',p.source_result_revision_id,
        'resultSources',(SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'resultId',l.result_id,'sourceRevisionId',l.source_revision_id) ORDER BY l.result_id),'[]'::jsonb)
          FROM app.problem_result_links l WHERE l.project_id=$1 AND l.problem_id=p.id),
        'latestReviewRetest',CASE WHEN a.object_id IS NULL THEN NULL ELSE jsonb_build_object(
          'id',a.payload->>'id','outcome',a.payload->>'outcome',
          'resultId',a.payload#>>'{reportReview,resultId}',
          'resultRevisionId',a.payload#>>'{reportReview,resultRevisionId}','createdAt',a.created_at)
          END,
        'resultIds',(SELECT COALESCE(jsonb_agg(DISTINCT ids.id ORDER BY ids.id),'[]'::jsonb) FROM (
          SELECT p.source_result_id id WHERE p.source_result_id IS NOT NULL
          UNION SELECT l.result_id FROM app.problem_result_links l WHERE l.project_id=$1 AND l.problem_id=p.id) ids),
        'issueIds',(SELECT COALESCE(jsonb_agg(l.issue_id ORDER BY l.issue_id),'[]'::jsonb)
          FROM app.issue_problem_links l WHERE l.project_id=$1 AND l.problem_id=p.id)) ORDER BY p.created_at,p.id)
        FROM problems p LEFT JOIN review_retests a ON a.object_id=p.id),'[]'::jsonb) problems,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id',i.id,'number','BUG-'||lpad(i.number::text,5,'0'),'requirementId',i.requirement_id,
        'title',i.title,'severity',i.severity,'state',i.state,'mergedIntoId',i.merged_into_id,
        'rowVersion',i.row_version,'updatedAt',i.updated_at,
        'assignee',CASE WHEN i.assignee_id IS NULL THEN NULL ELSE jsonb_build_object(
          'id',i.assignee_id,'displayName',(SELECT u.display_name FROM app.users u WHERE u.id=i.assignee_id),
          'active',EXISTS(SELECT 1 FROM app.users u JOIN app.project_members m ON m.user_id=u.id
            WHERE u.id=i.assignee_id AND u.active AND m.project_id=$1 AND m.active)) END,
        'resultIds',(SELECT COALESCE(jsonb_agg(l.result_id ORDER BY l.result_id),'[]'::jsonb)
          FROM app.issue_result_links l WHERE l.project_id=$1 AND l.issue_id=i.id),
        'problemIds',(SELECT COALESCE(jsonb_agg(l.problem_id ORDER BY l.problem_id),'[]'::jsonb)
          FROM app.issue_problem_links l WHERE l.project_id=$1 AND l.issue_id=i.id),
        'latestVerification',(SELECT jsonb_build_object('id',v.id,'method',v.method,'outcome',v.outcome,
          'runId',v.run_id,'createdAt',v.created_at) FROM app.issue_verifications v
          WHERE v.project_id=$1 AND v.issue_id=i.id ORDER BY v.created_at DESC,v.id DESC LIMIT 1)) ORDER BY i.number,i.id)
        FROM issues i),'[]'::jsonb) issues`,
      [projectId, runId],
    )
  ).rows[0];
  if (!row) throw new Error('Report handling query returned no aggregate');
  const problems = reportHandlingSchema.shape.problems.parse(row.problems);
  const issues = reportHandlingSchema.shape.issues.parse(row.issues);
  return reportHandlingSchema.parse({
    capturedAt: row.captured_at.toISOString(),
    problems,
    issues,
    statistics: {
      problemCount: problems.length,
      pendingProblemCount: problems.filter(
        (p) => p.state === 'pendingConfirmation',
      ).length,
      confirmedProblemCount: problems.filter((p) => p.state === 'confirmed')
        .length,
      dismissedProblemCount: problems.filter((p) => p.state === 'dismissed')
        .length,
      issueCount: issues.length,
      openIssueCount: issues.filter((i) => i.state !== 'closed').length,
      mergedIssueCount: issues.filter((i) => i.mergedIntoId !== null).length,
    },
  });
}
