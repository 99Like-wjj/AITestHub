import type { SqlExecutor } from '../../../persistence/src/database.js';
import { assertSubmissionFileBudget } from '../files/submission-budget.js';
import { DomainError } from '../errors.js';
import type { FilePolicySnapshot } from '../files/resource-policy.js';

/** Amendments can explicitly reuse old evidence; count only this new revision's references. */
export async function assertReferencedEvidenceFileBudget(
  tx: SqlExecutor,
  projectId: string,
  runId: string,
  evidenceRefs: readonly string[],
  policy?: FilePolicySnapshot,
) {
  const refs = [...new Set(evidenceRefs)].sort();
  const existing = refs.length
    ? (
        await tx.query<{ file_id: string }>(
          `SELECT file_id FROM app.run_evidence
         WHERE project_id=$1 AND run_id=$2 AND local_evidence_id=ANY($3::text[])
         ORDER BY id FOR SHARE`,
          [projectId, runId, refs],
        )
      ).rows.map((row) => row.file_id)
    : [];
  if (existing.length !== refs.length)
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '结果引用了本执行尚未登记的证据标识。',
      422,
    );
  // Another run's matching local ID never supplies files or authorization here.
  return assertSubmissionFileBudget(
    tx,
    projectId,
    [...existing],
    policy,
    'case',
  );
}
