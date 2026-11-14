import type { SqlExecutor } from '../../../persistence/src/database.js';
import { DomainError } from '../errors.js';

export interface UiDeliveryFileArtifacts {
  /** All associated UI runs, including legacy runs whose head may be activated concurrently. */
  readonly runIds: readonly string[];
}
async function relatedRuns(tx: SqlExecutor, fileId: string): Promise<string[]> {
  const rows = await tx.query<{ run_id: string }>(
    `/* ui-delivery-file-associations */
     SELECT r.id run_id FROM (
       SELECT run_id FROM app.run_evidence WHERE file_id=$1
       UNION SELECT run_id FROM app.ui_delivery_batch_sources WHERE file_id=$1
     ) related JOIN app.runs r ON r.id=related.run_id
     WHERE r.kind='UI' ORDER BY r.id`,
    [fileId],
  );
  return rows.rows.map((row) => row.run_id);
}

/**
 * Caller must pre-authorize the upload, or hold a previously authorized upload attempt
 * for trusted failure cleanup. Lock order matches receiveBatch/source linking:
 * all related runs (UUID order), then file. Never call during S3/network work.
 */
export async function lockUiDeliveryFileArtifacts(
  tx: SqlExecutor,
  fileId: string,
): Promise<UiDeliveryFileArtifacts> {
  const schema = (
    await tx.query<{ heads: boolean; sources: boolean; evidence: boolean }>(
      `SELECT to_regclass('app.ui_delivery_heads') IS NOT NULL heads,
      to_regclass('app.ui_delivery_batch_sources') IS NOT NULL sources,
      to_regclass('app.run_evidence') IS NOT NULL evidence`,
    )
  ).rows[0];
  if (!schema?.heads && !schema?.sources) return { runIds: [] };
  if (!schema?.heads || !schema.sources || !schema.evidence)
    throw new DomainError(
      'DEPENDENCY_UNAVAILABLE',
      '累计交付元数据结构暂不可用，文件状态未更新。',
      503,
    );
  const before = await relatedRuns(tx, fileId);
  if (before.length) {
    const locked = await tx.query<{ id: string }>(
      `/* ui-delivery-file-run-locks */ SELECT r.id FROM app.runs r
       WHERE r.id=ANY($1::uuid[]) ORDER BY r.id FOR UPDATE OF r`,
      [before],
    );
    if (locked.rows.length !== before.length)
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '文件交付关联已变化，请核对当前状态；本次未更新文件。',
        409,
      );
  }
  await tx.query(
    '/* ui-delivery-file-resource-lock */ SELECT id FROM app.file_resources WHERE id=$1 FOR UPDATE',
    [fileId],
  );
  const after = await relatedRuns(tx, fileId);
  if (
    before.length !== after.length ||
    before.some((id, index) => id !== after[index])
  )
    throw new DomainError(
      'BUSINESS_CONFLICT',
      '文件交付关联已变化，请核对当前状态后显式完整重传；本次未更新文件。',
      409,
    );
  return { runIds: before };
}

/** Only after an actual File.status transition, in the same run→file transaction. */
export async function bumpUiDeliveryFileArtifacts(
  tx: SqlExecutor,
  locked: UiDeliveryFileArtifacts,
): Promise<void> {
  if (!locked.runIds.length) return;
  // Potential legacy runs are locked to serialize first v2 activation. They must
  // not acquire a new v1 watermark merely because their old file changes.
  const active = (
    await tx.query<{ run_id: string }>(
      'SELECT run_id FROM app.ui_delivery_heads WHERE run_id=ANY($1::uuid[]) ORDER BY run_id',
      [locked.runIds],
    )
  ).rows.map((row) => row.run_id);
  if (!active.length) return;
  const runs = await tx.query(
    'UPDATE app.runs SET row_version=row_version+1 WHERE id=ANY($1::uuid[])',
    [active],
  );
  const heads = await tx.query(
    'UPDATE app.ui_delivery_heads SET row_version=row_version+1,updated_at=clock_timestamp() WHERE run_id=ANY($1::uuid[])',
    [active],
  );
  if (runs.rowCount !== active.length || heads.rowCount !== active.length)
    throw new DomainError(
      'BUSINESS_CONFLICT',
      '文件交付水位已变化，原状态事务未提交。',
      409,
    );
}
