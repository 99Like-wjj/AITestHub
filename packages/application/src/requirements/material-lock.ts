import type { RequirementAssetBasis } from '../../../contracts/src/domain.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { DomainError } from '../errors.js';

type VersionHead = { id: string; version_no: number };
type ScopeInput = {
  requirementId?: string | undefined;
  basisVersionId?: string | undefined;
  allowArchived?: boolean | undefined;
};

export async function currentRequirementMaterialHead(
  tx: SqlExecutor,
  projectId: string,
  requirementId: string,
): Promise<VersionHead> {
  const head = (
    await tx.query<VersionHead>(
      'SELECT id,version_no FROM app.requirement_versions WHERE project_id=$1 AND requirement_id=$2 ORDER BY version_no DESC LIMIT 1',
      [projectId, requirementId],
    )
  ).rows[0];
  if (!head) throw new DomainError('NOT_FOUND', '此需求没有可用资料。', 404);
  return head;
}

/** Keeps the accepted original basis and acquires the current formal lock in the asset transaction. */
export async function lockRequirementForTestAsset(
  tx: SqlExecutor,
  projectId: string,
  actorId: string,
  scope: ScopeInput,
): Promise<RequirementAssetBasis> {
  if (!scope.requirementId && !scope.basisVersionId)
    throw new DomainError('VALIDATION_ERROR', '请选择用例所属需求。', 400);
  const requirement = (
    await tx.query<{
      id: string;
      material_lock_version_id: string | null;
      archived_at: Date | null;
    }>(
      `SELECT r.id,r.material_lock_version_id,r.archived_at
       FROM app.requirements r
       WHERE r.project_id=$1 AND ($2::uuid IS NULL OR r.id=$2)
       AND ($3::uuid IS NULL OR EXISTS(
         SELECT 1 FROM app.requirement_versions v
         WHERE v.project_id=r.project_id AND v.requirement_id=r.id AND v.id=$3
       ))
       FOR UPDATE OF r`,
      [projectId, scope.requirementId ?? null, scope.basisVersionId ?? null],
    )
  ).rows[0];
  if (!requirement)
    throw new DomainError('NOT_FOUND', '资料依据不属于所选项目需求。', 404);
  if (requirement.archived_at && !scope.allowArchived)
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '已归档需求不能保存关联测试资产。',
      422,
    );
  // Resolve the current head in a new statement after waiting for the requirement row.
  const locked = requirement.material_lock_version_id
    ? await materialVersion(tx, projectId, requirement.material_lock_version_id)
    : await currentRequirementMaterialHead(tx, projectId, requirement.id);
  const basis =
    scope.basisVersionId && scope.basisVersionId !== locked.id
      ? await materialVersion(tx, projectId, scope.basisVersionId)
      : locked;
  if (!requirement.material_lock_version_id)
    await tx.query(
      `UPDATE app.requirements
       SET material_lock_version_id=$3,material_locked_at=clock_timestamp(),material_locked_by=$4
       WHERE project_id=$1 AND id=$2`,
      [projectId, requirement.id, locked.id, actorId],
    );
  return {
    requirementId: requirement.id,
    basisVersionId: basis.id,
    basisVersionNo: basis.version_no,
    lockedVersionId: locked.id,
    lockedVersionNo: locked.version_no,
    warning:
      basis.id === locked.id ? null : 'REQUIREMENT_BASIS_DIFFERS_FROM_LOCKED',
  };
}

async function materialVersion(
  tx: SqlExecutor,
  projectId: string,
  versionId: string,
): Promise<VersionHead> {
  const found = (
    await tx.query<VersionHead>(
      'SELECT id,version_no FROM app.requirement_versions WHERE project_id=$1 AND id=$2',
      [projectId, versionId],
    )
  ).rows[0];
  if (!found) throw new DomainError('NOT_FOUND', '没有此需求资料修订。', 404);
  return found;
}

export async function requirementOwnerOfVersion(
  tx: SqlExecutor,
  projectId: string,
  versionId: string,
): Promise<string> {
  const version = (
    await tx.query<{ requirement_id: string }>(
      'SELECT requirement_id FROM app.requirement_versions WHERE project_id=$1 AND id=$2',
      [projectId, versionId],
    )
  ).rows[0];
  if (!version)
    throw new DomainError('NOT_FOUND', '此项目没有该需求资料修订。', 404);
  return version.requirement_id;
}

export const requirementBasisProjection = `CASE WHEN locked_material.id IS NOT NULL THEN
  jsonb_build_object(
    'requirementId',basis_material.requirement_id,
    'basisVersionId',basis_material.id,'basisVersionNo',basis_material.version_no,
    'lockedVersionId',locked_material.id,'lockedVersionNo',locked_material.version_no,
    'warning',CASE WHEN basis_material.id<>locked_material.id THEN 'REQUIREMENT_BASIS_DIFFERS_FROM_LOCKED' END
  ) END AS requirement_basis`;

// The expressions are fixed SQL fragments of the callers' asset queries.
export function requirementBasisJoins(
  project: string,
  version: string,
): string {
  return `LEFT JOIN app.requirement_versions basis_material ON basis_material.project_id=${project} AND basis_material.id=${version}
    LEFT JOIN app.requirements basis_requirement ON basis_requirement.project_id=basis_material.project_id AND basis_requirement.id=basis_material.requirement_id
    LEFT JOIN app.requirement_versions locked_material ON locked_material.project_id=basis_requirement.project_id AND locked_material.id=basis_requirement.material_lock_version_id`;
}
