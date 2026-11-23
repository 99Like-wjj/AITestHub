import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Input,
  Modal,
  Upload,
  Radio,
  Select,
  Space,
  Table,
  Tree,
  Typography,
} from 'antd';
import type { TreeDataNode } from 'antd';
import {
  AppstoreOutlined,
  FileOutlined,
  FileImageOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  FolderOutlined,
  PlayCircleOutlined,
  UploadOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import type { z } from 'zod';
import {
  fileCenterDetailSchema,
  fileCenterListSchema,
  fileCenterTreeSchema,
  type FileCenterEntry,
} from '../../../packages/contracts/src/agent-workspace';
import { api, describeError, isUncertainMutationError } from './api';
import { subscribeIdentityChanges } from './identity-context';
import {
  humanFileSize,
  previewKind,
  readPreviewBlob,
} from './file-preview-data';
import {
  downloadFileCenterEntry,
  FilePreview,
  type PreviewEntry,
} from './file-preview';
import { uiLayers } from './ui-layers';
import { RecoveryBlock } from './recovery-block';
import { uploadPersonalFile } from './file-channel';
import {
  workspaceReceiptSchema,
  workspaceCommandReceiptSchema,
} from '../../../packages/contracts/src/agent-workspace';
import './file-center.css';
import { FileEntryActions } from './file-entry-actions';

import {
  fileKindLabels,
  FileKindTag,
  FileStatusTag,
} from './file-display-status';
import { BeijingTime, beijingDate } from './beijing-time';
import {
  ResultFilters,
  ResultListState,
  ResultPagination,
} from './result-list';

export { fileKindLabels } from './file-display-status';
export const displayFileName = (entry: PreviewEntry) =>
  entry.originalName ?? entry.path.split('/').at(-1) ?? entry.path;
function fileFormatLabel(entry: PreviewEntry): string {
  const extension = /\.([a-z0-9]{1,10})$/i.exec(displayFileName(entry))?.[1];
  if (extension) return extension.toUpperCase();
  const kind = previewKind(displayFileName(entry), entry.mediaType);
  return kind === 'image'
    ? '图片'
    : kind === 'video'
      ? '视频'
      : kind === 'audio'
        ? '音频'
        : kind === 'pdf'
          ? 'PDF'
          : kind === 'svg'
            ? 'SVG'
            : '文件';
}
function FormatIcon({ entry }: { entry: PreviewEntry }) {
  const kind = previewKind(displayFileName(entry), entry.mediaType);
  return kind === 'image' || kind === 'svg' ? (
    <FileImageOutlined />
  ) : kind === 'pdf' ? (
    <FilePdfOutlined />
  ) : kind === 'video' || kind === 'audio' ? (
    <PlayCircleOutlined />
  ) : ['markdown', 'code', 'structured'].includes(kind) ? (
    <FileTextOutlined />
  ) : (
    <FileOutlined />
  );
}
function FileThumbnail({ entry }: { entry: PreviewEntry }) {
  const ref = useRef<HTMLDivElement>(null),
    [visible, setVisible] = useState(false),
    [url, setUrl] = useState<string>(),
    [failed, setFailed] = useState(false),
    [duration, setDuration] = useState<number>();
  const kind = previewKind(displayFileName(entry), entry.mediaType);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '100px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setUrl(undefined);
    setDuration(undefined);
    setFailed(false);
    if (!visible || !['image', 'video'].includes(kind) || !entry.available)
      return;
    const abort = new AbortController();
    let objectUrl: string | undefined;
    void (async () => {
      const fresh = (
        await api(
          `/me/file-center/entries/${entry.id}`,
          { signal: abort.signal },
          fileCenterDetailSchema,
        )
      ).entry;
      if (abort.signal.aborted) return;
      if (
        !fresh.available ||
        fresh.resourceId !== entry.resourceId ||
        fresh.revision !== entry.revision ||
        fresh.sha256 !== entry.sha256 ||
        fresh.mediaType !== entry.mediaType
      )
        throw new Error('文件已改变或不可用，请刷新文件列表。');
      if (kind === 'video') {
        setUrl(
          `/api/v1/me/file-center/entries/${fresh.id}/content?revision=${fresh.revision}#t=0.1`,
        );
        return;
      }
      const blob = await readPreviewBlob(
        `/api/v1/me/file-center/entries/${fresh.id}/content?revision=${fresh.revision}`,
        `${fresh.resourceId}:${fresh.revision}:${fresh.sha256}`,
        abort.signal,
      );
      if (abort.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    })().catch(() => {
      if (!abort.signal.aborted) setFailed(true);
    });
    return () => {
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [
    visible,
    entry.id,
    entry.resourceId,
    entry.revision,
    entry.sha256,
    entry.available,
    kind,
  ]);
  return (
    <div className="file-center-card-thumbnail" ref={ref}>
      {url && !failed ? (
        kind === 'video' ? (
          <video
            src={url}
            muted
            preload="metadata"
            onLoadedMetadata={(event) => {
              setDuration(event.currentTarget.duration);
              event.currentTarget.currentTime = Math.min(
                0.1,
                event.currentTarget.duration / 2,
              );
            }}
            onError={() => setFailed(true)}
          />
        ) : (
          <img src={url} alt="实际文件缩略图" onError={() => setFailed(true)} />
        )
      ) : (
        <FormatIcon entry={entry} />
      )}
      <span>
        {duration && Number.isFinite(duration)
          ? `${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, '0')}`
          : failed
            ? '缩略图不可用'
            : fileFormatLabel(entry)}
      </span>
    </div>
  );
}
export function FileListing({
  entries,
  view,
  onPreview,
  onVersions,
  onDownload,
  onChanged,
}: {
  entries: readonly PreviewEntry[];
  view: 'list' | 'cards';
  onPreview: (entry: PreviewEntry) => void;
  onVersions?: (entry: PreviewEntry) => void;
  onDownload?: (entry: PreviewEntry) => void;
  onChanged?: () => void;
}) {
  const [error, setError] = useState<string>();
  const download = (entry: PreviewEntry) => {
    if (onDownload) onDownload(entry);
    else
      void downloadFileCenterEntry(entry).catch((err) =>
        setError(describeError(err)),
      );
  };
  const actions = (entry: PreviewEntry) => (
    <Space wrap>
      <Button
        size="small"
        disabled={!entry.available || Boolean(entry.deletedAt)}
        onClick={() => onPreview(entry)}
      >
        预览
      </Button>
      <Button
        size="small"
        disabled={!entry.available}
        onClick={() => download(entry)}
      >
        下载
      </Button>
      {entry.kind !== 'original' && onVersions ? (
        <Button size="small" onClick={() => onVersions(entry)}>
          版本记录
        </Button>
      ) : null}
      {entry.kind !== 'original' ? (
        <FileEntryActions entry={entry} {...(onChanged ? { onChanged } : {})} />
      ) : null}
    </Space>
  );
  return (
    <>
      {error ? (
        <Alert
          type="error"
          title={error}
          closable
          onClose={() => setError(undefined)}
        />
      ) : null}
      {!entries.length ? (
        <ResultListState state="empty" title="此范围暂无可读文件" />
      ) : view === 'cards' ? (
        <div className="file-center-card-grid">
          {entries.map((entry) => (
            <article className="file-center-card" key={entry.id}>
              <button
                type="button"
                className="file-center-card-open"
                onClick={() => onPreview(entry)}
                disabled={!entry.available}
              >
                <FileThumbnail entry={entry} />
                <strong>{displayFileName(entry)}</strong>
              </button>
              <Space wrap className="file-center-card-meta">
                <FileKindTag kind={entry.kind} />
                <FileStatusTag
                  status={
                    entry.deletedAt
                      ? 'deleted'
                      : entry.available
                        ? 'available'
                        : 'unavailable'
                  }
                />
                <span>{humanFileSize(entry.bytes)}</span>
                {entry.kind !== 'original' ? (
                  <span>v{entry.revision}</span>
                ) : null}
              </Space>
              <p className="file-center-card-description">
                {'conversationTitle' in entry
                  ? String(entry.conversationTitle)
                  : ''}
              </p>
              <p className="file-center-card-time">
                <BeijingTime value={entry.updatedAt} />
              </p>
              <div className="file-center-card-actions">{actions(entry)}</div>
            </article>
          ))}
        </div>
      ) : (
        <Table<PreviewEntry>
          rowKey="id"
          dataSource={[...entries]}
          pagination={false}
          scroll={{ x: 700 }}
          columns={[
            {
              title: '文件',
              key: 'name',
              render: (_, entry) => (
                <Space>
                  <span className="file-list-icon">
                    <FormatIcon entry={entry} />
                  </span>
                  <div>
                    <Button
                      type="link"
                      disabled={!entry.available}
                      onClick={() => onPreview(entry)}
                    >
                      {displayFileName(entry)}
                    </Button>
                    <div className="caption">
                      {'conversationTitle' in entry
                        ? String(entry.conversationTitle)
                        : entry.path}
                    </div>
                  </div>
                </Space>
              ),
            },
            {
              title: '分类',
              render: (_, entry) => (
                <Space wrap>
                  <FileKindTag kind={entry.kind} />
                  <FileStatusTag
                    status={
                      entry.deletedAt
                        ? 'deleted'
                        : entry.available
                          ? 'available'
                          : 'unavailable'
                    }
                  />
                </Space>
              ),
            },
            { title: '大小', render: (_, entry) => humanFileSize(entry.bytes) },
            {
              title: '版本 / 时间',
              render: (_, entry) => (
                <div>
                  {entry.kind === 'original' ? '原件' : `v${entry.revision}`}
                  <div className="caption">
                    <BeijingTime value={entry.updatedAt} />
                  </div>
                </div>
              ),
            },
            { title: '操作', render: (_, entry) => actions(entry) },
          ]}
        />
      )}
    </>
  );
}

type ConversationNode = z.infer<
  typeof fileCenterTreeSchema
>['conversations'][number];
type Scope = {
  projectId?: string;
  requirementId?: string;
  conversationId?: string;
  kind?: 'original' | 'artifact' | 'legacy';
};
export function buildFileCenterTree(
  conversations: readonly ConversationNode[],
): TreeDataNode[] {
  const projects = new Map<
    string,
    {
      title: string;
      requirements: Map<
        string,
        { title: string; conversations: ConversationNode[] }
      >;
    }
  >();
  for (const conversation of conversations) {
    const projectId = conversation.projectId ?? 'personal';
    let project = projects.get(projectId);
    if (!project) {
      project = {
        title: conversation.projectName ?? '个人文件',
        requirements: new Map(),
      };
      projects.set(projectId, project);
    }
    const requirementId = conversation.requirementId ?? 'unassigned';
    let requirement = project.requirements.get(requirementId);
    if (!requirement) {
      requirement = {
        title: conversation.requirementTitle ?? '未关联需求',
        conversations: [],
      };
      project.requirements.set(requirementId, requirement);
    }
    requirement.conversations.push(conversation);
  }
  return [...projects].map(([id, project]) => ({
    key: `p:${id}`,
    title: project.title,
    icon: <FolderOutlined />,
    children: [...project.requirements].map(([rid, requirement]) => ({
      key: `r:${id}:${rid}`,
      title: requirement.title,
      children: requirement.conversations.map((conversation) => ({
        key: `c:${conversation.conversationId}`,
        title: `${beijingDate(conversation.createdAt)} · ${conversation.conversationTitle} (${conversation.fileCount})`,
        children: (['original', 'artifact', 'legacy'] as const).map((kind) => ({
          key: `k:${conversation.conversationId}:${kind}`,
          title: fileKindLabels[kind],
          isLeaf: true,
        })),
      })),
    })),
  }));
}
export function FileCenter({
  open,
  onClose,
  initialConversationId,
}: {
  open: boolean;
  onClose: () => void;
  initialConversationId?: string;
}) {
  const [mode, setMode] = useState<
      'projects' | 'recent' | 'dates' | 'personal'
    >('projects'),
    [scope, setScope] = useState<Scope>(
      initialConversationId ? { conversationId: initialConversationId } : {},
    ),
    [query, setQuery] = useState(''),
    [type, setType] = useState('all'),
    [kind, setKind] = useState('all'),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [dateField, setDateField] = useState<'created' | 'updated'>('created'),
    [view, setView] = useState<'list' | 'cards'>('list'),
    [entries, setEntries] = useState<FileCenterEntry[]>([]),
    [nextCursor, setNextCursor] = useState<string | null>(null),
    [nodes, setNodes] = useState<ConversationNode[]>([]),
    [treeCursor, setTreeCursor] = useState<string | null>(null),
    [pending, setPending] = useState(false),
    [treePending, setTreePending] = useState(false),
    [error, setError] = useState<string>(),
    [listError, setListError] = useState<{
      description: string;
      cursor: string | undefined;
    }>(),
    [selected, setSelected] = useState<PreviewEntry | null>(null);
  const [pendingUpload, setPendingUpload] = useState<{
    conversationId: string;
    commandId: string;
  }>();
  const serial = useRef(0),
    listAbort = useRef<AbortController | undefined>(undefined);
  const closePreview = useCallback(() => setSelected(null), []);
  useEffect(() => {
    if (open)
      setScope(
        initialConversationId ? { conversationId: initialConversationId } : {},
      );
  }, [open, initialConversationId]);
  useEffect(
    () =>
      subscribeIdentityChanges(() => {
        serial.current++;
        listAbort.current?.abort();
        setEntries([]);
        setNodes([]);
        setSelected(null);
        setNextCursor(null);
        setTreeCursor(null);
        setPendingUpload(undefined);
        onClose();
      }),
    [onClose],
  );
  async function loadTree(cursor?: string, signal?: AbortSignal) {
    setTreePending(true);
    try {
      const result = await api(
        `/me/file-center/tree?limit=100${cursor ? `&cursor=${cursor}` : ''}`,
        signal ? { signal } : {},
        fileCenterTreeSchema,
      );
      if (signal?.aborted) return;
      setNodes((current) =>
        cursor ? [...current, ...result.conversations] : result.conversations,
      );
      setTreeCursor(result.nextCursor);
    } catch (err) {
      if (!signal?.aborted) setError(describeError(err));
    } finally {
      if (!signal?.aborted) setTreePending(false);
    }
  }
  const queryString = useMemo(() => {
    const params = new URLSearchParams({
      query,
      limit: '100',
      dateField: mode === 'recent' ? 'updated' : dateField,
    });
    if (mode === 'personal') params.set('personal', 'true');
    if (mode === 'projects')
      for (const [key, value] of Object.entries(scope))
        if (value) params.set(key, value);
    if (kind !== 'all') params.set('kind', kind);
    if (from && !Number.isNaN(Date.parse(`${from}T00:00:00+08:00`)))
      params.set('from', new Date(`${from}T00:00:00+08:00`).toISOString());
    if (to && !Number.isNaN(Date.parse(`${to}T23:59:59.999+08:00`)))
      params.set('to', new Date(`${to}T23:59:59.999+08:00`).toISOString());
    return params.toString();
  }, [query, scope, kind, mode, from, to, dateField]);
  const load = useCallback(
    async (cursor?: string) => {
      const generation = ++serial.current;
      listAbort.current?.abort();
      const abort = new AbortController();
      listAbort.current = abort;
      setPending(true);
      setListError(undefined);
      try {
        const result = await api(
          `/me/file-center?${queryString}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          { signal: abort.signal },
          fileCenterListSchema,
        );
        if (generation !== serial.current) return;
        setEntries((current) =>
          cursor
            ? [
                ...current,
                ...result.entries.filter(
                  (entry) => !current.some((old) => old.id === entry.id),
                ),
              ]
            : result.entries,
        );
        setNextCursor(result.nextCursor);
      } catch (err) {
        if (!abort.signal.aborted && generation === serial.current)
          setListError({ description: describeError(err), cursor });
      } finally {
        if (!abort.signal.aborted) setPending(false);
      }
    },
    [queryString],
  );
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    void loadTree(undefined, abort.signal);
    return () => abort.abort();
  }, [open]);
  useEffect(() => {
    if (open) {
      setEntries([]);
      setNextCursor(null);
      void load();
    }
    return () => listAbort.current?.abort();
  }, [open, load]);
  function clearResultFilters() {
    setQuery('');
    setKind('all');
    setType('all');
    setDateField('created');
    setFrom('');
    setTo('');
  }
  const filtered = entries.filter(
    (entry) =>
      type === 'all' ||
      previewKind(displayFileName(entry), entry.mediaType) === type,
  );
  async function upload(file: File) {
    const cid = mode === 'projects' ? scope.conversationId : undefined;
    if (!cid) {
      setError('请先在左侧选择具体对话作为原始资料归属。');
      return;
    }
    setPending(true);
    setError(undefined);
    const generation = serial.current;
    try {
      const resource = await uploadPersonalFile(file, crypto.randomUUID(), {
        isCurrent: () => generation === serial.current,
      });
      if (generation !== serial.current) return;
      const commandId = crypto.randomUUID();
      setPendingUpload({ conversationId: cid, commandId });
      try {
        await api(
          `/me/conversations/${cid}/workspace/import`,
          {
            method: 'POST',
            body: {
              commandId,
              expectedRowVersion: 0,
              path: `uploads/${resource.id}/${file.name}`,
              resourceId: resource.id,
            },
          },
          workspaceReceiptSchema,
        );
        setPendingUpload(undefined);
      } catch (err) {
        if (!isUncertainMutationError(err)) setPendingUpload(undefined);
        throw err;
      }
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }
  const groups = useMemo(() => {
    if (mode !== 'dates') return null;
    const grouped = new Map<string, FileCenterEntry[]>();
    for (const entry of filtered) {
      const date =
        (dateField === 'created' ? entry.createdAt : entry.updatedAt) ??
        entry.updatedAt;
      const key = beijingDate(date);
      grouped.set(key, [...(grouped.get(key) ?? []), entry]);
    }
    return grouped;
  }, [filtered, mode, dateField]);
  const choose = (key: string) => {
    const parts = key.split(':');
    if (parts[0] === 'p' && parts[1] === 'personal') {
      setMode('personal');
      setScope({});
      return;
    }
    if (parts[0] === 'p')
      setScope(
        parts[1] === 'personal' || !parts[1] ? {} : { projectId: parts[1] },
      );
    else if (parts[0] === 'r')
      setScope({
        ...(parts[1] && parts[1] !== 'personal' ? { projectId: parts[1] } : {}),
        ...(parts[2] && parts[2] !== 'unassigned'
          ? { requirementId: parts[2] }
          : {}),
      });
    else if (parts[0] === 'c' && parts[1])
      setScope({ conversationId: parts[1] });
    else if (
      parts[0] === 'k' &&
      parts[1] &&
      ['original', 'artifact', 'legacy'].includes(parts[2] ?? '')
    )
      setScope({
        conversationId: parts[1],
        kind: parts[2] as 'original' | 'artifact' | 'legacy',
      });
  };
  return (
    <>
      <Modal
        open={open}
        onCancel={onClose}
        title="文件中心"
        width="100vw"
        style={{ top: 0, paddingBottom: 0 }}
        styles={{ body: { height: 'calc(100dvh - 72px)', overflow: 'hidden' } }}
        className="file-center-modal"
        footer={null}
        destroyOnHidden
        zIndex={uiLayers.dialog}
      >
        <div className="file-center-layout">
          <aside className="file-center-navigation">
            <Typography.Title level={5}>文件</Typography.Title>
            <nav>
              {(
                [
                  ['projects', '项目与需求'],
                  ['recent', '最近文件'],
                  ['dates', '按日期'],
                  ['personal', '个人文件'],
                ] as const
              ).map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  className={mode === value ? 'active' : ''}
                  onClick={() => {
                    setMode(value);
                    if (value === 'projects') setScope({});
                  }}
                >
                  {label}
                </button>
              ))}
            </nav>
            {mode === 'projects' ? (
              <>
                <Tree
                  showIcon
                  blockNode
                  treeData={buildFileCenterTree(nodes)}
                  onSelect={(keys) => {
                    if (keys[0]) choose(String(keys[0]));
                  }}
                />
                {treeCursor ? (
                  <Button
                    size="small"
                    loading={treePending}
                    onClick={() => void loadTree(treeCursor)}
                  >
                    载入更多对话
                  </Button>
                ) : null}
                <Typography.Paragraph type="secondary" className="caption">
                  {nodes.length} 个已加载对话{treeCursor ? '，还有更多' : ''}
                  ；只列本人当前有权访问的记录。
                </Typography.Paragraph>
              </>
            ) : null}
          </aside>
          <main className="file-center-main">
            <div className="file-center-actions">
              <Radio.Group
                aria-label="文件展示方式"
                value={view}
                onChange={(event) => setView(event.target.value)}
              >
                <Radio.Button value="list">
                  <UnorderedListOutlined /> 列表
                </Radio.Button>
                <Radio.Button value="cards">
                  <AppstoreOutlined /> 卡片
                </Radio.Button>
              </Radio.Group>
              <Upload
                showUploadList={false}
                beforeUpload={(file) => {
                  void upload(file);
                  return false;
                }}
                disabled={
                  pending ||
                  Boolean(pendingUpload) ||
                  !scope.conversationId ||
                  mode !== 'projects'
                }
              >
                <Button
                  icon={<UploadOutlined />}
                  disabled={
                    pending ||
                    Boolean(pendingUpload) ||
                    !scope.conversationId ||
                    mode !== 'projects'
                  }
                >
                  上传原始资料
                </Button>
              </Upload>
            </div>
            <ResultFilters
              search={{
                label: '搜索文件名称',
                value: query,
                onChange: setQuery,
              }}
              onReset={clearResultFilters}
              summary={
                pending
                  ? '正在读取'
                  : `已加载 ${entries.length} 项${type !== 'all' ? '，格式筛选仅覆盖已加载结果' : ''}`
              }
            >
              <Select
                aria-label="文件来源分类"
                value={kind}
                onChange={setKind}
                options={[
                  { value: 'all', label: '全部来源' },
                  ...Object.entries(fileKindLabels).map(([value, label]) => ({
                    value,
                    label,
                  })),
                ]}
              />
              <Select
                aria-label="文件格式"
                value={type}
                onChange={setType}
                options={[
                  { value: 'all', label: '全部格式' },
                  ...[
                    'markdown',
                    'html',
                    'code',
                    'structured',
                    'table',
                    'office',
                    'pdf',
                    'image',
                    'svg',
                    'video',
                    'audio',
                    'zip',
                  ].map((value) => ({ value, label: value.toUpperCase() })),
                ]}
              />
              <Select
                value={dateField}
                aria-label="文件日期字段"
                onChange={setDateField}
                options={[
                  { value: 'created', label: '按创建日期' },
                  { value: 'updated', label: '按更新时间' },
                ]}
              />
              <Input
                type="date"
                aria-label="文件开始日期"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                style={{ width: 170 }}
              />
              <span>至</span>
              <Input
                type="date"
                aria-label="文件结束日期"
                value={to}
                onChange={(event) => setTo(event.target.value)}
                style={{ width: 170 }}
              />
            </ResultFilters>
            {error ? <Alert type="error" showIcon title={error} /> : null}
            {pendingUpload ? (
              <RecoveryBlock
                variant="pending"
                title="核对原上传关联"
                reference={pendingUpload.commandId}
                actions={
                  <Button
                    onClick={() => {
                      void api(
                        `/me/conversations/${pendingUpload.conversationId}/workspace/commands/${pendingUpload.commandId}`,
                        {},
                        workspaceCommandReceiptSchema,
                      )
                        .then((result) => {
                          if (result.found) {
                            setPendingUpload(undefined);
                            void load();
                          } else
                            setError(
                              '原关联回执尚未读到，请继续核对，不自动重发。',
                            );
                        })
                        .catch((err) => setError(describeError(err)));
                    }}
                  >
                    查询原回执
                  </Button>
                }
              />
            ) : null}
            <div className="file-center-files">
              {pending && !entries.length ? (
                <ResultListState state="loading" title="正在读取文件列表" />
              ) : listError && !entries.length ? (
                <ResultListState
                  state="error"
                  title="文件列表读取失败"
                  description={listError.description}
                  action={
                    <Button onClick={() => void load(listError.cursor)}>
                      重新读取
                    </Button>
                  }
                />
              ) : !filtered.length ? (
                query.trim() ||
                kind !== 'all' ||
                type !== 'all' ||
                from ||
                to ? (
                  <ResultListState
                    state="no-match"
                    title="没有符合条件的文件"
                    description={
                      nextCursor && type !== 'all'
                        ? '格式筛选仅覆盖已加载结果，可继续加载更多文件。'
                        : '可调整条件，或清空结果筛选。'
                    }
                    action={
                      <Button onClick={clearResultFilters}>清空结果筛选</Button>
                    }
                  />
                ) : (
                  <ResultListState state="empty" title="此范围暂无可读文件" />
                )
              ) : groups ? (
                [...groups].map(([date, entries]) => (
                  <section key={date}>
                    <Typography.Title level={5}>{date}</Typography.Title>
                    <FileListing
                      entries={entries}
                      view={view}
                      onPreview={setSelected}
                      onVersions={setSelected}
                      onChanged={() => void load()}
                    />
                  </section>
                ))
              ) : (
                <FileListing
                  entries={filtered}
                  view={view}
                  onPreview={setSelected}
                  onVersions={setSelected}
                  onChanged={() => void load()}
                />
              )}

              {entries.length > 0 && listError ? (
                <Alert
                  type="error"
                  showIcon
                  title={listError.description}
                  action={
                    <Button onClick={() => void load(listError.cursor)}>
                      重新读取
                    </Button>
                  }
                />
              ) : null}
              {entries.length > 0 || nextCursor ? (
                <ResultPagination
                  summary={
                    nextCursor
                      ? `已加载 ${entries.length} 项`
                      : '已加载当前范围全部文件'
                  }
                >
                  {nextCursor && (
                    <Button
                      loading={pending}
                      onClick={() => void load(nextCursor)}
                    >
                      加载更多
                    </Button>
                  )}
                </ResultPagination>
              ) : null}
            </div>
          </main>
        </div>
      </Modal>
      <FilePreview
        entry={selected}
        entries={filtered}
        onSelect={setSelected}
        onClose={closePreview}
      />
    </>
  );
}
