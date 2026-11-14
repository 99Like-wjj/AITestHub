import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { automaticAuxiliaryIntentSchema } from '../../../contracts/src/automatic-auxiliary.js';
import { auxiliaryResultSchema } from '../../../contracts/src/auxiliary.js';
import { requireProject } from '../access/policy.js';
import { DomainError } from '../errors.js';
import { canonicalJson } from '../operations/service.js';
export const automaticDigest = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
export const automaticNameHash = (title: string) =>
  createHash('sha256').update(title, 'utf8').digest('hex');
export interface AutomaticIntentRow {
  id: string;
  owner_id: string;
  purpose: 'groupAlias' | 'requirementLookup';
  project_id: string;
  requirement_id: string | null;
  conversation_id: string | null;
  parent_task_id: string | null;
  command_key: string;
  request_hash: string | null;
  state: string;
  auxiliary_command_id: string;
  auxiliary_task_id: string | null;
  disclosure_id: string | null;
  scope_digest: string | null;
  source_digest: string | null;
  source_name_hash: string | null;
  model_snapshot: unknown;
  data_scope: 'syntheticPublicOnly' | 'authorizedRelevantTestData' | null;
  accept_command_key: string | null;
  accept_hash: string | null;
  consented_at: Date | null;
  protected_history: boolean;
  error_code: string | null;
  local_matches: unknown;
  created_at: Date;
  updated_at: Date;
}
export async function automaticTableReady(tx: SqlExecutor) {
  return (
    (
      await tx.query<{ ready: boolean }>(
        "SELECT to_regclass('app.automatic_auxiliary_intents') IS NOT NULL ready",
      )
    ).rows[0]?.ready === true
  );
}
export function automaticIntentDto(row: AutomaticIntentRow, title: string) {
  return automaticAuxiliaryIntentSchema.parse({
    id: row.id,
    purpose: row.purpose,
    projectId: row.project_id,
    requirementId: row.requirement_id,
    title,
    state: row.state,
    auxiliaryTaskId: row.auxiliary_task_id,
    scopeDigest: row.scope_digest,
    errorCode: row.error_code,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}
/** Durable receipt application only. Never invokes a model or requeues a task. */
export async function finishAutomaticAuxiliaryTask(
  tx: SqlExecutor,
  taskId: string,
) {
  if (!(await automaticTableReady(tx))) return;
  const task = (
    await tx.query<{
      id: string;
      owner_id: string;
      command_id: string;
      state: string;
      result: unknown;
      source_snapshot: unknown;
      model_snapshot: unknown;
      error_code: string | null;
    }>(
      'SELECT id,owner_id,command_id,state,result,source_snapshot,model_snapshot,error_code FROM app.auxiliary_tasks WHERE id=$1',
      [taskId],
    )
  ).rows[0];
  if (!task) return;
  let intent = (
    await tx.query<AutomaticIntentRow>(
      "SELECT * FROM app.automatic_auxiliary_intents WHERE owner_id=$1 AND auxiliary_command_id=$2 AND consented_at IS NOT NULL AND state IN ('accepting','accepted','unknown')",
      [task.owner_id, task.command_id],
    )
  ).rows[0];
  if (!intent) return;
  if (intent.purpose === 'groupAlias') {
    // Formal title writers lock the requirement before changing the intent; group preference writers lock the group first.
    await tx.query('SELECT id FROM app.requirements WHERE id=$1 FOR SHARE', [
      intent.requirement_id,
    ]);
    await tx.query(
      'SELECT 1 FROM app.ai_requirement_groups WHERE owner_id=$1 AND requirement_id=$2 FOR UPDATE',
      [intent.owner_id, intent.requirement_id],
    );
  }
  intent = (
    await tx.query<AutomaticIntentRow>(
      "SELECT * FROM app.automatic_auxiliary_intents WHERE id=$1 AND consented_at IS NOT NULL AND state IN ('accepting','accepted','unknown') FOR UPDATE",
      [intent.id],
    )
  ).rows[0];
  if (!intent) return;
  if (!['completed', 'failed', 'cancelled', 'unknown'].includes(task.state))
    return;
  let state = task.state,
    errorCode: string | null = task.error_code;
  if (task.state === 'completed' && intent.purpose === 'groupAlias') {
    const result = auxiliaryResultSchema.safeParse(task.result),
      source = z
        .object({
          meta: z.object({
            kind: z.literal('requirementGroup'),
            objectId: z.uuid(),
            projectId: z.uuid(),
          }),
          payload: z.object({ text: z.string() }),
        })
        .safeParse(task.source_snapshot);
    if (
      !result.success ||
      result.data.purpose !== 'alias' ||
      !source.success ||
      source.data.meta.objectId !== intent.requirement_id ||
      source.data.meta.projectId !== intent.project_id ||
      automaticNameHash(source.data.payload.text) !== intent.source_name_hash ||
      canonicalJson(task.model_snapshot) !==
        canonicalJson(intent.model_snapshot)
    ) {
      state = 'failed';
      errorCode = 'AUTOMATIC_SOURCE_MISMATCH';
    } else {
      try {
        await requireProject(
          tx,
          {
            userId: intent.owner_id,
            entrypoint: 'internal-ai',
            requestId: task.id,
          },
          intent.project_id,
          'project.read',
        );
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        state = 'superseded';
        errorCode = 'SOURCE_UNAVAILABLE';
      }
      const group = (
        await tx.query<{ title: string }>(
          `SELECT r.title FROM app.ai_requirement_groups g JOIN app.requirements r ON r.id=g.requirement_id AND r.project_id=g.project_id JOIN app.requirement_participants p ON p.requirement_id=g.requirement_id AND p.user_id=g.owner_id AND p.active WHERE g.owner_id=$1 AND g.requirement_id=$2 AND NOT g.hidden AND g.archived_at IS NULL FOR UPDATE OF g FOR SHARE OF r,p`,
          [intent.owner_id, intent.requirement_id],
        )
      ).rows[0];
      if (
        state === 'completed' &&
        (!group || automaticNameHash(group.title) !== intent.source_name_hash)
      ) {
        state = 'superseded';
        errorCode = 'SOURCE_CHANGED';
      }
      if (state === 'completed')
        await tx.query(
          `UPDATE app.ai_requirement_groups SET generated_name=$3,generated_name_source_hash=$4,generated_name_task_id=$5,row_version=row_version+1 WHERE owner_id=$1 AND requirement_id=$2`,
          [
            intent.owner_id,
            intent.requirement_id,
            result.data.suggestedName,
            intent.source_name_hash,
            task.id,
          ],
        );
    }
  }
  await tx.query(
    'UPDATE app.automatic_auxiliary_intents SET auxiliary_task_id=$2,state=$3,error_code=COALESCE($4,error_code),protected_history=true,updated_at=clock_timestamp() WHERE id=$1',
    [intent.id, task.id, state, errorCode],
  );
  tx.noteSecurityControlChange?.({
    action: 'automatic-auxiliary.receipt',
    objectId: intent.id,
    projectId: intent.project_id,
  });
}

export async function redactAutomaticAuxiliaryConversation(
  tx: SqlExecutor,
  ownerId: string,
  conversationId: string,
) {
  if (!(await automaticTableReady(tx))) return;
  await tx.query(
    `UPDATE app.ai_requirement_groups SET generated_name=NULL,generated_name_task_id=NULL,generated_name_source_hash=NULL,row_version=row_version+1 WHERE owner_id=$1 AND generated_name_task_id IN (SELECT auxiliary_task_id FROM app.automatic_auxiliary_intents WHERE owner_id=$1 AND conversation_id=$2 UNION SELECT id FROM app.auxiliary_tasks WHERE conversation_id=$2 AND owner_id=$1)`,
    [ownerId, conversationId],
  );
  await tx.query(
    `UPDATE app.automatic_auxiliary_intents SET state='cancelled',request_hash=NULL,scope_digest=NULL,source_digest=NULL,source_name_hash=NULL,model_snapshot=NULL,accept_hash=NULL,disclosure_id=NULL,error_code='PRIVATE_SOURCE_DELETED',updated_at=clock_timestamp() WHERE owner_id=$1 AND (conversation_id=$2 OR auxiliary_task_id IN (SELECT id FROM app.auxiliary_tasks WHERE conversation_id=$2 AND owner_id=$1))`,
    [ownerId, conversationId],
  );
}
