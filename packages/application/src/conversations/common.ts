import type { ActorContext } from '../../../contracts/src/identity.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { currentUser, requireProject } from '../access/policy.js';
import { DomainError } from '../errors.js';

export interface ConversationRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  requirement_id: string | null;
  requirement_title?: string | null;
  default_title: string;
  alias: string | null;
  pinned_at: Date | null;
  archived_at: Date | null;
  archive_source: 'manual' | 'group' | null;
  deleted_at: Date | null;
  row_version: number;
  created_at: Date;
  updated_at: Date;
  active_task_status?: 'accepted' | 'running' | 'cancelling' | null;
}
export function conversationDto(row: ConversationRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    requirementId: row.requirement_id,
    requirementTitle: row.requirement_title ?? null,
    title: row.alias ?? row.default_title,
    alias: row.alias,
    pinnedAt: row.pinned_at?.toISOString() ?? null,
    archivedAt: row.archived_at?.toISOString() ?? null,
    rowVersion: row.row_version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    activeTaskStatus: row.active_task_status ?? null,
  };
}
// Shared read projection; c is always the owner-filtered conversation alias.
export const conversationRequirementTitleSql =
  '(SELECT r.title FROM app.requirements r WHERE r.id=c.requirement_id AND r.project_id=c.project_id) requirement_title';
export async function personalActor(
  tx: SqlExecutor,
  actor: ActorContext,
  internal = false,
): Promise<void> {
  await currentUser(tx, actor);
  if (
    actor.entrypoint !== 'web' &&
    !(internal && actor.entrypoint === 'internal-ai')
  )
    throw new DomainError(
      'FORBIDDEN',
      '个人会话和设置只开放本人网页及其受控任务。',
      403,
    );
}
export async function conversationRow(
  tx: SqlExecutor,
  actor: ActorContext,
  id: string,
  lock = false,
  internal = false,
): Promise<ConversationRow> {
  await personalActor(tx, actor, internal);
  const row = (
    await tx.query<ConversationRow>(
      `SELECT c.*,${conversationRequirementTitleSql},(SELECT t.state FROM app.ai_tasks t WHERE t.conversation_id=c.id AND t.owner_id=$2 AND t.state IN ('accepted','running','cancelling') ORDER BY t.created_at DESC,t.id DESC LIMIT 1) active_task_status
      FROM app.ai_conversations c WHERE c.id=$1 AND c.owner_id=$2 ${lock ? 'FOR UPDATE OF c' : 'FOR SHARE OF c'}`,
      [id, actor.userId],
    )
  ).rows[0];
  if (!row || row.deleted_at)
    throw new DomainError('NOT_FOUND', '会话不存在或当前不可访问。', 404);
  if (row.project_id) {
    try {
      await requireProject(tx, actor, row.project_id, 'project.read');
    } catch (error: unknown) {
      if (error instanceof DomainError && error.code === 'FORBIDDEN')
        throw new DomainError('NOT_FOUND', '会话不存在或当前不可访问。', 404);
      throw error;
    }
  }
  return row;
}
export async function requirementTarget(
  tx: SqlExecutor,
  actor: ActorContext,
  projectId: string,
  requirementId: string,
  participant = false,
): Promise<{ title: string }> {
  await requireProject(tx, actor, projectId, 'project.read');
  const requirement = (
    await tx.query<{ title: string }>(
      `SELECT r.title FROM app.requirements r WHERE r.id=$1 AND r.project_id=$2
    AND (NOT $4 OR EXISTS(SELECT 1 FROM app.requirement_participants rp WHERE rp.requirement_id=r.id AND rp.user_id=$3 AND rp.active)) FOR SHARE`,
      [requirementId, projectId, actor.userId, participant],
    )
  ).rows[0];
  if (!requirement)
    throw new DomainError(
      'NOT_FOUND',
      '需求不存在或不在当前个人参与范围。',
      404,
    );
  return requirement;
}
