import { createHash } from 'node:crypto';
import {
  prepareRequirementVersionResourceInputSchema as prepareRequirementVersionInputSchema,
  requirementVersionPreparationSchema,
} from '../../../contracts/src/preparation.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { Database } from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { DomainError, stale } from '../errors.js';
import { canonicalJson } from '../operations/service.js';
import { assertSafeResultContent } from '../results/safety.js';
import { assertSubmissionFileBudget } from '../files/submission-budget.js';
import {
  fileResourcePolicies,
  fileIntentDigest,
  assertFilePolicyCounts,
  type FileResourcePolicies,
} from '../files/resource-policy.js';

/** Read-only preflight. Commit independently rechecks current authorization, files and CAS. */
export async function prepareRequirementVersion(
  db: Pick<Database, 'transaction'>,
  actor: ActorContext,
  raw: unknown,
  policies: FileResourcePolicies = fileResourcePolicies,
) {
  const input = prepareRequirementVersionInputSchema.parse(raw),
    projectId =
      input.target === 'new' ? input.input.projectId : input.projectId;
  return db.transaction(async (tx) => {
    await requireProject(tx, actor, projectId, 'requirements.write');
    const namespace =
      input.target === 'new'
        ? ('requirements.create' as const)
        : ('requirements.add-version' as const);
    const payload =
      input.target === 'new'
        ? input.input
        : { projectId, id: input.requirementId, ...input.input };
    const existing = Boolean(
      (
        await tx.query(
          "SELECT 1 FROM app.commands WHERE actor_id=$1 AND operation=$2 AND key=$3 AND status='completed' AND project_id=$4 AND request_hash=$5",
          [
            actor.userId,
            namespace,
            input.input.submissionId,
            projectId,
            fileIntentDigest(payload),
          ],
        )
      ).rowCount,
    );
    const policy = await policies.read(tx, {
      ownerId: actor.userId,
      projectId,
      namespace,
      key: input.input.submissionId,
      payloadDigest: fileIntentDigest(payload),
      existing,
    });
    assertFilePolicyCounts(policy, input.input.materials.length);
    let requirementId: string | null = null,
      baseRowVersion: number | null = null,
      nextVersionNo = 1;
    if (input.target === 'existing') {
      const row = (
        await tx.query<{
          id: string;
          row_version: number;
          next_version: number;
        }>(
          'SELECT r.id,r.row_version,COALESCE((SELECT max(version_no) FROM app.requirement_versions v WHERE v.requirement_id=r.id),0)+1 next_version FROM app.requirements r WHERE r.project_id=$1 AND r.id=$2',
          [projectId, input.requirementId],
        )
      ).rows[0];
      if (!row) throw new DomainError('NOT_FOUND', '此项目内没有该需求。', 404);
      if (row.row_version !== input.input.rowVersion) stale();
      requirementId = row.id;
      baseRowVersion = row.row_version;
      nextVersionNo = row.next_version;
    } else if (
      input.input.businessNumber !== null &&
      (
        await tx.query(
          'SELECT 1 FROM app.requirements WHERE project_id=$1 AND business_number=$2',
          [projectId, input.input.businessNumber],
        )
      ).rowCount
    )
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '此项目已使用该需求编号。',
        409,
      );
    await assertSubmissionFileBudget(
      tx,
      projectId,
      input.input.materials.flatMap((material) =>
        material.fileResourceId ? [material.fileResourceId] : [],
      ),
      policy,
    );
    const digests: unknown[] = [],
      materials: ReturnType<
        typeof requirementVersionPreparationSchema.parse
      >['materials'] = [];
    for (const material of [...input.input.materials].sort(
      (a, b) => a.order - b.order,
    )) {
      if (material.sourceLink) {
        const url = new URL(material.sourceLink);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw new DomainError(
            'VALIDATION_ERROR',
            '来源链接必须为无内嵌凭据的HTTP(S)地址。',
            400,
          );
        assertSafeResultContent(material.sourceLink);
        digests.push({
          purpose: material.purpose,
          sourceLink: material.sourceLink,
          order: material.order,
        });
        materials.push({
          order: material.order,
          fileId: null,
          status: 'link',
          readability: material.readability,
        });
      } else {
        const file = (
          await tx.query<{
            status: 'pending' | 'uploading' | 'verified' | 'failed';
            deleted_at: Date | null;
            declared_sha256: string;
          }>(
            "SELECT status,deleted_at,declared_sha256 FROM app.file_resources WHERE id=$1 AND project_id=$2 AND owner_scope='project'",
            [material.fileResourceId, projectId],
          )
        ).rows[0];
        if (!file)
          throw new DomainError('NOT_FOUND', '材料文件不在本项目登记。', 404);
        digests.push({
          purpose: material.purpose,
          sha256: file.declared_sha256,
          order: material.order,
        });
        materials.push({
          order: material.order,
          fileId: material.fileResourceId!,
          status: file.deleted_at ? 'deleted' : file.status,
          readability: material.readability,
        });
      }
    }
    return requirementVersionPreparationSchema.parse({
      target: input.target,
      projectId,
      requirementId,
      submissionId: input.input.submissionId,
      inputDigest: createHash('sha256')
        .update(canonicalJson(input))
        .digest('hex'),
      baseRowVersion,
      nextVersionNo,
      materialSetDigest: createHash('sha256')
        .update(JSON.stringify(digests))
        .digest('hex'),
      ready: materials.every((material) =>
        ['verified', 'link'].includes(material.status),
      ),
      materials,
      readOnly: true,
    });
  });
}
