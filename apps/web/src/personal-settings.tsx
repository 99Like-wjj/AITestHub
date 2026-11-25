import { useEffect, useState } from 'react';
import {
  Alert,
  App,
  Avatar,
  Button,
  Checkbox,
  Form,
  Input,
  Modal,
  Segmented,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import {
  CloseOutlined,
  CopyOutlined,
  DeleteOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { api, describeError } from './api';
import { uiLayers } from './ui-layers';
import { registerNavigationBlocker } from './navigation-guard';
import { passwordRules } from './auth';
import { AvailableModelList } from './model-settings';
import { ExternalMcpPersonalKeys } from './external-mcp-settings';
import type { PersonalKey, Project, ThemeMode, User } from './types';
import {
  ArchivedConversationsPanel,
  AiPreferencePanel,
  PersonalResourcesPanel,
} from './personal-content';
import { PersonalUsagePanel } from './usage';
import {
  keysListSchema,
  capabilitySchema,
  type Capability,
  personalKeyCreatedSchema,
} from '../../../packages/contracts/src/identity';
import './personal-settings-page.css';
import { AgentMemoryPanel } from './agent-memory';
import { AgentSchedules } from './agent-schedules';

type KeyForm = {
  name: string;
  privateData?: boolean;
  projectManagement?: boolean;
  platformManagement?: boolean;
};
const protectedKeyScopes: Capability[] = [
  'personal.data',
  'project.members.manage',
  'platform.manage',
  'personal-key.manage',
];

function KeySettings({ user }: { user: User }) {
  const { modal, message } = App.useApp();
  const [keys, setKeys] = useState<PersonalKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [rawKey, setRawKey] = useState<string>();
  const [form] = Form.useForm<KeyForm>();

  async function load(signal?: AbortSignal) {
    setLoading(true);
    try {
      const response = await api(
        '/me/keys',
        signal ? { signal } : {},
        keysListSchema,
      );
      setKeys(response.keys);
      setError(undefined);
    } catch (err) {
      if (signal?.aborted) return;
      setError(describeError(err));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, []);

  async function create(values: KeyForm) {
    setPending(true);
    setError(undefined);
    try {
      const result = await api(
        '/me/keys',
        {
          method: 'POST',
          body: {
            name: values.name,
            allowedCapabilities: [
              ...capabilitySchema.options.filter(
                (scope) => !protectedKeyScopes.includes(scope),
              ),
              ...(values.privateData ? ['personal.data'] : []),
              ...(values.projectManagement ? ['project.members.manage'] : []),
              ...(values.platformManagement && user.isPlatformAdmin
                ? ['platform.manage']
                : []),
            ],
          },
        },
        personalKeyCreatedSchema,
      );
      setRawKey(result.rawKey);
      setKeys((current) => [result.key, ...current]);
      form.resetFields();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  function revoke(key: PersonalKey) {
    modal.confirm({
      title: `撤销「${key.name}」？`,
      content:
        '使用此 Key 的后续 MCP 和文件请求将被拒绝，其他 Key 和浏览器会话保持独立。',
      okText: '撤销 Key',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api(`/me/keys/${encodeURIComponent(key.id)}`, {
            method: 'DELETE',
          });
          await load();
        } catch (err) {
          setError(describeError(err));
          throw err;
        }
      },
    });
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Typography.Paragraph type="secondary">
        个人 Key 用于官方 MCP。Key
        按当前账号权限生效，可分别撤销。完整值仅在创建后显示一次，请在本地客户端安全配置。
      </Typography.Paragraph>
      {error && (
        <Alert
          type="error"
          title={error}
          showIcon
          action={<Button onClick={() => void load()}>刷新状态</Button>}
        />
      )}
      <Form
        form={form}
        layout="inline"
        onFinish={(values: KeyForm) => void create(values)}
      >
        <Form.Item
          name="name"
          label="Key 名称"
          rules={[
            {
              required: true,
              whitespace: true,
              max: 80,
              message: '请输入名称（不超过 80 字符）',
            },
          ]}
        >
          <Input maxLength={80} disabled={pending} />
        </Form.Item>
        <Form.Item name="privateData" valuePropName="checked">
          <Checkbox disabled={pending}>本人工作台</Checkbox>
        </Form.Item>
        <Form.Item name="projectManagement" valuePropName="checked">
          <Checkbox disabled={pending}>项目管理提案</Checkbox>
        </Form.Item>
        {user.isPlatformAdmin && (
          <Form.Item name="platformManagement" valuePropName="checked">
            <Checkbox disabled={pending}>平台管理提案</Checkbox>
          </Form.Item>
        )}
        <Form.Item>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            htmlType="submit"
            loading={pending}
          >
            创建 Key
          </Button>
        </Form.Item>
      </Form>
      <Table<PersonalKey>
        size="small"
        rowKey="id"
        dataSource={keys}
        loading={loading}
        pagination={false}
        scroll={{ x: 540 }}
        columns={[
          { title: '名称', dataIndex: 'name' },
          {
            title: '标识',
            dataIndex: 'prefix',
            render: (value: string) => (
              <Typography.Text code>{value}…</Typography.Text>
            ),
          },
          {
            title: '状态',
            render: (_, key) =>
              key.revokedAt ? <Tag>已撤销</Tag> : <Tag color="green">有效</Tag>,
          },
          {
            title: '创建时间',
            dataIndex: 'createdAt',
            render: (value: string) => new Date(value).toLocaleString('zh-CN'),
          },
          {
            title: '操作',
            render: (_, key) => (
              <Button
                type="text"
                danger
                icon={<DeleteOutlined />}
                disabled={key.revokedAt !== null}
                onClick={() => revoke(key)}
              >
                撤销
              </Button>
            ),
          },
        ]}
      />
      <Modal
        title="保存此 Key"
        zIndex={uiLayers.nestedDialog}
        open={rawKey !== undefined}
        onCancel={() => setRawKey(undefined)}
        footer={
          <Button type="primary" onClick={() => setRawKey(undefined)}>
            已安全保存
          </Button>
        }
        destroyOnHidden
      >
        <Alert
          type="warning"
          showIcon
          title="关闭后无法再次查看完整 Key。请勿粘贴到聊天、项目文件或日志。"
        />
        <Input.Password
          className="one-time-value"
          readOnly
          value={rawKey ?? ''}
          aria-label="新建的个人 Key"
          autoComplete="off"
        />
        <Button
          icon={<CopyOutlined />}
          onClick={() => {
            if (rawKey)
              void navigator.clipboard
                .writeText(rawKey)
                .then(() => message.success('已复制，请仅粘贴至本地安全配置'))
                .catch(() => message.error('无法访问剪贴板，请手动复制'));
          }}
        >
          复制 Key
        </Button>
      </Modal>
    </Space>
  );
}

export function PersonalSettings({
  initialTab,
  onTabChange,
  user,
  onClose,
  onRefresh,
  onPasswordChanged,
  onLogout,
  projects,
}: {
  initialTab?: string;
  onTabChange: (tab: string) => void;
  user: User;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onPasswordChanged: () => void;
  onLogout: () => Promise<void>;
  projects: Project[];
}) {
  const { message, modal } = App.useApp();
  const tabOrder = [
    'profile',
    'security',
    'appearance',
    'memory',
    'agent-schedules',
    'usage',
    'archive',
    'resources',
    'keys',
    'models',
  ];
  const [compactMenu, setCompactMenu] = useState(
    () => window.matchMedia('(max-width: 700px)').matches,
  );
  useEffect(() => {
    const media = window.matchMedia('(max-width: 700px)');
    const changed = () => setCompactMenu(media.matches);
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  const [activeTab, setActiveTab] = useState(initialTab ?? 'profile');
  useEffect(() => {
    if (initialTab) setActiveTab(initialTab);
  }, [initialTab]);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [profileForm] = Form.useForm<{ displayName: string }>();
  const [passwordForm] = Form.useForm<{
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
  }>();
  const displayName = Form.useWatch('displayName', {
    form: profileForm,
    preserve: true,
  });
  const currentPassword = Form.useWatch('currentPassword', {
    form: passwordForm,
    preserve: true,
  });
  const newPassword = Form.useWatch('newPassword', {
    form: passwordForm,
    preserve: true,
  });
  const confirmPassword = Form.useWatch('confirmPassword', {
    form: passwordForm,
    preserve: true,
  });
  const dirty =
    (displayName !== undefined && displayName !== user.displayName) ||
    Boolean(currentPassword || newPassword || confirmPassword);

  useEffect(() => {
    profileForm.setFieldsValue({ displayName: user.displayName });
    setError(undefined);
  }, [user.displayName, profileForm]);
  useEffect(() => {
    if (!pending && !dirty) return;
    const unregister = registerNavigationBlocker((proceed) => {
      if (pending) {
        void message.info('个人设置正在提交，请先等待本次回执。');
        return;
      }
      modal.confirm({
        title: '放弃未保存的个人设置？',
        content: '姓名或密码尚未保存，离开后需要重新填写。',
        okText: '放弃并离开',
        cancelText: '继续编辑',
        zIndex: uiLayers.confirmation,
        onOk: proceed,
      });
    });
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      unregister();
      window.removeEventListener('beforeunload', warn);
    };
  }, [pending, dirty, message, modal]);

  async function updateProfile(body: {
    displayName?: string;
    theme?: ThemeMode;
  }) {
    setPending(true);
    setError(undefined);
    try {
      await api('/me', {
        method: 'PUT',
        body: {
          displayName: user.displayName,
          theme: user.theme,
          ...body,
          rowVersion: user.rowVersion,
        },
      });
      await onRefresh();
      void message.success('个人设置已保存');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  async function updatePassword(values: {
    currentPassword: string;
    newPassword: string;
  }) {
    setPending(true);
    setError(undefined);
    try {
      await api('/me/password', {
        method: 'POST',
        body: {
          currentPassword: values.currentPassword,
          newPassword: values.newPassword,
        },
      });
      passwordForm.resetFields();
      onPasswordChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      className="personal-settings-page"
      aria-labelledby="personal-settings-title"
    >
      <header className="personal-settings-page-header">
        <h1 id="personal-settings-title">个人设置</h1>
        <Button
          type="text"
          className="personal-settings-close"
          icon={<CloseOutlined />}
          aria-label="关闭个人设置，返回 AI 工作台"
          title="返回 AI 工作台"
          disabled={pending}
          onClick={onClose}
        />
      </header>
      {error && (
        <Alert
          className="personal-settings-page-error section-alert"
          type="error"
          title={error}
          showIcon
        />
      )}
      <Tabs
        className="personal-settings-tabs personal-settings-page-body"
        tabPlacement={compactMenu ? 'top' : 'start'}
        activeKey={activeTab}
        onChange={(tab) => {
          setActiveTab(tab);
          onTabChange(tab);
        }}
        destroyOnHidden
        items={[
          {
            key: 'agent-schedules',
            label: '提醒与定时任务',
            children: <AgentSchedules />,
          },
          { key: 'memory', label: '个人记忆', children: <AgentMemoryPanel /> },
          {
            key: 'profile',
            label: '基本资料',
            children: (
              <>
                <div className="row mb">
                  <Avatar size={42}>{user.displayName.slice(0, 2)}</Avatar>
                  <div>
                    <h2>{user.displayName}</h2>
                    <p className="caption">{user.account}</p>
                  </div>
                </div>
                <Form
                  form={profileForm}
                  layout="vertical"
                  onFinish={(values: { displayName: string }) =>
                    void updateProfile(values)
                  }
                >
                  <div className="formgrid">
                    <Form.Item label="账号（登录标识）">
                      <Input value={user.account} readOnly />
                    </Form.Item>
                    <Form.Item
                      name="displayName"
                      label="姓名"
                      rules={[
                        {
                          required: true,
                          whitespace: true,
                          max: 50,
                          message: '请输入 1–50 个字符的姓名',
                        },
                      ]}
                    >
                      <Input maxLength={50} disabled={pending} />
                    </Form.Item>
                  </div>
                  <p className="caption mb">
                    姓名显示于协作名单；账号作为稳定登录标识，不因改姓名而改变。
                  </p>
                  <Button htmlType="submit" type="primary" loading={pending}>
                    保存资料
                  </Button>
                  <Button
                    className="personal-logout"
                    disabled={pending}
                    onClick={() => {
                      setPending(true);
                      void onLogout().catch((error) => {
                        setError(describeError(error));
                        setPending(false);
                      });
                    }}
                  >
                    退出登录
                  </Button>
                </Form>
              </>
            ),
          },
          {
            key: 'appearance',
            label: '外观与偏好',
            children: (
              <Space direction="vertical" size="middle">
                <Typography.Paragraph>
                  外观按账号保存。选择“跟随系统”后，页面随操作系统明暗变化。
                </Typography.Paragraph>
                <Segmented<ThemeMode>
                  value={user.theme}
                  disabled={pending}
                  options={[
                    { value: 'light', label: '浅色' },
                    { value: 'dark', label: '深色' },
                    { value: 'system', label: '跟随系统' },
                  ]}
                  onChange={(theme) => void updateProfile({ theme })}
                />
                <AiPreferencePanel />
              </Space>
            ),
          },
          {
            key: 'security',
            label: '账号安全',
            children: (
              <>
                <Typography.Paragraph type="secondary">
                  修改密码后现有浏览器会话失效，请重新登录。个人 MCP Key
                  可在独立页签管理。
                </Typography.Paragraph>
                <Form
                  form={passwordForm}
                  layout="vertical"
                  onFinish={(values: {
                    currentPassword: string;
                    newPassword: string;
                  }) => void updatePassword(values)}
                >
                  <Form.Item
                    name="currentPassword"
                    label="当前密码"
                    rules={[{ required: true, message: '请输入当前密码' }]}
                  >
                    <Input.Password
                      autoComplete="current-password"
                      disabled={pending}
                    />
                  </Form.Item>
                  <Form.Item
                    name="newPassword"
                    label="新密码"
                    rules={passwordRules}
                  >
                    <Input.Password
                      autoComplete="new-password"
                      maxLength={128}
                      disabled={pending}
                    />
                  </Form.Item>
                  <Form.Item
                    name="confirmPassword"
                    label="确认新密码"
                    dependencies={['newPassword']}
                    rules={[
                      { required: true, message: '请再次输入新密码' },
                      ({ getFieldValue }) => ({
                        validator(_, value: unknown) {
                          return value === getFieldValue('newPassword')
                            ? Promise.resolve()
                            : Promise.reject(new Error('两次密码不一致'));
                        },
                      }),
                    ]}
                  >
                    <Input.Password
                      autoComplete="new-password"
                      disabled={pending}
                    />
                  </Form.Item>
                  <Button type="primary" htmlType="submit" loading={pending}>
                    修改密码
                  </Button>
                </Form>
              </>
            ),
          },
          {
            key: 'models',
            label: '可用模型',
            children: <AvailableModelList />,
          },
          {
            key: 'keys',
            label: '个人 Key',
            children: (
              <>
                <KeySettings user={user} />
                <div className="divider" />
                <ExternalMcpPersonalKeys />
                <Button
                  className="mt"
                  onClick={() => {
                    onClose();
                    window.location.hash = 'external-mcp';
                  }}
                >
                  查看本人外部工具调用
                </Button>
              </>
            ),
          },
          {
            key: 'usage',
            label: '个人 AI 用量',
            children: <PersonalUsagePanel />,
          },
          {
            key: 'archive',
            label: '归档聊天',
            children: <ArchivedConversationsPanel />,
          },
          {
            key: 'resources',
            label: '资源管理',
            children: <PersonalResourcesPanel projects={projects} />,
          },
        ].sort(
          (left, right) =>
            tabOrder.indexOf(left.key) - tabOrder.indexOf(right.key),
        )}
      />
    </section>
  );
}
