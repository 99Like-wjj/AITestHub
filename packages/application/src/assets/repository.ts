import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import {
  assetContentSchema,
  assetSchema,
  type Asset,
  type AssetTargetType,
} from '../../../contracts/src/assets.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { DomainError } from '../errors.js';
import { canonicalJson } from '../operations/service.js';

export interface AssetRow extends QueryResultRow {
  id: string;
  project_id: string;
  kind: 'UI' | 'API';
  requirement_version_id: string;
  set_id: string;
  target_type: AssetTargetType;
  parent_id: string | null;
  current_revision_id: string;
  revision_no: number;
  row_version: number;
  review_state: 'pending' | 'needsOptimization' | 'aiOptimized' | 'approved';
  removed_at: Date | null;
  content: unknown;
}
export interface OpinionRow extends QueryResultRow {
  id: string;
  asset_id: string;
  revision_id: string;
  body: string;
  created_by: string;
  created_at: Date;
  removed_at: Date | null;
  row_version: number;
}
export const assetSelect =
  'SELECT a.*,r.content FROM app.test_assets a JOIN app.asset_revisions r ON r.id=a.current_revision_id';
export function assetDto(row: AssetRow): Asset {
  const content = assetContentSchema.parse(row.content);
  return assetSchema.parse({
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    requirementVersionId: row.requirement_version_id,
    setId: row.set_id,
    targetType: row.target_type,
    parentId: row.parent_id,
    title: content.title,
    revisionId: row.current_revision_id,
    revisionNo: row.revision_no,
    rowVersion: row.row_version,
    reviewState: row.review_state,
    removedAt: row.removed_at?.toISOString() ?? null,
    content,
  });
}
export async function getAsset(
  transaction: SqlExecutor,
  projectId: string,
  id: string,
  includeRemoved = false,
): Promise<AssetRow> {
  const row = (
    await transaction.query<AssetRow>(
      `${assetSelect} WHERE a.project_id=$1 AND a.id=$2`,
      [projectId, id],
    )
  ).rows[0];
  if (!row || (!includeRemoved && row.removed_at))
    throw new DomainError('NOT_FOUND', '此范围内没有该测试资产。', 404);
  return row;
}
export async function lockSet(
  transaction: SqlExecutor,
  projectId: string,
  id: string,
) {
  const row = await transaction.query(
    "SELECT id FROM app.test_assets WHERE project_id=$1 AND id=$2 AND target_type='set' AND removed_at IS NULL FOR UPDATE",
    [projectId, id],
  );
  if (!row.rowCount)
    throw new DomainError('NOT_FOUND', '此范围内没有该资产归属。', 404);
}
export async function ancestors(
  transaction: SqlExecutor,
  asset: AssetRow,
): Promise<AssetRow[]> {
  const context = [asset];
  let current = asset;
  while (current.parent_id) {
    current = await getAsset(transaction, asset.project_id, current.parent_id);
    context.push(current);
  }
  return context;
}
export async function currentOpinions(
  transaction: SqlExecutor,
  asset: AssetRow,
): Promise<OpinionRow[]> {
  return (
    await transaction.query<OpinionRow>(
      'SELECT * FROM app.review_opinions WHERE asset_id=$1 AND revision_id=$2 AND removed_at IS NULL ORDER BY created_at,id',
      [asset.id, asset.current_revision_id],
    )
  ).rows;
}
export async function invalidateAncestors(
  transaction: SqlExecutor,
  asset: AssetRow,
): Promise<void> {
  for (const parent of (await ancestors(transaction, asset)).slice(1)) {
    const hasOpinions = (await currentOpinions(transaction, parent)).length > 0;
    await transaction.query(
      'UPDATE app.test_assets SET review_state=$2,row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1',
      [parent.id, hasOpinions ? 'needsOptimization' : 'pending'],
    );
  }
}
export async function invalidateDescendants(
  transaction: SqlExecutor,
  asset: AssetRow,
): Promise<void> {
  if (asset.target_type === 'case') return;
  await transaction.query(
    `UPDATE app.test_assets a SET review_state=CASE WHEN EXISTS(
    SELECT 1 FROM app.review_opinions o WHERE o.asset_id=a.id AND o.revision_id=a.current_revision_id AND o.removed_at IS NULL)
    THEN 'needsOptimization' ELSE 'pending' END,row_version=row_version+1,updated_at=clock_timestamp()
    WHERE a.removed_at IS NULL AND a.id<>$1 AND (($2='set' AND a.set_id=$1) OR ($2='scenario' AND a.parent_id=$1))`,
    [asset.id, asset.target_type],
  );
}
export async function reviewContext(transaction: SqlExecutor, asset: AssetRow) {
  const chain = await ancestors(transaction, asset);
  const opinions = [];
  for (const target of chain)
    for (const opinion of await currentOpinions(transaction, target)) {
      opinions.push({
        id: opinion.id,
        assetId: opinion.asset_id,
        revisionId: opinion.revision_id,
        body: opinion.body,
        rowVersion: opinion.row_version,
      });
    }
  const context = {
    assets: chain.map((row) => ({
      id: row.id,
      revisionId: row.current_revision_id,
      rowVersion: row.row_version,
      reviewState: row.review_state,
    })),
    opinions,
  };
  const digest = createHash('sha256')
    .update(canonicalJson(context))
    .digest('hex');
  const reasons = [];
  for (const parent of chain.slice(1))
    if (
      parent.review_state !== 'approved' &&
      (await currentOpinions(transaction, parent)).length
    )
      reasons.push(
        `上层${parent.target_type === 'set' ? '测试集' : '场景'}仍有待人工处理意见。`,
      );
  return { chain, context, digest, reasons };
}
