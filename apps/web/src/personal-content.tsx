import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import { z } from 'zod';
import {
  aiPreferencesSchema,
  conversationDeletedSchema,
  conversationListSchema,
  conversationMutationSchema,
  deletionPreviewSchema,
  personalResourceListSchema,
  requirementGroupCandidatesSchema,
  requirementGroupMutationSchema,
} from '../../../packages/contracts/src/conversations';
import type {
  Conversation,
  PersonalResource,
} from '../../../packages/contracts/src/conversations';
import { api, describeError } from './api';
import { uiLayers } from './ui-layers';
import { downloadPrivateFile } from './file-channel';
import type { Project } from './types';
import { personalContentChanged } from './personal-content-events';

type DeleteTarget =
  | { type: 'conversation'; id: string; name: string }
  | { type: 'resource'; id: string; name: string };

function PermanentDelete({
  target,
  onClose,
  onDeleted,
}: {
  target: DeleteTarget | null;
  onClose: () => void;
  onDeleted: () => Promise<void>;
}) {
  const [preview, setPreview] = useState<z.infer<
    typeof deletionPreviewSchema
  > | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmed, setConfirmed] = useState(false);
  const [receipt, setReceipt] = useState<z.infer<
    typeof conversationDeletedSchema
  > | null>(null);
  const commandId = useRef(crypto.randomUUID());
  useEffect(() => {
    setPreview(null);
    setConfirmed(false);
    setReceipt(null);
    setError(undefined);
    commandId.current = crypto.randomUUID();
    if (!target) return;
    const controller = new AbortController();
    setLoading(true);
    const path =
      target.type === 'conversation'
        ? `/me/conversations/${target.id}/delete-preview`
        : `/me/resources/${target.id}/delete-preview`;
    void api(
      path,
      { method: 'POST', signal: controller.signal },
      deletionPreviewSchema,
    )
      .then((data) => {
        if (!controller.signal.aborted) setPreview(data);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(describeError(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [target]);
  async function commit() {
    if (!preview || !confirmed) return;
    const affected = target;
    if (!affected) return;
    setLoading(true);
    setError(undefined);
    try {
      const response = await api(
        '/me/conversations/delete',
        {
          method: 'POST',
          body: {
            commandId: commandId.current,
            previewId: preview.previewId,
            scopeDigest: preview.scopeDigest,
          },
        },
        conversationDeletedSchema,
      );
      setReceipt(response);
      personalContentChanged(
        affected.type === 'conversation'
          ? { type: 'conversationDeleted', conversationId: affected.id }
          : { type: 'resourceDeleted', resourceId: affected.id },
      );
      await onDeleted();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setLoading(false);
    }
  }
  return (
    <Modal
      zIndex={uiLayers.nestedDialog}
      title={target ? `永久删除：${target.name}` : '永久删除'}
      open={target !== null}
      onCancel={() => {
        if (!loading) onClose();
      }}
      width={720}
      closable={!loading}
      footer={
        <Space>
          <Button disabled={loading} onClick={onClose}>
            {receipt ? '关闭回执' : '取消'}
          </Button>
          {!receipt && (
            <Button
              danger
              type="primary"
              disabled={!preview || !confirmed}
              loading={loading}
              onClick={() => void commit()}
            >
              确认永久删除精确范围
            </Button>
          )}
        </Space>
      }
      destroyOnHidden
    >
      {error && (
        <Alert type="error" title={error} showIcon className="section-alert" />
      )}
      {preview && (
        <>
          <Alert
            type="warning"
            showIcon
            title="删除后立即停止产品访问，不设回收站或单独找回"
            description="独有文件进入回收处理；复用或正式副本保留。备份副本按不超过30天轮换，恢复需重新应用删除/撤权记录，不承诺所有物理字节瞬间抹除。"
          />
          <Space direction="vertical" className="section-alert">
            <Typography.Text>
              独有资源 {preview.exclusiveResourceIds.length} 项；保留复用资源{' '}
              {preview.retainedResourceIds.length} 项；关联本人会话{' '}
              {preview.affectedConversationIds.length} 项；当前任务{' '}
              {preview.activeTaskIds.length} 项。
            </Typography.Text>
            <Typography.Text code>
              目标 {preview.targetId} · 基准 {preview.rowVersion}
            </Typography.Text>
            <Typography.Text type="secondary">
              预览摘要 {preview.scopeDigest}；到期{' '}
              {new Date(preview.expiresAt).toLocaleString('zh-CN')}
            </Typography.Text>
          </Space>
          {!receipt && (
            <Checkbox
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            >
              已核对上述范围与不可恢复影响
            </Checkbox>
          )}
        </>
      )}
      {receipt && (
        <Alert
          type="success"
          showIcon
          title="永久删除已提交，产品访问已停止"
          description={`删除事件 ${receipt.deletionEventId}；文件回收${receipt.gcState === 'pending' ? '处理中' : '无需处理'}；恢复控制记录${receipt.controlLedger === 'recorded' ? '已登记' : '待同步，恢复应保持隔离核对'}。`}
          className="section-alert"
        />
      )}
    </Modal>
  );
}

export function ArchivedConversationsPanel() {
  const [rows, setRows] = useState<Conversation[]>([]);
  const [groups, setGroups] = useState<
    z.infer<typeof requirementGroupCandidatesSchema>['groups']
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [target, setTarget] = useState<DeleteTarget | null>(null);
  async function load(signal?: AbortSignal) {
    setLoading(true);
    try {
      const [response, archivedGroups] = await Promise.all([
        api(
          '/me/conversations?archived=true',
          signal ? { signal } : {},
          conversationListSchema,
        ),
        api(
          '/me/requirement-groups/archived',
          signal ? { signal } : {},
          requirementGroupCandidatesSchema,
        ),
      ]);
      if (!signal?.aborted) {
        setRows(response.conversations);
        setGroups(archivedGroups.groups);
        setError(undefined);
      }
    } catch (failure) {
      if (!signal?.aborted) {
        setRows([]);
        setGroups([]);
        setError(describeError(failure));
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, []);
  async function restore(conversation: Conversation) {
    setLoading(true);
    try {
      await api(
        `/me/conversations/${conversation.id}`,
        {
          method: 'PUT',
          body: {
            commandId: crypto.randomUUID(),
            rowVersion: conversation.rowVersion,
            archived: false,
          },
        },
        conversationMutationSchema,
      );
      personalContentChanged({
        type: 'conversationRestored',
        conversationId: conversation.id,
      });
      await load();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setLoading(false);
    }
  }
  async function restoreGroup(group: (typeof groups)[number]) {
    setLoading(true);
    try {
      await api(
        `/me/requirement-groups/${group.projectId}/${group.requirementId}`,
        {
          method: 'PUT',
          body: {
            commandId: crypto.randomUUID(),
            rowVersion: group.rowVersion,
            archived: false,
            hidden: false,
            expanded: true,
          },
        },
        requirementGroupMutationSchema,
      );
      personalContentChanged({
        type: 'requirementGroupRestored',
        projectId: group.projectId,
        requirementId: group.requirementId,
      });
      await load();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setLoading(false);
    }
  }
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Typography.Text>仅本人归档会话</Typography.Text>
      {error && (
        <Alert
          type="error"
          title={error}
          showIcon
          action={
            <Button loading={loading} onClick={() => void load()}>
              重新读取归档
            </Button>
          }
        />
      )}
      <Typography.Text type="secondary">
        恢复单个会话会同时显示其需求分组；不会恢复其他手工归档的会话。
      </Typography.Text>
      {groups.length > 0 && (
        <Table
          rowKey={(group) => `${group.projectId}:${group.requirementId}`}
          size="small"
          loading={loading}
          dataSource={groups}
          pagination={false}
          columns={[
            {
              title: '归档需求分组',
              render: (_, group) =>
                group.alias ?? group.generatedName ?? group.formalTitle,
            },
            {
              title: '操作',
              render: (_, group) => (
                <Button
                  disabled={loading}
                  onClick={() => void restoreGroup(group)}
                >
                  恢复整个分组
                </Button>
              ),
            },
          ]}
        />
      )}
      <Table
        rowKey="id"
        size="small"
        dataSource={rows}
        loading={loading}
        pagination={{ pageSize: 15 }}
        locale={{ emptyText: error ? '归档列表未能读取。' : '尚无归档会话。' }}
        columns={[
          {
            title: '对话',
            render: (_, conversation) =>
              conversation.alias ?? conversation.title,
          },
          {
            title: '归档时间',
            dataIndex: 'archivedAt',
            render: (value: string) => new Date(value).toLocaleString('zh-CN'),
          },
          {
            title: '操作',
            render: (_, conversation) => (
              <Space>
                <Button
                  disabled={loading}
                  onClick={() => void restore(conversation)}
                >
                  恢复到侧栏
                </Button>
                <Button
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() =>
                    setTarget({
                      type: 'conversation',
                      id: conversation.id,
                      name: conversation.alias ?? conversation.title,
                    })
                  }
                >
                  永久删除
                </Button>
              </Space>
            ),
          },
        ]}
      />
      <PermanentDelete
        target={target}
        onClose={() => setTarget(null)}
        onDeleted={() => load()}
      />
    </Space>
  );
}

export function PersonalResourcesPanel({ projects }: { projects: Project[] }) {
  const [resources, setResources] = useState<PersonalResource[]>([]);
  const [query, setQuery] = useState('');
  const [projectId, setProjectId] = useState('all');
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [target, setTarget] = useState<DeleteTarget | null>(null);
  const generation = useRef(0);
  async function load(signal?: AbortSignal, cursor?: string) {
    const epoch = ++generation.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({ query, limit: '30' });
      if (projectId === 'unassigned') params.set('scope', 'unassigned');
      else if (projectId !== 'all') params.set('projectId', projectId);
      if (cursor) params.set('cursor', cursor);
      const response = await api(
        `/me/resources?${params}`,
        signal ? { signal } : {},
        personalResourceListSchema,
      );
      if (!signal?.aborted && epoch === generation.current) {
        setResources((previous) =>
          cursor
            ? [
                ...previous,
                ...response.resources.filter(
                  (entry) => !previous.some((old) => old.id === entry.id),
                ),
              ]
            : response.resources,
        );
        setNext(response.nextCursor);
        setError(undefined);
      }
    } catch (failure) {
      if (!signal?.aborted && epoch === generation.current) {
        setResources([]);
        setNext(null);
        setError(describeError(failure));
      }
    } finally {
      if (!signal?.aborted && epoch === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    generation.current += 1;
    setLoading(true);
    setNext(null);
    setResources([]);
    const timer = window.setTimeout(() => void load(controller.signal), 250);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, projectId]);
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Typography.Paragraph type="secondary">
        仅本人个人资源。元数据字节校验与正文解析分开；正式资料和复用副本按实际引用保留。
      </Typography.Paragraph>
      <Space wrap>
        <Input
          aria-label="搜索个人资源"
          value={query}
          maxLength={500}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索原件名称"
        />
        <Select
          aria-label="个人资源关联范围"
          value={projectId}
          onChange={setProjectId}
          style={{ minWidth: 210 }}
          options={[
            { value: 'all', label: '本人全部资源' },
            { value: 'unassigned', label: '尚未关联' },
            ...projects.map((project) => ({
              value: project.id,
              label: project.name,
            })),
          ]}
        />
      </Space>
      {error && (
        <Alert
          type="error"
          title={error}
          showIcon
          action={
            <Button loading={loading} onClick={() => void load()}>
              重新读取资源
            </Button>
          }
        />
      )}
      <Table
        rowKey="id"
        size="small"
        dataSource={resources}
        loading={loading}
        pagination={false}
        scroll={{ x: 700 }}
        locale={{
          emptyText: error ? '资源未能读取。' : '此范围尚无个人资源。',
        }}
        columns={[
          { title: '原件', dataIndex: 'originalName' },
          {
            title: '校验/解析',
            render: (_, resource) => (
              <Space direction="vertical" size={0}>
                <Tag>
                  {resource.status === 'verified'
                    ? '字节已校验'
                    : resource.status}
                </Tag>
                <Typography.Text type="secondary">
                  {resource.textExtractionSupported
                    ? '类型支持尝试文本提取，未声明已读'
                    : '当前未支持文本解析'}
                </Typography.Text>
              </Space>
            ),
          },
          {
            title: '字节数/引用',
            render: (_, resource) =>
              `${BigInt(resource.bytes).toLocaleString('zh-CN')} 字节 · ${BigInt(resource.referenceCount).toLocaleString('zh-CN')} 处引用`,
          },
          {
            title: '操作',
            render: (_, resource) => (
              <Space>
                <Button
                  disabled={resource.status !== 'verified'}
                  onClick={() =>
                    void downloadPrivateFile(
                      resource.id,
                      resource.originalName,
                    ).catch((failure: unknown) =>
                      setError(describeError(failure)),
                    )
                  }
                >
                  下载原件
                </Button>
                <Button
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() =>
                    setTarget({
                      type: 'resource',
                      id: resource.id,
                      name: resource.originalName,
                    })
                  }
                >
                  永久删除
                </Button>
              </Space>
            ),
          },
        ]}
      />
      {next && (
        <Button loading={loading} onClick={() => void load(undefined, next)}>
          加载更多本人资源
        </Button>
      )}
      <PermanentDelete
        target={target}
        onClose={() => setTarget(null)}
        onDeleted={() => load()}
      />
    </Space>
  );
}

export function AiPreferencePanel() {
  const [data, setData] = useState<
    z.infer<typeof aiPreferencesSchema>['preferences'] | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [form] = Form.useForm<{
    defaultTarget: 'personal' | 'lastRequirement';
  }>();
  useEffect(() => {
    const controller = new AbortController();
    void api(
      '/me/ai-preferences',
      { signal: controller.signal },
      aiPreferencesSchema,
    )
      .then((response) => {
        if (!controller.signal.aborted) {
          setData(response.preferences);
          form.setFieldsValue(response.preferences);
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(describeError(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [form]);
  async function save(values: {
    defaultTarget: 'personal' | 'lastRequirement';
  }) {
    if (!data) return;
    setLoading(true);
    setError(undefined);
    try {
      const response = await api(
        '/me/ai-preferences',
        {
          method: 'PUT',
          body: {
            commandId: crypto.randomUUID(),
            rowVersion: data.rowVersion,
            defaultTarget: values.defaultTarget,
          },
        },
        aiPreferencesSchema,
      );
      setData(response.preferences);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setLoading(false);
    }
  }
  return (
    <>
      <Typography.Title level={5}>新聊天默认归属</Typography.Title>
      {error && <Alert type="error" showIcon title={error} />}
      {data && (
        <Form
          form={form}
          layout="vertical"
          onFinish={(values: {
            defaultTarget: 'personal' | 'lastRequirement';
          }) => void save(values)}
        >
          <Form.Item name="defaultTarget" label="左上新聊天默认位置">
            <Select
              disabled={loading}
              options={[
                { value: 'personal', label: '个人无项目对话' },
                { value: 'lastRequirement', label: '最近使用的本人需求' },
              ]}
            />
          </Form.Item>
          <Typography.Paragraph type="secondary">
            需求行的新对话仍明确归于该需求。最近需求已失效时，服务会建立个人对话并提示重新核对目标。
          </Typography.Paragraph>
          <Button type="primary" htmlType="submit" loading={loading}>
            保存默认归属
          </Button>
        </Form>
      )}
    </>
  );
}
