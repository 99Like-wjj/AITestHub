import type { ActorContext } from '../../../contracts/src/identity.js';
import {
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
    | 'uploadInterrupted';
  objectId: string;
  title: string;
  path: string;
  recipients: string[];
}
const canRead = `n.recipient_id=$1 AND EXISTS(SELECT 1 FROM app.users u WHERE u.id=$1 AND u.active)
 AND (n.project_id IS NULL OR EXISTS(SELECT 1 FROM app.project_members m JOIN app.projects p ON p.id=m.project_id
  WHERE m.project_id=n.project_id AND m.user_id=$1 AND m.active AND p.active AND
   (n.kind='uploadInterrupted' OR (n.kind='issueNotDefect' AND 'developer'=ANY(m.roles)) OR (n.kind NOT IN ('issueNotDefect','uploadInterrupted') AND 'tester'=ANY(m.roles)))))`;
export class NotificationService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  constructor(readonly db: Database) {}
  private async personal(tx: SqlExecutor, actor: ActorContext) {
    await currentUser(tx, actor);
    if (actor.entrypoint !== 'web')
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
    developer = false,
    memberOnly = false,
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
   WHERE m.project_id=$1 AND m.user_id=$2 AND m.active AND u.active AND p.active AND ($3='member' OR $3=ANY(m.roles))`,
          [
            event.project_id,
            userId,
            memberOnly ? 'member' : developer ? 'developer' : 'tester',
          ],
        )
      ).rowCount,
    );
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
        if (message)
          for (const recipient of new Set(message.recipients)) {
            if (
              !(await this.recipientStillValid(
                tx,
                event,
                recipient,
                message.kind === 'issueNotDefect',
                message.kind === 'uploadInterrupted',
              ))
            )
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
  async list(actor: ActorContext, raw: unknown = {}) {
    const input = notificationListQuerySchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await this.personal(tx, actor);
      const cursor = input.cursor
        ? (
            await tx.query<{ created_at: Date; id: string }>(
              `SELECT n.created_at,n.id FROM app.notifications n WHERE n.id=$2 AND ${canRead}`,
              [actor.userId, input.cursor],
            )
          ).rows[0]
        : null;
      if (input.cursor && !cursor)
        throw new DomainError('NOT_FOUND', '此本人通知游标当前不可访问。', 404);
      const rows = (
        await tx.query<{
          id: string;
          project_id: string | null;
          kind: string;
          object_id: string;
          title: string;
          target_path: string;
          read_at: Date | null;
          created_at: Date;
          asset_title: string | null;
          asset_revision_id: string | null;
          asset_revision_no: number | null;
          project_name: string | null;
        }>(
          `SELECT n.*,ar.content->>'title' asset_title,ar.id asset_revision_id,ar.revision_no asset_revision_no,p.name project_name FROM app.notifications n
           JOIN app.outbox e ON e.id=n.event_id
           LEFT JOIN app.asset_revisions ar ON n.kind='assetReview' AND ar.asset_id=n.object_id AND ar.id::text=e.payload->>'revisionId'
           LEFT JOIN app.projects p ON p.id=n.project_id WHERE ${canRead}
    AND (NOT $2 OR n.read_at IS NULL) AND ($3::timestamptz IS NULL OR (n.created_at,n.id)<($3,$4::uuid)) ORDER BY n.created_at DESC,n.id DESC LIMIT $5`,
          [
            actor.userId,
            input.unreadOnly,
            cursor?.created_at ?? null,
            cursor?.id ?? null,
            input.limit + 1,
          ],
        )
      ).rows;
      const unread = (
        await tx.query<{ n: string }>(
          `SELECT count(*)::text n FROM app.notifications n WHERE ${canRead} AND n.read_at IS NULL`,
          [actor.userId],
        )
      ).rows[0]!.n;
      const visible = rows.slice(0, input.limit);
      return notificationListSchema.parse({
        notifications: visible.map((n) => ({
          id: n.id,
          projectId: n.project_id,
          kind: n.kind,
          objectId: n.object_id,
          title:
            n.kind === 'assetReview' && n.asset_title
              ? `${n.project_name ?? '项目'} · ${n.asset_title}${n.asset_revision_no ? ` · r${n.asset_revision_no}` : ''}有待评审内容`
              : n.title,
          targetPath:
            n.kind === 'assetReview' && n.target_path.startsWith('/#cases?')
              ? (() => {
                  const query = new URLSearchParams(
                    n.target_path.split('?')[1],
                  );
                  query.set('assetId', n.object_id);
                  if (n.asset_revision_id)
                    query.set('assetRevisionId', n.asset_revision_id);
                  return `/#cases?${query}`;
                })()
              : n.target_path,
          readAt: n.read_at?.toISOString() ?? null,
          createdAt: n.created_at.toISOString(),
        })),
        unreadCount: Number(unread),
        nextCursor: rows.length > input.limit ? visible.at(-1)!.id : null,
      });
    });
  }
  async markRead(actor: ActorContext, raw: unknown) {
    const input = markNotificationsReadSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await this.personal(tx, actor);
      const rows = await tx.query<{ id: string }>(
        `UPDATE app.notifications n SET read_at=COALESCE(read_at,clock_timestamp()) WHERE ${canRead} AND n.id=ANY($2::uuid[]) RETURNING id`,
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
