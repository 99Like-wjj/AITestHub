import {
  caseSupplementOriginSchema,
  caseSupplementOriginResultSchema,
} from '../../../contracts/src/assets.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { DomainError } from '../errors.js';
import { audit } from '../events.js';
import { getAsset, type AssetRow } from './repository.js';
import type { z } from 'zod';

export async function recordCaseSupplementOrigin(
  tx: SqlExecutor,
  actor: ActorContext,
  created: AssetRow,
  origin: z.infer<typeof caseSupplementOriginSchema>,
) {
  if (created.kind !== 'UI')
    throw new DomainError(
      'VALIDATION_ERROR',
      '只能为 UI 用例关联评审补充来源。',
      400,
    );
  const source = await getAsset(tx, created.project_id, origin.caseId, true);
  const revision = await tx.query(
    'SELECT id FROM app.asset_revisions WHERE project_id=$1 AND asset_id=$2 AND id=$3',
    [created.project_id, origin.caseId, origin.revisionId],
  );
  if (
    source.target_type !== 'case' ||
    source.kind !== 'UI' ||
    source.requirement_version_id !== created.requirement_version_id ||
    !revision.rowCount
  )
    throw new DomainError(
      'VALIDATION_ERROR',
      '补充来源须是同一需求版本中的精确 UI 用例修订。',
      400,
    );

  await tx.query(
    `INSERT INTO app.ui_case_supplement_origins
       (case_id,project_id,requirement_version_id,source_case_id,source_revision_id,origin,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      created.id,
      created.project_id,
      created.requirement_version_id,
      origin.caseId,
      origin.revisionId,
      JSON.stringify(origin),
      actor.userId,
    ],
  );
  await audit(
    tx,
    actor,
    'assets.case-supplement-origin-recorded',
    created.id,
    created.project_id,
    {
      sourceCaseId: origin.caseId,
      sourceRevisionId: origin.revisionId,
    },
  );
}

export async function readCaseSupplementOrigin(
  db: Database,
  actor: ActorContext,
  projectId: string,
  caseId: string,
) {
  return db.transaction(async (tx) => {
    await requireProject(tx, actor, projectId, 'project.read');
    const target = await getAsset(tx, projectId, caseId, true);
    if (target.kind !== 'UI' || target.target_type !== 'case')
      throw new DomainError('NOT_FOUND', '此范围内没有该 UI 用例。', 404);
    const { rows } = await tx.query<{ origin: unknown }>(
      'SELECT origin FROM app.ui_case_supplement_origins WHERE project_id=$1 AND case_id=$2',
      [projectId, caseId],
    );
    return caseSupplementOriginResultSchema.parse({
      origin: rows[0]?.origin ?? null,
    });
  });
}
