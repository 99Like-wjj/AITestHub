import { useEffect, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { z } from 'zod';
import {
  membersListSchema,
  memberCandidatesSchema,
  projectSchema,
  userSummarySchema,
} from '../../../packages/contracts/src/identity';
import { api, describeError } from './api';
import { roleLabels, roleOptions } from './types';
import type { Project, ProjectMember, Role } from './types';

const userSearchSchema = z.object({ users: z.array(userSummarySchema) });
const projectListSchema = z.object({ projects: z.array(projectSchema) });
type MemberCandidate = z.infer<typeof memberCandidatesSchema>['users'][number];

function UserPicker({
  projectId,
  onCandidate,
  id,
  value,
  onChange,
  multiple = false,
  disabled = false,
}: {
  projectId?: string;
  onCandidate?: (candidate: MemberCandidate | null) => void;
  id?: string;
  value?: string | string[];
  onChange?: (value: string | string[]) => void;
  multiple?: boolean;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [options, setOptions] = useState<{ value: string; label: string }[]>(
    [],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [candidates, setCandidates] = useState<MemberCandidate[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      void (
        projectId
          ? api(
              `/projects/${projectId}/member-candidates?search=${encodeURIComponent(search)}`,
              { signal: controller.signal },
              memberCandidatesSchema,
            )
          : api(
              `/users?search=${encodeURIComponent(search)}`,
              { signal: controller.signal },
              userSearchSchema,
            ).then((result) => ({
              users: result.users.map((user) => ({
                ...user,
                membership: null,
              })),
            }))
      )
        .then(({ users }) => {
          if (!controller.signal.aborted) {
            setCandidates(users);
            setOptions(
              users
                .filter((user) => user.active)
                .map((user) => ({
                  value: user.id,
                  label: `${user.displayName}（${user.account}）${user.membership?.active ? ' · 已为成员' : user.membership ? ' · 可重新添加' : ''}`,
                  disabled: Boolean(projectId && user.membership?.active),
                })),
            );
            setError(undefined);
          }
        })
        .catch((err: unknown) => {
          if (!controller.signal.aborted) setError(describeError(err));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [search, projectId]);
  return (
    <>
      <Select
        {...(id === undefined ? {} : { id })}
        aria-label="搜索注册账号"
        {...(multiple ? { mode: 'multiple' as const } : {})}
        {...(value === undefined ? {} : { value })}
        onChange={(next: string | string[]) => {
          onChange?.(next);
          if (typeof next === 'string')
            onCandidate?.(
              candidates.find((candidate) => candidate.id === next) ?? null,
            );
        }}
        disabled={disabled}
        showSearch
        filterOption={false}
        onSearch={setSearch}
        loading={loading}
        options={options}
        placeholder="搜索姓名或账号"
        notFoundContent={loading ? '加载中…' : '没有可选择的有效账号'}
        style={{ minWidth: 260, width: '100%' }}
      />
      {error && (
        <Typography.Text type="danger" role="alert">
          {error}
        </Typography.Text>
      )}
    </>
  );
}

function MemberEditor({
  project,
  member,
  open,
  onClose,
  onSaved,
}: {
  project: Project;
  member: ProjectMember | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form] = Form.useForm<{
    userId: string;
    isAdmin: boolean;
    roles: Role[];
  }>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [candidate, setCandidate] = useState<MemberCandidate | null>(null);
  useEffect(() => {
    if (open) {
      form.resetFields();
      form.setFieldsValue(
        member
          ? {
              userId: member.userId,
              isAdmin: member.isAdmin,
              roles: member.roles,
            }
          : { isAdmin: false, roles: [] },
      );
      setError(undefined);
      setCandidate(null);
    }
  }, [open, member, form]);
  async function save(values: {
    userId: string;
    isAdmin: boolean;
    roles: Role[];
  }) {
    setPending(true);
    setError(undefined);
    try {
      if (
        !member &&
        (!candidate ||
          candidate.id !== values.userId ||
          candidate.membership?.active)
      )
        throw new Error('请重新搜索并选择当前可添加的成员候选，再保存。');
      await api(
        `/projects/${encodeURIComponent(project.id)}/members/${encodeURIComponent(member?.userId ?? values.userId)}`,
        {
          method: 'PUT',
          body: {
            isAdmin: values.isAdmin,
            roles: values.roles,
            rowVersion:
              member?.rowVersion ?? candidate?.membership?.rowVersion ?? 0,
          },
        },
      );
      await onSaved();
      onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <Modal
      title={member ? `编辑成员：${member.displayName}` : '添加项目成员'}
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText="保存成员"
      cancelText="取消"
      confirmLoading={pending}
      destroyOnHidden
    >
      {error && (
        <Alert type="error" showIcon title={error} className="section-alert" />
      )}
      <Typography.Paragraph type="secondary">
        项目管理员管理成员与配置。测试审批、计划和执行组织须另有测试角色。
      </Typography.Paragraph>
      <Form
        form={form}
        layout="vertical"
        onFinish={(values: {
          userId: string;
          isAdmin: boolean;
          roles: Role[];
        }) => void save(values)}
      >
        {!member && (
          <Form.Item
            name="userId"
            label="注册账号"
            rules={[{ required: true, message: '请选择有效账号' }]}
          >
            <UserPicker
              projectId={project.id}
              onCandidate={setCandidate}
              disabled={pending}
            />
          </Form.Item>
        )}
        <Form.Item name="isAdmin" valuePropName="checked">
          <Checkbox disabled={pending}>项目管理员</Checkbox>
        </Form.Item>
        <Form.Item name="roles" label="业务角色">
          <Checkbox.Group disabled={pending} options={roleOptions} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

export function ProjectSettings({
  project,
  canManage,
  onMembershipChanged,
}: {
  project: Project | null;
  canManage: boolean;
  onMembershipChanged: () => Promise<void>;
}) {
  const { modal } = App.useApp();
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<ProjectMember | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  async function load(signal?: AbortSignal) {
    if (!project) {
      setMembers([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await api(
        `/projects/${encodeURIComponent(project.id)}/members`,
        signal ? { signal } : {},
        membersListSchema,
      );
      if (!signal?.aborted) {
        setMembers(result.members);
        setError(undefined);
      }
    } catch (err) {
      if (!signal?.aborted) {
        setMembers([]);
        setError(describeError(err));
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    setMembers([]);
    setEditorOpen(false);
    void load(controller.signal);
    return () => controller.abort();
  }, [project?.id]);

  async function saved() {
    await onMembershipChanged();
    await load();
  }
  function remove(member: ProjectMember) {
    if (!project) return;
    const projectId = project.id;
    modal.confirm({
      title: `移除「${member.displayName}（${member.account}）」？`,
      content: `将撤销其对「${project.name}」的后续访问，历史记录仍保留。需求参与关系失效，负责缺陷不自动改派。`,
      okText: '移除成员',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api(
            `/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(member.userId)}?rowVersion=${member.rowVersion}`,
            { method: 'DELETE' },
          );
          await saved();
        } catch (err) {
          setError(describeError(err));
          throw err;
        }
      },
    });
  }

  if (!project)
    return <Empty description="请先选择当前有效项目，再查看项目与设置。" />;
  return (
    <Card
      title="项目成员"
      extra={
        <Space>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => void load()}
            loading={loading}
          >
            刷新
          </Button>
          {canManage && (
            <Button
              icon={<PlusOutlined />}
              type="primary"
              onClick={() => {
                setEditing(null);
                setEditorOpen(true);
              }}
            >
              添加成员
            </Button>
          )}
        </Space>
      }
    >
      <Typography.Paragraph type="secondary">
        {project.name} · 管理身份与业务角色独立，变更按当前权限校验。
      </Typography.Paragraph>
      {error && (
        <Alert type="error" title={error} showIcon className="section-alert" />
      )}
      {!error && (
        <Table<ProjectMember>
          rowKey="userId"
          dataSource={members}
          loading={loading}
          pagination={{ pageSize: 20 }}
          scroll={{ x: 720 }}
          columns={[
            { title: '姓名', dataIndex: 'displayName' },
            { title: '账号', dataIndex: 'account' },
            {
              title: '账号状态',
              render: (_, member) =>
                member.active ? (
                  <Tag color="green">有效</Tag>
                ) : (
                  <Tag>已停用</Tag>
                ),
            },
            {
              title: '管理身份',
              render: (_, member) =>
                member.isAdmin ? <Tag color="cyan">项目管理员</Tag> : '成员',
            },
            {
              title: '业务角色',
              render: (_, member) =>
                member.roles.length ? (
                  member.roles.map((role) => (
                    <Tag key={role}>{roleLabels[role]}</Tag>
                  ))
                ) : (
                  <Typography.Text type="secondary">未授予</Typography.Text>
                ),
            },
            ...(canManage
              ? [
                  {
                    title: '操作',
                    key: 'actions',
                    render: (_: unknown, member: ProjectMember) => (
                      <Space>
                        <Button
                          type="text"
                          icon={<EditOutlined />}
                          onClick={() => {
                            setEditing(member);
                            setEditorOpen(true);
                          }}
                        >
                          编辑
                        </Button>
                        <Button
                          type="text"
                          danger
                          icon={<DeleteOutlined />}
                          onClick={() => remove(member)}
                        >
                          移除
                        </Button>
                      </Space>
                    ),
                  },
                ]
              : []),
          ]}
        />
      )}
      {canManage && (
        <MemberEditor
          project={project}
          member={editing}
          open={editorOpen}
          onClose={() => setEditorOpen(false)}
          onSaved={saved}
        />
      )}
    </Card>
  );
}

export function PlatformProjects({
  onRefresh,
}: {
  onRefresh: () => Promise<void>;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [form] = Form.useForm<{ name: string; administratorIds: string[] }>();
  async function load(signal?: AbortSignal) {
    setLoading(true);
    try {
      const result = await api(
        '/projects',
        signal ? { signal } : {},
        projectListSchema,
      );
      if (!signal?.aborted) {
        setProjects(result.projects);
        setError(undefined);
      }
    } catch (err) {
      if (!signal?.aborted) setError(describeError(err));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, []);
  async function create(values: { name: string; administratorIds: string[] }) {
    setPending(true);
    setError(undefined);
    try {
      await api('/projects', { method: 'POST', body: values });
      await load();
      await onRefresh();
      form.resetFields();
      setOpen(false);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }
  const selected =
    projects.find((project) => project.id === selectedId) ?? null;
  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card
        title="平台项目管理"
        extra={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setOpen(true)}
          >
            创建项目
          </Button>
        }
      >
        <Typography.Paragraph type="secondary">
          平台管理员创建项目并指定一名或多名项目管理员。平台管理身份不授予项目测试审批权。
        </Typography.Paragraph>
        {error && (
          <Alert
            type="error"
            title={error}
            showIcon
            className="section-alert"
            action={<Button onClick={() => void load()}>刷新</Button>}
          />
        )}
        <Table<Project>
          rowKey="id"
          loading={loading}
          dataSource={projects}
          pagination={{ pageSize: 15 }}
          columns={[
            { title: '项目名称', dataIndex: 'name' },
            {
              title: '项目 ID',
              dataIndex: 'id',
              render: (id: string) => (
                <Typography.Text code>{id}</Typography.Text>
              ),
            },
            {
              title: '管理',
              render: (_, project) => (
                <Button onClick={() => setSelectedId(project.id)}>
                  管理成员
                </Button>
              ),
            },
          ]}
        />
      </Card>
      {selected && (
        <ProjectSettings
          key={selected.id}
          project={selected}
          canManage
          onMembershipChanged={onRefresh}
        />
      )}
      <Modal
        title="创建项目"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        okText="创建项目"
        cancelText="取消"
        confirmLoading={pending}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(values: { name: string; administratorIds: string[] }) =>
            void create(values)
          }
        >
          <Form.Item
            name="name"
            label="项目名称"
            rules={[
              {
                required: true,
                whitespace: true,
                max: 200,
                message: '请输入项目名称（不超过 200 字符）',
              },
            ]}
          >
            <Input disabled={pending} maxLength={200} />
          </Form.Item>
          <Form.Item
            name="administratorIds"
            label="项目管理员"
            rules={[
              {
                required: true,
                type: 'array',
                min: 1,
                message: '至少指定一名有效项目管理员',
              },
            ]}
          >
            <UserPicker multiple disabled={pending} />
          </Form.Item>
        </Form>
        <Typography.Paragraph type="secondary">
          被指定账号同时成为项目成员；业务角色在成员管理中另行设置。
        </Typography.Paragraph>
      </Modal>
    </Space>
  );
}
