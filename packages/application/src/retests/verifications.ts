import { randomUUID } from 'node:crypto';
import {
  executionScopeSchema,
  resultItemSchema,
} from '../../../contracts/src/domain.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { uiDeliveryGate } from '../results/delivery-state.js';
/** Trusted archival only. Raw retest facts never close, assign or reopen an issue. */
export async function recordRetestVerifications(
  tx: SqlExecutor,
  projectId: string,
  runId: string,
): Promise<void> {
  const run = (
    await tx.query<{
      source: string;
      state: string;
      kind: 'UI' | 'API';
      created_by: string;
      scope_snapshot: unknown;
      execution_provenance: string;
    }>(
      'SELECT source,state,kind,created_by,scope_snapshot,execution_provenance FROM app.runs WHERE project_id=$1 AND id=$2',
      [projectId, runId],
    )
  ).rows[0];
  if (!run || !['completed', 'terminated', 'interrupted'].includes(run.state))
    return;
  if (run.kind === 'UI') {
    const gate = await uiDeliveryGate(tx, runId);
    if (gate.versioned && (!gate.sealed || gate.pendingDescriptors > 0)) return;
  }
  const scope = executionScopeSchema.parse(run.scope_snapshot);
  if (scope.sourceType !== 'retestPreparation') return;
  const rows = (
    await tx.query<{
      id: string;
      run_item_id: string;
      current_revision_id: string;
      content: unknown;
    }>(
      `SELECT r.id,r.run_item_id,r.current_revision_id,v.content
  FROM app.results r JOIN app.result_revisions v ON v.id=r.current_revision_id WHERE r.project_id=$1 AND r.run_id=$2`,
      [projectId, runId],
    )
  ).rows;
  const facts = new Map(
    rows.map((row) => [
      row.run_item_id,
      { ...row, item: resultItemSchema.parse(row.content) },
    ]),
  );
  if (scope.items.some((item) => !facts.has(item.runItemId))) return;
  for (const issueId of new Set(scope.items.flatMap((item) => item.issueIds))) {
    if (
      !(
        await tx.query(
          'SELECT 1 FROM app.retest_group_issues WHERE project_id=$1 AND group_id=$2 AND issue_id=$3',
          [projectId, scope.sourceRevisionId, issueId],
        )
      ).rowCount
    )
      continue;
    const items = scope.items
      .filter((item) => item.issueIds.includes(issueId))
      .map((item) => facts.get(item.runItemId)!);
    const outcomes = items.map((item) => item.item.originalOutcome);
    const outcome = outcomes.every((v) => v === 'passed')
      ? 'passed'
      : outcomes.some((v) => v === 'failed')
        ? 'failed'
        : outcomes.every((v) => v === 'notExecuted')
          ? 'notExecuted'
          : 'inconclusive';
    const note = JSON.stringify({
      basis: 'raw-fixed-scope',
      executionProvenance: run.execution_provenance,
      results: items.map((item) => ({
        resultId: item.id,
        revisionId: item.current_revision_id,
        outcome: item.item.originalOutcome,
      })),
    });
    await tx.query(
      `INSERT INTO app.issue_verifications(id,project_id,issue_id,method,outcome,run_id,note,actor_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(issue_id,run_id) WHERE run_id IS NOT NULL DO NOTHING`,
      [
        randomUUID(),
        projectId,
        issueId,
        run.kind,
        outcome,
        runId,
        note,
        run.created_by,
      ],
    );
  }
}
