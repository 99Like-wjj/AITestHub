import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Input,
  Modal,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { z } from 'zod';
import {
  historyCandidatesSchema,
  personalResourceListSchema,
} from '../../../packages/contracts/src/conversations';
import type { ConversationReferenceInput } from '../../../packages/contracts/src/conversations';
import { assetNavigationSchema } from '../../../packages/contracts/src/assets';
import { api, describeError } from './api';
import { uiLayers } from './ui-layers';
const KnowledgeReferenceCandidates = lazy(() =>
  import('./knowledge').then((module) => ({
    default: module.KnowledgeReferenceCandidates,
  })),
);
const ExternalMcpReferenceCandidates = lazy(() =>
  import('./external-mcp-settings').then((module) => ({
    default: module.ExternalMcpReferenceCandidates,
  })),
);

export interface PreparedReference {
  id: string;
  label: string;
  reference: ConversationReferenceInput;
  note: string;
  insertions?: import('./workspace-drafts').ComposerInsertion[] | undefined;
}
export type ReferenceTab =
  'history' | 'resources' | 'requirements' | 'knowledge' | 'external';
export function ReferencePicker({
  open,
  initialTab,
  projectId,
  remaining,
  onClose,
  onAdd,
}: {
  open: boolean;
  initialTab: ReferenceTab;
  projectId: string | null;
  remaining: number;
  onClose: () => void;
  onAdd: (reference: PreparedReference) => void;
}) {
  const [tab, setTab] = useState<ReferenceTab>(initialTab);
  const [query, setQuery] = useState('');
  const [fullRead, setFullRead] = useState(false);
  const [histories, setHistories] = useState<
    z.infer<typeof historyCandidatesSchema>['conversations']
  >([]);
  const [resources, setResources] = useState<
    z.infer<typeof personalResourceListSchema>['resources']
  >([]);
  const [requirements, setRequirements] = useState<
    z.infer<typeof assetNavigationSchema>['requirements']
  >([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setQuery('');
      setFullRead(false);
      setError(undefined);
    }
  }, [open, initialTab]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    generation.current += 1;
    setLoading(true);
    if (tab === 'history') setHistories([]);
    if (tab === 'resources') setResources([]);
    if (tab === 'requirements') setRequirements([]);
    const timer = window.setTimeout(
      () => {
        setLoading(true);
        setError(undefined);
        setNextCursor(null);
        const operation =
          tab === 'history'
            ? api(
                `/me/conversations/history-candidates?query=${encodeURIComponent(query)}`,
                { signal: controller.signal },
                historyCandidatesSchema,
              ).then((data) => {
                if (!controller.signal.aborted)
                  setHistories(data.conversations);
              })
            : tab === 'resources'
              ? api(
                  `/me/resources?query=${encodeURIComponent(query)}&limit=30`,
                  { signal: controller.signal },
                  personalResourceListSchema,
                ).then((data) => {
                  if (!controller.signal.aborted) {
                    setResources(data.resources);
                    setNextCursor(data.nextCursor);
                  }
                })
              : tab === 'requirements' && projectId
                ? api(
                    `/projects/${projectId}/assets/navigation?kind=UI`,
                    { signal: controller.signal },
                    assetNavigationSchema,
                  ).then((data) => {
                    if (!controller.signal.aborted)
                      setRequirements(data.requirements);
                  })
                : Promise.resolve();
        void operation
          .catch((err: unknown) => {
            if (!controller.signal.aborted) setError(describeError(err));
          })
          .finally(() => {
            if (!controller.signal.aborted) setLoading(false);
          });
      },
      tab === 'history' || tab === 'resources' ? 250 : 0,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, tab, query, projectId]);
  async function moreResources() {
    if (!nextCursor) return;
    const epoch = generation.current;
    setLoading(true);
    try {
      const result = await api(
        `/me/resources?query=${encodeURIComponent(query)}&cursor=${nextCursor}&limit=30`,
        {},
        personalResourceListSchema,
      );
      if (epoch !== generation.current) return;
      setResources((current) => [
        ...current,
        ...result.resources.filter(
          (item) => !current.some((previous) => previous.id === item.id),
        ),
      ]);
      setNextCursor(result.nextCursor);
    } catch (err) {
      if (epoch === generation.current) setError(describeError(err));
    } finally {
      if (epoch === generation.current) setLoading(false);
    }
  }
  function add(
    reference: ConversationReferenceInput,
    label: string,
    note: string,
  ) {
    if (remaining <= 0 || loading) return;
    onAdd({ id: crypto.randomUUID(), reference, label, note });
    onClose();
  }
  return (
    <Modal
      title="选择本次引用"
      zIndex={uiLayers.dialog}
      open={open}
      onCancel={onClose}
      width={920}
      footer={<Button onClick={onClose}>关闭候选</Button>}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">
        选中仅准备引用，不表示资料已读。发送时按当前权限冻结范围，实际解析/可读性以平台过程回执为准；不默认读取整项目或全知识库。
      </Typography.Paragraph>
      {remaining <= 0 && (
        <Alert
          type="warning"
          showIcon
          title="本条消息最多 30 个引用，请先移除已有选择。"
        />
      )}
      {error && (
        <Alert type="error" showIcon title={error} className="section-alert" />
      )}
      <Tabs
        activeKey={tab}
        onChange={(key) => {
          if (
            key === 'history' ||
            key === 'resources' ||
            key === 'requirements' ||
            key === 'knowledge' ||
            key === 'external'
          )
            setTab(key);
        }}
        items={[
          {
            key: 'history',
            label: '本人历史',
            children: (
              <>
                <Input
                  aria-label="搜索本人历史"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  maxLength={500}
                  placeholder="默认最近 5 条，关键词查找更早的本人对话"
                  className="section-alert"
                />
                <Checkbox
                  checked={fullRead}
                  onChange={(event) => setFullRead(event.target.checked)}
                >
                  明确通读所选对话（默认仅相关片段）
                </Checkbox>
                <Table
                  rowKey="id"
                  size="small"
                  dataSource={histories}
                  loading={loading}
                  pagination={false}
                  locale={{
                    emptyText: error
                      ? '候选未能读取。'
                      : '没有匹配的本人历史候选。',
                  }}
                  columns={[
                    {
                      title: '对话',
                      render: (_, conversation) =>
                        conversation.alias ?? conversation.title,
                    },
                    {
                      title: '最近更新',
                      dataIndex: 'updatedAt',
                      render: (value: string) =>
                        new Date(value).toLocaleString('zh-CN'),
                    },
                    {
                      title: '本次范围',
                      render: (_, conversation) => (
                        <Button
                          disabled={remaining <= 0 || loading}
                          onClick={() =>
                            add(
                              {
                                kind: 'conversation',
                                conversationId: conversation.id,
                                mode: fullRead ? 'full' : 'relevant',
                                ...(query.trim()
                                  ? { query: query.trim() }
                                  : {}),
                                dataScope: 'syntheticPublicOnly',
                              },
                              conversation.alias ?? conversation.title,
                              fullRead
                                ? '已明确请求通读；实际授权仍须校验'
                                : '仅相关片段；未默认通读',
                            )
                          }
                        >
                          {fullRead ? '准备通读引用' : '准备相关片段引用'}
                        </Button>
                      ),
                    },
                  ]}
                />
              </>
            ),
          },
          {
            key: 'resources',
            label: '已有附件',
            children: (
              <>
                <Input
                  aria-label="搜索本人附件"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  maxLength={500}
                  placeholder="仅本人个人资源元数据；不会读取正文"
                  className="section-alert"
                />
                <Table
                  rowKey="id"
                  size="small"
                  dataSource={resources}
                  loading={loading}
                  pagination={false}
                  locale={{
                    emptyText: error
                      ? '资源元数据未能读取。'
                      : '当前没有匹配的个人附件。',
                  }}
                  columns={[
                    { title: '原件', dataIndex: 'originalName' },
                    {
                      title: '字节状态',
                      render: (_, resource) => (
                        <Space direction="vertical" size={0}>
                          <Tag>
                            {resource.status === 'verified'
                              ? '字节已校验'
                              : resource.status}
                          </Tag>
                          <Typography.Text type="secondary">
                            {resource.textExtractionSupported
                              ? '支持尝试文本提取；正文尚未读取'
                              : '当前未支持文本解析，仅保留原件'}
                          </Typography.Text>
                        </Space>
                      ),
                    },
                    {
                      title: '操作',
                      render: (_, resource) => (
                        <Button
                          disabled={
                            remaining <= 0 ||
                            loading ||
                            resource.status !== 'verified'
                          }
                          onClick={() =>
                            add(
                              {
                                kind: 'resource',
                                resourceId: resource.id,
                                dataScope: 'syntheticPublicOnly',
                              },
                              resource.originalName,
                              resource.textExtractionSupported
                                ? '字节已校验，正文解析以发送/过程回执为准'
                                : '当前未解析；不得假装模型已读',
                            )
                          }
                        >
                          准备引用
                        </Button>
                      ),
                    },
                  ]}
                />
                {nextCursor && (
                  <Button
                    onClick={() => void moreResources()}
                    loading={loading}
                  >
                    加载更多本人资源
                  </Button>
                )}
              </>
            ),
          },
          {
            key: 'requirements',
            label: '需求版本',
            children: !projectId ? (
              <Alert
                type="info"
                showIcon
                title="先在工作台侧栏选择有权访问的项目，再选择具体需求版本。"
              />
            ) : (
              <Table
                rowKey="id"
                size="small"
                dataSource={requirements}
                loading={loading}
                pagination={{ pageSize: 10 }}
                locale={{
                  emptyText: error
                    ? '需求元数据未能读取。'
                    : '此项目暂无正式需求版本。',
                }}
                columns={[
                  { title: '需求', dataIndex: 'title' },
                  {
                    title: '明确版本',
                    render: (_, requirement) => (
                      <Space wrap>
                        {requirement.versions.map((version) => (
                          <Button
                            key={version.id}
                            disabled={remaining <= 0 || loading}
                            onClick={() =>
                              add(
                                {
                                  kind: 'requirementVersion',
                                  requirementVersionId: version.id,
                                  dataScope: 'syntheticPublicOnly',
                                },
                                `${requirement.title} · v${version.versionNo}`,
                                '指定版本材料；未默认注入其他版本或整个项目',
                              )
                            }
                          >
                            引用 v{version.versionNo}
                          </Button>
                        ))}
                      </Space>
                    ),
                  },
                ]}
              />
            ),
          },
          {
            key: 'knowledge',
            label: '知识',
            children: (
              <Suspense
                fallback={
                  <Typography.Text role="status">
                    读取知识候选模块…
                  </Typography.Text>
                }
              >
                <KnowledgeReferenceCandidates
                  projectId={projectId}
                  remaining={remaining}
                  onAdd={onAdd}
                />
              </Suspense>
            ),
          },
          {
            key: 'external',
            label: '外部 MCP',
            children: (
              <Suspense
                fallback={
                  <Typography.Text role="status">
                    读取本人外部工具候选…
                  </Typography.Text>
                }
              >
                <ExternalMcpReferenceCandidates
                  remaining={remaining}
                  onAdd={onAdd}
                />
              </Suspense>
            ),
          },
        ]}
      />
    </Modal>
  );
}
