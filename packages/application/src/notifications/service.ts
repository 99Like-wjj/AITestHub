import { permitsPersonalData } from '../access/policy.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import {
  markNotificationGroupsReadReceiptSchema,
  markNotificationGroupsReadSchema,
  notificationGroupItemsQuerySchema,
  notificationGroupItemsSchema,
  notificationKindSchema,
  notificationListQuerySchema,
  notificationListSchema,
  markNotificationsReadSchema,
} from '../../../contracts/src/notifications.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { currentUser } from '../access/policy.js';
import { DomainError } from '../errors.js';
import { idSchema } from '../../../contracts/src/base.js';
import {
  canReadNotification,
  groupWatermark,
  notificationView,
} from './queries.js';
interface EventRow {
  id: string;
  event_type: string;
  project_id: string | null;
  actor_id: string | null;
  aggregate_id: string | null;
  payload: Record<string, unknown>;
}
interface Delivery {
  kind:
    | 'requirementReview'
    | 'assetReview'
    | 'reportReady'
    | 'scheduleCompleted'
    | 'issueNotDefect'
    | 'uploadInterrupted'
    | 'issueAssigned'
    | 'issueRetest'
    | 'issueReturned';
  objectId: string;
  title: string;
  path: string;
  recipients: string[];
}
type RecipientRole = 'tester' | 'developer' | 'member' | 'issueHandler';

interface NoticeRow {
  id: string;
  project_id: string | null;
  kind: string;
  object_id: string;
  title: string;
  target_path: string;
  read_at: Date | string | null;
  created_at: Date | string;
  asset_kind: 'UI' | 'API' | null;
  asset_title: string | null;
  asset_revision_id: string | null;
  asset_revision_no: number | null;
  issue_number: string | null;
  issue_title: string | null;
  run_state: string | null;
  lane: 'attention' | 'activity';
}

interface GroupRow extends NoticeRow {
  project_name: string | null;
  requirement_id: string | null;
  requirement_title: string | null;
  requirement_version_no: number | null;
  group_key: string;
  group_unread: string;
  group_total: string;
  read_through: string;
  preview: NoticeRow[];
  unread_groups: string;
}

function notification(row: NoticeRow) {
  let title = row.title;
  let path = row.target_path;
  if (row.kind === 'assetReview') {
    const asset =
      row.asset_title ?? (row.asset_kind === 'API' ? '接口用例' : 'UI 用例');
    const revision =
      row.asset_revision_no === null ? '' : ` · r${row.asset_revision_no}`;
    title = `${asset}${revision} · ${row.lane === 'attention' ? '待评审' : '用例变更'}`;
    if (path.startsWith('/#cases?')) {
      const query = new URLSearchParams(path.split('?')[1]);
      query.set('assetId', row.object_id);
      if (row.asset_revision_id)
        query.set('assetRevisionId', row.asset_revision_id);
      path = `/#cases?${query}`;
    }
  }
  if (row.issue_title)
    title = `${row.issue_number ?? '缺陷'} · ${row.issue_title} · ${row.title}`;
  if (row.kind === 'reportReady' && row.lane === 'attention')
    title =
      row.run_state === 'interrupted' || row.run_state === 'recoveryRequired'
        ? '执行需要核对恢复'
        : '执行报告交付未完整';
  return {
    id: row.id,
    projectId: row.project_id,
    kind: notificationKindSchema.parse(row.kind),
    objectId: row.object_id,
    title,
    targetPath: path,
    readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
export class NotificationService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  constructor(readonly db: Database) {}
  private async personal(tx: SqlExecutor, actor: ActorContext) {
    await currentUser(tx, actor);
    if (!permitsPersonalData(actor))
      throw new DomainError('FORBIDDEN', '站内通知仅供本人平台会话。', 403);
  }
  private async relatedTesters(
    tx: SqlExecutor,
    p: string,
    requirementIds: string[],
    ownerId: string | null = null,
  ) {
    return (
      await tx.query<{ id: string }>(
        `SELECT DISTINCT u.id FROM app.users u JOIN app.project_members m ON m.user_id=u.id JOIN app.projects p ON p.id=m.project_id
   WHERE u.active AND m.active AND p.active AND m.project_id=$1 AND 'tester'=ANY(m.roles) AND (u.id=$3::uuid OR EXISTS(
    SELECT 1 FROM app.requirements r WHERE r.project_id=$1 AND r.id=ANY($2::uuid[]) AND (r.created_by=u.id OR EXISTS(
     SELECT 1 FROM app.requirement_participants rp WHERE rp.requirement_id=r.id AND rp.user_id=u.id AND rp.active))))`,
        [p, requirementIds, ownerId],
      )
    ).rows.map((r) => r.id);
  }
  private async recipientStillValid(
    tx: SqlExecutor,
    event: EventRow,
    userId: string,
    role: RecipientRole = 'tester',
  ) {
    if (!event.project_id)
      return Boolean(
        (
          await tx.query('SELECT 1 FROM app.users WHERE id=$1 AND active', [
            userId,
          ])
        ).rowCount,
      );
    return Boolean(
      (
        await tx.query(
          `SELECT 1 FROM app.project_members m JOIN app.users u ON u.id=m.user_id JOIN app.projects p ON p.id=m.project_id
   WHERE m.project_id=$1 AND m.user_id=$2 AND m.active AND u.active AND p.active AND (
     $3='member' OR $3=ANY(m.roles) OR ($3='issueHandler' AND m.roles && ARRAY['tester','developer']::text[])
   )`,
          [event.project_id, userId, role],
        )
      ).rowCount,
    );
  }
  private async issueDelivery(
    tx: SqlExecutor,
    event: EventRow,
    projectId: string,
    issueId: string,
  ): Promise<Delivery | null> {
    if (event.payload.notificationResponsibilityChanged !== true) return null;
    const { previousOwner, newOwner, previousState, newState, outcome } =
      event.payload;
    const assignee = idSchema.safeParse(newOwner);
    if (
      (event.event_type === 'issue.created' ||
        event.event_type === 'issue.assign' ||
        event.event_type === 'issue.transfer') &&
      assignee.success &&
      assignee.data !== previousOwner &&
      assignee.data !== event.actor_id
    )
      return {
        kind: 'issueAssigned',
        objectId: issueId,
        title: '已指派给你',
        path: `/#issues?projectId=${projectId}&issueId=${issueId}`,
        recipients: [assignee.data],
      };
    if (
      event.event_type === 'issue.manual-verification' &&
      previousState === 'awaitingRetest' &&
      outcome === 'failed' &&
      newState === 'inProgress' &&
      assignee.success &&
      assignee.data !== event.actor_id
    )
      return {
        kind: 'issueReturned',
        objectId: issueId,
        title: '复测未通过，已退回处理',
        path: `/#issues?projectId=${projectId}&issueId=${issueId}`,
        recipients: [assignee.data],
      };
    if (
      event.event_type !== 'issue.ready-for-retest' ||
      newState !== 'awaitingRetest'
    )
      return null;
    const submitter = (
      await tx.query<{ submitted_by: string }>(
        'SELECT submitted_by FROM app.issues WHERE project_id=$1 AND id=$2',
        [projectId, issueId],
      )
    ).rows[0]?.submitted_by;
    if (!submitter || submitter === event.actor_id) return null;
    return {
      kind: 'issueRetest',
      objectId: issueId,
      title: '待你复测',
      path: `/#issues?projectId=${projectId}&scope=all&tab=retest&issueId=${issueId}`,
      recipients: [submitter],
    };
  }
  private async delivery(
    tx: SqlExecutor,
    event: EventRow,
  ): Promise<Delivery | null> {
    const p = event.project_id,
      id = event.aggregate_id;
    if (!id) return null;
    if (
      (event.event_type === 'requirement.created' ||
        event.event_type === 'requirement.version-created') &&
      p
    ) {
      const r = (
        await tx.query(
          'SELECT 1 FROM app.requirements WHERE project_id=$1 AND id=$2',
          [p, id],
        )
      ).rowCount;
      if (!r) return null;
      return {
        kind: 'requirementReview',
        objectId: id,
        title: '需求资料已提交',
        path: `/#requirements?projectId=${p}&requirementId=${id}`,
        recipients: await this.relatedTesters(tx, p, [id]),
      };
    }
    if (
      (event.event_type === 'assets.created' ||
        event.event_type === 'assets.revised') &&
      p
    ) {
      const asset = (
        await tx.query<{
          requirement_id: string;
          kind: string;
          version_id: string;
          version_no: number;
          title: string;
        }>(
          `SELECT v.requirement_id,a.kind,v.id version_id,v.version_no,r.title FROM app.test_assets a JOIN app.requirement_versions v ON v.id=a.requirement_version_id
    JOIN app.requirements r ON r.id=v.requirement_id WHERE a.project_id=$1 AND a.id=$2 AND a.target_type='case' AND a.removed_at IS NULL`,
          [p, id],
        )
      ).rows[0];
      if (!asset) return null;
      const query = new URLSearchParams({
        projectId: p,
        requirementId: asset.requirement_id,
        versionId: asset.version_id,
        versionNo: String(asset.version_no),
        kind: asset.kind,
        title: asset.title,
        assetId: id,
      });
      return {
        kind: 'assetReview',
        objectId: id,
        title: '用例有待评审内容',
        path: `/#cases?${query}`,
        recipients: await this.relatedTesters(tx, p, [asset.requirement_id]),
      };
    }
    if (event.event_type === 'report.ready' && p) {
      const report = (
        await tx.query<{ run_id: string; source: string; created_by: string }>(
          `SELECT r.run_id,u.source,u.created_by FROM app.reports r JOIN app.runs u ON u.id=r.run_id WHERE r.project_id=$1 AND r.id=$2`,
          [p, id],
        )
      ).rows[0];
      if (!report || report.source === 'scheduled') return null;
      const reqs = (
        await tx.query<{ requirement_id: string }>(
          `SELECT DISTINCT v.requirement_id FROM app.run_items i JOIN app.test_assets a ON a.id=i.case_id JOIN app.requirement_versions v ON v.id=a.requirement_version_id WHERE i.run_id=$1`,
          [report.run_id],
        )
      ).rows.map((v) => v.requirement_id);
      return {
        kind: 'reportReady',
        objectId: id,
        title: '执行报告已就绪',
        path: `/#reports?projectId=${p}&reportId=${id}`,
        recipients: await this.relatedTesters(tx, p, reqs, report.created_by),
      };
    }
    if (event.event_type === 'schedule.run.completed' && p) {
      const recipient = event.payload.recipientUserId,
        runId = event.payload.runId,
        scheduleId = event.payload.scheduleId;
      if (
        !idSchema.safeParse(recipient).success ||
        !idSchema.safeParse(runId).success ||
        !idSchema.safeParse(scheduleId).success
      )
        return null;
      if (
        typeof recipient !== 'string' ||
        typeof runId !== 'string' ||
        typeof scheduleId !== 'string'
      )
        return null;
      const source = (
        await tx.query(
          `SELECT 1 FROM app.api_schedules s JOIN app.schedule_occurrences o ON o.schedule_id=s.id JOIN app.runs r ON r.id=o.run_id
    WHERE s.project_id=$1 AND s.id=$2 AND s.created_by=$3 AND r.id=$4 AND o.state='completed' AND r.ended_at IS NOT NULL
     AND EXISTS(SELECT 1 FROM app.api_case_facts f WHERE f.run_id=r.id)`,
          [p, scheduleId, recipient, runId],
        )
      ).rowCount;
      if (!source || !(await this.recipientStillValid(tx, event, recipient)))
        return null;
      return {
        kind: 'scheduleCompleted',
        objectId: scheduleId,
        title: '定时接口执行已完成',
        path: `/#plans?projectId=${p}&scheduleId=${scheduleId}&runId=${runId}`,
        recipients: [recipient],
      };
    }
    if (
      event.event_type === 'issue.closed' &&
      event.payload.resolution === 'notDefect' &&
      p
    ) {
      const users = (
        await tx.query<{ id: string }>(
          `SELECT DISTINCT u.id FROM app.users u JOIN app.project_members m ON m.user_id=u.id JOIN app.issues i ON i.project_id=m.project_id
    WHERE i.project_id=$1 AND i.id=$2 AND m.active AND u.active AND 'developer'=ANY(m.roles) AND (i.assignee_id=u.id OR EXISTS(
     SELECT 1 FROM app.issue_events e WHERE e.issue_id=i.id AND (e.previous_owner_id=u.id OR e.new_owner_id=u.id)))`,
          [p, id],
        )
      ).rows.map((u) => u.id);
      return {
        kind: 'issueNotDefect',
        objectId: id,
        title: '相关缺陷已明确为非缺陷并关闭',
        path: `/#issues?projectId=${p}&issueId=${id}`,
        recipients: users,
      };
    }
    if (p && event.event_type.startsWith('issue.')) {
      const notice = await this.issueDelivery(tx, event, p, id);
      if (notice) return notice;
    }
    if (event.event_type === 'file.upload-incomplete') {
      if (
        typeof event.payload.attempt !== 'number' ||
        !Number.isSafeInteger(event.payload.attempt) ||
        event.payload.attempt < 1
      )
        return null;
      const file = (
        await tx.query<{
          owner_user_id: string;
          run_id: string | null;
          owner_scope: string;
        }>(
          `SELECT owner_user_id,run_id,owner_scope FROM app.file_resources
    WHERE id=$1 AND status='failed' AND attempt=$2 AND deleted_at IS NULL`,
          [id, event.payload.attempt],
        )
      ).rows[0];
      if (!file) return null;
      return {
        kind: 'uploadInterrupted',
        objectId: id,
        title: '文件接收未完成，请核对状态后完整重传',
        path:
          file.run_id && p
            ? `/#reports?projectId=${p}&runId=${file.run_id}`
            : '/#workspace?panel=resources',
        recipients: [file.owner_user_id],
      };
    }
    return null;
  }
  async dispatchBatch(limit = 100) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new Error('Invalid notification batch size');
    return this.db.transaction(async (tx) => {
      const acquired = (
        await tx.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_xact_lock(hashtextextended('notification-dispatch',0)) locked",
        )
      ).rows[0]?.locked;
      if (!acquired) return { eventsProcessed: 0, notificationsCreated: 0 };
      const events = (
        await tx.query<EventRow>(
          `SELECT e.* FROM app.outbox e WHERE NOT EXISTS(SELECT 1 FROM app.notification_dispatches d WHERE d.event_id=e.id) ORDER BY e.seq LIMIT $1`,
          [limit],
        )
      ).rows;
      let delivered = 0;
      for (const event of events) {
        const message = await this.delivery(tx, event);
        if (message) {
          const role =
            message.kind === 'issueNotDefect'
              ? 'developer'
              : message.kind === 'uploadInterrupted'
                ? 'member'
                : message.kind === 'issueAssigned' ||
                    message.kind === 'issueReturned'
                  ? 'issueHandler'
                  : 'tester';
          for (const recipient of new Set(message.recipients)) {
            if (!(await this.recipientStillValid(tx, event, recipient, role)))
              continue;
            const inserted = await tx.query(
              `INSERT INTO app.notifications(recipient_id,event_id,project_id,kind,object_id,title,target_path)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(recipient_id,event_id) DO NOTHING`,
              [
                recipient,
                event.id,
                event.project_id,
                message.kind,
                message.objectId,
                message.title,
                message.path,
              ],
            );
            delivered += inserted.rowCount ?? 0;
          }
        }
        await tx.query(
          'INSERT INTO app.notification_dispatches(event_id) VALUES($1) ON CONFLICT DO NOTHING',
          [event.id],
        );
      }
      return {
        eventsProcessed: events.length,
        notificationsCreated: delivered,
      };
    });
  }

  private async checkCursor(
    tx: SqlExecutor,
    actor: ActorContext,
    cursor: string | undefined,
  ) {
    if (!cursor) return;
    const visible = await tx.query(
      `SELECT 1 FROM app.notifications n WHERE n.id=$2 AND ${canReadNotification}`,
      [actor.userId, cursor],
    );
    if (!visible.rowCount)
      throw new DomainError('NOT_FOUND', '此本人通知游标当前不可访问。', 404);
  }
  async list(actor: ActorContext, raw: unknown = {}) {
    const input = notificationListQuerySchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await this.personal(tx, actor);
      await this.checkCursor(tx, actor, input.cursor);
      const rows = (
        await tx.query<GroupRow>(
          `${notificationView}, counts AS (
            SELECT group_key,count(*)::text group_total,
              count(*) FILTER(WHERE read_at IS NULL)::text group_unread
            FROM notification_view WHERE lane=$2 GROUP BY group_key
            HAVING NOT $3 OR bool_or(read_at IS NULL)
          ), latest AS (
            SELECT DISTINCT ON (v.group_key) v.*,c.group_total,c.group_unread
            FROM notification_view v JOIN counts c USING (group_key)
            WHERE lane=$2 ORDER BY v.group_key,v.created_at DESC,v.id DESC
          ), selected AS (
            SELECT * FROM latest
            WHERE $4::uuid IS NULL OR (created_at,id)<(
              SELECT created_at,id FROM app.notifications WHERE id=$4
            )
            ORDER BY created_at DESC,id DESC LIMIT $5
          ), stats AS (
            SELECT count(DISTINCT group_key)::text unread_groups FROM notification_view
            WHERE lane='attention' AND read_at IS NULL
          )
          SELECT head.*,stats.unread_groups,${groupWatermark} read_through,
            (SELECT json_agg(sample ORDER BY sample.created_at DESC,sample.id DESC) FROM (
              SELECT v.* FROM notification_view v
              WHERE v.lane=$2 AND v.group_key=head.group_key
              ORDER BY v.created_at DESC,v.id DESC LIMIT 4
            ) sample) preview
          FROM stats LEFT JOIN selected head ON true
          ORDER BY head.created_at DESC,head.id DESC`,
          [
            actor.userId,
            input.lane,
            input.unreadOnly,
            input.cursor ?? null,
            input.limit + 1,
          ],
        )
      ).rows;
      const visible = rows
        .filter((row) => row.id !== null)
        .slice(0, input.limit);
      return notificationListSchema.parse({
        groups: visible.map((row) => ({
          key: row.group_key,
          projectId: row.project_id,
          projectName: row.project_name,
          kind: row.kind,
          requirementId: row.requirement_id,
          requirementTitle: row.requirement_title,
          requirementVersionNo:
            row.kind === 'assetReview' ? row.requirement_version_no : null,
          assetKind: row.asset_kind,
          title: row.requirement_title ?? notification(row).title,
          latestAt: new Date(row.created_at).toISOString(),
          itemCount: Number(row.group_total),
          unreadCount: Number(row.group_unread),
          readThrough: row.read_through,
          preview: row.preview.map(notification),
        })),
        unreadCount: Number(rows[0]?.unread_groups ?? 0),
        nextCursor:
          rows.length > input.limit ? (visible.at(-1)?.id ?? null) : null,
      });
    });
  }
  async groupItems(actor: ActorContext, raw: unknown) {
    const input = notificationGroupItemsQuerySchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await this.personal(tx, actor);
      await this.checkCursor(tx, actor, input.cursor);
      const rows = (
        await tx.query<NoticeRow>(
          `${notificationView}
          SELECT * FROM notification_view WHERE lane=$2 AND group_key=$3
            AND (NOT $4 OR read_at IS NULL) AND ($5::uuid IS NULL OR (created_at,id)<(
              SELECT created_at,id FROM app.notifications WHERE id=$5
            ))
          ORDER BY created_at DESC,id DESC LIMIT $6`,
          [
            actor.userId,
            input.lane,
            input.groupKey,
            input.unreadOnly,
            input.cursor ?? null,
            input.limit + 1,
          ],
        )
      ).rows;
      const visible = rows.slice(0, input.limit);
      return notificationGroupItemsSchema.parse({
        notifications: visible.map(notification),
        nextCursor:
          rows.length > input.limit ? (visible.at(-1)?.id ?? null) : null,
      });
    });
  }
  async markGroupsRead(actor: ActorContext, raw: unknown) {
    const input = markNotificationGroupsReadSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await this.personal(tx, actor);
      const changed = await tx.query(
        `${notificationView}, requested AS (
          SELECT * FROM jsonb_to_recordset($3::jsonb) AS r(key text,"readThrough" timestamptz)
        )
        UPDATE app.notifications n SET read_at=clock_timestamp()
        FROM notification_view v JOIN requested r ON r.key=v.group_key
        WHERE n.id=v.id AND v.lane=$2 AND n.created_at<=r."readThrough"
          AND n.read_at IS NULL AND ${canReadNotification}`,
        [actor.userId, input.lane, JSON.stringify(input.groups)],
      );
      return markNotificationGroupsReadReceiptSchema.parse({
        readCount: changed.rowCount,
      });
    });
  }
  async markRead(actor: ActorContext, raw: unknown) {
    const input = markNotificationsReadSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await this.personal(tx, actor);
      const rows = await tx.query<{ id: string }>(
        `UPDATE app.notifications n SET read_at=COALESCE(read_at,clock_timestamp()) WHERE ${canReadNotification} AND n.id=ANY($2::uuid[]) RETURNING id`,
        [actor.userId, input.ids],
      );
      return { readIds: rows.rows.map((r) => r.id) };
    });
  }
  start(intervalMs = 1000) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      void this.dispatchBatch()
        .catch(() => process.stderr.write('NOTIFICATION_DISPATCH_FAILED\n'))
        .finally(() => {
          this.busy = false;
        });
    }, intervalMs);
    this.timer.unref();
  }
  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    while (this.busy) await new Promise<void>((r) => setTimeout(r, 20));
  }
}
