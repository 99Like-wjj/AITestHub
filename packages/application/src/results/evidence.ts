import { z } from 'zod';
import { evidenceManifestItemSchema } from '../../../contracts/src/domain.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { canonicalJson } from '../operations/service.js';
import { DomainError } from '../errors.js';

export type EvidenceManifest = z.infer<typeof evidenceManifestItemSchema>[];
export async function registerEvidence(
  tx: SqlExecutor,
  actor: ActorContext,
  projectId: string,
  runId: string,
  manifest: EvidenceManifest,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const item of manifest) {
    const file = (
      await tx.query<{
        id: string;
        declared_sha256: string;
        declared_bytes: string;
        run_id: string | null;
      }>(
        `SELECT id,declared_sha256,declared_bytes,run_id FROM app.file_resources WHERE id=$1 AND project_id=$2
       AND owner_scope='project' AND deleted_at IS NULL FOR SHARE`,
        [item.fileId, projectId],
      )
    ).rows[0];
    if (!file)
      throw new DomainError(
        'NOT_FOUND',
        '清单中的证据文件尚未在本项目登记。',
        404,
      );
    if (file.run_id !== null && file.run_id !== runId)
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '此证据已固定属于另一执行。',
        409,
      );
    if (
      file.declared_sha256 !== item.sha256 ||
      file.declared_bytes !== item.bytes
    ) {
      throw new DomainError(
        'FILE_HASH_MISMATCH',
        '证据清单与文件登记的字节数或摘要不一致。',
        409,
      );
    }
    const prior = (
      await tx.query<{ id: string; manifest: unknown }>(
        'SELECT id,manifest FROM app.run_evidence WHERE run_id=$1 AND local_evidence_id=$2',
        [runId, item.localEvidenceId],
      )
    ).rows[0];
    if (prior) {
      if (canonicalJson(prior.manifest) !== canonicalJson(item))
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          '同一执行的本地证据标识已用于不同文件或元数据。',
          409,
        );
      ids.set(item.localEvidenceId, prior.id);
      continue;
    }
    const evidence = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.run_evidence(run_id,project_id,local_evidence_id,file_id,manifest,actor_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
        [
          runId,
          projectId,
          item.localEvidenceId,
          item.fileId,
          JSON.stringify(item),
          actor.userId,
        ],
      )
    ).rows[0];
    if (!evidence) throw new Error('Evidence insert returned no row');
    await tx.query(
      `INSERT INTO app.resource_references(resource_id,project_id,reference_type,reference_id,created_by)
       VALUES($1,$2,'evidence',$3,$4) ON CONFLICT DO NOTHING`,
      [item.fileId, projectId, evidence.id, actor.userId],
    );
    ids.set(item.localEvidenceId, evidence.id);
  }
  return ids;
}

export async function evidenceIdsForReferences(
  tx: SqlExecutor,
  runId: string,
  references: string[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const reference of new Set(references)) {
    const row = (
      await tx.query<{ id: string }>(
        'SELECT id FROM app.run_evidence WHERE run_id=$1 AND local_evidence_id=$2',
        [runId, reference],
      )
    ).rows[0];
    if (!row)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '结果引用了本执行尚未登记的证据标识。',
        422,
      );
    ids.push(row.id);
  }
  return ids;
}

export async function linkEvidence(
  tx: SqlExecutor,
  actor: ActorContext,
  resultId: string,
  ids: string[],
  source: 'original' | 'manualAddition',
): Promise<void> {
  for (const id of ids)
    await tx.query(
      'INSERT INTO app.result_evidence_links(result_id,evidence_id,source,created_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [resultId, id, source, actor.userId],
    );
}

export async function missingFiles(
  tx: SqlExecutor,
  runId: string,
): Promise<string[]> {
  return (
    await tx.query<{ file_id: string }>(
      `SELECT DISTINCT e.file_id FROM app.run_evidence e JOIN app.file_resources f ON f.id=e.file_id
     WHERE e.run_id=$1 AND (f.status<>'verified' OR f.deleted_at IS NOT NULL) ORDER BY e.file_id`,
      [runId],
    )
  ).rows.map((row) => row.file_id);
}
