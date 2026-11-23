import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Form,
  Input,
  Modal,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  CopyOutlined,
  EditOutlined,
  KeyOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import { z } from 'zod';
import {
  adminUserPageSchema,
  accountRemovalReceiptSchema,
} from '../../../packages/contracts/src/identity';
import type { AdminUser } from './types';
import { api, describeError, isUncertainMutationError } from './api';
import { currentIdentityOwner, identityContextEpoch } from './identity-context';
import {
  accountRemovalIntents,
  retainAccountRemoval,
  resolveAccountRemoval,
  type AccountRemovalIntent,
} from './account-removal-intents';

const resetReceiptSchema = z.object({
  resetCode: z.string(),
  expiresAt: z.string(),
});

export function PlatformUsers({
  onRefresh,
}: {
  onRefresh: () => Promise<void>;
}) {
  const { modal, message } = App.useApp();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [includeRemoved, setIncludeRemoved] = useState(false);
  const [removals, setRemovals] = useState<AccountRemovalIntent[]>([]);
  const [composing, setComposing] = useState(false);
  const loadEpoch = useRef(0);
  const queryRef = useRef({ query, page, pageSize, includeRemoved });
  queryRef.current = { query, page, pageSize, includeRemoved };
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [pending, setPending] = useState(false);
  const removalBusy = useRef(false);
  const [reset, setReset] = useState<{
    user: AdminUser;
    resetCode: string;
    expiresAt: string;
  }>();
  const [form] = Form.useForm<{ active: boolean; isPlatformAdmin: boolean }>();
  async function load(signal?: AbortSignal) {
    const requested = queryRef.current,
      epoch = ++loadEpoch.current,
      owner = currentIdentityOwner(),
      identity = identityContextEpoch();
    const current = () =>
      !signal?.aborted &&
      epoch === loadEpoch.current &&
      requested.query === queryRef.current.query &&
      requested.page === queryRef.current.page &&
      requested.pageSize === queryRef.current.pageSize &&
      requested.includeRemoved === queryRef.current.includeRemoved &&
      owner !== null &&
      owner === currentIdentityOwner() &&
      identity === identityContextEpoch();
    setLoading(true);
    try {
      const params = new URLSearchParams({
        search: requested.query,
        page: String(requested.page),
        pageSize: String(requested.pageSize),
        includeRemoved: String(requested.includeRemoved),
      });
      const result = await api(
        '/admin/users?' + params,
        signal ? { signal } : {},
        adminUserPageSchema,
      );
      if (current()) {
        setUsers(result.users);
        setRemovals(accountRemovalIntents(owner!));
        setTotal(result.total);
        const lastPage = Math.max(
          1,
          Math.ceil(result.total / requested.pageSize),
        );
        if (requested.page > lastPage) setPage(lastPage);
        setError(undefined);
      }
    } catch (err) {
      if (current()) setError(describeError(err));
    } finally {
      if (current()) setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [query, page, pageSize, includeRemoved]);
  useEffect(() => {
    if (composing) return;
    const timer = window.setTimeout(() => {
      setPage(1);
      setQuery(search.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search, composing]);

  async function save(values: { active: boolean; isPlatformAdmin: boolean }) {
    if (!editing) return;
    setPending(true);
    setError(undefined);
    try {
      await api(`/admin/users/${encodeURIComponent(editing.id)}`, {
        method: 'PUT',
        body: { ...values, rowVersion: editing.rowVersion },
      });
      setEditing(null);
      await onRefresh();
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }
  function assistReset(user: AdminUser) {
    modal.confirm({
      title: `协助重置「${user.displayName}（${user.account}）」的密码`,
      content:
        '请先人工核验账号本人身份。生成一次性重置凭据后，经安全渠道交给本人，由本人设置新密码。原密码不会被读取。',
      okText: '已核验，生成凭据',
      cancelText: '取消',
      onOk: async () => {
        try {
          const receipt = await api(
            `/admin/users/${encodeURIComponent(user.id)}/password-reset`,
            { method: 'POST', body: { rowVersion: user.rowVersion } },
            resetReceiptSchema,
          );
          setReset({ user, ...receipt });
        } catch (err) {
          setError(describeError(err));
          throw err;
        }
      },
    });
  }
  function remove(user: AdminUser) {
    const owner = currentIdentityOwner(),
      identity = identityContextEpoch();
    if (!owner || removalBusy.current || user.removedAt) return;
    modal.confirm({
      title: `移除账号「${user.displayName}（${user.account}）」`,
      content:
        '账号将不能登录，现有会话、个人Key与重置凭据会失效。原姓名、账号标识、项目关系、作者记录及所有业务和私聊数据保留，不会转交给其他人。',
      okText: '移除账号并保留数据',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        if (
          removalBusy.current ||
          currentIdentityOwner() !== owner ||
          identityContextEpoch() !== identity
        )
          throw Error('当前身份已变化，请重新核对移除目标。');
        const intent = {
          ownerId: owner,
          userId: user.id,
          commandId: crypto.randomUUID(),
          rowVersion: user.rowVersion,
        };
        removalBusy.current = true;
        setPending(true);
        try {
          retainAccountRemoval(intent);
          setRemovals(accountRemovalIntents(owner));
          const receipt = await api(
            `/admin/users/${encodeURIComponent(user.id)}`,
            {
              method: 'DELETE',
              body: {
                commandId: intent.commandId,
                rowVersion: intent.rowVersion,
              },
            },
            accountRemovalReceiptSchema,
          );
          if (
            receipt.commandId !== intent.commandId ||
            receipt.user.id !== user.id ||
            receipt.removedBy !== owner
          )
            throw Error('原移除回执目标不匹配，请保留原标识查询。');
          resolveAccountRemoval(intent);
          setRemovals(accountRemovalIntents(owner));
          if (
            currentIdentityOwner() === owner &&
            identityContextEpoch() === identity
          ) {
            void message.success('账号已移除，关联数据保留。');
            await onRefresh();
            if (
              currentIdentityOwner() === owner &&
              identityContextEpoch() === identity
            )
              await load();
          }
        } catch (failure) {
          if (
            !isUncertainMutationError(failure) &&
            failure instanceof Error &&
            'status' in failure
          )
            resolveAccountRemoval(intent);
          if (
            currentIdentityOwner() === owner &&
            identityContextEpoch() === identity
          ) {
            setError(describeError(failure));
            try {
              setRemovals(accountRemovalIntents(owner));
            } catch {
              // The original storage error remains visible; no new request is sent.
            }
          }
          throw failure;
        } finally {
          removalBusy.current = false;
          if (
            currentIdentityOwner() === owner &&
            identityContextEpoch() === identity
          )
            setPending(false);
        }
      },
    });
  }
  async function recoverRemoval(intent: AccountRemovalIntent) {
    const identity = identityContextEpoch();
    if (pending || currentIdentityOwner() !== intent.ownerId) return;
    setPending(true);
    try {
      const receipt = await api(
        `/admin/users/${encodeURIComponent(intent.userId)}/removal-receipts/${encodeURIComponent(intent.commandId)}`,
        {},
        accountRemovalReceiptSchema,
      );
      if (
        receipt.commandId !== intent.commandId ||
        receipt.user.id !== intent.userId ||
        receipt.removedBy !== intent.ownerId
      )
        throw Error('原移除回执不匹配，请保留记录核对。');
      resolveAccountRemoval(intent);
      if (
        currentIdentityOwner() === intent.ownerId &&
        identityContextEpoch() === identity
      ) {
        setRemovals(accountRemovalIntents(intent.ownerId));
        void message.success('已查回原移除回执，没有重复发送。');
        await load();
      }
    } catch (failure) {
      if (
        currentIdentityOwner() === intent.ownerId &&
        identityContextEpoch() === identity
      )
        setError(describeError(failure));
    } finally {
      if (
        currentIdentityOwner() === intent.ownerId &&
        identityContextEpoch() === identity
      )
        setPending(false);
    }
  }
  return (
    <Card title="平台账号管理">
      <Typography.Paragraph type="secondary">
        管理账号有效性、平台管理身份与协助重置。移除账号保留关联数据和作者记录。全局停用或移除不受项目最后管理员限制，受影响项目需另行补充管理员。
      </Typography.Paragraph>
      {error && (
        <Alert
          type="error"
          title={error}
          showIcon
          className="section-alert"
          action={
            <Button loading={loading} onClick={() => void load()}>
              重新读取账号
            </Button>
          }
        />
      )}
      <Input
        className="list-search"
        placeholder="搜索姓名或账号"
        aria-label="搜索平台账号"
        allowClear
        value={search}
        maxLength={100}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onChange={(event) => setSearch(event.target.value)}
      />
      <Checkbox
        checked={includeRemoved}
        onChange={(event) => {
          setPage(1);
          setIncludeRemoved(event.target.checked);
        }}
      >
        包含已移除账号
      </Checkbox>
      {removals.map((intent) => (
        <Alert
          key={intent.commandId}
          className="section-alert"
          type="warning"
          showIcon
          title={`账号移除回执待核对：${intent.userId}`}
          description="只查询原操作；暂未查到不代表原操作未发生。不会自动换标识再次移除。"
          action={
            <Button
              loading={pending}
              onClick={() => void recoverRemoval(intent)}
            >
              查询原移除回执
            </Button>
          }
        />
      ))}
      <Table<AdminUser>
        rowKey="id"
        dataSource={users}
        loading={loading}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          pageSizeOptions: [20, 50, 100],
          showTotal: (count) => '共 ' + count + ' 个账号',
          onChange: (next, size) => {
            setPage(next);
            setPageSize(size);
          },
        }}
        scroll={{ x: 700 }}
        columns={[
          { title: '姓名', dataIndex: 'displayName' },
          { title: '账号', dataIndex: 'account' },
          {
            title: '状态',
            render: (_, user) =>
              user.removedAt ? (
                <Tag>已移除</Tag>
              ) : user.active ? (
                <Tag color="green">有效</Tag>
              ) : (
                <Tag>已停用</Tag>
              ),
          },
          {
            title: '管理身份',
            render: (_, user) =>
              user.isPlatformAdmin ? (
                <Tag color="cyan">平台管理员</Tag>
              ) : (
                '普通账号'
              ),
          },
          {
            title: '操作',
            render: (_, user) => (
              <Space>
                <Button
                  icon={<EditOutlined />}
                  type="text"
                  disabled={pending || Boolean(user.removedAt)}
                  onClick={() => {
                    form.setFieldsValue({
                      active: user.active,
                      isPlatformAdmin: user.isPlatformAdmin,
                    });
                    setEditing(user);
                  }}
                >
                  编辑
                </Button>
                <Button
                  icon={<KeyOutlined />}
                  type="text"
                  disabled={pending || Boolean(user.removedAt)}
                  onClick={() => assistReset(user)}
                >
                  协助重置
                </Button>
                <Button
                  icon={<DeleteOutlined />}
                  type="text"
                  danger
                  disabled={
                    pending ||
                    Boolean(user.removedAt) ||
                    removals.some((intent) => intent.userId === user.id)
                  }
                  onClick={() => remove(user)}
                >
                  移除
                </Button>
              </Space>
            ),
          },
        ]}
      />
      <Modal
        title={
          editing
            ? `编辑账号：${editing.displayName}（${editing.account}）`
            : '编辑账号'
        }
        open={editing !== null}
        onCancel={() => setEditing(null)}
        onOk={() => form.submit()}
        okText="保存账号"
        cancelText="取消"
        confirmLoading={pending}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(values: { active: boolean; isPlatformAdmin: boolean }) =>
            void save(values)
          }
        >
          <Form.Item name="active" valuePropName="checked">
            <Checkbox disabled={pending}>账号有效</Checkbox>
          </Form.Item>
          <Form.Item name="isPlatformAdmin" valuePropName="checked">
            <Checkbox disabled={pending}>平台管理员</Checkbox>
          </Form.Item>
        </Form>
        <Typography.Paragraph type="secondary">
          停用影响后续 Web、MCP
          与文件访问；项目角色与历史记录保留。平台管理身份不隐含项目测试角色。
        </Typography.Paragraph>
      </Modal>
      <Modal
        title="一次性密码重置凭据"
        open={reset !== undefined}
        onCancel={() => setReset(undefined)}
        footer={
          <Button type="primary" onClick={() => setReset(undefined)}>
            已安全交付
          </Button>
        }
        destroyOnHidden
      >
        <Alert
          type="warning"
          showIcon
          title="凭据仅在此显示。请通过安全渠道交付给经过核验的本人，不放入聊天、项目资料或日志。"
        />
        <Descriptions
          className="section-alert"
          column={1}
          size="small"
          items={[
            { key: 'user', label: '账号', children: reset?.user.account },
            {
              key: 'expiresAt',
              label: '到期时间',
              children: reset
                ? new Date(reset.expiresAt).toLocaleString('zh-CN')
                : '',
            },
          ]}
        />
        <Input.Password
          className="one-time-value"
          readOnly
          value={reset?.resetCode ?? ''}
          aria-label="一次性重置凭据"
          autoComplete="off"
        />
        <Button
          icon={<CopyOutlined />}
          onClick={() => {
            if (reset)
              void navigator.clipboard
                .writeText(reset.resetCode)
                .then(() => message.success('已复制，请安全交付本人'))
                .catch(() => message.error('无法访问剪贴板，请手动复制'));
          }}
        >
          复制凭据
        </Button>
      </Modal>
    </Card>
  );
}
