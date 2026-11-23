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
    ...('assertions' in content && content.assertions
      ? { assertions: content.assertions }
      : {}),
  };
}

export async function assertResultEvidenceScope(
  tx: SqlExecutor,
  projectId: string,
  runId: string,
  item: z.infer<typeof resultItemSchema>,
) {
  assertResultStepEvidenceReferences(item);
  const ordinals = [
    ...(item.stepObservations ?? []).map((step) => step.ordinal),
    ...(item.observations ?? []).flatMap(
      (observation) => observation.stepOrdinals ?? [],
    ),
    ...(item.evidenceGaps ?? []).flatMap((gap) =>
      gap.ordinal === undefined ? [] : [gap.ordinal],
    ),
  ];
  const assertionIds = [
    ...(item.observations ?? []).flatMap(
      (observation) => observation.assertionIds ?? [],
    ),
    ...(item.assertionResults ?? []).map((assertion) => assertion.assertionId),
    ...(item.evidenceGaps ?? []).flatMap((gap) => gap.assertionIds ?? []),
  ];
  if (!ordinals.length && !assertionIds.length) return;
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
  const knownAssertions = new Set(
    scope.assertions?.map((assertion) => assertion.id),
  );
  if (assertionIds.some((id) => !knownAssertions.has(id)))
    throw new DomainError(
      'VALIDATION_ERROR',
      '观察与断言结论须引用此执行项冻结的业务断言。',
      422,
    );
}

/** An independent archive may record observed steps without claiming a frozen testcase. */
export function assertResultStepEvidenceReferences(
  item: z.infer<typeof resultItemSchema>,
) {
  const declared = new Set(item.evidenceRefs);
  if (
    [...(item.stepObservations ?? []), ...(item.observations ?? [])].some(
      (entry) => entry.evidenceRefs?.some((ref) => !declared.has(ref)),
    )
  )
    throw new DomainError(
      'VALIDATION_ERROR',
      '观察证据须引用同一结果已声明的证据。',
      422,
    );
  if (
    item.observations?.some((observation) =>
      observation.actionOrdinals?.some(
        (ordinal) => ordinal > (item.actualActions?.length ?? 0),
      ),
    )
  )
    throw new DomainError(
      'VALIDATION_ERROR',
      '观察引用的实际操作须属于同一结果。',
      422,
    );
}
