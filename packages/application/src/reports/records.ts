import type { ActorContext } from '../../../contracts/src/identity.js';
import {
  executionRecordQuerySchema,
  executionRecordListSchema,
} from '../../../contracts/src/ui-results.js';
import type { Database } from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import {
  uiDeliveryGates,
  projectUiDelivery,
} from '../results/delivery-state.js';
const outcomes = [
  'passed',
  'failed',
  'blocked',
  'inconclusive',
  'notExecuted',
] as const;
// Only trusted source expressions are interpolated. All caller values remain parameters.
const counts = (expression: string, extra = '') =>
  `jsonb_build_object(${outcomes.map((outcome) => `'${outcome}',count(*) FILTER(WHERE ${expression}='${outcome}')::integer`).join(',')},'notReported',greatest(jsonb_array_length(r.scope_snapshot->'items')-count(res.id),0)::integer${extra})`;
interface RecordRow {
  run_id: string;
  total: string;
  report_id: string | null;
  report_revision_id: string | null;
  name: string;
  kind: string;
  source: string;
  state: string;
  environment_id: string;
  environment_name: string | null;
  product_build: string | null;
  created_by: string;
  creator_name: string;
  creator_active: boolean;
  created_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
  total_items: number;
  completed_items: number;
  reported_items: number;
  missing_files: number;
  delivery_status: string;
  cleanup_state: string;
  execution_provenance: string;
  progress_closed_at: Date | null;
  last_progress_at: Date | null;
  current_case_id: string | null;
  current_case_title: string | null;
  current_case_ordinal: number | null;
  requirement_count: number;
  requirement_preview: unknown;
  invalid_results: number;
  assessment_basis_changed: number;
  original_stats: unknown;
  reported_stats: unknown;
  final_stats: unknown;
  effective_stats: unknown;
  row_version: number;
}
export async function executionRecords(
  db: Database,
  actor: ActorContext,
  projectId: string,
  raw: unknown = {},
) {
  const input = executionRecordQuerySchema.parse(raw);
  return db.transaction(async (tx) => {
    await requireProject(tx, actor, projectId, 'project.read');
    const rows = (
      await tx.query<RecordRow>(
        `WITH filtered AS MATERIALIZED(
   SELECT r.id,r.created_at FROM app.runs r LEFT JOIN app.plan_revisions p ON p.id=r.source_revision_id
   LEFT JOIN app.retest_groups g ON g.id=r.source_revision_id LEFT JOIN app.retest_preparations prep ON prep.id=g.preparation_id
   WHERE r.project_id=$1 AND (($7='archive' AND r.source='uiArchive') OR ($7='formal' AND r.source NOT IN('debug','uiArchive'))) AND ($2='all' OR r.kind=$2) AND ($3::text IS NULL OR r.state=$3)
    AND ($4='' OR position(lower($4) in lower(COALESCE(p.name,prep.name,r.scope_snapshot->>'title','')||' '||r.id::text))>0)
  ),total AS(SELECT count(*)::text total FROM filtered),page AS(SELECT id FROM filtered ORDER BY created_at DESC,id DESC LIMIT $5 OFFSET $6)
  SELECT r.id run_id,total.total,rep.id report_id,rep.current_revision_id report_revision_id,
   COALESCE(pr.name,prep.name,r.scope_snapshot->>'title',CASE WHEN r.kind='UI' THEN '本地 UI 执行' ELSE '接口回归' END) name,r.kind,r.source,r.state,r.environment_id,er.content->>'name' environment_name,r.product_build,
   r.created_by,u.display_name creator_name,COALESCE(u.active AND m.active,false) creator_active,r.created_at,r.started_at,r.ended_at,
   jsonb_array_length(r.scope_snapshot->'items') total_items,
   CASE WHEN r.kind='UI' THEN CASE WHEN rep.id IS NULL THEN r.completed_items ELSE facts.reported_items-(facts.reported_stats->>'notExecuted')::integer END ELSE (SELECT count(*)::integer FROM app.run_items WHERE run_id=r.id AND outcome IN ('passed','failed')) END completed_items,
   facts.reported_items,files.missing_files,
   CASE WHEN rep.id IS NULL THEN r.delivery_status WHEN facts.reported_items=jsonb_array_length(r.scope_snapshot->'items') AND files.missing_files=0 THEN 'complete' ELSE 'incomplete' END delivery_status,
   r.cleanup_state,r.execution_provenance,r.progress_closed_at,r.last_progress_at,current_case.id current_case_id,current_case.snapshot->'content'->>'title' current_case_title,current_case.ordinal current_case_ordinal,
   requirements.requirement_count,preview.requirement_preview,facts.invalid_results,facts.assessment_basis_changed,facts.original_stats,facts.reported_stats,facts.final_stats,facts.effective_stats,r.row_version
  FROM total LEFT JOIN page ON true LEFT JOIN app.runs r ON r.id=page.id
   LEFT JOIN app.plan_revisions pr ON pr.id=r.source_revision_id LEFT JOIN app.retest_groups g ON g.id=r.source_revision_id LEFT JOIN app.retest_preparations prep ON prep.id=g.preparation_id
   LEFT JOIN app.test_configuration_revisions er ON er.id=r.environment_revision_id LEFT JOIN app.users u ON u.id=r.created_by LEFT JOIN app.project_members m ON m.project_id=r.project_id AND m.user_id=r.created_by
   LEFT JOIN app.reports rep ON rep.run_id=r.id
   LEFT JOIN LATERAL(SELECT i.id,i.snapshot,i.ordinal FROM app.run_items i WHERE i.run_id=r.id AND i.state='running' ORDER BY i.ordinal LIMIT 1)current_case ON true
   LEFT JOIN LATERAL(SELECT count(DISTINCT v.requirement_id)::integer requirement_count FROM jsonb_array_elements(COALESCE(r.scope_snapshot->'items','[]'::jsonb)) item JOIN app.requirement_versions v ON v.id=(item->>'requirementVersionId')::uuid AND v.project_id=$1)requirements ON true
   LEFT JOIN LATERAL(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',q.id,'title',q.title,'versionNo',q.version_no) ORDER BY q.title,q.version_no),'[]'::jsonb) requirement_preview FROM(
    SELECT DISTINCT req.id,req.title,v.version_no FROM jsonb_array_elements(COALESCE(r.scope_snapshot->'items','[]'::jsonb)) item JOIN app.requirement_versions v ON v.id=(item->>'requirementVersionId')::uuid AND v.project_id=$1 JOIN app.requirements req ON req.id=v.requirement_id ORDER BY req.title,v.version_no LIMIT 3
   )q)preview ON true
   LEFT JOIN LATERAL(SELECT count(DISTINCT e.file_id)::integer missing_files FROM app.run_evidence e JOIN app.file_resources f ON f.id=e.file_id WHERE e.run_id=r.id AND (f.status<>'verified' OR f.deleted_at IS NOT NULL))files ON true
   LEFT JOIN LATERAL(SELECT count(res.id)::integer reported_items,
    count(*) FILTER(WHERE cv.content->>'originalOutcome' IS NULL OR cv.content->>'originalOutcome' NOT IN ('passed','failed','blocked','inconclusive','notExecuted') OR iv.content->>'originalOutcome' IS NULL OR iv.content->>'originalOutcome' NOT IN ('passed','failed','blocked','inconclusive','notExecuted'))::integer invalid_results,
    count(*) FILTER(WHERE a.id IS NOT NULL AND a.result_revision_id<>res.current_revision_id)::integer assessment_basis_changed,
    ${counts("iv.content->>'originalOutcome'")} original_stats,${counts("cv.content->>'originalOutcome'")} reported_stats,
    ${counts('a.final_outcome', ",'notAssessed',count(*) FILTER(WHERE a.id IS NULL)::integer")} final_stats,
    ${counts("COALESCE(a.final_outcome,cv.content->>'originalOutcome')")} effective_stats
    FROM app.results res JOIN app.result_revisions cv ON cv.id=res.current_revision_id JOIN app.result_revisions iv ON iv.result_id=res.id AND iv.revision_no=1 LEFT JOIN app.result_assessments a ON a.id=res.current_assessment_revision_id WHERE res.run_id=r.id
   )facts ON true
  ORDER BY r.created_at DESC,r.id DESC`,
        [
          projectId,
          input.kind,
          input.state ?? null,
          input.search,
          input.pageSize,
          (input.page - 1) * input.pageSize,
          input.source,
        ],
      )
    ).rows;
    const total = Number(rows[0]?.total ?? '0');
    const gates = await uiDeliveryGates(
      tx,
      rows.filter((r) => r.run_id && r.kind === 'UI').map((r) => r.run_id),
    );
    return executionRecordListSchema.parse({
      records: rows
        .filter((r) => r.run_id !== null)
        .map((r) => ({
          runId: r.run_id,
          reportId: r.report_id,
          reportRevisionId: r.report_revision_id,
          name: r.name,
          kind: r.kind,
          source: r.source,
          state: r.state,
          environment: {
            id: r.environment_id,
            name: r.environment_name ?? '环境名称暂不可用',
          },
          productBuild: r.product_build,
          createdBy: {
            id: r.created_by,
            name: r.creator_name,
            active: r.creator_active,
          },
          createdAt: r.created_at.toISOString(),
          startedAt: r.started_at?.toISOString() ?? null,
          endedAt: r.ended_at?.toISOString() ?? null,
          durationMs:
            r.started_at && r.ended_at
              ? Math.max(0, r.ended_at.getTime() - r.started_at.getTime())
              : null,
          totalItems: r.total_items,
          completedItems: r.completed_items,
          reportedItems: r.reported_items,
          missingFileCount:
            r.missing_files + (gates.get(r.run_id)?.missingSources ?? 0),
          deliveryStatus:
            projectUiDelivery(
              gates.get(r.run_id),
              r.reported_items,
              r.total_items,
              r.missing_files + (gates.get(r.run_id)?.missingSources ?? 0),
            ) ?? r.delivery_status,
          cleanupState: r.cleanup_state,
          executionProvenance: r.execution_provenance,
          progressClosedAt: r.progress_closed_at?.toISOString() ?? null,
          lastProgressAt: r.last_progress_at?.toISOString() ?? null,
          currentCase: r.current_case_id
            ? {
                runItemId: r.current_case_id,
                title: r.current_case_title ?? '当前用例',
                ordinal: r.current_case_ordinal,
              }
            : null,
          requirementCount: r.requirement_count,
          requirementPreview: r.requirement_preview,
          invalidResultCount: r.invalid_results,
          assessmentBasisChangedCount: r.assessment_basis_changed,
          statistics: r.invalid_results
            ? null
            : {
                denominator: r.total_items,
                reportedItems: r.reported_items,
                original: r.original_stats,
                reported: r.reported_stats,
                final: r.final_stats,
                effective: r.effective_stats,
              },
          rowVersion: r.row_version,
        })),
      total,
      page: input.page,
      pageSize: input.pageSize,
      hasMore: input.page * input.pageSize < total,
    });
  });
}
