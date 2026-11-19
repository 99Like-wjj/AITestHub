import { randomUUID } from 'node:crypto';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { executionScopeSchema } from '../../../contracts/src/domain.js';
import { requireProject } from '../access/policy.js';
import { DomainError, forbidden } from '../errors.js';
import { readRun, semanticDigest } from '../ui-executions/service.js';
import type { RunRow } from '../ui-executions/service.js';
import { assertLocalUiActor } from './delivery-access.js';
import { requireUiDeliveryReady } from './delivery-state.js';
import type { DeliveryHead, ExecutionFactRow } from './delivery-model.js';

export const uiDeliveryOperations = {
  batch: 'results.ui-delivery.receive-batch',
  end: 'ui-executions.declare-end',
  resume: 'ui-executions.declare-resume',
  seal: 'results.ui-delivery.seal',
} as const;
export async function authorizeDelivery(
  tx: SqlExecutor,
  actor: ActorContext,
  projectId: string,
  runId: string,
  snapshotDigest?: string,
  lock: boolean | 'share' = false,
) {
  assertLocalUiActor(actor);
  await requireProject(tx, actor, projectId, 'results.submit');
  await requireUiDeliveryReady(tx);
  const run = await readRun(tx, projectId, runId, lock);
  if (
    run.kind !== 'UI' ||
    run.source === 'uiArchive' ||
    run.created_by !== actor.userId
  )
    forbidden();
  if (snapshotDigest !== undefined && snapshotDigest !== run.scope_digest)
    throw new DomainError(
      'BUSINESS_CONFLICT',
      '累计交付不是此执行的固定范围。',
      409,
    );
  return run;
}
export async function deliveryHead(
  tx: SqlExecutor,
  runId: string,
  lock = false,
): Promise<DeliveryHead | null> {
  return (
    (
      await tx.query<DeliveryHead>(
        `SELECT * FROM app.ui_delivery_heads WHERE run_id=$1${lock ? ' FOR UPDATE' : ''}`,
        [runId],
      )
    ).rows[0] ?? null
  );
}
export async function ensureDeliveryHead(
  tx: SqlExecutor,
  run: RunRow,
): Promise<DeliveryHead> {
  const existing = await deliveryHead(tx, run.id, true);
  if (existing) return existing;
  const legacy = ['completed', 'terminated', 'interrupted'].includes(run.state);
  const ended = legacy
    ? ((
        await tx.query<{ ended_at: Date | null }>(
          'SELECT ended_at FROM app.runs WHERE id=$1',
          [run.id],
        )
      ).rows[0]?.ended_at ?? null)
    : null;
  const initialDigest = semanticDigest({
    schemaVersion: 'ath.ui-delivery-ledger.v2',
    runId: run.id,
    snapshotDigest: run.scope_digest,
  });
  await tx.query(
    `INSERT INTO app.ui_delivery_heads(run_id,project_id,owner_id,scope_digest,mode,legacy_state,legacy_ended_at,ledger_digest)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      run.id,
      run.project_id,
      run.created_by,
      run.scope_digest,
      legacy ? 'legacyDeliveryOnly' : 'nativeV2',
      legacy ? run.state : null,
      ended,
      initialDigest,
    ],
  );
  if (legacy) {
    const id = randomUUID(),
      payload = {
        runId: run.id,
        snapshotDigest: run.scope_digest,
        legacyState: run.state,
        endedAt: ended?.toISOString() ?? null,
      };
    // Import the prior recorded end as an immutable legacy basis; never invent its date or rewrite the old run.
    await tx.query(
      `INSERT INTO app.ui_execution_facts(id,project_id,run_id,owner_id,scope_digest,sequence,fact_kind,semantic_digest,end_kind,ended_at,reason,provenance,legacy_state,payload,receipt)
      VALUES($1,$2,$3,$4,$5,1,'end',$6,'legacy',$7,'保留v1既有结束状态；不代表本次重新执行。','legacy-v1',$8,$9,$10)`,
      [
        id,
        run.project_id,
        run.id,
        run.created_by,
        run.scope_digest,
        semanticDigest(payload),
        ended,
        run.state,
        JSON.stringify(payload),
        JSON.stringify({ factId: id, ...payload, importedLegacy: true }),
      ],
    );
    await tx.query(
      'UPDATE app.ui_delivery_heads SET execution_version=1,last_execution_fact_id=$2,last_end_fact_id=$2 WHERE run_id=$1',
      [run.id, id],
    );
  }
  return (await deliveryHead(tx, run.id, true))!;
}
export async function executionFact(
  tx: SqlExecutor,
  runId: string,
  id: string,
): Promise<ExecutionFactRow | null> {
  return (
    (
      await tx.query<ExecutionFactRow>(
        'SELECT * FROM app.ui_execution_facts WHERE run_id=$1 AND id=$2',
        [runId, id],
      )
    ).rows[0] ?? null
  );
}
export async function coverageSnapshot(tx: SqlExecutor, run: RunRow) {
  const scope = executionScopeSchema.parse(run.scope_snapshot);
  const facts = (
    await tx.query<{
      run_item_id: string;
      result_id: string;
      revision_id: string;
      semantic_digest: string;
      original_outcome: string;
    }>(
      `SELECT r.run_item_id,r.id result_id,v.id revision_id,v.semantic_digest,v.content->>'originalOutcome' original_outcome
    FROM app.results r JOIN app.result_revisions v ON v.result_id=r.id AND v.revision_no=1 WHERE r.run_id=$1 ORDER BY r.run_item_id`,
      [run.id],
    )
  ).rows;
  const byItem = new Map(facts.map((x) => [x.run_item_id, x]));
  const snapshot = scope.items.map((x) => ({
    runItemId: x.runItemId,
    resultId: byItem.get(x.runItemId)?.result_id ?? null,
    revisionId: byItem.get(x.runItemId)?.revision_id ?? null,
    semanticDigest: byItem.get(x.runItemId)?.semantic_digest ?? null,
  }));
  return {
    scope,
    snapshot,
    digest: semanticDigest(snapshot),
    reported: facts.length,
    missing: snapshot
      .filter((x) => x.resultId === null)
      .map((x) => x.runItemId),
  };
}
