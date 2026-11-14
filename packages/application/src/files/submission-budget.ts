import type { SqlExecutor } from '../../../persistence/src/database.js';
import { DomainError } from '../errors.js';
import {
  fileResourcePolicies,
  assertFilePolicyCounts,
  registeredFilePolicyIntent,
  type RegisteredFilePolicyIdentity,
  type FilePolicySnapshot,
} from './resource-policy.js';

export const defaultSubmissionFileBudgetBytes = 1_073_741_824n;

/**
 * Call after the submission's current project authorization, in the same transaction.
 * Registration metadata is authoritative even while bytes are pending. Identity is the
 * resource UUID, never its hash; this budget does not accumulate across submissions.
 * The optional policy is a trusted accepted/active snapshot, never client/model input.
 * callerCounted means the caller already checked evidence/material identities;
 * a source JSON carrier joins the byte set without taking another evidence slot.
 */
export async function assertSubmissionFileBudget(
  tx: SqlExecutor,
  projectId: string,
  resourceIds: readonly string[],
  policy?: FilePolicySnapshot,
  scope: 'batch' | 'case' | 'callerCounted' = 'batch',
) {
  const selected = policy ?? (await fileResourcePolicies.read(tx));
  const maximumBytes = BigInt(selected.policy.files.maxSubmissionBytes);
  const ids = [...new Set(resourceIds.map((id) => id.toLowerCase()))].sort();
  const files = ids.length
    ? (
        await tx.query<RegisteredFilePolicyIdentity>(
          `SELECT id,owner_scope,owner_user_id,project_id,run_id,local_file_id,original_name,media_type,declared_bytes::text,declared_sha256 FROM app.file_resources
           WHERE id=ANY($1::uuid[]) AND project_id=$2 AND owner_scope='project'
             AND deleted_at IS NULL ORDER BY id FOR SHARE`,
          [ids, projectId],
        )
      ).rows
    : [];
  // Never reveal a foreign/private/deleted resource's size or partial aggregate.
  if (files.length !== ids.length)
    throw new DomainError('NOT_FOUND', '提交文件不在本项目的可用登记中。', 404);
  if (scope === 'batch') assertFilePolicyCounts(selected, ids.length);
  else if (scope === 'case' && ids.length > 1000)
    throw new DomainError(
      'FILE_TOO_LARGE',
      '单结果引用超过1000项结构范围。',
      413,
    );
  for (const file of files) {
    const original = await fileResourcePolicies.read(
      tx,
      registeredFilePolicyIntent(file),
    );
    if (
      BigInt(file.declared_bytes) > BigInt(original.policy.files.maxFileBytes)
    )
      throw new DomainError(
        'FILE_TOO_LARGE',
        '提交文件超过该资源原受理单文件策略。',
        413,
      );
  }
  const bytes = files.reduce(
    (total, file) => total + BigInt(file.declared_bytes),
    0n,
  );
  if (bytes > maximumBytes)
    throw new DomainError(
      'FILE_TOO_LARGE',
      '本次提交的唯一文件总大小超过受理资源策略限制。',
      413,
      {
        limitBytes: maximumBytes.toString(),
        declaredBytes: bytes.toString(),
        uniqueFiles: ids.length,
      },
    );
  return { declaredBytes: bytes.toString(), uniqueFiles: ids.length };
}
