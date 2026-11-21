import { resultItemSchema } from '../../../contracts/src/domain.js';
import { reportScopeItemSchema } from '../../../contracts/src/ui-archives.js';
import type { z } from 'zod';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { DomainError } from '../errors.js';

export async function readResultScope(
  tx: SqlExecutor,
  projectId: string,
  runId: string,
  runItemId: string,
) {
  const row = (
    await tx.query<{
      snapshot: unknown;
      case_revision_id: string | null;
      revision_no: number | null;
    }>(
      `SELECT i.snapshot,s.case_revision_id,v.revision_no
       FROM app.run_items i
       LEFT JOIN app.approval_snapshots s ON s.id=i.approval_snapshot_id
       LEFT JOIN app.asset_revisions v ON v.id=s.case_revision_id
       WHERE i.project_id=$1 AND i.run_id=$2 AND i.id=$3`,
      [projectId, runId, runItemId],
    )
  ).rows[0];
  const fixed = reportScopeItemSchema.safeParse(row?.snapshot);
  if (!row || !fixed.success) return undefined;
  const { content } = fixed.data;
  const archiveRevision =
    'caseRevisionId' in fixed.data ? fixed.data.caseRevisionId : null;
  return {
    kind: content.kind,
    caseId: fixed.data.caseId,
    revisionId: row.case_revision_id ?? archiveRevision,
    revisionNo: row.revision_no,
    approvalSnapshotId: fixed.data.approvalSnapshotId,
    title: content.title,
    ...('dataRow' in fixed.data && fixed.data.dataRow
      ? { dataRow: fixed.data.dataRow }
      : {}),
    ...('preparationSources' in fixed.data && fixed.data.preparationSources
      ? { preparationSources: fixed.data.preparationSources }
      : {}),
    preconditions: 'preconditions' in content ? content.preconditions : [],
    expected: 'expected' in content ? content.expected : null,
    steps:
      content.kind === 'UI' && 'steps' in content ? (content.steps ?? []) : [],
  };
}

export async function assertResultEvidenceScope(
  tx: SqlExecutor,
  projectId: string,
  runId: string,
  item: z.infer<typeof resultItemSchema>,
) {
  const observations = item.stepObservations ?? [];
  const ordinals = [
    ...observations.map((step) => step.ordinal),
    ...(item.evidenceGaps ?? []).flatMap((gap) =>
      gap.ordinal === undefined ? [] : [gap.ordinal],
    ),
  ];
  if (!ordinals.length) return;
  const declared = new Set(item.evidenceRefs);
  if (
    observations.some((step) =>
      step.evidenceRefs.some((ref) => !declared.has(ref)),
    )
  )
    throw new DomainError(
      'VALIDATION_ERROR',
      '步骤证据须引用同一结果已声明的证据。',
      422,
    );
  const scope = await readResultScope(tx, projectId, runId, item.runItemId);
  if (
    !scope ||
    scope.kind !== 'UI' ||
    ordinals.some((ordinal) => ordinal > scope.steps.length)
  )
    throw new DomainError(
      'VALIDATION_ERROR',
      '步骤观察须定位到此执行项的冻结 UI 用例步骤。',
      422,
    );
}
