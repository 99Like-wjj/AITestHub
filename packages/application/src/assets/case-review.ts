import type { SqlExecutor } from '../../../persistence/src/database.js';
import type { AssetRow } from './repository.js';

export interface CaseReviewRow {
  id: string;
  revision_id: string;
  row_version: number;
  review_state: AssetRow['review_state'];
  title: string;
  archived: boolean;
  removed: boolean;
  parent_blocked: boolean;
  has_suggestions: boolean;
  needs_response: boolean;
}

export async function lockCaseReviewRequirements(
  tx: SqlExecutor,
  projectId: string,
  caseIds: string[],
) {
  await tx.query(
    `SELECT r.id FROM app.requirements r WHERE r.project_id=$1 AND EXISTS(
    SELECT 1 FROM app.requirement_versions v JOIN app.test_assets a
      ON a.project_id=v.project_id AND a.requirement_version_id=v.id
    WHERE v.project_id=r.project_id AND v.requirement_id=r.id AND a.id=ANY($2::uuid[])
      AND a.kind='UI' AND a.target_type='case') ORDER BY r.id FOR UPDATE`,
    [projectId, caseIds],
  );
}

export async function caseReviewRows(
  tx: SqlExecutor,
  projectId: string,
  scope:
    | { requirementId: string }
    | { requirementVersionId: string }
    | { caseIds: string[] },
) {
  const filter =
    'requirementId' in scope
      ? (['r.id=$2', scope.requirementId] as const)
      : 'requirementVersionId' in scope
        ? (['v.id=$2', scope.requirementVersionId] as const)
        : (['a.id=ANY($2::uuid[])', scope.caseIds] as const);
  const visibility = 'caseIds' in scope ? '' : 'AND a.removed_at IS NULL';
  return (
    await tx.query<CaseReviewRow>(
      `SELECT a.id,a.current_revision_id revision_id,a.row_version,a.review_state,
       ar.content->>'title' title,r.archived_at IS NOT NULL archived,a.removed_at IS NOT NULL removed,
       EXISTS(SELECT 1 FROM app.test_assets p JOIN app.review_opinions o
         ON o.asset_id=p.id AND o.revision_id=p.current_revision_id AND o.removed_at IS NULL
         WHERE p.id IN (a.parent_id,a.set_id) AND p.review_state<>'approved') parent_blocked,
       COALESCE(suggestions.has_suggestions,false) has_suggestions,
       COALESCE(suggestions.needs_response,false) needs_response
    FROM app.test_assets a
    JOIN app.asset_revisions ar ON ar.id=a.current_revision_id
    JOIN app.requirement_versions v ON v.project_id=a.project_id AND v.id=a.requirement_version_id
    JOIN app.requirements r ON r.project_id=a.project_id AND r.id=v.requirement_id
    LEFT JOIN LATERAL (
      SELECT count(*)>0 has_suggestions,bool_or(o.revision_id=a.current_revision_id OR NOT EXISTS(
        SELECT 1 FROM app.optimization_notes n WHERE n.asset_id=a.id AND n.opinion_id=o.id
          AND n.target_revision_id=a.current_revision_id)) needs_response
      FROM app.review_opinions o WHERE o.asset_id=a.id AND o.removed_at IS NULL AND o.resolved_approval_id IS NULL
    ) suggestions ON true
    WHERE a.project_id=$1 AND a.kind='UI' AND a.target_type='case' AND ${filter[0]} ${visibility}
    ORDER BY a.created_at,a.id LIMIT 10000`,
      [projectId, filter[1]],
    )
  ).rows;
}

export function caseApprovalReasons(row: CaseReviewRow) {
  return [
    ...(row.archived ? ['需求已归档。'] : []),
    ...(row.removed ? ['用例已移除。'] : []),
    ...(row.review_state === 'approved' ? ['当前修订已审批通过。'] : []),
    ...(row.needs_response ? ['还有修改建议待处理。'] : []),
    ...(row.parent_blocked ? ['所属场景或测试集还有意见待处理。'] : []),
  ];
}

export function caseReviewStage(row: CaseReviewRow) {
  return row.needs_response
    ? ('needsOptimization' as const)
    : row.review_state === 'approved'
      ? ('approved' as const)
      : row.has_suggestions || row.review_state === 'aiOptimized'
        ? ('waitingHuman' as const)
        : ('pending' as const);
}

export async function caseSuggestions(
  tx: SqlExecutor,
  projectId: string,
  caseIds: string[],
) {
  if (!caseIds.length) return [];
  const { rows } = await tx.query<{
    asset_id: string;
    id: string;
    revision_id: string;
    revision_no: number;
    body: string;
    created_by: string;
    created_at: Date;
    response: string | null;
  }>(
    `SELECT o.asset_id,o.id,o.revision_id,r.revision_no,o.body,o.created_by,o.created_at,answer.note response
    FROM app.review_opinions o JOIN app.test_assets a ON a.id=o.asset_id
    JOIN app.asset_revisions r ON r.id=o.revision_id
    LEFT JOIN LATERAL (
      SELECT n.note FROM app.optimization_notes n WHERE n.asset_id=a.id AND n.opinion_id=o.id
        AND n.target_revision_id=a.current_revision_id AND o.revision_id<>a.current_revision_id
      ORDER BY n.created_at DESC,n.id DESC LIMIT 1
    ) answer ON true
    WHERE o.project_id=$1 AND o.asset_id=ANY($2::uuid[]) AND o.removed_at IS NULL AND o.resolved_approval_id IS NULL
    ORDER BY o.created_at,o.id`,
    [projectId, caseIds],
  );
  return rows.map((row) => ({
    caseId: row.asset_id,
    suggestion: {
      id: row.id,
      sourceRevisionId: row.revision_id,
      sourceRevisionNo: row.revision_no,
      body: row.body,
      createdBy: row.created_by,
      createdAt: row.created_at.toISOString(),
      response: row.response,
    },
  }));
}
