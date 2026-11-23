import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Drawer,
  Empty,
  Segmented,
  Skeleton,
  Space,
  Tag,
  Tooltip,
} from 'antd';
import type { z } from 'zod';
import {
  markNotificationGroupsReadReceiptSchema,
  markNotificationGroupsReadSchema,
  markNotificationsReadReceiptSchema,
  markNotificationsReadSchema,
  notificationGroupItemsSchema,
  notificationLaneSchema,
  notificationListSchema,
} from '../../../packages/contracts/src/notifications';
import { AppIcon } from './app-icon';
import { api, describeError } from './api';
import { BeijingTime } from './beijing-time';
import './notifications.css';

type Group = z.infer<typeof notificationListSchema>['groups'][number];
type Notification = z.infer<
  typeof notificationGroupItemsSchema
>['notifications'][number];
type Lane = z.infer<typeof notificationLaneSchema>;
type ReadSelection =
  { group: Pick<Group, 'key' | 'readThrough'> } | { itemId: string };

const notificationLabels: Record<Notification['kind'], string> = {
  requirementReview: '需求资料',
  assetReview: '用例评审',
  reportReady: '执行报告',
  scheduleCompleted: '定时执行',
  issueNotDefect: '非缺陷关闭',
  issueAssigned: '缺陷指派',
  issueRetest: '缺陷待复测',
  issueReturned: '复测退回',
  uploadInterrupted: '文件上传中断',
  agentReminder: '个人提醒',
  agentTaskReady: '定时任务结果',
};

export function NotificationBell({
  unreadCount,
  onClick,
}: {
  unreadCount: number | null;
  onClick: () => void;
}) {
  return (
    <Tooltip title={unreadCount === null ? '通知状态尚未取得' : '本人站内通知'}>
      <Badge
        className="notification-bell"
        count={unreadCount ?? 0}
        size="small"
        overflowCount={99}
      >
        <Button
          type="text"
          className="iconbtn"
          icon={<AppIcon name="bell" />}
          aria-label={
            unreadCount === null
              ? '打开本人通知（状态尚未取得）'
              : `打开本人通知，${unreadCount} 组待处理未读`
          }
          onClick={onClick}
        />
      </Badge>
    </Tooltip>
  );
}

function safeTarget(path: string): string | null {
  try {
    const url = new URL(path, window.location.origin);
    return url.origin === window.location.origin &&
      url.pathname === '/' &&
      url.hash.startsWith('#')
      ? url.pathname + url.hash
      : null;
  } catch {
    return null;
  }
}

function NotificationGroupItems({
  group,
  lane,
  pending,
  onOpen,
  onMark,
}: {
  group: Group;
  lane: Lane;
  pending: boolean;
  onOpen: (row: Notification) => void;
  onMark: (itemId: string) => void;
}) {
  const [rows, setRows] = useState(group.preview);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const generation = useRef(0);

  const load = useCallback(
    async (nextCursor?: string | null, signal?: AbortSignal) => {
      const epoch = ++generation.current;
      setLoading(true);
      setError(undefined);
      const query = new URLSearchParams({
        groupKey: group.key,
        lane,
        limit: '20',
      });
      if (nextCursor) query.set('cursor', nextCursor);
      try {
        const response = await api(
          `/me/notifications/groups?${query}`,
          signal ? { signal } : {},
          notificationGroupItemsSchema,
        );
        if (signal?.aborted || epoch !== generation.current) return;
        setRows((previous) =>
          nextCursor
            ? [
                ...previous,
                ...response.notifications.filter(
                  (row) => !previous.some((existing) => existing.id === row.id),
                ),
              ]
            : response.notifications,
        );
        setCursor(response.nextCursor);
      } catch (failure) {
        if (signal?.aborted || epoch !== generation.current) return;
        setError(describeError(failure));
        setRows([]);
        setCursor(null);
      } finally {
        if (!signal?.aborted && epoch === generation.current) setLoading(false);
      }
    },
    [group.key, lane],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(null, controller.signal);
    return () => {
      generation.current += 1;
      controller.abort();
    };
  }, [load]);

  return (
    <div className="notification-group-items">
      {error && (
        <Alert
          type="error"
          showIcon
          title={error}
          action={
            <Button size="small" onClick={() => void load()}>
              重试
            </Button>
          }
        />
      )}
      {loading && !rows.length && <Skeleton active paragraph={{ rows: 2 }} />}
      {!loading && !error && !rows.length && (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="暂无可查看的明细"
        />
      )}
      {rows.length > 0 && (
        <ul className="notification-items">
          {rows.map((row) => (
            <li key={row.id} className="notification-item">
              <div className="notification-item-copy">
                <strong>{row.title}</strong>
                <div className="notification-muted">
                  <BeijingTime value={row.createdAt} />
                  <span>{row.readAt ? '已读' : '未读'}</span>
                </div>
              </div>
              <Space size={4} wrap className="notification-item-actions">
                <Button
                  size="small"
                  aria-label={`查看关联对象，${row.title}`}
                  onClick={() => onOpen(row)}
                >
                  查看
                </Button>
                {!row.readAt && (
                  <Button
                    size="small"
                    type="text"
                    onClick={() => onMark(row.id)}
                    disabled={pending}
                  >
                    标为已读
                  </Button>
                )}
              </Space>
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <Button
          size="small"
          loading={loading}
          onClick={() => void load(cursor)}
        >
          加载更多明细
        </Button>
      )}
    </div>
  );
}

function GroupSummary({ group }: { group: Group }) {
  const context = [
    group.projectName,
    group.requirementTitle,
    group.requirementVersionNo === null
      ? null
      : `v${group.requirementVersionNo}`,
  ].filter(Boolean);
  return (
    <span className="notification-group-summary">
      <span className="notification-title-line">
        <strong>{group.title}</strong>
        {group.title !== notificationLabels[group.kind] && (
          <Tag>{notificationLabels[group.kind]}</Tag>
        )}
      </span>
      <span className="notification-muted">
        <span>{group.itemCount} 条</span>
        {group.unreadCount > 0 && <span>{group.unreadCount} 条未读</span>}
        {context.length > 0 && <span>{context.join(' · ')}</span>}
        <BeijingTime value={group.latestAt} />
      </span>
    </span>
  );
}

function NotificationGroupCard({
  group,
  expanded,
  onToggle,
  onMark,
  disabled,
  children,
}: {
  group: Group;
  expanded: boolean;
  onToggle: () => void;
  onMark: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  const detailId = useId();
  return (
    <article className="notification-group">
      <header className="notification-group-header">
        <button
          type="button"
          className="notification-group-toggle"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={detailId}
        >
          <AppIcon name="down" />
          <GroupSummary group={group} />
        </button>
        {group.unreadCount > 0 && (
          <Button
            size="small"
            disabled={disabled}
            onClick={onMark}
            aria-label={`整组已读，${group.title}`}
          >
            整组已读
          </Button>
        )}
      </header>
      <div id={detailId} hidden={!expanded}>
        {expanded && children}
      </div>
    </article>
  );
}

export function NotificationPanel({
  open,
  onClose,
  onNavigate,
  onUnreadCount,
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (projectId: string | null, target: string) => void;
  onUnreadCount: (count: number | null) => void;
}) {
  const [lane, setLane] = useState<Lane>('attention');
  const [groups, setGroups] = useState<Group[]>([]);
  const [badgeCount, setBadgeCount] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [detailsVersion, setDetailsVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const generation = useRef(0);

  const load = useCallback(
    async (cursor?: string | null, signal?: AbortSignal) => {
      const epoch = ++generation.current;
      setLoading(true);
      setError(undefined);
      const query = new URLSearchParams({
        lane: open ? lane : 'attention',
        limit: open ? '30' : '1',
        unreadOnly: String(open && unreadOnly),
      });
      if (cursor) query.set('cursor', cursor);
      try {
        const response = await api(
          `/me/notifications?${query}`,
          signal ? { signal } : {},
          notificationListSchema,
        );
        if (signal?.aborted || epoch !== generation.current) return;
        onUnreadCount(response.unreadCount);
        setBadgeCount(response.unreadCount);
        if (!open) return;
        setGroups((previous) =>
          cursor
            ? [
                ...previous,
                ...response.groups.filter(
                  (group) =>
                    !previous.some((existing) => existing.key === group.key),
                ),
              ]
            : response.groups,
        );
        setNextCursor(response.nextCursor);
        if (!cursor) setDetailsVersion((value) => value + 1);
      } catch (failure) {
        if (signal?.aborted || epoch !== generation.current) return;
        if (!cursor) {
          setGroups([]);
          setNextCursor(null);
        }
        setError(describeError(failure));
        onUnreadCount(null);
        setBadgeCount(null);
      } finally {
        if (!signal?.aborted && epoch === generation.current) setLoading(false);
      }
    },
    [lane, open, unreadOnly, onUnreadCount],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(null, controller.signal);
    return () => {
      generation.current += 1;
      controller.abort();
    };
  }, [load]);

  async function mark(selection: ReadSelection) {
    if (pending) return;
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    try {
      let count: number;
      if ('group' in selection) {
        const body = markNotificationGroupsReadSchema.parse({
          lane,
          groups: [
            {
              key: selection.group.key,
              readThrough: selection.group.readThrough,
            },
          ],
        });
        const receipt = await api(
          '/me/notifications/read-groups',
          { method: 'POST', body },
          markNotificationGroupsReadReceiptSchema,
        );
        count = receipt.readCount;
      } else {
        const body = markNotificationsReadSchema.parse({
          ids: [selection.itemId],
        });
        const receipt = await api(
          '/me/notifications/read',
          { method: 'POST', body },
          markNotificationsReadReceiptSchema,
        );
        count = receipt.readIds.length;
      }
      setNotice(count ? `已标记 ${count} 条为已读` : '当前无可标记的通知');
      await load();
    } catch (failure) {
      setError(`${describeError(failure)}。请重新读取通知核对已读状态。`);
    } finally {
      setPending(false);
    }
  }

  function openSource(row: Notification) {
    const target = safeTarget(row.targetPath);
    if (!target) {
      setError('此通知的关联对象无法打开。');
      return;
    }
    onNavigate(row.projectId, target);
  }

  return (
    <Drawer
      open={open}
      title="消息提醒"
      size="min(100vw, 620px)"
      onClose={onClose}
      destroyOnHidden
    >
      <div className="notification-panel">
        <div className="notification-controls">
          <Segmented
            aria-label="消息分类"
            value={lane}
            disabled={pending}
            options={[
              {
                label: badgeCount ? `待我处理 ${badgeCount}` : '待我处理',
                value: 'attention',
              },
              { label: '动态摘要', value: 'activity' },
            ]}
            onChange={(value) => {
              setLane(notificationLaneSchema.parse(value));
              setGroups([]);
              setNextCursor(null);
              setExpanded([]);
              setNotice(undefined);
            }}
          />
          <Space wrap>
            <Checkbox
              checked={unreadOnly}
              disabled={pending}
              onChange={(event) => {
                setUnreadOnly(event.target.checked);
                setGroups([]);
                setNextCursor(null);
                setExpanded([]);
                setNotice(undefined);
              }}
            >
              仅未读
            </Checkbox>
          </Space>
        </div>
        {error && (
          <Alert
            type="error"
            title={error}
            showIcon
            action={
              <Button
                loading={loading}
                disabled={pending}
                onClick={() => void load()}
              >
                重新读取通知
              </Button>
            }
          />
        )}
        {notice && (
          <span role="status" className="notification-muted">
            {notice}
          </span>
        )}
        {loading && !groups.length && (
          <Skeleton active paragraph={{ rows: 3 }} />
        )}
        {!loading && !error && !groups.length && (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              unreadOnly
                ? '暂无未读消息组'
                : lane === 'attention'
                  ? '暂无待处理消息'
                  : '暂无相关动态'
            }
          />
        )}
        {groups.length > 0 && (
          <div className="notification-groups">
            {groups.map((group) => (
              <NotificationGroupCard
                key={group.key}
                group={group}
                expanded={expanded.includes(group.key)}
                onToggle={() =>
                  setExpanded((keys) =>
                    keys.includes(group.key)
                      ? keys.filter((key) => key !== group.key)
                      : [...keys, group.key],
                  )
                }
                onMark={() => void mark({ group })}
                disabled={pending || loading}
              >
                <NotificationGroupItems
                  key={detailsVersion}
                  group={group}
                  lane={lane}
                  pending={pending || loading}
                  onOpen={openSource}
                  onMark={(itemId) => void mark({ itemId })}
                />
              </NotificationGroupCard>
            ))}
          </div>
        )}
        {nextCursor && (
          <Button
            loading={loading}
            disabled={pending}
            onClick={() => void load(nextCursor)}
          >
            加载更多
          </Button>
        )}
      </div>
    </Drawer>
  );
}
