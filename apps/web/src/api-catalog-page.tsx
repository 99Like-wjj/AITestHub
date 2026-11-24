import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Empty,
  Input,
  Modal,
  Select,
  Skeleton,
  Space,
  Table,
  Tabs,
  Tag,
} from 'antd';
import {
  DownloadOutlined,
  FolderOutlined,
  PlusOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import {
  apiCatalogCreateInputSchema,
  apiCatalogCloneDraftInputSchema,
  apiCatalogDiagnosticDraftInputSchema,
  apiCatalogSourceDraftSchema,
  apiCatalogGetResultSchema,
  apiCatalogListResultSchema,
  apiCatalogMockResultSchema,
  apiCatalogMockInputSchema,
  apiCatalogNodeSchema,
  apiCatalogOrganizeInputSchema,
  apiCatalogReviseInputSchema,
  apiCatalogExportInputSchema,
  apiCatalogExportResultSchema,
  apiInterfaceMethodSchema,
  type ApiCatalogGetResult,
  type ApiCatalogNode,
  type ApiCatalogSourceDraft,
  type ApiInterfaceDefinition,
} from '../../../packages/contracts/src/api-catalog';
import { idSchema } from '../../../packages/contracts/src/base';
import { z } from 'zod';
import { api, describeError } from './api';
import {
  ApiCatalogDefinitionEditor,
  buildCatalogDefinition,
  makeCatalogDraft,
  statusLabels,
} from './api-catalog-definition';
import { ApiCatalogImportDialog } from './api-catalog-import';
import { ApiDiagnosticPage } from './api-draft-debugger';
import { ApiStageFields } from './api-stage-fields';
import {
  apiNoStages,
  type ApiCatalogStageProvider,
  type ApiStageSettings,
} from '../../../packages/contracts/src/api-stage-actions';
import { CommandDialog, useBusinessCommand } from './business-command';
import {
  ExplorerTree,
  findExplorerPath,
  useExplorerSearch,
  type ExplorerNode,
} from './explorer-tree';
import {
  registerNavigationBlocker,
  requestNavigation,
} from './navigation-guard';
import { PageHeading } from './page-heading';
import { RequirementDirectory } from './requirement-directory';
import { BeijingTime } from './beijing-time';
import type { Project } from './types';
import { canEditProjectAssets } from './project-access';
import './api-assets-workbench.css';

type CatalogTab =
  'document' | 'edit' | 'debug' | 'cases' | 'mock' | 'revisions';
const allowedTabs: CatalogTab[] = [
  'document',
  'edit',
  'debug',
  'cases',
  'mock',
  'revisions',
];
type EditKind = ApiCatalogNode['kind'];
type DiagnosticOrigin = { runId: string; attemptId: string };
type Dialog = { session: string } & (
  | {
      kind: 'create';
      nodeKind: EditKind;
      parentId?: string | undefined;
      source?: ApiCatalogSourceDraft;
    }
  | {
      kind: 'organize';
      node: ApiCatalogNode;
      directoryStages?: ApiStageSettings | null | undefined;
      directoryProviders?: ApiCatalogStageProvider[] | undefined;
    }
  | { kind: 'import' }
  | { kind: 'diagnostic'; origin: DiagnosticOrigin }
);

function query() {
  return new URLSearchParams(window.location.hash.split('?')[1]);
}
function routeState(projectId: string) {
  const location = query();
  if (location.has('projectId') && location.get('projectId') !== projectId)
    return {
      id: null,
      revisionId: undefined,
      tab: 'document' as CatalogTab,
      runId: undefined,
      attemptId: undefined,
    };
  const rawTab = location.get('tab');
  return {
    id:
      idSchema.safeParse(location.get('nodeId') ?? location.get('endpointId'))
        .data ?? null,
    revisionId: idSchema.safeParse(location.get('revisionId')).data,
    tab: allowedTabs.find((tab) => tab === rawTab) ?? 'document',
    runId: idSchema.safeParse(location.get('diagnosticRunId')).data,
    attemptId: idSchema.safeParse(location.get('diagnosticAttemptId')).data,
  };
}
function nodeTitle(kind: EditKind) {
  return kind === 'module'
    ? '产品模块'
    : kind === 'folder'
      ? '功能目录'
      : '接口';
}
function treeNodes(
  nodes: readonly ApiCatalogNode[],
  interfaces: ReadonlySet<string>,
) {
  const byParent = new Map<string | null, ApiCatalogNode[]>();
  for (const node of nodes) {
    const siblings = byParent.get(node.parentId);
    if (siblings) siblings.push(node);
    else byParent.set(node.parentId, [node]);
  }
  function branch(parentId: string | null): ExplorerNode[] {
    return (byParent.get(parentId) ?? []).flatMap((node): ExplorerNode[] => {
      const core = {
        id: node.id,
        title: node.title,
        archived: node.archivedAt !== null,
      };
      if (node.kind === 'interface')
        return interfaces.has(node.id)
          ? [
              {
                ...core,
                kind: 'endpoint',
                detail: node.method ?? '接口',
                searchText: [node.path, node.serviceKey, ...node.tags].join(
                  ' ',
                ),
              },
            ]
          : [];
      const children = branch(node.id);
      const count = children.reduce(
        (sum, item) =>
          sum +
          (item.kind === 'endpoint'
            ? 1
            : typeof item.count === 'number'
              ? item.count
              : 0),
        0,
      );
      return [{ ...core, count, children }];
    });
  }
  return [
    {
      id: 'all',
      title: '全部接口',
      count: interfaces.size,
      kind: 'all' as const,
    },
    ...branch(null),
  ];
}
function download(name: string, type: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = window.document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ApiCatalogPage({
  project,
  userId,
  onNavigate,
}: {
  project: Project | null;
  userId: string;
  onNavigate: (hash: string) => void;
}) {
  if (!project)
    return (
      <Card>
        <Empty description="请选择可访问的项目。" />
      </Card>
    );
  return (
    <ProjectCatalog project={project} userId={userId} onNavigate={onNavigate} />
  );
}

function ProjectCatalog({
  project,
  userId,
  onNavigate,
}: {
  project: Project;
  userId: string;
  onNavigate: (hash: string) => void;
}) {
  const { message, modal } = App.useApp();
  const [route, setRoute] = useState(() => routeState(project.id));
  const [search, setSearch] = useExplorerSearch(
    `explorer:catalog:${userId}:${project.id}:search`,
  );
  const [method, setMethod] = useState<ApiInterfaceDefinition['method']>();
  const [status, setStatus] = useState<ApiInterfaceDefinition['status']>();
  const [tag, setTag] = useState<string>();
  const [checked, setChecked] = useState<string[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [nodes, setNodes] = useState<ApiCatalogNode[]>([]);
  const [details, setDetails] = useState<ApiCatalogGetResult>();
  const [loading, setLoading] = useState(true);
  const [detailError, setDetailError] = useState<string>();
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);
  const [dialog, setDialog] = useState<Dialog>();
  const [history, setHistory] = useState(false);
  const [draft, setDraft] = useState(() => makeCatalogDraft());
  const [dirty, setDirty] = useState(false);
  const [restoredFrom, setRestoredFrom] =
    useState<NonNullable<ApiCatalogGetResult['revision']>>();
  const [cloning, setCloning] = useState(false);
  const revision = details?.revision;
  const selected = nodes.find((node) => node.id === route.id) ?? details?.node;
  const folder =
    selected?.kind === 'folder'
      ? selected.id
      : selected?.kind === 'interface'
        ? selected.parentId
        : undefined;
  const folders = nodes.filter(
    (node) => node.kind === 'folder' && !node.archivedAt,
  );
  const tester = project.roles.includes('tester');
  const allowed = canEditProjectAssets(project);
  const base = `/projects/${project.id}/api-catalog`;
  const save = useBusinessCommand(
    revision
      ? `${project.id}:${revision.id}:${details?.node.rowVersion}`
      : null,
  );
  const matching = useMemo(
    () =>
      new Set(
        nodes
          .filter(
            (node) =>
              node.kind === 'interface' &&
              (!method || node.method === method) &&
              (!status || node.status === status) &&
              (!tag || node.tags.includes(tag)),
          )
          .map((node) => node.id),
      ),
    [nodes, method, status, tag],
  );
  const tree = useMemo(() => treeNodes(nodes, matching), [nodes, matching]);
  const crumbs = findExplorerPath(tree, route.id);

  useEffect(() => {
    const listener = () => setRoute(routeState(project.id));
    window.addEventListener('hashchange', listener);
    return () => window.removeEventListener('hashchange', listener);
  }, [project.id]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    void api(
      `${base}/nodes?includeArchived=${includeArchived}`,
      { signal: controller.signal },
      apiCatalogListResultSchema,
    )
      .then(
        ({ nodes }) => {
          if (!controller.signal.aborted) setNodes(nodes);
        },
        (failure: unknown) => {
          if (!controller.signal.aborted) setError(describeError(failure));
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [base, includeArchived, reload]);
  useEffect(() => {
    setDetails(undefined);
    setDetailError(undefined);
    setDirty(false);
    setRestoredFrom(undefined);
    if (!route.id) return;
    const controller = new AbortController();
    const version = route.revisionId
      ? `?revisionId=${encodeURIComponent(route.revisionId)}`
      : '';
    void api(
      `${base}/nodes/${route.id}${version}`,
      { signal: controller.signal },
      apiCatalogGetResultSchema,
    ).then(
      (result) => {
        if (!controller.signal.aborted) {
          setDetails(result);
          setDraft(makeCatalogDraft(result.revision?.definition));
        }
      },
      (failure: unknown) => {
        if (!controller.signal.aborted) setDetailError(describeError(failure));
      },
    );
    return () => controller.abort();
  }, [base, route.id, route.revisionId, reload]);
  useEffect(() => {
    if (!dirty && !save.pending) return;
    return registerNavigationBlocker((proceed) => {
      if (save.pending) return;
      modal.confirm({
        title: '放弃未保存的接口定义？',
        okText: '放弃修改',
        cancelText: '继续编辑',
        onOk: proceed,
      });
    });
  }, [dirty, save.pending, modal]);

  function navigate(
    id: string | null,
    tab: CatalogTab = 'document',
    revisionId?: string,
  ) {
    const next = `#api-catalog?${new URLSearchParams({
      projectId: project.id,
      ...(id && { endpointId: id }),
      ...(revisionId && { revisionId }),
      ...(tab !== 'document' && { tab }),
    })}`;
    if (next !== window.location.hash) onNavigate(next);
  }
  function select(id: string | null, revisionId?: string) {
    if (id !== route.id || revisionId !== route.revisionId)
      requestNavigation(() => navigate(id, 'document', revisionId));
  }
  function create(nodeKind: EditKind, parentId?: string) {
    setDialog({
      kind: 'create',
      session: crypto.randomUUID(),
      nodeKind,
      parentId,
    });
  }
  function changed(node?: ApiCatalogNode) {
    setDirty(false);
    setRestoredFrom(undefined);
    setDialog(undefined);
    setReload((count) => count + 1);
    if (node) navigate(node.id);
  }
  async function saveRevision() {
    if (!details?.node.currentRevisionId || !revision) return;
    const result = await save.run((commandId) =>
      api(
        base,
        {
          method: 'POST',
          body: {
            op: 'revise',
            input: apiCatalogReviseInputSchema.parse({
              commandId,
              id: details.node.id,
              baseRevisionId: details.node.currentRevisionId,
              rowVersion: details.node.rowVersion,
              ...(restoredFrom && { restoredFromRevisionId: restoredFrom.id }),
              definition: buildCatalogDefinition(draft),
            }),
          },
        },
        apiCatalogNodeSchema,
      ),
    );
    if (result) {
      void message.success('已保存接口修订 r' + result.revisionNumber);
      changed(result);
    }
  }
  function changeTab(tab: CatalogTab) {
    setRoute((prior) => ({ ...prior, tab }));
    const location = query();
    location.set('tab', tab);
    window.history.replaceState(null, '', '#api-catalog?' + location);
  }
  function restoreRevision(
    source: NonNullable<ApiCatalogGetResult['revision']>,
  ) {
    if (
      !allowed ||
      details?.node.archivedAt ||
      details?.node.id !== source.nodeId ||
      details.node.currentRevisionId === source.id ||
      save.pending ||
      save.uncertain
    )
      return;
    requestNavigation(() => {
      setRestoredFrom(source);
      setDraft(makeCatalogDraft(source.definition));
      changeTab('edit');
      setDirty(true);
    });
  }
  function openRequestDebugger() {
    if (!details || !revision || !tester) return;
    const hash = `#api-regression?${new URLSearchParams({
      projectId: project.id,
      fromInterface: details.node.id,
      fromRevision: revision.id,
      create: 'debug',
    })}`;
    requestNavigation(() => onNavigate(hash));
  }
  const selectedPath = (node: ApiCatalogNode) => {
    const parent = nodes.find((item) => item.id === node.parentId);
    const module = nodes.find((item) => item.id === parent?.parentId);
    return [module?.title, parent?.title].filter(Boolean).join(' / ');
  };
  function visibleInterfaces() {
    return nodes.filter((node) => {
      if (!matching.has(node.id)) return false;
      if (route.id && selected?.kind === 'folder' && node.parentId !== route.id)
        return false;
      if (
        route.id &&
        selected?.kind === 'module' &&
        !nodes.some(
          (parent) =>
            parent.id === node.parentId && parent.parentId === route.id,
        )
      )
        return false;
      const searchValue = search.trim().toLocaleLowerCase();
      return (
        !searchValue ||
        [
          selectedPath(node),
          node.title,
          node.path,
          node.serviceKey,
          node.method,
          ...node.tags,
        ]
          .filter(Boolean)
          .join(' ')
          .toLocaleLowerCase()
          .includes(searchValue)
      );
    });
  }
  const isInterface = selected?.kind === 'interface';
  const isCurrent = Boolean(
    revision && revision.id === details?.node.currentRevisionId,
  );
  const tab = route.tab;
  useEffect(() => {
    if (allowed && route.runId && route.attemptId)
      setDialog({
        session: crypto.randomUUID(),
        kind: 'diagnostic',
        origin: { runId: route.runId, attemptId: route.attemptId },
      });
  }, [allowed, route.runId, route.attemptId]);
  function closeDiagnostic() {
    const location = query();
    location.delete('diagnosticRunId');
    location.delete('diagnosticAttemptId');
    window.history.replaceState(null, '', '#api-catalog?' + location);
    setRoute(routeState(project.id));
    setDialog(undefined);
  }
  function openSourceDraft(source: ApiCatalogSourceDraft) {
    closeDiagnostic();
    setDialog({
      session: crypto.randomUUID(),
      kind: 'create',
      nodeKind: 'interface',
      parentId: folder ?? undefined,
      source,
    });
  }
  async function cloneRevision() {
    if (!allowed || !revision || !details) return;
    const input = apiCatalogCloneDraftInputSchema.parse({
      interfaceId: details.node.id,
      revisionId: revision.id,
    });
    setCloning(true);
    try {
      openSourceDraft(
        await api(
          base,
          { method: 'POST', body: { op: 'preview-clone', input } },
          apiCatalogSourceDraftSchema,
        ),
      );
    } catch (error) {
      void message.error(describeError(error));
    } finally {
      setCloning(false);
    }
  }
  return (
    <>
      <PageHeading
        title="接口管理"
        description="按产品模块管理接口契约、调试与引用。"
        actions={
          <>
            <Button type="text" onClick={() => setHistory(true)}>
              请求历史
            </Button>
            <Button
              icon={<UploadOutlined />}
              disabled={!allowed || !folders.length}
              onClick={() =>
                setDialog({ kind: 'import', session: crypto.randomUUID() })
              }
            >
              导入 OpenAPI
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              disabled={!allowed || !folders.length}
              onClick={() => create('interface', folder ?? undefined)}
            >
              新建接口
            </Button>
          </>
        }
      />
      <div className="requirement-directory-layout api-assets-layout">
        <RequirementDirectory
          title="接口目录"
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="搜索模块、接口、方法或路径"
          archiveLabel="显示已归档接口"
          includeArchived={includeArchived}
          onIncludeArchivedChange={setIncludeArchived}
          action={
            <Button
              size="small"
              aria-label="新建产品模块"
              icon={<PlusOutlined />}
              disabled={!allowed}
              onClick={() => create('module')}
            />
          }
        >
          {loading ? (
            <Skeleton active />
          ) : (
            <ExplorerTree
              label="接口资产"
              nodes={tree}
              selected={route.id ?? 'all'}
              search={search}
              storageKey={`explorer:catalog:${userId}:${project.id}`}
              onSelect={(id) => select(id === 'all' ? null : id)}
            />
          )}
        </RequirementDirectory>
        <div className="explorer-workspace-main api-catalog-stack">
          <nav aria-label="当前接口路径" className="api-catalog-breadcrumb">
            <Button type="link" size="small" onClick={() => select(null)}>
              接口目录
            </Button>
            {crumbs.map((node) => (
              <span key={node.id}>
                {' '}
                <span aria-hidden>›</span>{' '}
                {node.id === route.id ? (
                  <b>{node.title}</b>
                ) : (
                  <Button
                    type="link"
                    size="small"
                    onClick={() => select(node.id)}
                  >
                    {node.title}
                  </Button>
                )}
              </span>
            ))}
          </nav>
          {error && <Alert type="error" title={error} showIcon />}
          {detailError && <Alert type="error" title={detailError} showIcon />}
          {!allowed && route.runId && route.attemptId && (
            <Alert
              type="warning"
              title="当前角色只能查看原诊断，创建接口需要项目测试角色。"
              showIcon
            />
          )}
          {isInterface ? (
            details && revision ? (
              <section className="card api-catalog-detail">
                <header className="api-catalog-section-head">
                  <div>
                    <h2>
                      <code>{revision.definition.method}</code>{' '}
                      {isCurrent ? details.node.title : revision.title}
                      <Tag
                        color={
                          revision.definition.status === 'active'
                            ? 'green'
                            : 'default'
                        }
                      >
                        {statusLabels[revision.definition.status]}
                      </Tag>
                    </h2>
                    <p className="caption">
                      <code>{revision.definition.path}</code> · r
                      {revision.revisionNumber} ·{' '}
                      {revision.definition.serviceKey}
                    </p>
                  </div>
                  <Space wrap>
                    <Button
                      disabled={
                        !allowed ||
                        !folders.length ||
                        save.pending ||
                        save.uncertain
                      }
                      loading={cloning}
                      onClick={() =>
                        requestNavigation(() => void cloneRevision())
                      }
                    >
                      复制此修订为接口草稿
                    </Button>
                    <Button
                      disabled={!allowed || !isCurrent}
                      onClick={() =>
                        setDialog({
                          session: crypto.randomUUID(),
                          kind: 'organize',
                          node: details.node,
                        })
                      }
                    >
                      移动目录
                    </Button>
                    <Button
                      type="primary"
                      disabled={
                        !allowed ||
                        details.node.archivedAt !== null ||
                        (!isCurrent && !restoredFrom) ||
                        !dirty ||
                        save.uncertain
                      }
                      loading={save.pending}
                      onClick={() => void saveRevision()}
                    >
                      保存接口
                    </Button>
                  </Space>
                </header>
                <Tabs
                  activeKey={tab}
                  destroyOnHidden={false}
                  onChange={(key) => {
                    const picked = allowedTabs.find((tab) => tab === key);
                    if (picked) changeTab(picked);
                  }}
                  items={[
                    {
                      key: 'document',
                      label: '接口文档',
                      children: (
                        <div className="api-catalog-stack">
                          <DefinitionDocument
                            definition={revision.definition}
                            projectId={project.id}
                          />
                          <UsageList details={details} />
                        </div>
                      ),
                    },
                    {
                      key: 'edit',
                      label: '定义编辑',
                      children: (
                        <>
                          {save.error && (
                            <Alert type="error" title={save.error} showIcon />
                          )}
                          {save.uncertain && (
                            <Alert
                              type="warning"
                              title={'原命令待核对 ' + save.commandId}
                              showIcon
                            />
                          )}
                          {(isCurrent || restoredFrom) &&
                          !details.node.archivedAt ? (
                            <>
                              {restoredFrom && (
                                <Alert
                                  type="info"
                                  showIcon
                                  title={
                                    '恢复草稿来自 r' +
                                    restoredFrom.revisionNumber
                                  }
                                  description="检查当前目录的继承规则，确认后保存为新修订。历史修订继续保留。"
                                />
                              )}
                              <ApiCatalogDefinitionEditor
                                projectId={project.id}
                                draft={draft}
                                stageProviders={(restoredFrom
                                  ? details.directoryProviders
                                  : revision.stageProviders
                                ).filter(
                                  (provider) => provider.kind !== 'interface',
                                )}
                                disabled={
                                  !allowed || save.pending || save.uncertain
                                }
                                onChange={(value) => {
                                  setDraft(value);
                                  setDirty(true);
                                }}
                              />
                            </>
                          ) : (
                            <Alert
                              type="info"
                              title="当前为只读接口修订。"
                              showIcon
                            />
                          )}
                        </>
                      ),
                    },
                    {
                      key: 'debug',
                      label: '请求调试',
                      children: (
                        <div className="api-catalog-stack">
                          <p>
                            从当前接口修订建立请求诊断。在自动化工作台选择环境和输入后发送。
                          </p>
                          <div>
                            <Button
                              disabled={
                                !tester || Boolean(details.node.archivedAt)
                              }
                              type="primary"
                              onClick={openRequestDebugger}
                            >
                              打开请求调试
                            </Button>
                          </div>
                        </div>
                      ),
                    },
                    {
                      key: 'cases',
                      label: '单接口用例',
                      children: <UsageList details={details} single />,
                    },
                    {
                      key: 'mock',
                      label: 'Mock',
                      children: (
                        <CatalogMock
                          key={revision.id}
                          base={base}
                          details={details}
                        />
                      ),
                    },
                    {
                      key: 'revisions',
                      label: '修订与引用',
                      children: (
                        <div className="api-catalog-stack">
                          <section>
                            <h3>接口修订</h3>
                            <div className="row wrap">
                              {details.revisions.map((item) => (
                                <Button
                                  key={item.id}
                                  type={
                                    item.id === revision.id
                                      ? 'primary'
                                      : 'default'
                                  }
                                  onClick={() =>
                                    select(details.node.id, item.id)
                                  }
                                >
                                  r{item.revisionNumber} ·{' '}
                                  <BeijingTime value={item.createdAt} />
                                </Button>
                              ))}
                            </div>
                          </section>
                          <CatalogRevisionComparison
                            key={revision.id}
                            path={base}
                            details={details}
                            {...(allowed &&
                              !details.node.archivedAt && {
                                onRestore: restoreRevision,
                              })}
                          />
                          <UsageList details={details} />
                          <CatalogExport
                            base={base}
                            nodeId={details.node.id}
                            revisionId={revision.id}
                          />
                        </div>
                      ),
                    },
                  ]}
                />
              </section>
            ) : (
              !detailError && (
                <Card>
                  <Skeleton active />
                </Card>
              )
            )
          ) : (
            <section className="card api-catalog-detail">
              <header className="api-catalog-section-head">
                <div>
                  <h2>{selected?.title ?? '全部接口'}</h2>
                  <p className="caption">产品模块 → 功能目录 → 接口</p>
                </div>
                <Space wrap>
                  {selected && (
                    <Button
                      disabled={!allowed}
                      onClick={() =>
                        setDialog({
                          session: crypto.randomUUID(),
                          kind: 'organize',
                          node: selected,
                          directoryStages: details?.directoryStages,
                          directoryProviders: details?.directoryProviders,
                        })
                      }
                    >
                      管理{nodeTitle(selected.kind)}
                    </Button>
                  )}
                  <Button
                    icon={<PlusOutlined />}
                    disabled={!allowed}
                    onClick={() =>
                      selected?.kind === 'module'
                        ? create('folder', selected.id)
                        : selected?.kind === 'folder'
                          ? create('interface', selected.id)
                          : create('module')
                    }
                  >
                    新建
                    {nodeTitle(
                      selected?.kind === 'module'
                        ? 'folder'
                        : selected?.kind === 'folder'
                          ? 'interface'
                          : 'module',
                    )}
                  </Button>
                </Space>
              </header>
              <div className="api-catalog-stack">
                <div className="api-catalog-folder-grid">
                  {nodes
                    .filter(
                      (node) =>
                        node.kind !== 'interface' && node.parentId === route.id,
                    )
                    .map((node) => (
                      <Button
                        key={node.id}
                        icon={<FolderOutlined />}
                        onClick={() => select(node.id)}
                      >
                        {node.title}
                      </Button>
                    ))}
                </div>
                <div className="row wrap">
                  <Select
                    allowClear
                    aria-label="按 HTTP 方法筛选"
                    placeholder="HTTP 方法"
                    value={method}
                    onChange={setMethod}
                    options={apiInterfaceMethodSchema.options.map((value) => ({
                      value,
                      label: value,
                    }))}
                  />
                  <Select
                    allowClear
                    aria-label="按接口状态筛选"
                    placeholder="状态"
                    value={status}
                    onChange={setStatus}
                    options={Object.entries(statusLabels).map(
                      ([value, label]) => ({ value, label }),
                    )}
                  />
                  <Select
                    allowClear
                    aria-label="按接口标签筛选"
                    placeholder="标签"
                    value={tag}
                    onChange={setTag}
                    options={[
                      ...new Set(nodes.flatMap((item) => item.tags)),
                    ].map((value) => ({ value, label: value }))}
                  />
                  {checked.length > 0 && (
                    <Button type="link" onClick={() => setChecked([])}>
                      清空已选 {checked.length} 项
                    </Button>
                  )}
                </div>
                <Table
                  rowKey="id"
                  size="small"
                  loading={loading}
                  rowSelection={{
                    selectedRowKeys: checked,
                    onChange: (keys) => setChecked(keys.map(String)),
                  }}
                  dataSource={visibleInterfaces()}
                  locale={{ emptyText: '当前范围暂无接口' }}
                  columns={[
                    {
                      title: '接口',
                      render: (_value, row) => (
                        <Button
                          size="small"
                          type="link"
                          onClick={() => select(row.id)}
                        >
                          {row.title}
                        </Button>
                      ),
                    },
                    {
                      title: '方法与路径',
                      render: (_value, row) => (
                        <code>
                          {row.method} {row.path}
                        </code>
                      ),
                    },
                    {
                      title: '所在目录',
                      render: (_value, row) => selectedPath(row),
                    },
                    {
                      title: '修订',
                      render: (_value, row) => 'r' + row.revisionNumber,
                    },
                  ]}
                />
              </div>
            </section>
          )}
        </div>
      </div>
      {dialog?.kind === 'import' && (
        <ApiCatalogImportDialog
          key={dialog.session}
          session={dialog.session}
          path={base}
          projectId={project.id}
          folders={folders}
          parentId={folder ?? undefined}
          onClose={() => setDialog(undefined)}
          onApplied={(created) => changed(created[0])}
        />
      )}
      {dialog?.kind === 'diagnostic' && (
        <CatalogDiagnosticSourceDialog
          key={dialog.session}
          base={base}
          origin={dialog.origin}
          hasFolder={folders.length > 0}
          onClose={closeDiagnostic}
          onDraft={openSourceDraft}
        />
      )}
      {dialog && (dialog.kind === 'create' || dialog.kind === 'organize') && (
        <CatalogNodeDialog
          projectId={project.id}
          canArchive={tester}
          key={dialog.session}
          dialog={dialog}
          base={base}
          nodes={nodes}
          onClose={() => setDialog(undefined)}
          onSaved={changed}
        />
      )}
      {history && (
        <Modal
          open
          title="请求历史"
          width={820}
          onCancel={() => setHistory(false)}
          footer={<Button onClick={() => setHistory(false)}>关闭</Button>}
        >
          {details?.usage.length ? (
            <div className="api-catalog-stack">
              <h3>使用此接口的用例</h3>
              {[
                ...new Map(
                  details.usage.map((item) => [item.caseId, item]),
                ).values(),
              ].map((item) => (
                <div className="api-catalog-usage-row" key={item.caseId}>
                  <span>{item.title}</span>
                  <Button
                    type="link"
                    href={`#api-regression?${new URLSearchParams({ projectId: item.projectId, caseId: item.caseId, history: '1', view: 'workbench' })}`}
                  >
                    查看诊断记录
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
          <ApiDiagnosticPage project={project} />
        </Modal>
      )}
    </>
  );
}

const revisionFieldLabels: Record<
  keyof ApiInterfaceDefinition | 'title' | 'stageProviders',
  string
> = {
  title: '接口名称',
  serviceKey: '服务键',
  method: '请求方法',
  path: '接口路径',
  status: '发布状态',
  description: '端点说明',
  tags: '标签',
  ownerId: '接口负责人',
  requirementVersionId: '关联需求版本',
  auth: '认证设置',
  parameters: '请求参数',
  requestBodies: '请求体',
  responses: '响应规范',
  models: '数据模型',
  mocks: 'Mock 规则',
  basisRefs: '来源依据',
  stageSettings: '前置与后置操作',
  stageProviders: '冻结的前后置策略',
};

function CatalogRevisionComparison({
  path,
  details,
  onRestore,
}: {
  path: string;
  details: ApiCatalogGetResult;
  onRestore?: (revision: NonNullable<ApiCatalogGetResult['revision']>) => void;
}) {
  const [target, setTarget] = useState<string | undefined>(() =>
    details.revision?.id !== details.node.currentRevisionId
      ? (details.node.currentRevisionId ?? undefined)
      : details.revisions.find((item) => item.id !== details.revision?.id)?.id,
  );
  const [compare, setCompare] = useState<ApiCatalogGetResult['revision']>(null);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const revision = details.revision;
  useEffect(() => {
    setCompare(null);
    setError(undefined);
    setLoading(Boolean(target));
    if (!target) return;
    const controller = new AbortController();
    void api(
      `${path}/nodes/${details.node.id}?revisionId=${target}`,
      {
        signal: controller.signal,
      },
      apiCatalogGetResultSchema,
    )
      .then(
        (result) => {
          if (!controller.signal.aborted) setCompare(result.revision);
        },
        (failure: unknown) => {
          if (!controller.signal.aborted) setError(describeError(failure));
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, details.node.id, target]);
  if (!revision || details.revisions.length < 2) return null;
  const snapshot = (item: NonNullable<ApiCatalogGetResult['revision']>) => ({
    title: item.title,
    ...item.definition,
    stageProviders: item.stageProviders,
  });
  const current = snapshot(revision);
  const other = compare ? snapshot(compare) : undefined;
  const keys = Object.keys(revisionFieldLabels) as Array<
    keyof typeof revisionFieldLabels
  >;
  const fields = other
    ? keys.filter(
        (key) => JSON.stringify(current[key]) !== JSON.stringify(other[key]),
      )
    : [];
  const restoreSource =
    revision.id !== details.node.currentRevisionId
      ? revision
      : compare?.id !== details.node.currentRevisionId
        ? compare
        : null;
  return (
    <section className="api-catalog-stack">
      <label className="api-catalog-form-field">
        <span>对比当前查看的 r{revision.revisionNumber}</span>
        <Select
          allowClear
          aria-label="选择对比修订"
          value={target}
          onChange={setTarget}
          loading={loading}
          placeholder="选择对比修订"
          options={details.revisions
            .filter((item) => item.id !== revision.id)
            .map((item) => ({
              value: item.id,
              label: 'r' + item.revisionNumber + ' · ' + item.title,
            }))}
        />
      </label>
      {onRestore && restoreSource && (
        <Button
          icon={<PlusOutlined />}
          onClick={() => onRestore(restoreSource)}
        >
          以此恢复为草稿 · r{restoreSource.revisionNumber}
        </Button>
      )}
      {error && <Alert type="error" title={error} />}
      {compare &&
        other &&
        (!fields.length ? (
          <p className="caption">定义及冻结策略无差异。</p>
        ) : (
          <>
            <p className="caption">
              r{compare.revisionNumber} 与 r{revision.revisionNumber}有{' '}
              {fields.length} 项差异
            </p>
            {fields.map((key) => (
              <details key={key}>
                <summary>{revisionFieldLabels[key]}</summary>
                <div className="api-catalog-form-grid">
                  <div>
                    <span className="caption">r{compare.revisionNumber}</span>
                    <pre className="api-catalog-result">
                      {JSON.stringify(other[key], null, 2) ?? '未设置'}
                    </pre>
                  </div>
                  <div>
                    <span className="caption">r{revision.revisionNumber}</span>
                    <pre className="api-catalog-result">
                      {JSON.stringify(current[key], null, 2) ?? '未设置'}
                    </pre>
                  </div>
                </div>
              </details>
            ))}
          </>
        ))}
    </section>
  );
}

function BodyDocumentation({
  body,
}: {
  body: ApiInterfaceDefinition['requestBodies'][number];
}) {
  return (
    <div className="stack">
      <b>{body.mediaType}</b>
      {body.schema !== undefined && (
        <pre className="api-catalog-result">
          {JSON.stringify(body.schema, null, 2)}
        </pre>
      )}
      {body.examples.map((example, index) => (
        <details key={example.name + ':' + index}>
          <summary>示例 · {example.name}</summary>
          {example.description && (
            <p className="caption">{example.description}</p>
          )}
          <pre className="api-catalog-result">
            {JSON.stringify(example.value, null, 2)}
          </pre>
        </details>
      ))}
    </div>
  );
}

function DefinitionDocument({
  definition,
  projectId,
}: {
  definition: ApiInterfaceDefinition;
  projectId: string;
}) {
  return (
    <div className="api-catalog-stack">
      <div className="api-catalog-summary">
        {definition.description || '暂无接口说明'}
      </div>
      <div className="api-catalog-form-grid">
        <div className="api-catalog-stack">
          <h3>请求定义</h3>
          <div className="row wrap">
            <Tag>{definition.method}</Tag>
            <code>{definition.path}</code>
            <span className="caption">
              {definition.auth.mode === 'inherit'
                ? '继承待配置（不选取环境中的其他账号）'
                : definition.auth.mode === 'none'
                  ? '无需认证'
                  : '项目账号用途'}
            </span>
          </div>
          <Table
            size="small"
            rowKey={(item) => item.location + ':' + item.name}
            dataSource={definition.parameters}
            pagination={false}
            columns={[
              { title: '来源', dataIndex: 'location' },
              { title: '参数', dataIndex: 'name' },
              {
                title: '类型',
                render: (_value, row) =>
                  row.schema &&
                  typeof row.schema !== 'boolean' &&
                  typeof row.schema.type === 'string'
                    ? row.schema.type
                    : '—',
              },
              {
                title: '必填',
                render: (_value, row) => (row.required ? '是' : '否'),
              },
              {
                title: '示例',
                render: (_value, row) =>
                  row.examples[0] ? (
                    <code title={row.description}>
                      {JSON.stringify(row.examples[0].value)}
                    </code>
                  ) : (
                    '—'
                  ),
              },
            ]}
          />
          {definition.requestBodies.map((body) => (
            <BodyDocumentation body={body} key={body.mediaType} />
          ))}
        </div>
        <div className="api-catalog-stack">
          <h3>响应规范</h3>
          {definition.responses.length ? (
            definition.responses.map((response) => (
              <div key={response.code}>
                <Tag color="green">{response.code}</Tag>
                {response.description}
                {response.headers.length > 0 && (
                  <div className="caption">
                    响应头：
                    {response.headers.map((header) => header.name).join('、')}
                  </div>
                )}
                {response.content.map((body) => (
                  <BodyDocumentation body={body} key={body.mediaType} />
                ))}
              </div>
            ))
          ) : (
            <p className="caption">暂无响应声明</p>
          )}
        </div>
      </div>
      {Object.entries(definition.models).map(([name, model]) => (
        <details key={name}>
          <summary>公共模型 · {name}</summary>
          <pre className="api-catalog-result">
            {JSON.stringify(model, null, 2)}
          </pre>
        </details>
      ))}
      {definition.basisRefs.length > 0 && (
        <section>
          <h3>定义来源</h3>
          <ul>
            {definition.basisRefs.map((basis, index) => (
              <li key={index}>
                {basis.description}{' '}
                {basis.kind === 'interfaceRevision' ? (
                  <a
                    href={
                      '#api-catalog?' +
                      new URLSearchParams({
                        projectId,
                        endpointId: basis.interfaceId,
                        revisionId: basis.revisionId,
                      })
                    }
                  >
                    查看固定接口修订
                  </a>
                ) : basis.kind === 'diagnostic' ? (
                  <>
                    <a
                      href={
                        '#api-regression?' +
                        new URLSearchParams({
                          projectId,
                          debugRunId: basis.runId,
                        })
                      }
                    >
                      查看原诊断
                    </a>{' '}
                    <code title={basis.attemptId}>
                      步骤事实 {basis.attemptId.slice(0, 8)}
                    </code>
                  </>
                ) : basis.kind === 'material' ? (
                  <code title={basis.requirementVersionId}>
                    需求材料 {basis.materialId.slice(0, 8)}
                  </code>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function UsageList({
  details,
  single = false,
}: {
  details: ApiCatalogGetResult;
  single?: boolean;
}) {
  const usage = details.usage.filter(
    (row) => !single || row.caseType === 'single',
  );
  return (
    <section>
      <h3>使用此接口的用例</h3>
      {usage.length ? (
        usage.map((item) => (
          <div
            key={item.caseId + ':' + item.interfaceRevisionId}
            className="api-catalog-usage-row"
          >
            <a
              href={`#api-regression?${new URLSearchParams({ projectId: item.projectId, caseId: item.caseId, revisionId: item.caseRevisionId, view: 'workbench' })}`}
            >
              {item.title}
            </a>
            <code>{item.interfaceRevisionId}</code>
          </div>
        ))
      ) : (
        <p className="caption">暂无用例引用。</p>
      )}
    </section>
  );
}

function CatalogDiagnosticSourceDialog({
  base,
  origin,
  hasFolder,
  onClose,
  onDraft,
}: {
  base: string;
  origin: DiagnosticOrigin;
  hasFolder: boolean;
  onClose: () => void;
  onDraft: (draft: ApiCatalogSourceDraft) => void;
}) {
  const [serviceKey, setServiceKey] = useState('');
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  async function read() {
    setPending(true);
    setError(undefined);
    try {
      const input = apiCatalogDiagnosticDraftInputSchema.parse({
        ...origin,
        serviceKey: serviceKey.trim(),
      });
      const draft = await api(
        base,
        { method: 'POST', body: { op: 'preview-diagnostic', input } },
        apiCatalogSourceDraftSchema,
      );
      onDraft(draft);
    } catch (error) {
      setError(describeError(error));
    } finally {
      setPending(false);
    }
  }
  return (
    <Modal
      open
      title="从诊断创建接口草稿"
      okText="读取并预览"
      onOk={() => void read()}
      onCancel={onClose}
      confirmLoading={pending}
      closable={!pending}
      maskClosable={!pending}
      okButtonProps={{ disabled: !serviceKey.trim() || !hasFolder }}
    >
      <div className="api-catalog-stack">
        {error && <Alert type="error" title={error} showIcon />}
        {!hasFolder && (
          <Alert type="info" title="请先创建产品模块和功能目录。" showIcon />
        )}
        <p className="caption">
          诊断 {origin.runId.slice(0, 8)} · 步骤事实{' '}
          {origin.attemptId.slice(0, 8)}
        </p>
        <label className="api-catalog-form-field">
          <span>应用到项目服务键</span>
          <Input
            aria-label="诊断接口服务键"
            autoComplete="off"
            maxLength={100}
            placeholder="例如 default"
            disabled={pending}
            value={serviceKey}
            onChange={(event) => setServiceKey(event.target.value)}
          />
        </label>
      </div>
    </Modal>
  );
}

function CatalogNodeDialog({
  dialog,
  base,
  projectId,
  canArchive,
  nodes,
  onSaved,
  onClose,
}: {
  dialog: Extract<Dialog, { kind: 'create' | 'organize' }>;
  base: string;
  projectId: string;
  canArchive: boolean;
  nodes: readonly ApiCatalogNode[];
  onSaved: (node: ApiCatalogNode) => void;
  onClose: () => void;
}) {
  const node = dialog.kind === 'organize' ? dialog.node : null;
  const nodeKind =
    dialog.kind === 'create' ? dialog.nodeKind : dialog.node.kind;
  const source = dialog.kind === 'create' ? dialog.source : undefined;
  const [title, setTitle] = useState(node?.title ?? source?.title ?? '');
  const [parent, setParent] = useState(
    (dialog.kind === 'create' ? dialog.parentId : dialog.node.parentId) ??
      undefined,
  );
  const [archived, setArchived] = useState(Boolean(node?.archivedAt));
  const [directoryStages, setDirectoryStages] = useState<ApiStageSettings>(
    () =>
      (dialog.kind === 'organize' ? dialog.directoryStages : null) ??
      apiNoStages,
  );
  const [stagesChanged, setStagesChanged] = useState(false);
  const [draft, setDraft] = useState(() =>
    makeCatalogDraft(source?.definition),
  );
  const [edited, setEdited] = useState(false);
  const command = useBusinessCommand(dialog.session);
  const busy = command.pending || command.uncertain;
  const options = nodes.filter(
    (item) =>
      !item.archivedAt &&
      item.kind === (nodeKind === 'folder' ? 'module' : 'folder'),
  );
  async function submit() {
    const response = await command.run((commandId) => {
      const input = node
        ? apiCatalogOrganizeInputSchema.parse({
            id: node.id,
            rowVersion: node.rowVersion,
            commandId,
            ...(title.trim() !== node.title && { title }),
            ...(parent !== undefined &&
              parent !== node.parentId && { parentId: parent }),
            ...(archived !== Boolean(node.archivedAt) && { archived }),
            ...(stagesChanged && { directoryStages }),
          })
        : apiCatalogCreateInputSchema.parse({
            commandId,
            kind: nodeKind,
            title,
            ...(nodeKind !== 'module' && { parentId: parent }),
            ...(nodeKind === 'interface' && {
              definition: buildCatalogDefinition(draft),
            }),
            ...(nodeKind !== 'interface' &&
              stagesChanged && { directoryStages }),
          });
      return api(
        base,
        { method: 'POST', body: { op: node ? 'organize' : 'create', input } },
        apiCatalogNodeSchema,
      );
    });
    if (response) onSaved(response);
  }
  return (
    <CommandDialog
      open
      title={
        source
          ? '保存接口草稿'
          : `${node ? '管理' : '新建'}${nodeTitle(nodeKind)}`
      }
      command={command}
      dirty={edited}
      width={nodeKind === 'interface' ? 860 : 580}
      onClose={onClose}
      onSave={() => void submit()}
      allowSave={Boolean(
        title.trim() && (nodeKind === 'module' || parent) && (!node || edited),
      )}
      saveLabel={node ? '保存目录变更' : '创建'}
    >
      <div className="api-catalog-stack">
        {source && (
          <Alert
            type="info"
            showIcon
            title="来源已固定，请核对后创建"
            description={source.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          />
        )}
        <label className="api-catalog-form-field">
          <span>{nodeTitle(nodeKind)}名称</span>
          <Input
            maxLength={200}
            disabled={busy}
            value={title}
            onChange={(event) => {
              setEdited(true);
              setTitle(event.target.value);
            }}
          />
        </label>
        {nodeKind !== 'module' && (
          <label className="api-catalog-form-field">
            <span>所属{nodeKind === 'folder' ? '产品模块' : '功能目录'}</span>
            <Select
              showSearch
              optionFilterProp="label"
              disabled={busy}
              value={parent ?? null}
              options={options.map((item) => ({
                value: item.id,
                label: [
                  nodes.find((parent) => parent.id === item.parentId)?.title,
                  item.title,
                ]
                  .filter(Boolean)
                  .join(' / '),
              }))}
              onChange={(value: string) => {
                setEdited(true);
                setParent(value);
              }}
            />
          </label>
        )}
        {node ? (
          <Checkbox
            checked={archived}
            disabled={busy || !canArchive}
            onChange={(event) => {
              setEdited(true);
              setArchived(event.target.checked);
            }}
          >
            归档此目录项
          </Checkbox>
        ) : (
          nodeKind === 'interface' && (
            <ApiCatalogDefinitionEditor
              projectId={projectId}
              draft={draft}
              disabled={busy}
              onChange={(value) => {
                setEdited(true);
                setDraft(value);
              }}
            />
          )
        )}
        {nodeKind !== 'interface' && (
          <ApiStageFields
            projectId={projectId}
            value={directoryStages}
            {...(dialog.kind === 'organize' &&
              dialog.directoryProviders && {
                providers: dialog.directoryProviders.filter(
                  (provider) => provider.id !== dialog.node.id,
                ),
              })}
            disabled={busy}
            onChange={(value) => {
              setDirectoryStages(value);
              setStagesChanged(true);
              setEdited(true);
            }}
          />
        )}
      </div>
    </CommandDialog>
  );
}

function CatalogMock({
  base,
  details,
}: {
  base: string;
  details: ApiCatalogGetResult;
}) {
  const definition = details.revision?.definition;
  const [path, setPath] = useState(definition?.path ?? '/');
  const [method, setMethod] = useState<ApiInterfaceDefinition['method']>(
    definition?.method ?? 'GET',
  );
  const [args, setArgs] = useState('{}');
  const [result, setResult] =
    useState<z.output<typeof apiCatalogMockResultSchema>>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  async function preview() {
    setPending(true);
    setResult(undefined);
    setError(undefined);
    try {
      const payload: unknown = JSON.parse(args);
      const params = z
        .strictObject({
          query: z.record(z.string(), z.string()).optional(),
          headers: z.record(z.string(), z.string()).optional(),
          body: z.json().optional(),
        })
        .parse(payload);
      const input = apiCatalogMockInputSchema.parse({
        ...params,
        path,
        method,
        revisionId: details.revision?.id,
      });
      const response = await api(
        base,
        {
          method: 'POST',
          body: { op: 'preview-mock', id: details.node.id, input },
        },
        apiCatalogMockResultSchema,
      );
      setResult(response);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="api-catalog-stack">
      <h3>Mock 期望</h3>
      <ul>
        {definition?.mocks.map((item) => (
          <li key={item.name}>
            {item.name} · {item.enabled ? '启用' : '停用'} · 优先级{' '}
            {item.priority}
          </li>
        ))}
      </ul>
      <div className="row wrap">
        <Select
          aria-label="Mock 方法"
          value={method}
          onChange={setMethod}
          options={apiInterfaceMethodSchema.options.map((value) => ({
            value,
            label: value,
          }))}
        />
        <Input
          aria-label="Mock 路径"
          className="grow"
          value={path}
          onChange={(event) => setPath(event.target.value)}
        />
        <Button loading={pending} type="primary" onClick={() => void preview()}>
          预览模拟响应
        </Button>
      </div>
      <label className="api-catalog-form-field">
        <span>请求参数（query、headers、body）</span>
        <Input.TextArea
          className="api-catalog-code"
          value={args}
          autoSize={{ minRows: 3, maxRows: 10 }}
          onChange={(event) => setArgs(event.target.value)}
        />
      </label>
      {error && <Alert type="error" title={error} showIcon />}
      {result && (
        <>
          <Tag color="blue">
            Mock · {result.status} · {result.mediaType}
          </Tag>
          <pre className="api-catalog-result">
            {JSON.stringify(result.body, null, 2)}
          </pre>
        </>
      )}
    </div>
  );
}

function CatalogExport({
  base,
  nodeId,
  revisionId,
}: {
  base: string;
  nodeId: string;
  revisionId: string;
}) {
  const { message } = App.useApp();
  const [format, setFormat] =
    useState<z.output<typeof apiCatalogExportInputSchema>['format']>('openapi');
  const [pending, setPending] = useState(false);
  async function exportDefinition() {
    setPending(true);
    try {
      const result = await api(
        base,
        {
          method: 'POST',
          body: {
            op: 'export',
            id: nodeId,
            input: apiCatalogExportInputSchema.parse({ format, revisionId }),
          },
        },
        apiCatalogExportResultSchema,
      );
      download(result.fileName, result.mediaType, result.content);
    } catch (failure) {
      void message.error(describeError(failure));
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="row wrap">
      <Select
        aria-label="导出接口格式"
        disabled={pending}
        value={format}
        onChange={setFormat}
        options={[
          { value: 'openapi', label: 'OpenAPI' },
          { value: 'markdown', label: 'Markdown' },
          { value: 'curl', label: 'cURL' },
        ]}
      />
      <Button
        icon={<DownloadOutlined />}
        loading={pending}
        onClick={() => void exportDefinition()}
      >
        导出此修订
      </Button>
    </div>
  );
}
