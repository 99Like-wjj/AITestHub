import type { z } from 'zod';
import type { issueListQuerySchema } from '../../../contracts/src/issues.js';
/** Shared predicate/parameter order for bounded record lists and unbounded aggregation. */
export function issueListFilter(
  projectId: string,
  actorId: string,
  input: z.infer<typeof issueListQuerySchema>,
) {
  return {
    where: `i.project_id=$1
    AND ($2='all' OR ($2='mine' AND i.assignee_id=$3) OR ($2='unassigned' AND i.assignee_id IS NULL AND i.state<>'closed'))
    AND ($2='mine' OR NOT $4 OR EXISTS(SELECT 1 FROM app.requirement_participants rp WHERE rp.requirement_id=i.requirement_id AND rp.user_id=$3 AND rp.active))
    AND ($5::uuid IS NULL OR i.requirement_id=$5) AND ($6::text IS NULL OR i.state=$6) AND ($7::text IS NULL OR i.severity=$7)
    AND ($8::uuid IS NULL OR i.assignee_id=$8) AND ($9::uuid IS NULL OR i.submitted_by=$9)
    AND ($10='' OR position(lower($10) in lower(i.title||' '||i.description||' BUG-'||lpad(i.number::text,5,'0')))>0)
    AND ($11 OR i.merged_into_id IS NULL) AND ($12 OR NOT EXISTS(SELECT 1 FROM app.requirements ar WHERE ar.id=i.requirement_id AND ar.project_id=i.project_id AND ar.archived_at IS NOT NULL))`,
    values: [
      projectId,
      input.scope,
      actorId,
      input.participationOnly,
      input.requirementId ?? null,
      input.state ?? null,
      input.severity ?? null,
      input.assigneeId ?? null,
      input.submittedBy ?? null,
      input.search,
      input.includeMerged,
      input.includeArchivedRequirements,
    ],
  };
}
