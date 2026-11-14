import { createHash } from 'node:crypto';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import type { RequirementMaterialInput } from '../../../contracts/src/requirements.js';
import { DomainError } from '../errors.js';

/** Whole verified file sets only: a matching URL cannot prove equal remote bytes. */
export async function matchRequirementMaterials(
  tx: SqlExecutor,
  projectId: string,
  materials: RequirementMaterialInput[],
) {
  if (materials.some((material) => material.sourceLink))
    return { complete: false, matches: [] };
  const fileIds = [
    ...new Set(
      materials.flatMap((material) =>
        material.fileResourceId ? [material.fileResourceId] : [],
      ),
    ),
  ];
  const files = (
    await tx.query<{ id: string; declared_sha256: string }>(
      "SELECT id,declared_sha256 FROM app.file_resources WHERE id=ANY($1::uuid[]) AND owner_scope='project' AND project_id=$2 AND status='verified' AND deleted_at IS NULL FOR SHARE",
      [fileIds, projectId],
    )
  ).rows;
  if (
    files.length !== fileIds.length ||
    materials.some((material) => !material.fileResourceId)
  )
    throw new DomainError(
      'FILE_NOT_READY',
      '完整材料查找仅接收本项目已验证文件，未完成上传或越权资料不能冒充已核对。',
      422,
    );
  const hashes = new Map(files.map((file) => [file.id, file.declared_sha256]));
  const materialSetDigest = createHash('sha256')
    .update(
      JSON.stringify(
        [...materials]
          .sort((a, b) => a.order - b.order)
          .map((material) => ({
            purpose: material.purpose,
            sha256: hashes.get(material.fileResourceId!),
            order: material.order,
          })),
      ),
    )
    .digest('hex');
  const matches = (
    await tx.query<{
      requirement_id: string;
      id: string;
      version_no: number;
      latest_version_no: number;
    }>(
      `SELECT v.requirement_id,v.id,v.version_no,(SELECT max(n.version_no) FROM app.requirement_versions n WHERE n.project_id=v.project_id AND n.requirement_id=v.requirement_id) latest_version_no
     FROM app.requirement_versions v WHERE v.project_id=$1 AND v.material_set_digest=$2 ORDER BY v.requirement_id,v.version_no DESC LIMIT 201`,
      [projectId, materialSetDigest],
    )
  ).rows;
  return {
    complete: matches.length <= 200,
    matches: matches.slice(0, 200).map((item) => ({
      requirementId: item.requirement_id,
      requirementVersionId: item.id,
      versionNo: item.version_no,
      latestVersionNo: item.latest_version_no,
    })),
  };
}
