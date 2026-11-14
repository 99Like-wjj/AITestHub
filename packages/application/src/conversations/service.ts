import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ActorContext } from '../../../contracts/src/identity.js';
import {
  conversationCreateInputSchema,
  conversationUpdateInputSchema,
  conversationAssociateInputSchema,
  requirementGroupUpdateInputSchema,
  aiPreferencesInputSchema,
  sendMessageInputSchema,
  deletionCommitInputSchema,
  historySearchInputSchema,
  taskAcceptedSchema,
  conversationCreatedSchema,
  type TaskState,
} from '../../../contracts/src/conversations.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { ConfigurationService } from '../configuration/service.js';
import { readMessageModelSnapshot } from '../configuration/model-selection.js';
import { requireProject } from '../access/policy.js';
import { OperationService, canonicalJson } from '../operations/service.js';
import { DomainError, stale } from '../errors.js';
import { rejectMissingAcceptedReceipt } from '../recovery/receipts.js';
import { audit } from '../events.js';
import { assertSafeModelInput } from '../security/model-input.js';
import { assertModelDataScope } from '../security/model-data-scope.js';
import { exportConversationMarkdown } from './markdown-export.js';
import {
  conversationDto,
  conversationRow,
  conversationRequirementTitleSql,
  personalActor,
  requirementTarget,
  type ConversationRow,
} from './common.js';
import {
  ConversationReferences,
  type PersonalFileReader,
} from './references.js';
import {
  applyPrivacyDeletion,
  insertDeletionEvent,
  type PrivacyDeletion,
  type PrivacyLedgerPort,
} from './privacy.js';

interface GroupRow {
  project_id: string;
  requirement_id: string;
  title: string;
  alias: string | null;
  generated_name?: string | null;
  generated_name_source_hash?: string | null;
  pinned_at: Date | null;
  sort_order: number;
  expanded: boolean;
  hidden: boolean;
  archived_at: Date | null;
  row_version: number;
}
interface PreviewRow {
  id: string;
  target_type: 'conversation' | 'resource';
  target_id: string;
  row_version: number;
  scope_digest: string;
  payload: unknown;
  expires_at: Date;
  consumed_at: Date | null;
}
const activeStates = ['accepted', 'running', 'cancelling'];

export class ConversationsService {
  readonly references: ConversationReferences;
  readonly #operations: OperationService;
  constructor(
    readonly db: Database,
    readonly configuration: ConfigurationService,
    files: PersonalFileReader,
    readonly privacyLedger: PrivacyLedgerPort,
  ) {
    this.references = new ConversationReferences(db, files);
    this.#operations = new OperationService(db);
  }
  async create(actor: ActorContext, raw: unknown) {
    const input = conversationCreateInputSchema.parse(raw);
    return this.#operations.execute(
      actor,
      'conversations.create',
      input.commandId,
      input,
      async (tx) => {
        await personalActor(tx, actor);
        const previous = (
          await tx.query<{ response: unknown }>(
            "SELECT response FROM app.commands WHERE actor_id=$1 AND operation='conversations.create' AND key=$2",
            [actor.userId, input.commandId],
          )
        ).rows[0];
        if (
          z.object({ deleted: z.literal(true) }).safeParse(previous?.response)
            .success
        )
          throw new DomainError(
            'NOT_FOUND',
            '原会话已永久删除，不能用旧提交恢复。',
            404,
          );
        const receipt = z
          .object({ conversation: z.object({ id: z.uuid() }) })
          .safeParse(previous?.response);
        if (receipt.success)
          await conversationRow(tx, actor, receipt.data.conversation.id);
      },
      async (tx) => {
        let projectId = input.projectId ?? null;
        let requirementId = input.requirementId ?? null;
        let notice: string | null = null;
        if (!requirementId && input.useDefaultTarget) {
          const preference = (
            await tx.query<{
              default_target: string;
              last_project_id: string | null;
              last_requirement_id: string | null;
            }>(
              'SELECT * FROM app.ai_conversation_preferences WHERE user_id=$1',
              [actor.userId],
            )
          ).rows[0];
          if (preference?.default_target === 'lastRequirement') {
            projectId = preference.last_project_id;
            requirementId = preference.last_requirement_id;
          }
        }
        let title = '新聊天';
        if (projectId && requirementId) {
          try {
            title = (
              await requirementTarget(tx, actor, projectId, requirementId)
            ).title;
          } catch (error: unknown) {
            if (
              error instanceof DomainError &&
              ['NOT_FOUND', 'FORBIDDEN'].includes(error.code)
            ) {
              projectId = null;
              requirementId = null;
              notice = 'requirement-unavailable-personal-fallback';
            } else throw error;
          }
        }
        const row = (
          await tx.query<ConversationRow>(
            'INSERT INTO app.ai_conversations(owner_id,project_id,requirement_id,default_title) VALUES($1,$2,$3,$4) RETURNING *',
            [actor.userId, projectId, requirementId, title],
          )
        ).rows[0];
        if (!row) throw new Error('Conversation insert returned no row');
        if (projectId && requirementId)
          await tx.query(
            `INSERT INTO app.ai_conversation_preferences(user_id,last_project_id,last_requirement_id) VALUES($1,$2,$3)
        ON CONFLICT(user_id) DO UPDATE SET last_project_id=$2,last_requirement_id=$3,row_version=app.ai_conversation_preferences.row_version+1`,
            [actor.userId, projectId, requirementId],
          );
        await audit(tx, actor, 'conversation.created', row.id, projectId);
        return {
          conversation: conversationDto(
            await conversationRow(tx, actor, row.id),
          ),
          notice,
        };
      },
    );
  }
  async createReceipt(actor: ActorContext, commandId: string) {
    z.string().min(8).max(128).parse(commandId);
    return this.db.transaction(async (tx) => {
      await personalActor(tx, actor);
      const command = (
        await tx.query<{
          response: unknown;
          response_redacted_at: Date | null;
        }>(
          "SELECT response,response_redacted_at FROM app.commands WHERE actor_id=$1 AND operation='conversations.create' AND key=$2 AND status='completed'",
          [actor.userId, commandId],
        )
      ).rows[0];
      const parsed = conversationCreatedSchema.safeParse(
        command?.response_redacted_at ? null : command?.response,
      );
      if (parsed.success) {
        try {
          await conversationRow(tx, actor, parsed.data.conversation.id);
          return { commandId, receipt: parsed.data };
        } catch (error: unknown) {
          if (!(error instanceof DomainError && error.code === 'NOT_FOUND'))
            throw error;
        }
      }
      await rejectMissingAcceptedReceipt(
        tx,
        actor,
        'conversations.create',
        commandId,
      );
      throw new DomainError(
        'NOT_FOUND',
        '当前未检索到可读取的原会话创建回执，不代表未受理。请保留原提交标识核对，不能据此重复创建。',
        404,
      );
    });
  }
  async list(actor: ActorContext, options: { archived?: boolean } = {}) {
    return this.db.transaction(async (tx) => {
      await personalActor(tx, actor);
      const rows = await tx.query<ConversationRow>(
        `SELECT c.*,${conversationRequirementTitleSql},(SELECT t.state FROM app.ai_tasks t WHERE t.conversation_id=c.id AND t.owner_id=$1 AND t.state IN ('accepted','running','cancelling') ORDER BY t.created_at DESC,t.id DESC LIMIT 1) active_task_status
        FROM app.ai_conversations c WHERE c.owner_id=$1 AND c.deleted_at IS NULL
        AND (($2 AND c.archived_at IS NOT NULL) OR (NOT $2 AND c.archived_at IS NULL))
        AND (c.project_id IS NULL OR EXISTS(SELECT 1 FROM app.project_members m JOIN app.projects p ON p.id=m.project_id WHERE m.user_id=$1 AND m.project_id=c.project_id AND m.active AND p.active))
        ORDER BY c.updated_at DESC,c.id LIMIT 200`,
        [actor.userId, options.archived ?? false],
      );
      return { conversations: rows.rows.map(conversationDto) };
    });
  }
  async get(
    actor: ActorContext,
    id: string,
    options: { before?: string; limit?: number } = {},
  ) {
    const limit = z
      .number()
      .int()
      .min(1)
      .max(200)
      .parse(options.limit ?? 50);
    if (options.before) z.uuid().parse(options.before);
    return this.db.transaction(async (tx) => {
      const row = await conversationRow(tx, actor, id);
      if (row.project_id && row.requirement_id)
        await tx.query(
          `INSERT INTO app.ai_conversation_preferences(user_id,last_project_id,last_requirement_id) VALUES($1,$2,$3)
        ON CONFLICT(user_id) DO UPDATE SET last_project_id=$2,last_requirement_id=$3`,
          [actor.userId, row.project_id, row.requirement_id],
        );
      const before = options.before
        ? (
            await tx.query<{ created_at: Date }>(
              'SELECT created_at FROM app.ai_messages WHERE id=$1 AND conversation_id=$2 AND deleted_at IS NULL',
              [options.before, id],
            )
          ).rows[0]
        : undefined;
      if (options.before && !before)
        throw new DomainError('NOT_FOUND', '消息分页位置不可访问。', 404);
      const messages = await tx.query<{
        id: string;
        task_id: string | null;
        task_state: TaskState | null;
        execution_origin: 'fixture' | 'liveProvider' | 'legacyUnknown' | null;
        role: string;
        content: string;
        status: string;
        model_service_id: string | null;
        model_config_revision: number | null;
        effort: string | null;
        explicit_refs: unknown;
        model_snapshot: unknown;
        operation_target: unknown;
        created_at: Date;
      }>(
        `SELECT m.*,t.id task_id,t.state task_state,to_jsonb(t)->>'execution_origin' execution_origin
          FROM app.ai_messages m LEFT JOIN app.ai_tasks t ON t.owner_id=$5 AND t.conversation_id=m.conversation_id
          AND ((m.role='user' AND t.user_message_id=m.id) OR (m.role='assistant' AND t.assistant_message_id=m.id))
          WHERE m.conversation_id=$1 AND m.deleted_at IS NULL AND ($2::timestamptz IS NULL OR (m.created_at,m.id)<($2,$3::uuid)) ORDER BY m.created_at DESC,m.id DESC LIMIT $4`,
        [
          id,
          before?.created_at ?? null,
          options.before ?? null,
          limit + 1,
          actor.userId,
        ],
      );
      const visibleMessages = messages.rows.slice(0, limit);
      const pageTaskIds = [
        ...new Set(
          visibleMessages.flatMap((message) =>
            message.role === 'assistant' && message.task_id
              ? [message.task_id]
              : [],
          ),
        ),
      ];
      const notices = pageTaskIds.length
        ? (
            await tx.query<{
              task_id: string;
              has_failed_tools: boolean;
              has_unknown_tool_effects: boolean;
              has_context_reset: boolean;
            }>(
              `WITH relevant AS (
                SELECT e.task_id,e.event_type,e.payload,e.sequence FROM app.ai_task_events e
                JOIN app.ai_tasks t ON t.id=e.task_id AND t.owner_id=$2 AND t.conversation_id=$3
                WHERE e.task_id=ANY($1::uuid[]) AND e.event_type IN ('ai.tool','ai.contextReset')
              ), latest_tools AS (
                SELECT DISTINCT ON (task_id,payload->>'invocationId') task_id,payload FROM relevant
                WHERE event_type='ai.tool' ORDER BY task_id,payload->>'invocationId',sequence DESC
              ), flags AS (
                SELECT task_id,bool_or(payload->>'state'='failed') has_failed_tools,
                  bool_or(COALESCE(payload->>'unknownEffect','false')='true') has_unknown_tool_effects,
                  false has_context_reset FROM latest_tools GROUP BY task_id
                UNION ALL
                SELECT task_id,false,false,true FROM relevant WHERE event_type='ai.contextReset' GROUP BY task_id
              ) SELECT task_id,bool_or(has_failed_tools) has_failed_tools,
                bool_or(has_unknown_tool_effects) has_unknown_tool_effects,bool_or(has_context_reset) has_context_reset
                FROM flags GROUP BY task_id`,
              [pageTaskIds, actor.userId, id],
            )
          ).rows
        : [];
      const noticesByTask = new Map(
        notices.map((item) => [item.task_id, item]),
      );
      return {
        conversation: conversationDto(row),
        messages: visibleMessages.reverse().map((message) => ({
          id: message.id,
          taskId: message.task_id,
          taskStatus: message.task_state,
          ...(message.role === 'assistant' && message.task_id
            ? {
                taskNotices: {
                  hasFailedTools:
                    noticesByTask.get(message.task_id)?.has_failed_tools ??
                    false,
                  hasUnknownToolEffects:
                    noticesByTask.get(message.task_id)
                      ?.has_unknown_tool_effects ?? false,
                  hasContextReset:
                    noticesByTask.get(message.task_id)?.has_context_reset ??
                    false,
                },
              }
            : {}),
          executionOrigin: message.execution_origin ?? 'legacyUnknown',
          role: message.role,
          content: message.content,
          status: message.status,
          modelServiceId: message.model_service_id,
          configRevision: message.model_config_revision,
          modelSnapshot: (() => {
            try {
              return readMessageModelSnapshot(message.model_snapshot).snapshot;
            } catch {
              return null;
            }
          })(),
          effort: message.effort,
          references: message.explicit_refs,
          operationTarget: message.operation_target,
          createdAt: message.created_at.toISOString(),
        })),
        nextMessageCursor:
          messages.rows.length > limit
            ? (messages.rows[limit - 1]?.id ?? null)
            : null,
      };
    });
  }
  exportMarkdown(actor: ActorContext, id: string) {
    return exportConversationMarkdown(this.db, actor, id);
  }
  referenceMetadata(actor: ActorContext, id: string) {
    z.uuid().parse(id);
    return this.db.transaction(async (tx) => ({
      conversation: conversationDto(await conversationRow(tx, actor, id)),
    }));
  }
  async update(actor: ActorContext, id: string, raw: unknown) {
    const input = conversationUpdateInputSchema.parse(raw);
    return this.#operations.execute(
      actor,
      'conversations.update',
      input.commandId,
      { id, input },
      async (tx) => {
        if (input.archived === false) {
          // Follow group-update lock order before locking a member chat.
          const target = (
            await tx.query<{
              project_id: string | null;
              requirement_id: string | null;
            }>(
              'SELECT project_id,requirement_id FROM app.ai_conversations WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL',
              [id, actor.userId],
            )
          ).rows[0];
          if (target?.project_id && target.requirement_id) {
            await requirementTarget(
              tx,
              actor,
              target.project_id,
              target.requirement_id,
              true,
            );
            await tx.query(
              'SELECT requirement_id FROM app.ai_requirement_groups WHERE owner_id=$1 AND requirement_id=$2 FOR UPDATE',
              [actor.userId, target.requirement_id],
            );
          }
        }
        await conversationRow(tx, actor, id, true);
      },
      async (tx) => {
        const row = await conversationRow(tx, actor, id, true);
        if (row.row_version !== input.rowVersion) stale();
        if (input.archived === false && row.project_id && row.requirement_id) {
          await requirementTarget(
            tx,
            actor,
            row.project_id,
            row.requirement_id,
            true,
          );
          // Restoring one chat makes its parent reachable without unarchiving any other chat.
          await tx.query(
            `UPDATE app.ai_requirement_groups SET hidden=false,archived_at=NULL,expanded=true,row_version=row_version+1
            WHERE owner_id=$1 AND project_id=$2 AND requirement_id=$3 AND (hidden OR archived_at IS NOT NULL OR NOT expanded)`,
            [actor.userId, row.project_id, row.requirement_id],
          );
        }
        const updated = (
          await tx.query<ConversationRow>(
            `UPDATE app.ai_conversations SET alias=CASE WHEN $2 THEN $3 ELSE alias END,
        pinned_at=CASE WHEN $4 THEN CASE WHEN $5 THEN COALESCE(pinned_at,clock_timestamp()) ELSE NULL END ELSE pinned_at END,
        archived_at=CASE WHEN $6 THEN CASE WHEN $7 THEN COALESCE(archived_at,clock_timestamp()) ELSE NULL END ELSE archived_at END,
        archive_source=CASE WHEN $6 THEN CASE WHEN $7 THEN 'manual' ELSE NULL END ELSE archive_source END,
        row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
            [
              id,
              input.alias !== undefined,
              input.alias ?? null,
              input.pinned !== undefined,
              input.pinned ?? false,
              input.archived !== undefined,
              input.archived ?? false,
            ],
          )
        ).rows[0];
        if (!updated) throw new Error('Conversation update returned no row');
        return {
          conversation: conversationDto(
            await conversationRow(tx, actor, updated.id),
          ),
        };
      },
    );
  }
  async associate(actor: ActorContext, id: string, raw: unknown) {
    const input = conversationAssociateInputSchema.parse(raw);
    return this.#operations.execute(
      actor,
      'conversations.associate',
      input.commandId,
      { id, input },
      async (tx) => {
        await conversationRow(tx, actor, id, true);
        await requirementTarget(
          tx,
          actor,
          input.projectId,
          input.requirementId,
        );
      },
      async (tx) => {
        const row = await conversationRow(tx, actor, id, true);
        if (row.row_version !== input.rowVersion) stale();
        if (row.project_id || row.requirement_id)
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '已归属需求的会话不能静默改向；关联入口用于个人会话。',
            409,
          );
        const updated = (
          await tx.query<ConversationRow>(
            'UPDATE app.ai_conversations SET project_id=$2,requirement_id=$3,row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *',
            [id, input.projectId, input.requirementId],
          )
        ).rows[0];
        if (!updated)
          throw new Error('Conversation association returned no row');
        await tx.query(
          'UPDATE app.ai_conversations SET context_revision=context_revision+1 WHERE id=$1',
          [id],
        );
        await tx.query(
          'UPDATE app.ai_runtime_threads SET project_id=$3 WHERE conversation_id=$1 AND owner_id=$2 AND active_run_id IS NULL',
          [id, actor.userId, input.projectId],
        );
        await audit(tx, actor, 'conversation.associated', id, input.projectId, {
          requirementId: input.requirementId,
        });
        return {
          conversation: conversationDto(
            await conversationRow(tx, actor, updated.id),
          ),
        };
      },
    );
  }
  async preferences(actor: ActorContext) {
    return this.db.transaction(async (tx) => {
      await personalActor(tx, actor);
      const row = (
        await tx.query<{ default_target: string; row_version: number }>(
          'SELECT * FROM app.ai_conversation_preferences WHERE user_id=$1',
          [actor.userId],
        )
      ).rows[0];
      return {
        preferences: {
          defaultTarget: row?.default_target ?? 'personal',
          rowVersion: row?.row_version ?? 0,
        },
      };
    });
  }
  async updatePreferences(actor: ActorContext, raw: unknown) {
    const input = aiPreferencesInputSchema.parse(raw);
    return this.#operations.execute(
      actor,
      'conversations.preferences',
      input.commandId,
      input,
      (tx) => personalActor(tx, actor),
      async (tx) => {
        const prior = (
          await tx.query<{ row_version: number }>(
            'SELECT row_version FROM app.ai_conversation_preferences WHERE user_id=$1 FOR UPDATE',
            [actor.userId],
          )
        ).rows[0];
        if ((prior?.row_version ?? 0) !== input.rowVersion) stale();
        const row = (
          await tx.query<{ default_target: string; row_version: number }>(
            `INSERT INTO app.ai_conversation_preferences(user_id,default_target) VALUES($1,$2)
        ON CONFLICT(user_id) DO UPDATE SET default_target=$2,row_version=app.ai_conversation_preferences.row_version+1 RETURNING *`,
            [actor.userId, input.defaultTarget],
          )
        ).rows[0];
        return {
          preferences: {
            defaultTarget: row?.default_target,
            rowVersion: row?.row_version,
          },
        };
      },
    );
  }
  async sidebar(actor: ActorContext, projectId?: string) {
    return this.db.transaction(async (tx) => {
      await personalActor(tx, actor);
      if (projectId) {
        await requireProject(tx, actor, projectId, 'project.read');
        await tx.query(
          `INSERT INTO app.ai_requirement_groups(owner_id,project_id,requirement_id)
          SELECT $1,r.project_id,r.id FROM app.requirements r JOIN app.requirement_participants rp ON rp.requirement_id=r.id
          WHERE r.project_id=$2 AND rp.user_id=$1 AND rp.active ON CONFLICT DO NOTHING`,
          [actor.userId, projectId],
        );
      }
      const groups = projectId
        ? (
            await tx.query<GroupRow>(
              `SELECT g.*,r.title FROM app.ai_requirement_groups g JOIN app.requirements r ON r.id=g.requirement_id
        JOIN app.requirement_participants rp ON rp.requirement_id=r.id AND rp.user_id=g.owner_id AND rp.active
        WHERE g.owner_id=$1 AND g.project_id=$2 AND NOT g.hidden AND g.archived_at IS NULL ORDER BY g.pinned_at DESC NULLS LAST,g.sort_order,g.requirement_id`,
              [actor.userId, projectId],
            )
          ).rows
        : [];
      const conversations = (
        await tx.query<ConversationRow>(
          `SELECT c.*,${conversationRequirementTitleSql},(SELECT t.state FROM app.ai_tasks t WHERE t.conversation_id=c.id AND t.owner_id=$1 AND t.state IN ('accepted','running','cancelling') ORDER BY t.created_at DESC,t.id DESC LIMIT 1) active_task_status
          FROM app.ai_conversations c WHERE c.owner_id=$1 AND c.deleted_at IS NULL AND c.archived_at IS NULL AND (c.project_id=$2 OR c.project_id IS NULL) ORDER BY c.pinned_at DESC NULLS LAST,c.updated_at DESC,c.id`,
          [actor.userId, projectId ?? null],
        )
      ).rows;
      return {
        groups: groups.map((group) => ({
          projectId: group.project_id,
          requirementId: group.requirement_id,
          formalTitle: group.title,
          generatedName:
            group.generated_name_source_hash ===
            createHash('sha256').update(group.title, 'utf8').digest('hex')
              ? (group.generated_name ?? null)
              : null,
          alias: group.alias,
          pinnedAt: group.pinned_at?.toISOString() ?? null,
          sortOrder: group.sort_order,
          expanded: group.expanded,
          hidden: group.hidden,
          archivedAt: group.archived_at?.toISOString() ?? null,
          rowVersion: group.row_version,
          conversations: conversations
            .filter(
              (conversation) =>
                conversation.requirement_id === group.requirement_id &&
                !conversation.pinned_at,
            )
            .map(conversationDto),
        })),
        pinned: conversations
          .filter((conversation) => conversation.pinned_at)
          .map((conversation) => ({
            ...conversationDto(conversation),
            parentHidden: Boolean(
              conversation.requirement_id &&
              !groups.some(
                (group) => group.requirement_id === conversation.requirement_id,
              ),
            ),
          })),
        recent: conversations
          .filter(
            (conversation) =>
              !conversation.project_id &&
              !conversation.requirement_id &&
              !conversation.pinned_at,
          )
          .map(conversationDto),
      };
    });
  }
  async updateGroup(
    actor: ActorContext,
    projectId: string,
    requirementId: string,
    raw: unknown,
  ) {
    const input = requirementGroupUpdateInputSchema.parse(raw);
    return this.#operations.execute(
      actor,
      'conversations.group-update',
      input.commandId,
      { projectId, requirementId, input },
      async (tx) => {
        await personalActor(tx, actor);
        await requirementTarget(tx, actor, projectId, requirementId, true);
      },
      async (tx) => {
        const group = (
          await tx.query<{ row_version: number }>(
            'SELECT row_version FROM app.ai_requirement_groups WHERE owner_id=$1 AND requirement_id=$2 FOR UPDATE',
            [actor.userId, requirementId],
          )
        ).rows[0];
        if ((group?.row_version ?? 0) !== input.rowVersion) stale();
        if (!group)
          await tx.query(
            'INSERT INTO app.ai_requirement_groups(owner_id,project_id,requirement_id) VALUES($1,$2,$3)',
            [actor.userId, projectId, requirementId],
          );
        const updated = (
          await tx.query<GroupRow>(
            `UPDATE app.ai_requirement_groups SET alias=CASE WHEN $3 THEN $4 ELSE alias END,
        pinned_at=CASE WHEN $5 THEN CASE WHEN $6 THEN clock_timestamp() ELSE NULL END ELSE pinned_at END,
        expanded=COALESCE($7,expanded),hidden=COALESCE($8,hidden),sort_order=COALESCE($9,sort_order),
        archived_at=CASE WHEN $10 THEN CASE WHEN $11 THEN COALESCE(archived_at,clock_timestamp()) ELSE NULL END ELSE archived_at END,row_version=row_version+1
        WHERE owner_id=$1 AND requirement_id=$2 RETURNING *`,
            [
              actor.userId,
              requirementId,
              input.alias !== undefined,
              input.alias ?? null,
              input.pinned !== undefined,
              input.pinned ?? false,
              input.expanded ?? null,
              input.hidden ?? null,
              input.sortOrder ?? null,
              input.archived !== undefined,
              input.archived ?? false,
            ],
          )
        ).rows[0];
        if (input.archived === true)
          await tx.query(
            "UPDATE app.ai_conversations SET archived_at=clock_timestamp(),archive_source='group',row_version=row_version+1 WHERE owner_id=$1 AND requirement_id=$2 AND archived_at IS NULL AND deleted_at IS NULL",
            [actor.userId, requirementId],
          );
        if (input.archived === false)
          await tx.query(
            "UPDATE app.ai_conversations SET archived_at=NULL,archive_source=NULL,row_version=row_version+1 WHERE owner_id=$1 AND requirement_id=$2 AND archive_source='group' AND deleted_at IS NULL",
            [actor.userId, requirementId],
          );
        return {
          group: {
            requirementId,
            rowVersion: updated?.row_version,
            hidden: updated?.hidden,
            expanded: updated?.expanded,
          },
        };
      },
      projectId,
    );
  }
  async historyCandidates(actor: ActorContext, query = '') {
    z.string().max(500).parse(query);
    return this.db.transaction(async (tx) => {
      await personalActor(tx, actor);
      const rows = await tx.query<ConversationRow>(
        `SELECT c.*,${conversationRequirementTitleSql},(SELECT t.state FROM app.ai_tasks t WHERE t.conversation_id=c.id AND t.owner_id=$1 AND t.state IN ('accepted','running','cancelling') ORDER BY t.created_at DESC,t.id DESC LIMIT 1) active_task_status
        FROM app.ai_conversations c WHERE c.owner_id=$1 AND c.deleted_at IS NULL
        AND (c.project_id IS NULL OR EXISTS(SELECT 1 FROM app.project_members m JOIN app.projects p ON p.id=m.project_id WHERE m.user_id=$1 AND m.project_id=c.project_id AND m.active AND p.active))
        AND ($2='' OR position(lower($2) in lower(COALESCE(c.alias,c.default_title)))>0 OR EXISTS(SELECT 1 FROM app.ai_messages m WHERE m.conversation_id=c.id AND m.deleted_at IS NULL AND position(lower($2) in lower(m.content))>0))
        ORDER BY c.updated_at DESC,c.id LIMIT $3`,
        [actor.userId, query, query ? 20 : 5],
      );
      return { conversations: rows.rows.map(conversationDto) };
    });
  }
  async archivedGroups(actor: ActorContext) {
    return this.db.transaction(async (tx) => {
      await personalActor(tx, actor);
      const projects = (
        await tx.query<{ project_id: string }>(
          `SELECT DISTINCT g.project_id FROM app.ai_requirement_groups g
         JOIN app.project_members m ON m.project_id=g.project_id AND m.user_id=g.owner_id AND m.active
         JOIN app.projects p ON p.id=g.project_id AND p.active
         WHERE g.owner_id=$1 AND g.archived_at IS NOT NULL`,
          [actor.userId],
        )
      ).rows;
      const groups = [];
      for (const project of projects) {
        const candidates = await this.groupCandidatesInTransaction(
          tx,
          actor,
          project.project_id,
        );
        groups.push(
          ...candidates.groups.filter((group) => group.archivedAt !== null),
        );
      }
      return { groups };
    });
  }
  async groupCandidates(actor: ActorContext, projectId: string) {
    return this.db.transaction(async (tx) => {
      return this.groupCandidatesInTransaction(tx, actor, projectId);
    });
  }
  private async groupCandidatesInTransaction(
    tx: SqlExecutor,
    actor: ActorContext,
    projectId: string,
  ) {
    await personalActor(tx, actor);
    await requireProject(tx, actor, projectId, 'project.read');
    const rows = await tx.query<GroupRow & { group_exists: boolean }>(
      `SELECT r.project_id,r.id requirement_id,r.title,g.alias,to_jsonb(g)->>'generated_name' generated_name,to_jsonb(g)->>'generated_name_source_hash' generated_name_source_hash,g.pinned_at,
        COALESCE(g.sort_order,0) sort_order,COALESCE(g.expanded,true) expanded,COALESCE(g.hidden,false) hidden,g.archived_at,
        COALESCE(g.row_version,0) row_version,(g.requirement_id IS NOT NULL) group_exists
        FROM app.requirements r JOIN app.requirement_participants rp ON rp.requirement_id=r.id AND rp.user_id=$1 AND rp.active
        LEFT JOIN app.ai_requirement_groups g ON g.requirement_id=r.id AND g.owner_id=$1 WHERE r.project_id=$2 ORDER BY r.business_updated_at DESC,r.id`,
      [actor.userId, projectId],
    );
    return {
      groups: rows.rows.map((group) => ({
        projectId: group.project_id,
        requirementId: group.requirement_id,
        formalTitle: group.title,
        generatedName:
          group.generated_name_source_hash ===
          createHash('sha256').update(group.title, 'utf8').digest('hex')
            ? (group.generated_name ?? null)
            : null,
        alias: group.alias,
        pinnedAt: group.pinned_at?.toISOString() ?? null,
        sortOrder: group.sort_order,
        expanded: group.expanded,
        hidden: group.hidden,
        archivedAt: group.archived_at?.toISOString() ?? null,
        rowVersion: group.row_version,
        groupExists: group.group_exists,
      })),
    };
  }
  async resources(
    actor: ActorContext,
    options: {
      projectId?: string;
      requirementId?: string;
      unassigned?: boolean;
      query?: string;
      cursor?: string;
      limit?: number;
    } = {},
  ) {
    const limit = z
      .number()
      .int()
      .min(1)
      .max(200)
      .parse(options.limit ?? 50);
    z.string()
      .max(500)
      .parse(options.query ?? '');
    if (options.cursor) z.uuid().parse(options.cursor);
    if (
      (options.requirementId && !options.projectId) ||
      (options.unassigned && options.projectId)
    )
      throw new DomainError(
        'VALIDATION_ERROR',
        '资源范围需明确选择需求或个人无项目范围。',
        400,
      );
    return this.db.transaction(async (tx) => {
      await personalActor(tx, actor);
      if (options.projectId)
        await requireProject(tx, actor, options.projectId, 'project.read');
      if (options.projectId && options.requirementId)
        await requirementTarget(
          tx,
          actor,
          options.projectId,
          options.requirementId,
        );
      const cursor = options.cursor
        ? (
            await tx.query<{ created_at: Date }>(
              "SELECT created_at FROM app.file_resources WHERE id=$1 AND owner_user_id=$2 AND owner_scope='personal' AND deleted_at IS NULL",
              [options.cursor, actor.userId],
            )
          ).rows[0]
        : undefined;
      if (options.cursor && !cursor)
        throw new DomainError('NOT_FOUND', '资源分页位置不可访问。', 404);
      const rows = (
        await tx.query<{
          id: string;
          original_name: string;
          media_type: string;
          declared_bytes: string;
          declared_sha256: string;
          status: string;
          created_at: Date;
          verified_at: Date | null;
          reference_count: string;
          conversation_ids: string[];
          requirement_ids: string[];
          project_ids: string[];
        }>(
          `SELECT f.id,f.original_name,f.media_type,f.declared_bytes::text,f.declared_sha256,f.status,f.created_at,f.verified_at,
        (SELECT count(*)::text FROM app.resource_references r WHERE r.resource_id=f.id) reference_count,
        COALESCE(array_agg(DISTINCT c.id) FILTER(WHERE c.id IS NOT NULL),'{}'::uuid[]) conversation_ids,
        COALESCE(array_agg(DISTINCT c.requirement_id) FILTER(WHERE c.requirement_id IS NOT NULL),'{}'::uuid[]) requirement_ids,
        COALESCE(array_agg(DISTINCT c.project_id) FILTER(WHERE c.project_id IS NOT NULL),'{}'::uuid[]) project_ids
        FROM app.file_resources f LEFT JOIN app.resource_references r ON r.resource_id=f.id AND r.reference_type='conversation'
        LEFT JOIN app.ai_conversations c ON c.id=r.reference_id AND c.owner_id=$1 AND c.deleted_at IS NULL
          AND (c.project_id IS NULL OR EXISTS(SELECT 1 FROM app.project_members m JOIN app.projects p ON p.id=m.project_id WHERE m.user_id=$1 AND m.project_id=c.project_id AND m.active AND p.active))
        WHERE f.owner_user_id=$1 AND f.owner_scope='personal' AND f.deleted_at IS NULL
          AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM app.resource_references x JOIN app.ai_conversations v ON v.id=x.reference_id WHERE x.resource_id=f.id AND x.reference_type='conversation' AND v.owner_id=$1 AND v.deleted_at IS NULL AND v.project_id=$2 AND ($3::uuid IS NULL OR v.requirement_id=$3)))
          AND (NOT $4 OR NOT EXISTS(SELECT 1 FROM app.resource_references x JOIN app.ai_conversations v ON v.id=x.reference_id WHERE x.resource_id=f.id AND x.reference_type='conversation' AND v.owner_id=$1 AND v.deleted_at IS NULL AND v.project_id IS NOT NULL)
            OR EXISTS(SELECT 1 FROM app.resource_references x JOIN app.ai_conversations v ON v.id=x.reference_id WHERE x.resource_id=f.id AND x.reference_type='conversation' AND v.owner_id=$1 AND v.deleted_at IS NULL AND v.project_id IS NULL))
          AND ($5='' OR position(lower($5) in lower(f.original_name))>0)
          AND ($6::timestamptz IS NULL OR (f.created_at,f.id)<($6,$7::uuid))
        GROUP BY f.id ORDER BY f.created_at DESC,f.id DESC LIMIT $8`,
          [
            actor.userId,
            options.projectId ?? null,
            options.requirementId ?? null,
            options.unassigned ?? false,
            options.query ?? '',
            cursor?.created_at ?? null,
            options.cursor ?? null,
            limit + 1,
          ],
        )
      ).rows;
      return {
        resources: rows.slice(0, limit).map((file) => ({
          id: file.id,
          originalName: file.original_name,
          mediaType: file.media_type,
          bytes: file.declared_bytes,
          sha256: file.declared_sha256,
          status: file.status,
          createdAt: file.created_at.toISOString(),
          verifiedAt: file.verified_at?.toISOString() ?? null,
          referenceCount: file.reference_count,
          conversationIds: file.conversation_ids,
          requirementIds: file.requirement_ids,
          projectIds: file.project_ids,
          textExtractionSupported: [
            'text/plain',
            'text/markdown',
            'text/csv',
            'application/json',
            'text/html',
          ].includes(file.media_type),
        })),
        nextCursor: rows.length > limit ? (rows[limit - 1]?.id ?? null) : null,
      };
    });
  }
  async searchHistory(actor: ActorContext, raw: unknown) {
    const input = historySearchInputSchema.parse(raw);
    return this.references.searchSelected(
      actor,
      input.conversationIds,
      input.query,
      input.fullRead,
    );
  }
  async send(actor: ActorContext, conversationId: string, raw: unknown) {
    const input = sendMessageInputSchema.parse(raw);
    assertSafeModelInput(input.content);
    // Resolve before enqueue and again in worker. No model request is made by this path.
    const selection = await this.configuration.resolveRuntimeSelection(
      actor,
      input.modelSelection,
    );
    assertModelDataScope(selection, input.dataScope);
    if (
      input.dataScope === 'syntheticPublicOnly' &&
      input.references.some(
        (reference) => reference.dataScope !== 'syntheticPublicOnly',
      )
    )
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '所选来源包含相关内部测试资料，请明确选择对应资料范围。',
        422,
      );
    const frozenReferences = await this.references.freeze(
      actor,
      input.references,
      conversationId,
    );
    return this.#operations.execute(
      actor,
      'conversations.send',
      input.commandId,
      { conversationId, input },
      async (tx) => {
        await conversationRow(tx, actor, conversationId, true);
        if (
          input.dataScope === 'syntheticPublicOnly' &&
          (
            await tx.query(
              "SELECT 1 FROM app.ai_tasks WHERE conversation_id=$1 AND data_scope<>'syntheticPublicOnly' LIMIT 1",
              [conversationId],
            )
          ).rowCount
        )
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '此会话包含已声明的相关内部测试资料，继续对话需保留对应资料范围。',
            422,
          );
        if (input.operationTarget) {
          await requireProject(
            tx,
            actor,
            input.operationTarget.projectId,
            'project.read',
          );
          if (input.operationTarget.requirementId)
            await requirementTarget(
              tx,
              actor,
              input.operationTarget.projectId,
              input.operationTarget.requirementId,
            );
        }
      },
      async (tx) => {
        const conversation = await conversationRow(
          tx,
          actor,
          conversationId,
          true,
        );
        if (
          (
            await tx.query(
              'SELECT 1 FROM app.ai_tasks WHERE conversation_id=$1 AND state=ANY($2::text[])',
              [conversationId, activeStates],
            )
          ).rowCount
        )
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '此会话已有未结束消息任务，请等待或明确停止生成。',
            409,
          );
        const userMessageId = randomUUID();
        const assistantMessageId = randomUUID();
        const taskId = randomUUID();
        const snapshot =
          'runtimeVersion' in selection
            ? {
                schemaVersion: 'ath.model-snapshot.v2',
                modelServiceId: selection.modelServiceId,
                modelEntryId: selection.modelEntryId,
                serviceRevision: selection.serviceRevision,
                serviceName: selection.serviceName,
                modelDisplayName: selection.modelDisplayName,
                protocol: selection.protocol,
                modelId: selection.modelId,
                effort: selection.effort,
              }
            : {
                modelServiceId: selection.modelServiceId,
                configRevision: selection.configRevision,
                provider: selection.provider,
                modelId: selection.modelId,
                effort: selection.effort,
              };
        for (const [id, role, content, refs] of [
          [userMessageId, 'user', input.content, frozenReferences],
          [assistantMessageId, 'assistant', '', []],
        ] as const) {
          await tx.query(
            `INSERT INTO app.ai_messages(id,conversation_id,role,content,status,model_service_id,model_config_revision,effort,model_snapshot,explicit_refs,operation_target)
          VALUES($1,$2,$3,$4,'queued',$5,$6,$7,$8,$9,$10)`,
            [
              id,
              conversationId,
              role,
              content,
              selection.modelServiceId,
              selection.configRevision,
              selection.effort,
              snapshot,
              JSON.stringify(refs),
              input.operationTarget,
            ],
          );
        }
        await tx.query(
          `INSERT INTO app.ai_tasks(id,owner_id,conversation_id,user_message_id,assistant_message_id,model_selection,operation_target,data_scope)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            taskId,
            actor.userId,
            conversationId,
            userMessageId,
            assistantMessageId,
            'runtimeVersion' in selection
              ? {
                  modelServiceId: selection.modelServiceId,
                  modelEntryId: selection.modelEntryId,
                  serviceRevision: selection.serviceRevision,
                  effort: selection.effort,
                }
              : {
                  modelServiceId: selection.modelServiceId,
                  configRevision: selection.configRevision,
                  effort: selection.effort,
                },
            input.operationTarget,
            input.dataScope,
          ],
        );
        const resourceIds = new Set(
          frozenReferences.flatMap((reference) =>
            reference.reference.kind === 'resource'
              ? [
                  reference.reference.resourceId,
                  ...(reference.resourceIds ?? []),
                ]
              : (reference.resourceIds ?? []),
          ),
        );
        for (const resourceId of resourceIds) {
          const source = await this.references.authorizeResource(
            tx,
            actor,
            resourceId,
          );
          await tx.query(
            "INSERT INTO app.resource_references(resource_id,project_id,reference_type,reference_id,created_by) VALUES($1,$2,'conversation',$3,$4) ON CONFLICT DO NOTHING",
            [resourceId, source.project_id, conversationId, actor.userId],
          );
        }
        await tx.query(
          'UPDATE app.ai_conversations SET updated_at=clock_timestamp(),row_version=row_version+1 WHERE id=$1',
          [conversationId],
        );
        await tx.query(
          "INSERT INTO app.ai_task_events(task_id,event_type,payload) VALUES($1,'task.accepted',$2)",
          [taskId, { taskId, status: 'accepted', conversationId }],
        );
        await audit(
          tx,
          actor,
          'ai.task-accepted',
          taskId,
          conversation.project_id,
        );
        return {
          taskId,
          userMessageId,
          assistantMessageId,
          status: 'accepted' as const,
        };
      },
    );
  }
  async sendReceipt(
    actor: ActorContext,
    conversationId: string,
    commandId: string,
  ) {
    z.string().min(8).max(128).parse(commandId);
    return this.db.transaction(async (tx) => {
      await conversationRow(tx, actor, conversationId);
      const command = (
        await tx.query<{ response: unknown }>(
          "SELECT response FROM app.commands WHERE actor_id=$1 AND operation='conversations.send' AND key=$2 AND status='completed'",
          [actor.userId, commandId],
        )
      ).rows[0];
      const parsed = taskAcceptedSchema.safeParse(command?.response);
      if (!parsed.success) {
        await rejectMissingAcceptedReceipt(
          tx,
          actor,
          'conversations.send',
          commandId,
        );
        throw new DomainError(
          'NOT_FOUND',
          '当前未检索到本会话发送回执，请保留原提交标识核对；不据此新建重复发送。',
          404,
        );
      }
      const task = (
        await tx.query<{ state: string }>(
          'SELECT state FROM app.ai_tasks WHERE id=$1 AND owner_id=$2 AND conversation_id=$3',
          [parsed.data.taskId, actor.userId, conversationId],
        )
      ).rows[0];
      if (!task) {
        await rejectMissingAcceptedReceipt(
          tx,
          actor,
          'conversations.send',
          commandId,
        );
        throw new DomainError(
          'OPERATION_RESULT_UNKNOWN',
          '原提交已有受理回执，但当前查询范围没有完整任务记录；未再次发起，请先核对原执行。',
          409,
        );
      }
      return { receipt: parsed.data, currentStatus: task.state };
    });
  }

  async previewDelete(
    actor: ActorContext,
    targetType: 'conversation' | 'resource',
    id: string,
  ) {
    return this.db.transaction(async (tx) => {
      const impact = await this.#impact(tx, actor, targetType, id);
      const payload = { targetType, targetId: id, ...impact };
      const digest = createHash('sha256')
        .update(canonicalJson(payload))
        .digest('hex');
      const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
      const preview = (
        await tx.query<{ id: string }>(
          'INSERT INTO app.ai_deletion_previews(owner_id,target_type,target_id,row_version,scope_digest,payload,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
          [
            actor.userId,
            targetType,
            id,
            impact.rowVersion,
            digest,
            payload,
            expiresAt,
          ],
        )
      ).rows[0];
      if (!preview) throw new Error('Preview insert returned no row');
      return {
        previewId: preview.id,
        targetType,
        targetId: id,
        scopeDigest: digest,
        expiresAt,
        ...impact,
      };
    });
  }
  async commitDelete(actor: ActorContext, raw: unknown) {
    const input = deletionCommitInputSchema.parse(raw);
    const result = await this.#operations.execute(
      actor,
      'conversations.delete',
      input.commandId,
      input,
      (tx) => personalActor(tx, actor),
      async (tx) => {
        const preview = (
          await tx.query<PreviewRow>(
            'SELECT * FROM app.ai_deletion_previews WHERE id=$1 AND owner_id=$2 FOR UPDATE',
            [input.previewId, actor.userId],
          )
        ).rows[0];
        if (
          !preview ||
          preview.consumed_at ||
          preview.expires_at.getTime() < Date.now() ||
          preview.scope_digest !== input.scopeDigest
        )
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '删除预览已失效，请重新核对影响范围。',
            422,
          );
        const impact = await this.#impact(
          tx,
          actor,
          preview.target_type,
          preview.target_id,
          true,
        );
        if (
          createHash('sha256')
            .update(
              canonicalJson({
                targetType: preview.target_type,
                targetId: preview.target_id,
                ...impact,
              }),
            )
            .digest('hex') !== input.scopeDigest
        )
          stale();
        const entry: PrivacyDeletion = {
          id: randomUUID(),
          ownerId: actor.userId,
          targetType: preview.target_type,
          targetId: preview.target_id,
          exclusiveResourceIds: impact.exclusiveResourceIds,
          occurredAt: new Date().toISOString(),
          controlVersion: 1,
        };
        await insertDeletionEvent(tx, entry);
        await tx.query(
          "INSERT INTO app.privacy_deletion_replication(event_id,state) VALUES($1,'pending')",
          [entry.id],
        );
        await applyPrivacyDeletion(tx, entry);
        await tx.query(
          'UPDATE app.ai_deletion_previews SET consumed_at=clock_timestamp() WHERE id=$1',
          [preview.id],
        );
        await audit(tx, actor, 'privacy.deleted', entry.targetId, null, {
          targetType: entry.targetType,
          deletionEventId: entry.id,
        });
        return {
          deleted: true,
          deletion: entry,
          gcState: impact.exclusiveResourceIds.length ? 'pending' : 'notNeeded',
        };
      },
    );
    try {
      await this.privacyLedger.record(result.deletion);
      await this.db.query(
        "UPDATE app.privacy_deletion_replication SET state='recorded',recorded_at=clock_timestamp() WHERE event_id=$1",
        [result.deletion.id],
      );
      return {
        deleted: true,
        deletionEventId: result.deletion.id,
        controlLedger: 'recorded',
        gcState: result.gcState,
      };
    } catch {
      return {
        deleted: true,
        deletionEventId: result.deletion.id,
        controlLedger: 'pending',
        gcState: result.gcState,
      };
    }
  }
  /** Internal local replication only. Never exposed as a model/MCP or user-selected file path action. */
  async replicatePendingDeletionControls(): Promise<{
    recorded: number;
    pending: number;
  }> {
    let recorded = 0;
    let after = '00000000-0000-0000-0000-000000000000';
    while (true) {
      // Verify all known records as well as pending ones: a DB receipt alone does not prove
      // the independent control directory still contains its signed record after recovery.
      const rows = (
        await this.db.query<{
          id: string;
          owner_id: string;
          target_type: 'conversation' | 'resource';
          target_id: string;
          exclusive_resource_ids: string[];
          occurred_at: Date;
        }>(
          `SELECT e.* FROM app.privacy_deletion_events e WHERE e.id>$1 ORDER BY e.id LIMIT 500`,
          [after],
        )
      ).rows;
      if (!rows.length) break;
      for (const row of rows) {
        try {
          await this.privacyLedger.record({
            id: row.id,
            ownerId: row.owner_id,
            targetType: row.target_type,
            targetId: row.target_id,
            exclusiveResourceIds: row.exclusive_resource_ids,
            occurredAt: row.occurred_at.toISOString(),
            controlVersion: 1,
          });
          await this.db.query(
            "UPDATE app.privacy_deletion_replication SET state='recorded',recorded_at=clock_timestamp() WHERE event_id=$1",
            [row.id],
          );
          recorded++;
        } catch {
          await this.db.query(
            "UPDATE app.privacy_deletion_replication SET state='pending',recorded_at=NULL WHERE event_id=$1",
            [row.id],
          );
        }
      }
      after = rows.at(-1)?.id ?? after;
    }
    const pending =
      (
        await this.db.query<{ count: string }>(
          "SELECT count(*)::text count FROM app.privacy_deletion_replication WHERE state='pending'",
        )
      ).rows[0]?.count ?? '0';
    return { recorded, pending: Number(pending) };
  }
  async #impact(
    tx: SqlExecutor,
    actor: ActorContext,
    type: 'conversation' | 'resource',
    id: string,
    lock = false,
  ) {
    await personalActor(tx, actor);
    let rowVersion: number;
    let affectedConversationIds: string[] = [];
    let resourceIds: string[] = [];
    if (type === 'conversation') {
      const conversation = await conversationRow(tx, actor, id, lock);
      rowVersion = conversation.row_version;
      affectedConversationIds = [id];
      resourceIds = (
        await tx.query<{ resource_id: string }>(
          "SELECT resource_id FROM app.resource_references WHERE reference_type='conversation' AND reference_id=$1 ORDER BY resource_id",
          [id],
        )
      ).rows.map((row) => row.resource_id);
    } else {
      const file = (
        await tx.query<{
          owner_user_id: string;
          owner_scope: string;
          row_version: number;
          deleted_at: Date | null;
        }>(
          `SELECT * FROM app.file_resources WHERE id=$1 ${lock ? 'FOR UPDATE' : 'FOR SHARE'}`,
          [id],
        )
      ).rows[0];
      if (
        !file ||
        file.owner_user_id !== actor.userId ||
        file.owner_scope !== 'personal' ||
        file.deleted_at
      )
        throw new DomainError('NOT_FOUND', '没有本人可删除的个人资源。', 404);
      rowVersion = file.row_version;
      resourceIds = [id];
      if (
        (
          await tx.query(
            "SELECT 1 FROM app.resource_references WHERE resource_id=$1 AND reference_type<>'conversation' LIMIT 1",
            [id],
          )
        ).rowCount
      )
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '此个人资源仍有正式资料引用，不能假装已永久删除；请先处理来源副本关系。',
          422,
        );
      affectedConversationIds = (
        await tx.query<{ reference_id: string }>(
          "SELECT r.reference_id FROM app.resource_references r JOIN app.ai_conversations c ON c.id=r.reference_id WHERE r.resource_id=$1 AND r.reference_type='conversation' AND c.owner_id=$2 AND c.deleted_at IS NULL ORDER BY r.reference_id",
          [id, actor.userId],
        )
      ).rows.map((row) => row.reference_id);
    }
    const exclusiveResourceIds: string[] = [];
    const retainedResourceIds: string[] = [];
    for (const resourceId of resourceIds) {
      const file = (
        await tx.query<{ owner_scope: string; owner_user_id: string }>(
          `SELECT * FROM app.file_resources WHERE id=$1 ${lock ? 'FOR UPDATE' : 'FOR SHARE'}`,
          [resourceId],
        )
      ).rows[0];
      const otherRefs = await tx.query(
        "SELECT 1 FROM app.resource_references WHERE resource_id=$1 AND NOT(reference_type='conversation' AND reference_id=$2)",
        [resourceId, type === 'conversation' ? id : null],
      );
      if (
        file?.owner_scope === 'personal' &&
        file.owner_user_id === actor.userId &&
        (type === 'resource' || !otherRefs.rowCount)
      )
        exclusiveResourceIds.push(resourceId);
      else retainedResourceIds.push(resourceId);
    }
    const activeTaskIds = (
      await tx.query<{ id: string }>(
        'SELECT id FROM app.ai_tasks WHERE conversation_id=ANY($1::uuid[]) AND state=ANY($2::text[]) ORDER BY id',
        [affectedConversationIds, activeStates],
      )
    ).rows.map((row) => row.id);
    return {
      rowVersion,
      exclusiveResourceIds,
      retainedResourceIds,
      affectedConversationIds,
      activeTaskIds,
    };
  }
}
