import type { SqlExecutor } from '../../../persistence/src/database.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import {
  workspaceMaximumEntries,
  workspacePathSchema,
} from '../../../contracts/src/agent-workspace.js';
import { DomainError } from '../errors.js';

function safeOriginalPath(name: string, resourceId: string): string {
  const suffix = name.split(/[\\/]/).at(-1)?.normalize('NFC') ?? 'file';
  const cleaned = suffix
    .replace(/[\\\x00-\x1f\x7f:<>"|?*]/g, '_')
    .trim()
    .replace(/\.+$/, '')
    .slice(0, 100);
  const filename =
    cleaned && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)
      ? cleaned
      : 'file';
  return workspacePathSchema.parse(`attachments/${resourceId}/${filename}`);
}

/** Caller holds the authorized conversation lock and has authorized the exact resource. No bytes copied. */
export async function attachOriginalResource(
  tx: SqlExecutor,
  actor: ActorContext,
  conversationId: string,
  resourceId: string,
  messageId: string | null,
) {
  const file = (
    await tx.query<{
      original_name: string;
      owner_scope: string;
      owner_user_id: string;
      local_file_id: string;
    }>(
      "SELECT original_name,owner_scope,owner_user_id,local_file_id FROM app.file_resources WHERE id=$1 AND status='verified' AND deleted_at IS NULL FOR SHARE",
      [resourceId],
    )
  ).rows[0];
  if (
    !file ||
    (file.owner_scope === 'personal' && file.owner_user_id !== actor.userId)
  )
    throw new DomainError('NOT_FOUND', '附件原件不存在或当前不可读取。', 404);
  const existing = (
    await tx.query<{ id: string }>(
      `SELECT e.id FROM app.agent_workspace_entries e JOIN app.agent_workspace_versions v ON v.entry_id=e.id
     WHERE e.conversation_id=$1 AND e.owner_id=$2 AND v.resource_id=$3 AND e.deleted_at IS NULL
       AND (e.kind='original' OR (e.kind='artifact' AND $4))
     ORDER BY (e.kind='original') DESC,e.created_at,e.id LIMIT 1`,
      [
        conversationId,
        actor.userId,
        resourceId,
        file.local_file_id.startsWith('workspace:'),
      ],
    )
  ).rows[0];
  let entryId = existing?.id;
  if (!entryId) {
    const count = (
      await tx.query<{ count: string }>(
        'SELECT count(*)::text count FROM app.agent_workspace_entries WHERE conversation_id=$1',
        [conversationId],
      )
    ).rows[0];
    if (Number(count?.count ?? 0) >= workspaceMaximumEntries)
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '当前会话文件数量已达上限。',
        409,
      );
    entryId = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.agent_workspace_entries(conversation_id,owner_id,path,kind,original_name,origin_message_id,origin_resource_id)
       VALUES($1,$2,$3,'original',$4,$5,$6) RETURNING id`,
        [
          conversationId,
          actor.userId,
          safeOriginalPath(file.original_name, resourceId),
          file.original_name,
          messageId,
          resourceId,
        ],
      )
    ).rows[0]?.id;
    if (!entryId) throw new Error('Original insertion returned no identity');
    await tx.query(
      'INSERT INTO app.agent_workspace_versions(entry_id,revision,resource_id,created_by,message_id) VALUES($1,1,$2,$3,$4)',
      [entryId, resourceId, actor.userId, messageId],
    );
  }
  if (messageId)
    await tx.query(
      'INSERT INTO app.agent_workspace_message_links(entry_id,message_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [entryId, messageId],
    );
  return entryId;
}
