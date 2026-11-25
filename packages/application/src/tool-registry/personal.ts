import { z } from 'zod';
import { idSchema } from '../../../contracts/src/base.js';
import {
  conversationUpdateInputSchema,
  deletionCommitInputSchema,
} from '../../../contracts/src/conversations.js';
import {
  workspaceDraftKeySchema,
  workspaceDraftSaveSchema,
  workspaceDraftDeleteSchema,
} from '../../../contracts/src/workspace-drafts.js';
import {
  notificationListQuerySchema,
  markNotificationsReadSchema,
  markNotificationGroupsReadSchema,
} from '../../../contracts/src/notifications.js';
import { fileCenterQuerySchema } from '../../../contracts/src/agent-workspace.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { Database } from '../../../persistence/src/database.js';
import type { FileCenterService } from '../agent-workspace/file-center.js';
import type { ConversationsService } from '../conversations/service.js';
import { WorkspaceDraftService } from '../conversations/drafts.js';
import { NotificationService } from '../notifications/service.js';
import { personalActor } from '../conversations/common.js';
import { DomainError } from '../errors.js';
import type { BusinessToolRegistry, ConfirmationScope } from './registry.js';

export interface PersonalBusinessServices {
  conversations?: ConversationsService;
  fileCenter?: FileCenterService;
}
export function registerPersonalTools(
  registry: BusinessToolRegistry,
  db: Database,
  services: PersonalBusinessServices,
) {
  const drafts = new WorkspaceDraftService(db);
  const notifications = new NotificationService(db);
  const name = 'ath_personal_workspace';
  const description =
    '本人工作台的会话、草稿、通知和文件元数据。个人 Key 须明确授权 personal.data；永久删除需精确影响确认。';
  const add = <S extends z.ZodType>(
    op: string,
    schema: S,
    access: 'read' | 'write',
    execute: (actor: ActorContext, input: z.infer<S>) => Promise<unknown>,
    confirm?: (
      actor: ActorContext,
      input: z.infer<S>,
    ) => Promise<ConfirmationScope>,
  ) =>
    registry.add(
      name,
      description,
      op,
      schema,
      access,
      execute,
      confirm,
      false,
      'personal',
    );
  const item = <S extends z.ZodType>(op: string, schema: S) =>
    z.strictObject({ op: z.literal(op), input: schema });
  const draft = { key: workspaceDraftKeySchema };
  add('drafts', z.strictObject({ op: z.literal('drafts') }), 'read', (actor) =>
    drafts.listUnsaved(actor),
  );
  add(
    'get-draft',
    z.strictObject({ op: z.literal('get-draft'), ...draft }),
    'read',
    (actor, args) => drafts.read(actor, args.key),
  );
  add(
    'save-draft',
    z.strictObject({
      op: z.literal('save-draft'),
      ...draft,
      input: workspaceDraftSaveSchema,
    }),
    'write',
    (actor, args) => drafts.save(actor, args.key, args.input),
  );
  add(
    'delete-draft',
    z.strictObject({
      op: z.literal('delete-draft'),
      ...draft,
      input: workspaceDraftDeleteSchema,
    }),
    'write',
    (actor, args) => drafts.delete(actor, args.key, args.input),
  );
  add(
    'notifications',
    item('notifications', notificationListQuerySchema),
    'read',
    (actor, args) => notifications.list(actor, args.input),
  );
  add(
    'mark-read',
    item('mark-read', markNotificationsReadSchema),
    'write',
    (actor, args) => notifications.markRead(actor, args.input),
  );
  add(
    'mark-groups-read',
    item('mark-groups-read', markNotificationGroupsReadSchema),
    'write',
    (actor, args) => notifications.markGroupsRead(actor, args.input),
  );
  if (services.fileCenter) {
    const center = services.fileCenter;
    add('files', item('files', fileCenterQuerySchema), 'read', (actor, args) =>
      center.list(actor, args.input),
    );
    add(
      'file-detail',
      z.strictObject({ op: z.literal('file-detail'), id: idSchema }),
      'read',
      (actor, args) => center.detail(actor, args.id),
    );
  }
  if (services.conversations) {
    const conversations = services.conversations;
    add(
      'conversations',
      z.strictObject({
        op: z.literal('conversations'),
        archived: z.boolean().default(false),
      }),
      'read',
      (actor, args) => conversations.list(actor, { archived: args.archived }),
    );
    add(
      'update-conversation',
      z.strictObject({
        op: z.literal('update-conversation'),
        id: idSchema,
        input: conversationUpdateInputSchema,
      }),
      'write',
      (actor, args) => conversations.update(actor, args.id, args.input),
    );
    add(
      'delete-preview',
      z.strictObject({
        op: z.literal('delete-preview'),
        targetType: z.enum(['conversation', 'resource']),
        id: idSchema,
      }),
      'read',
      (actor, args) =>
        conversations.previewDelete(actor, args.targetType, args.id),
    );
    add(
      'delete',
      item('delete', deletionCommitInputSchema),
      'write',
      (actor, args) => conversations.commitDelete(actor, args.input),
      async (actor, args) =>
        db.transaction(async (tx) => {
          await personalActor(tx, actor);
          const row = (
            await tx.query<{
              payload: unknown;
              scope_digest: string;
              expires_at: Date;
            }>(
              'SELECT payload,scope_digest,expires_at FROM app.ai_deletion_previews WHERE id=$1 AND owner_id=$2',
              [args.input.previewId, actor.userId],
            )
          ).rows[0];
          if (
            !row ||
            row.scope_digest !== args.input.scopeDigest ||
            row.expires_at.getTime() <= Date.now()
          )
            throw new DomainError(
              'PRECONDITIONS_MISSING',
              '删除预览过期或与当前用户和范围不符。',
              422,
            );
          return {
            reason: 'impact',
            summary: '确认删除本人资料及精确列出的影响。',
            scope: row.payload,
            links: [],
          };
        }),
    );
  }
}
