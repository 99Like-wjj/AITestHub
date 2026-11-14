import type { ActorContext } from '../../../contracts/src/identity.js';
import {
  issueSchema,
  problemEvidenceSchema,
  type Issue,
} from '../../../contracts/src/issues.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { DomainError } from '../errors.js';
import { audit } from '../events.js';

export interface IssueRow {
  id: string;
  project_id: string;
  number: string;
  requirement_id: string;
  requirement_version_id: string | null;
  title: string;
  description: string;
  severity: 'severe' | 'normal' | 'minor';
  state: 'pending' | 'inProgress' | 'awaitingRetest' | 'closed';
  assignee_id: string | null;
  assignee_active: boolean;
  merged_into_id: string | null;
  source: 'manualTester' | 'manualProduct' | 'confirmedProblem';
  submitted_by: string;
  row_version: number;
  created_at: Date;
  updated_at: Date;
  latest_handling?: unknown;
}
export const issueSelect = `SELECT i.*,EXISTS(SELECT 1 FROM app.users u JOIN app.project_members m ON m.user_id=u.id
  WHERE u.id=i.assignee_id AND u.active AND m.project_id=i.project_id AND m.active) assignee_active,
  (SELECT jsonb_build_object('action',e.action,'actorId',e.actor_id,'previousOwnerId',e.previous_owner_id,'newOwnerId',e.new_owner_id,'note',COALESCE(e.payload->>'note',''),'createdAt',e.created_at)
    FROM app.issue_events e WHERE e.issue_id=i.id AND e.action IN ('created','claim','assign','transfer','return','takeover','start-processing','ready-for-retest') ORDER BY e.created_at DESC,e.id DESC LIMIT 1) latest_handling FROM app.issues i`;
export const issueDto = (row: IssueRow): Issue =>
  issueSchema.parse({
    id: row.id,
    projectId: row.project_id,
    number: `BUG-${row.number.padStart(5, '0')}`,
    requirementId: row.requirement_id,
    requirementVersionId: row.requirement_version_id,
    title: row.title,
    description: row.description,
    severity: row.severity,
    state: row.state,
    assigneeId: row.assignee_id,
    assigneeActive: row.assignee_active,
    mergedIntoId: row.merged_into_id,
    source: row.source,
    submittedBy: row.submitted_by,
    rowVersion: row.row_version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    latestHandling: row.latest_handling ?? null,
  });
export async function issueRow(
  tx: SqlExecutor,
  projectId: string,
  id: string,
  lock = false,
): Promise<IssueRow> {
  const row = (
    await tx.query<IssueRow>(
      `${issueSelect} WHERE i.project_id=$1 AND i.id=$2${lock ? ' FOR UPDATE OF i' : ''}`,
      [projectId, id],
    )
  ).rows[0];
  if (!row) throw new DomainError('NOT_FOUND', '此项目内没有该正式缺陷。', 404);
  return row;
}
export async function requireRequirement(
  tx: SqlExecutor,
  projectId: string,
  requirementId: string,
  versionId: string | null,
): Promise<void> {
  if (
    !(
      await tx.query(
        'SELECT 1 FROM app.requirements WHERE project_id=$1 AND id=$2',
        [projectId, requirementId],
      )
    ).rowCount
  )
    throw new DomainError('NOT_FOUND', '此项目内没有该需求。', 404);
  if (
    versionId &&
    !(
      await tx.query(
        'SELECT 1 FROM app.requirement_versions WHERE project_id=$1 AND requirement_id=$2 AND id=$3',
        [projectId, requirementId, versionId],
      )
    ).rowCount
  ) {
    throw new DomainError('NOT_FOUND', '需求版本与选定需求不一致。', 404);
  }
}
export async function requireAssignee(
  tx: SqlExecutor,
  projectId: string,
  userId: string | null,
): Promise<void> {
  if (!userId) return;
  if (
    !(
      await tx.query(
        `SELECT 1 FROM app.project_members m JOIN app.users u ON u.id=m.user_id
    WHERE m.project_id=$1 AND m.user_id=$2 AND m.active AND u.active FOR SHARE OF m,u`,
        [projectId, userId],
      )
    ).rowCount
  ) {
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '负责人必须是本项目当前有效成员；指派不会自动加入需求或授予业务角色。',
      422,
    );
  }
}
export async function evidenceDtos(
  tx: SqlExecutor,
  projectId: string,
  evidenceIds: readonly string[],
) {
  if (!evidenceIds.length) return [];
  const rows = await tx.query<{
    id: string;
    file_id: string;
    local_evidence_id: string;
    manifest: unknown;
    original_name: string;
    status: string;
    deleted_at: Date | null;
  }>(
    `SELECT e.*,f.original_name,f.status,f.deleted_at FROM app.run_evidence e JOIN app.file_resources f ON f.id=e.file_id
    WHERE e.project_id=$1 AND e.id=ANY($2::uuid[]) ORDER BY e.created_at,e.id`,
    [projectId, [...new Set(evidenceIds)]],
  );
  return rows.rows.map((row) =>
    problemEvidenceSchema.parse({
      evidenceId: row.id,
      fileId: row.file_id,
      localEvidenceId: row.local_evidence_id,
      manifest: row.manifest,
      originalName: row.original_name,
      fileStatus: row.status,
      fileAvailable: row.status === 'verified' && row.deleted_at === null,
      downloadPath: `/api/v1/files/${row.file_id}/content`,
    }),
  );
}
export async function lockIssueProject(
  tx: SqlExecutor,
  projectId: string,
): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `issues:${projectId}`,
  ]);
}
export async function issueEvent(
  tx: SqlExecutor,
  actor: ActorContext,
  row: IssueRow,
  action: string,
  previousOwner: string | null,
  newOwner: string | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await tx.query(
    `INSERT INTO app.issue_events(issue_id,action,actor_id,previous_owner_id,new_owner_id,payload) VALUES($1,$2,$3,$4,$5,$6)`,
    [
      row.id,
      action,
      actor.userId,
      previousOwner,
      newOwner,
      JSON.stringify(payload),
    ],
  );
  const summary: Record<string, unknown> = { previousOwner, newOwner };
  for (const key of [
    'resolution',
    'previousState',
    'newState',
    'outcome',
    'verificationId',
    'mergeId',
  ])
    if (key in payload) summary[key] = payload[key];
  await audit(tx, actor, `issue.${action}`, row.id, row.project_id, summary);
}
export async function linkResults(
  tx: SqlExecutor,
  projectId: string,
  issueId: string,
  resultIds: string[],
): Promise<void> {
  for (const id of new Set(resultIds)) {
    const result = (
      await tx.query<{ current_revision_id: string }>(
        'SELECT current_revision_id FROM app.results WHERE project_id=$1 AND id=$2',
        [projectId, id],
      )
    ).rows[0];
    if (!result)
      throw new DomainError('NOT_FOUND', '关联结果不属于本项目。', 404);
    await tx.query(
      'INSERT INTO app.issue_result_links(project_id,issue_id,result_id,source_revision_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [projectId, issueId, id, result.current_revision_id],
    );
  }
}
