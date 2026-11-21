import type { SqlExecutor } from '../../../persistence/src/database.js';
import { DomainError } from '../errors.js';
import { missingFiles } from './evidence.js';

export interface UiDeliveryGate {
  versioned: boolean;
  sealed: boolean;
  missingSources: number;
  hasEnd: boolean;
  currentEnded: boolean;
  pendingDescriptors: number;
}
/** One pure v2 projection shared by old/new readers; null preserves each v1 reader's old behavior. */
export function projectUiDelivery(
  gate: UiDeliveryGate | undefined,
  reported: number,
  total: number,
  missing: number,
): 'receiving' | 'incomplete' | 'complete' | null {
  if (!gate?.versioned) return null;
  if (
    gate.sealed &&
    gate.currentEnded &&
    gate.pendingDescriptors === 0 &&
    reported === total &&
    missing === 0 &&
    gate.missingSources === 0
  )
    return 'complete';
  return reported > 0 || gate.hasEnd ? 'incomplete' : 'receiving';
}
/** Caller already owns the run UPDATE lock; artifact/current-result changes are not execution facts. */
export async function bumpUiDeliveryRunMetadata(
  tx: SqlExecutor,
  runId: string,
): Promise<void> {
  if (!(await uiDeliveryReady(tx))) return;
  const changed = await tx.query(
    'UPDATE app.ui_delivery_heads SET row_version=row_version+1,updated_at=clock_timestamp() WHERE run_id=$1',
    [runId],
  );
  if (changed.rowCount)
    await tx.query(
      'UPDATE app.runs SET row_version=row_version+1 WHERE id=$1',
      [runId],
    );
}
export async function uiDeliveryReady(tx: SqlExecutor): Promise<boolean> {
  return Boolean(
    (
      await tx.query<{ ready: boolean }>(
        "SELECT to_regclass('app.ui_delivery_heads') IS NOT NULL AS ready",
      )
    ).rows[0]?.ready,
  );
}
export async function requireUiDeliveryReady(tx: SqlExecutor): Promise<void> {
  if (!(await uiDeliveryReady(tx)))
    throw new DomainError(
      'DEPENDENCY_UNAVAILABLE',
      'UI累计交付协议尚未迁移，请保留原run和本地载荷。',
      503,
    );
}
/** New v1 writes cannot bypass an already activated v2 execution fact chain. */
export async function uiDeliveryGates(
  tx: SqlExecutor,
  runIds: readonly string[],
): Promise<Map<string, UiDeliveryGate>> {
  const result = new Map<string, UiDeliveryGate>();
  if (!runIds.length || !(await uiDeliveryReady(tx))) return result;
  const rows = await tx.query<{
    run_id: string;
    sealed: boolean;
    missing_sources: number;
    has_end: boolean;
    current_ended: boolean;
    pending_descriptors: number;
  }>(
    `SELECT h.run_id,
    (s.id IS NOT NULL AND s.ledger_version=h.ledger_version AND s.ledger_digest=h.ledger_digest
     AND s.end_fact_id=h.last_end_fact_id AND h.last_execution_fact_id=h.last_end_fact_id) AS sealed,
    h.last_end_fact_id IS NOT NULL AS has_end,
    (h.last_execution_fact_id IS NOT NULL AND h.last_execution_fact_id=h.last_end_fact_id) AS current_ended,
    (SELECT count(*)::integer FROM app.ui_result_descriptors d WHERE d.run_id=h.run_id
      AND NOT EXISTS(SELECT 1 FROM app.ui_delivery_assemblies a WHERE a.descriptor_record_id=d.id)
      AND NOT EXISTS(SELECT 1 FROM app.ui_result_descriptors n WHERE n.supersedes_descriptor_id=d.id)) AS pending_descriptors,
    (SELECT count(DISTINCT b.file_id)::integer FROM app.ui_delivery_batch_sources b JOIN app.file_resources f ON f.id=b.file_id
      WHERE b.run_id=h.run_id AND (f.status<>'verified' OR f.deleted_at IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM app.run_evidence e WHERE e.run_id=h.run_id AND e.file_id=b.file_id)) AS missing_sources
    FROM app.ui_delivery_heads h LEFT JOIN app.ui_delivery_seals s ON s.id=h.latest_seal_id AND s.run_id=h.run_id
    WHERE h.run_id=ANY($1::uuid[])`,
    [[...runIds]],
  );
  for (const row of rows.rows)
    result.set(row.run_id, {
      versioned: true,
      sealed: Boolean(row.sealed),
      missingSources: row.missing_sources,
      hasEnd: row.has_end,
      currentEnded: Boolean(row.current_ended),
      pendingDescriptors: row.pending_descriptors,
    });
  return result;
}
export async function uiDeliveryGate(
  tx: SqlExecutor,
  runId: string,
): Promise<UiDeliveryGate> {
  return (
    (await uiDeliveryGates(tx, [runId])).get(runId) ?? {
      versioned: false,
      sealed: false,
      missingSources: 0,
      hasEnd: false,
      currentEnded: false,
      pendingDescriptors: 0,
    }
  );
}
export async function deliveryMissingFiles(
  tx: SqlExecutor,
  runId: string,
): Promise<string[]> {
  if (!(await uiDeliveryReady(tx))) return missingFiles(tx, runId);
  return (
    await tx.query<{ id: string }>(
      `WITH ids AS(
    SELECT file_id FROM app.run_evidence WHERE run_id=$1 UNION SELECT file_id FROM app.ui_delivery_batch_sources WHERE run_id=$1)
    SELECT f.id FROM ids JOIN app.file_resources f ON f.id=ids.file_id WHERE f.status<>'verified' OR f.deleted_at IS NOT NULL ORDER BY f.id`,
      [runId],
    )
  ).rows.map((x) => x.id);
}
/** Derived link only: no report creation, no raw-byte read, no change to old refs or receipts. */
export async function linkUiDeliverySourcesToReport(
  tx: SqlExecutor,
  actorId: string,
  projectId: string,
  runId: string,
  reportId: string,
): Promise<void> {
  if (!(await uiDeliveryReady(tx))) return;
  await tx.query(
    `INSERT INTO app.resource_references(resource_id,project_id,reference_type,reference_id,created_by)
    SELECT s.file_id,$1,'report',$3,$4 FROM app.ui_delivery_batch_sources s
    JOIN app.file_resources f ON f.id=s.file_id AND f.project_id=s.project_id AND f.run_id=s.run_id
    JOIN app.reports r ON r.id=$3 AND r.project_id=$1 AND r.run_id=$2
    WHERE s.project_id=$1 AND s.run_id=$2 AND f.owner_scope='project' AND f.status='verified' AND f.deleted_at IS NULL
    ON CONFLICT DO NOTHING`,
    [projectId, runId, reportId, actorId],
  );
}
