import { randomUUID } from 'node:crypto';
import { resultItemSchema } from '../../../contracts/src/domain.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { semanticDigest } from '../ui-executions/service.js';
import { evidenceIdsForReferences, linkEvidence } from './evidence.js';
import { ensureFailedProblemInTransaction } from '../issues/problems.js';
import { assertResultEvidenceScope } from './result-scope.js';

export interface DeliveryHead {
  run_id: string;
  project_id: string;
  owner_id: string;
  scope_digest: string;
  mode: 'nativeV2' | 'legacyDeliveryOnly' | 'legacyResumed';
  legacy_state: string | null;
  legacy_ended_at: Date | null;
  ledger_version: string;
  ledger_digest: string;
  execution_version: string;
  row_version: number;
  last_execution_fact_id: string | null;
  last_end_fact_id: string | null;
  last_resume_fact_id: string | null;
  latest_seal_id: string | null;
}
export interface ExecutionFactRow {
  id: string;
  project_id: string;
  run_id: string;
  owner_id: string;
  scope_digest: string;
  sequence: string;
  fact_kind: 'end' | 'resume';
  command_id: string | null;
  semantic_digest: string;
  previous_fact_id: string | null;
  end_fact_id: string | null;
  resume_fact_id: string | null;
  end_kind: 'normal' | 'terminated' | 'interrupted' | 'legacy' | null;
  ended_at: Date | null;
  resumed_at: Date | null;
  reason: string;
  provenance: 'local-ai' | 'protocol-synthetic' | 'unknown' | 'legacy-v1';
  legacy_state: string | null;
  payload: unknown;
  receipt: unknown;
  received_at: Date;
}
export interface DescriptorRow {
  id: string;
  project_id: string;
  run_id: string;
  owner_id: string;
  descriptor_id: string;
  batch_record_id: string;
  run_item_id: string;
  local_result_id: string;
  core: unknown;
  refs_count: number;
  segment_count: number;
  full_refs_digest: string;
  item_digest: string;
  semantic_digest: string;
}
export interface OriginalFactReceipt {
  status: 'accepted' | 'skipped' | 'conflict';
  resultId: string | null;
  revisionId: string | null;
  code: string | null;
  message: string | null;
}

/** Append the first original only. A later replay must never undo a subsequent amendment. */
export async function appendUiOriginal(
  tx: SqlExecutor,
  actor: ActorContext,
  projectId: string,
  runId: string,
  raw: unknown,
): Promise<OriginalFactReceipt> {
  const item = resultItemSchema.parse(raw),
    itemDigest = semanticDigest(item);
  const prior = (
    await tx.query<{
      id: string;
      revision_id: string;
      semantic_digest: string;
    }>(
      `SELECT r.id,v.id revision_id,v.semantic_digest
    FROM app.results r JOIN app.result_revisions v ON v.result_id=r.id AND v.revision_no=1
    WHERE r.project_id=$1 AND r.run_id=$2 AND r.run_item_id=$3 FOR UPDATE OF r`,
      [projectId, runId, item.runItemId],
    )
  ).rows[0];
  if (prior)
    return prior.semantic_digest === itemDigest
      ? {
          status: 'skipped',
          resultId: prior.id,
          revisionId: prior.revision_id,
          code: null,
          message: '相同原始事实已接收，未改变后续更正。',
        }
      : {
          status: 'conflict',
          resultId: prior.id,
          revisionId: prior.revision_id,
          code: 'EXPLICIT_AMENDMENT_REQUIRED',
          message: '已有原始结果；更正须使用确切修订与原因。',
        };
  if (
    (
      await tx.query(
        'SELECT 1 FROM app.results WHERE run_id=$1 AND local_result_id=$2',
        [runId, item.localResultId],
      )
    ).rowCount
  )
    return {
      status: 'conflict',
      resultId: null,
      revisionId: null,
      code: 'LOCAL_RESULT_ID_CONFLICT',
      message: '此本地结果标识已经属于另一固定项。',
    };
  await assertResultEvidenceScope(tx, projectId, runId, item);
  const evidenceIds = await evidenceIdsForReferences(
      tx,
      runId,
      item.evidenceRefs,
    ),
    resultId = randomUUID(),
    revisionId = randomUUID();
  await tx.query(
    'INSERT INTO app.results(id,project_id,run_id,run_item_id,local_result_id,current_revision_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      resultId,
      projectId,
      runId,
      item.runItemId,
      item.localResultId,
      revisionId,
      actor.userId,
    ],
  );
  await tx.query(
    'INSERT INTO app.result_revisions(id,result_id,revision_no,content,semantic_digest,actor_id) VALUES($1,$2,1,$3,$4,$5)',
    [revisionId, resultId, JSON.stringify(item), itemDigest, actor.userId],
  );
  await linkEvidence(tx, actor, resultId, evidenceIds, 'original');
  await ensureFailedProblemInTransaction(
    tx,
    actor,
    projectId,
    resultId,
    revisionId,
  );
  await tx.query(
    'UPDATE app.run_items SET state=$2,outcome=$3,side_effect_certainty=$4,started_at=$5,ended_at=$6 WHERE id=$1',
    [
      item.runItemId,
      item.originalOutcome === 'notExecuted' ? 'notExecuted' : 'completed',
      item.originalOutcome,
      item.sideEffectCertainty,
      item.startedAt ?? null,
      item.endedAt ?? null,
    ],
  );
  return {
    status: 'accepted',
    resultId,
    revisionId,
    code: null,
    message: null,
  };
}
