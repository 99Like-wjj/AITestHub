import type { ActorContext } from '../../../contracts/src/identity.js';
import { projectOverviewSchema } from '../../../contracts/src/overview.js';
import type { Database } from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { requirementInactivityDeadlineSql } from '../requirements/service.js';
import { executionRecords } from '../reports/records.js';
export class ProjectOverviewService {
  constructor(readonly db: Database) {}
  async get(actor: ActorContext, projectId: string) {
    const summary = await this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const row = (
        await tx.query<{
          ongoing: number;
          inactive: number;
          pending_ui: number;
          pending_api: number;
          issues: number;
          runs: number;
          problems: number;
          owned: number;
          incomplete: number;
          participating_total: number;
          participating: unknown;
          captured_at: Date;
        }>(
          `SELECT
    (SELECT count(*)::integer FROM app.requirements r WHERE r.project_id=$1 AND r.archived_at IS NULL AND r.lifecycle='inProgress') ongoing,
    (SELECT count(*)::integer FROM app.requirements r WHERE r.project_id=$1 AND r.archived_at IS NULL AND r.lifecycle='inProgress' AND (${requirementInactivityDeadlineSql})<=clock_timestamp()) inactive,
    (SELECT count(*)::integer FROM app.test_assets WHERE project_id=$1 AND kind='UI' AND target_type='case' AND removed_at IS NULL AND review_state<>'approved') pending_ui,
    (SELECT count(*)::integer FROM app.test_assets WHERE project_id=$1 AND kind='API' AND target_type='case' AND removed_at IS NULL AND review_state<>'approved') pending_api,
    (SELECT count(*)::integer FROM app.issues WHERE project_id=$1 AND state<>'closed') issues,
    (SELECT count(*)::integer FROM app.runs WHERE project_id=$1 AND source<>'debug') runs,
    (SELECT count(*)::integer FROM app.problem_candidates WHERE project_id=$1 AND state='pendingConfirmation') problems,
    (SELECT count(*)::integer FROM app.issues WHERE project_id=$1 AND state<>'closed' AND assignee_id=$2) owned,
    (SELECT count(*)::integer FROM app.runs r WHERE r.project_id=$1 AND r.source<>'debug' AND (
      NOT EXISTS(SELECT 1 FROM app.reports rep WHERE rep.run_id=r.id)
      OR (SELECT count(*) FROM app.results res WHERE res.run_id=r.id)<jsonb_array_length(r.scope_snapshot->'items')
      OR EXISTS(SELECT 1 FROM app.run_evidence e JOIN app.file_resources f ON f.id=e.file_id WHERE e.run_id=r.id AND (f.status<>'verified' OR f.deleted_at IS NOT NULL)))) incomplete,
    (SELECT count(*)::integer FROM app.requirements r JOIN app.requirement_participants rp ON rp.requirement_id=r.id AND rp.project_id=r.project_id WHERE r.project_id=$1 AND rp.user_id=$2 AND rp.active) participating_total,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',q.id,'title',q.title,'businessNumber',q.business_number,'latestVersionId',q.version_id,'latestVersionNo',q.version_no,'lifecycle',CASE WHEN q.archived_at IS NOT NULL OR q.lifecycle<>'inProgress' THEN 'archived' ELSE 'inProgress' END,'inactive',q.inactive,'archivedAt',q.archived_at) ORDER BY q.business_updated_at DESC,q.id),'[]'::jsonb) FROM(
      SELECT r.id,r.title,r.business_number,v.id version_id,v.version_no,r.lifecycle,r.archived_at,r.business_updated_at,(r.archived_at IS NULL AND r.lifecycle='inProgress' AND (${requirementInactivityDeadlineSql})<=clock_timestamp()) inactive FROM app.requirements r JOIN app.requirement_participants rp ON rp.requirement_id=r.id AND rp.project_id=r.project_id JOIN LATERAL(SELECT id,version_no FROM app.requirement_versions WHERE requirement_id=r.id AND project_id=$1 ORDER BY version_no DESC LIMIT 1)v ON true
      WHERE r.project_id=$1 AND rp.user_id=$2 AND rp.active ORDER BY r.business_updated_at DESC,r.id LIMIT 6
    )q) participating,clock_timestamp() captured_at`,
          [projectId, actor.userId],
        )
      ).rows[0];
      if (!row) throw new Error('Project overview unavailable');
      return row;
    });
    const recent = await executionRecords(this.db, actor, projectId, {
      pageSize: 5,
    });
    return projectOverviewSchema.parse({
      projectId,
      stats: {
        ongoingRequirements: summary.ongoing,
        inactiveOngoingRequirements: summary.inactive,
        pendingCases: summary.pending_ui + summary.pending_api,
        pendingUiCases: summary.pending_ui,
        pendingApiCases: summary.pending_api,
        openIssues: summary.issues,
        executionRecords: summary.runs,
      },
      myWork: {
        pendingCases: summary.pending_ui + summary.pending_api,
        pendingProblems: summary.problems,
        ownedOpenIssues: summary.owned,
        incompleteDeliveries: summary.incomplete,
      },
      participatingRequirements: summary.participating,
      participatingRequirementsTotal: summary.participating_total,
      recentExecutions: recent.records,
      capturedAt: summary.captured_at.toISOString(),
    });
  }
}
