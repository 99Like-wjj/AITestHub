import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Drawer,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { AppIcon } from './app-icon';
import { z } from 'zod';
import {
  notificationListSchema,
  markNotificationsReadSchema,
  markNotificationsReadReceiptSchema,
} from '../../../packages/contracts/src/notifications';
import { api, describeError } from './api';

type Notification = z.infer<
  typeof notificationListSchema
>['notifications'][number];
const notificationLabels: Record<Notification['kind'], string> = {
  requirementReview: '需求资料',
  assetReview: '用例评审',
  reportReady: '执行报告',
  scheduleCompleted: '定时运行完成',
  issueNotDefect: '非缺陷决定',
  uploadInterrupted: '文件上传中断',
};
export function NotificationBell({
  unreadCount,
  onClick,
}: {
  unreadCount: number | null;
  onClick: () => void;
}) {
  return (
    <Tooltip
      title={unreadCount === null ? '通知未读状态尚未取得' : '本人站内通知'}
    >
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
              : `打开本人通知，${unreadCount}条未读`
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
  const [rows, setRows] = useState<Notification[]>([]);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const generation = useRef(0);
  async function load(append = false, signal?: AbortSignal) {
    const epoch = ++generation.current;
    setLoading(true);
    setError(undefined);
    const query = new URLSearchParams({
      limit: '30',
      unreadOnly: String(unreadOnly),
    });
    if (append && nextCursor) query.set('cursor', nextCursor);
    try {
      const response = await api(
        `/me/notifications?${query}`,
        signal ? { signal } : {},
        notificationListSchema,
      );
      if (signal?.aborted || epoch !== generation.current) return;
      setRows((previous) =>
        append
          ? [
              ...previous,
              ...response.notifications.filter(
                (row) => !previous.some((existing) => existing.id === row.id),
              ),
            ]
          : response.notifications,
      );
      setNextCursor(response.nextCursor);
      onUnreadCount(response.unreadCount);
      if (!append) setSelected([]);
    } catch (failure) {
      if (!signal?.aborted && epoch === generation.current) {
        if (!append) setRows([]);
        setError(describeError(failure));
        onUnreadCount(null);
      }
    } finally {
      if (!signal?.aborted && epoch === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void load(false, controller.signal);
    return () => controller.abort();
  }, [unreadOnly, open]);
  async function mark(ids: string[]) {
    if (!ids.length || pending) return;
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const body = markNotificationsReadSchema.parse({ ids });
      const receipt = await api(
        '/me/notifications/read',
        { method: 'POST', body },
        markNotificationsReadReceiptSchema,
      );
      setNotice(
        `服务端已确认 ${receipt.readIds.length}/${ids.length} 条本人通知为已读；当前权限已变化的条目以刷新结果为准。`,
      );
      await load();
    } catch (failure) {
      setError(
        `${describeError(failure)}；先只读刷新核对原通知状态，不自动重复标记。`,
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <Drawer
      open={open}
      title="本人站内通知"
      width={850}
      onClose={onClose}
      destroyOnHidden
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Typography.Paragraph type="secondary">
          通知按当前本人和项目权限读取。打开通知、进入关联页面都不会自动标记已读；已读不批准、不执行、不改变业务状态。
        </Typography.Paragraph>
        {error && <Alert type="error" title={error} showIcon />}
        {notice && <Alert type="info" title={notice} showIcon />}
        <Space wrap>
          <Checkbox
            checked={unreadOnly}
            disabled={pending}
            onChange={(event) => {
              setUnreadOnly(event.target.checked);
              setSelected([]);
              setNotice(undefined);
            }}
          >
            仅未读
          </Checkbox>
          <Button
            loading={loading}
            disabled={pending}
            onClick={() => void load()}
          >
            只读刷新
          </Button>
          <Button
            disabled={pending || !selected.length}
            loading={pending}
            onClick={() => void mark(selected)}
          >
            明确标记所选 {selected.length} 条已读
          </Button>
        </Space>
        <Table
          rowKey="id"
          loading={loading}
          pagination={false}
          dataSource={rows}
          scroll={{ x: 650 }}
          rowSelection={{
            selectedRowKeys: selected,
            onChange: (keys) => setSelected(keys.map(String)),
            getCheckboxProps: (row) => ({
              disabled: pending || Boolean(row.readAt),
            }),
            preserveSelectedRowKeys: true,
          }}
          locale={{
            emptyText: error ? '通知尚未取得。' : '当前范围没有可读通知。',
          }}
          columns={[
            {
              title: '通知',
              render: (_, row) => (
                <Space direction="vertical">
                  <Typography.Text strong>{row.title}</Typography.Text>
                  <Typography.Text type="secondary">
                    {row.createdAt}
                  </Typography.Text>
                  <Tag>{notificationLabels[row.kind]}</Tag>
                </Space>
              ),
            },
            {
              title: '状态',
              render: (_, row) =>
                row.readAt ? `已读 · ${row.readAt}` : '未读',
            },
            {
              title: '操作',
              render: (_, row) => (
                <Space direction="vertical">
                  <Button
                    onClick={() => {
                      const target = safeTarget(row.targetPath);
                      if (!target) {
                        setError('此通知目标不是可打开的平台同源页面。');
                        return;
                      }
                      onNavigate(row.projectId, target);
                    }}
                  >
                    查看关联对象
                  </Button>
                  <Button
                    disabled={pending || Boolean(row.readAt)}
                    onClick={() => void mark([row.id])}
                  >
                    明确标记此条已读
                  </Button>
                </Space>
              ),
            },
          ]}
        />
        {nextCursor && (
          <Button
            loading={loading}
            disabled={pending}
            onClick={() => void load(true)}
          >
            加载更早的本人通知
          </Button>
        )}
      </Space>
    </Drawer>
  );
}
