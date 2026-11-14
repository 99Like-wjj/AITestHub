import { createHash } from 'node:crypto';
import {
  issueCountsQuerySchema,
  issueCountsResponseSchema,
} from '../../../contracts/src/issues.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { Database } from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { issueListFilter } from './list-filter.js';

export async function readIssueCounts(
  db: Database,
  actor: ActorContext,
  projectId: string,
  raw: unknown = {},
) {
  const input = issueCountsQuerySchema.parse(raw);
  return db.transaction(async (tx) => {
    await requireProject(tx, actor, projectId, 'project.read');
    const filter = issueListFilter(projectId, actor.userId, input);
    const row = (
      await tx.query<{
        requirements: unknown;
        totals: unknown;
        calculated_at: Date;
      }>(
        `WITH formal AS (
      SELECT i.requirement_id,i.assignee_id,i.state FROM app.issues i WHERE ${filter.where}
      AND (NOT $13::boolean OR (i.assignee_id IS NULL AND i.state<>'closed'))
    ),pending AS (
      SELECT p.requirement_id FROM app.problem_candidates p WHERE p.project_id=$1 AND p.state='pendingConfirmation'
      AND ($14::text IS NULL OR p.state=$14) AND (NOT $15::boolean OR EXISTS(SELECT 1 FROM app.requirement_participants rp WHERE rp.requirement_id=p.requirement_id AND rp.user_id=$3 AND rp.active))
      AND ($10='' OR position(lower($10) in lower(p.title||' '||p.description))>0)
      AND ($12 OR NOT EXISTS(SELECT 1 FROM app.requirements ar WHERE ar.id=p.requirement_id AND ar.project_id=p.project_id AND ar.archived_at IS NOT NULL))
    ),formal_groups AS (
      SELECT requirement_id,count(*) formal,count(*) FILTER(WHERE assignee_id IS NULL AND state<>'closed') unassigned FROM formal GROUP BY requirement_id
    ),pending_groups AS (SELECT requirement_id,count(*) pending FROM pending GROUP BY requirement_id)
    SELECT COALESCE(jsonb_agg(jsonb_build_object('requirementId',r.id,'formal',coalesce(f.formal,0)::text,'unassigned',coalesce(f.unassigned,0)::text,'pendingTestConfirmation',coalesce(p.pending,0)::text) ORDER BY r.id),'[]'::jsonb) requirements,
      jsonb_build_object('formal',(SELECT count(*)::text FROM formal),'unassigned',(SELECT count(*)::text FROM formal WHERE assignee_id IS NULL AND state<>'closed'),'pendingTestConfirmation',(SELECT count(*)::text FROM pending)) totals,
      clock_timestamp() calculated_at
    FROM app.requirements r LEFT JOIN formal_groups f ON f.requirement_id=r.id LEFT JOIN pending_groups p ON p.requirement_id=r.id
    WHERE r.project_id=$1 AND ($12 OR r.archived_at IS NULL)`,
        [
          ...filter.values,
          input.unassignedOnly,
          input.problemState ?? null,
          input.scope === 'mine' ? false : input.participationOnly,
        ],
      )
    ).rows[0];
    if (!row) throw Error('Issue count aggregation returned no snapshot.');
    const version = createHash('sha256')
      .update(
        JSON.stringify({
          projectId,
          actor: actor.userId,
          input,
          requirements: row.requirements,
          totals: row.totals,
        }),
      )
      .digest('hex');
    return issueCountsResponseSchema.parse({
      projectId,
      filters: input,
      version,
      calculatedAt: row.calculated_at.toISOString(),
      requirements: row.requirements,
      totals: row.totals,
      pendingConfirmationOwnership: 'noAssignee',
    });
  });
}
