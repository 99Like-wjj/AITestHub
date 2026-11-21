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
  if (existing?.mode !== 'nativeV2')
    throw new DomainError(
      'UNSUPPORTED_OPERATION',
      '此历史执行仅供查阅和原回执核对；新执行须使用当前 UI 交付。',
      410,
    );
  return existing;
}

export async function initializeNativeUiDelivery(
  tx: SqlExecutor,
  runId: string,
  projectId: string,
  ownerId: string,
  scopeDigest: string,
) {
  await requireUiDeliveryReady(tx);
  const initialDigest = semanticDigest({
    schemaVersion: 'ath.ui-delivery-ledger.v2',
    runId,
    snapshotDigest: scopeDigest,
  });
  await tx.query(
    `INSERT INTO app.ui_delivery_heads(run_id,project_id,owner_id,scope_digest,mode,ledger_digest)
    VALUES($1,$2,$3,$4,'nativeV2',$5)`,
    [runId, projectId, ownerId, scopeDigest, initialDigest],
  );
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
