import { z } from 'zod';
import type { ActorContext } from '../../../contracts/src/identity.js';
import { idSchema } from '../../../contracts/src/base.js';
import {
  frozenConversationReferenceSchema,
  operationTargetSchema,
} from '../../../contracts/src/conversations.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { currentUser, requireProject } from '../access/policy.js';
import { DomainError } from '../errors.js';
import { ConversationReferences } from './references.js';

/** Human-selected source projects only. Assistant/tool provenance remains an ACL dependency, never a grant. */
export async function taskSourceProjectIds(
  tx: SqlExecutor,
  actor: ActorContext,
  taskId: string,
): Promise<string[]> {
  idSchema.parse(taskId);
  await currentUser(tx, actor);
  const task = (
    await tx.query<{
      conversation_id: string;
      project_id: string | null;
      operation_target: unknown;
    }>(
      `SELECT t.conversation_id,c.project_id,t.operation_target FROM app.ai_tasks t
    JOIN app.ai_conversations c ON c.id=t.conversation_id AND c.owner_id=t.owner_id
    JOIN app.ai_messages u ON u.id=t.user_message_id AND u.conversation_id=t.conversation_id AND u.role='user' AND u.deleted_at IS NULL
    WHERE t.id=$1 AND t.owner_id=$2 AND c.deleted_at IS NULL`,
      [taskId, actor.userId],
    )
  ).rows[0];
  if (!task)
    throw new DomainError(
      'NOT_FOUND',
      '原消息任务不存在或不可访问，未扩大工具资料范围。',
      404,
    );
  const projects = new Set<string>();
  if (task.project_id) projects.add(task.project_id);
  if (task.operation_target !== null)
    projects.add(operationTargetSchema.parse(task.operation_target).projectId);
  const rows = (
    await tx.query<{ explicit_refs: unknown }>(
      "SELECT explicit_refs FROM app.ai_messages WHERE conversation_id=$1 AND role='user' AND deleted_at IS NULL ORDER BY created_at,id",
      [task.conversation_id],
    )
  ).rows;
  const candidates = rows.flatMap((row) =>
    z.array(frozenConversationReferenceSchema).parse(row.explicit_refs),
  );
  if (candidates.length > 1000)
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '明确来源范围过大，未扩大工具资料范围。',
      422,
    );
  const references = new ConversationReferences(
    { query: tx.query.bind(tx), transaction: async (work) => work(tx) },
    {
      readText: async () => {
        throw new Error('Source-project authorization never reads file bodies');
      },
    },
  );
  const sources = [];
  for (const candidate of candidates)
    if (await references.readable(actor, candidate)) sources.push(candidate);
  const versions: string[] = [],
    knowledge: string[] = [],
    resources: string[] = [],
    conversations: string[] = [],
    invocations: string[] = [];
  for (const source of sources) {
    const ref = source.reference;
    if (ref.kind === 'projectAccess') projects.add(ref.projectId);
    else if (ref.kind === 'requirementVersion')
      versions.push(source.frozenVersionId ?? ref.requirementVersionId);
    else if (ref.kind === 'knowledge') knowledge.push(ref.entryId);
    else if (ref.kind === 'resource') resources.push(ref.resourceId);
    else if (ref.kind === 'conversation')
      conversations.push(ref.conversationId);
    else if (ref.kind === 'externalMcpInvocation')
      invocations.push(ref.invocationId);
    // Explicitly selected historical attachments are frozen resources, not automatic assistant projectAccess.
    resources.push(...(source.resourceIds ?? []));
  }
  const metadata = await tx.query<{ project_id: string | null }>(
    `SELECT project_id FROM app.requirement_versions WHERE id=ANY($1::uuid[])
    UNION SELECT project_id FROM app.knowledge_entries WHERE id=ANY($2::uuid[])
    UNION SELECT project_id FROM app.file_resources WHERE id=ANY($3::uuid[]) AND deleted_at IS NULL
    UNION SELECT project_id FROM app.ai_conversations WHERE id=ANY($4::uuid[]) AND owner_id=$6 AND deleted_at IS NULL
    UNION SELECT project_id FROM app.external_mcp_invocations WHERE id=ANY($5::uuid[]) AND actor_id=$6`,
    [versions, knowledge, resources, conversations, invocations, actor.userId],
  );
  for (const row of metadata.rows)
    if (row.project_id) projects.add(row.project_id);
  const readable: string[] = [];
  for (const projectId of projects) {
    try {
      await requireProject(tx, actor, projectId, 'project.read');
      readable.push(projectId);
    } catch (error) {
      if (
        !(error instanceof DomainError) ||
        !['FORBIDDEN', 'NOT_FOUND'].includes(error.code)
      )
        throw error;
    }
  }
  return readable.sort();
}

export function assertSourceProjectAllowed(
  projectId: string | undefined,
  allowedProjectIds: readonly string[] | undefined,
) {
  if (allowedProjectIds === undefined) return;
  if (!projectId || !allowedProjectIds.includes(projectId))
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '此项目不在用户明确选择的来源、会话归属或本条消息目标内，未读取新的项目资料；请先由本人选择来源或使用已允许的内部资料范围。',
      422,
    );
}
