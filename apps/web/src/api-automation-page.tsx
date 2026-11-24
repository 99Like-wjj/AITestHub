import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Input,
  Select,
  Skeleton,
  Table,
  Tag,
  Typography,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { z } from 'zod';
import {
  apiAutomationArchiveInputSchema,
  apiAutomationCreateCaseInputSchema,
  apiAutomationCreateScenarioInputSchema,
  apiAutomationGetInputSchema,
  apiAutomationListSchema,
  apiAutomationReviseCaseInputSchema,
  apiAutomationReviseScenarioInputSchema,
  apiProjectAssetSchema,
  apiProjectCaseSchema,
  apiProjectScenarioSchema,
  type ApiProjectAsset,
  type ApiProjectCase,
  type ApiProjectScenario,
} from '../../../packages/contracts/src/api-automation';
import { apiCatalogGetResultSchema } from '../../../packages/contracts/src/api-catalog';
import { assetNavigationSchema } from '../../../packages/contracts/src/assets';
import { idSchema } from '../../../packages/contracts/src/base';
import { api, describeError } from './api';
import { CommandDialog, useBusinessCommand } from './business-command';
import {
  ExplorerTree,
  findExplorerPath,
  useExplorerSearch,
  type ExplorerNode,
} from './explorer-tree';
import { PageHeading } from './page-heading';
import { RequirementDirectory } from './requirement-directory';
import {
  RequirementBasisNotice,
  RequirementBasisTag,
  requirementMaterialsHref,
} from './requirement-basis';
import { canEditProjectAssets } from './project-access';
import { requestNavigation } from './navigation-guard';
import { ApiAutomationEditor } from './api-automation-editor';
import { ApiBatchDiagnostics } from './api-batch-diagnostics';
import { ApiDiagnosticPage } from './api-draft-debugger';
import type { Project } from './types';
import './api-assets-workbench.css';

const uuid = (value: string | null) => idSchema.safeParse(value).data;
type Navigation = z.output<typeof assetNavigationSchema>['requirements'];
type List = z.output<typeof apiAutomationListSchema>;
type CreateKind = 'single' | 'scenario' | 'debug';

function routeState(projectId: string) {
  const url = new URLSearchParams(window.location.hash.split('?')[1]);
  const scoped = !url.has('projectId') || url.get('projectId') === projectId;
  const create = url.get('create');
  const debugRun = uuid(url.get('debugRunId'));
  const debugCommand = uuid(url.get('debugCommandId'));
  return {
    caseId: scoped ? uuid(url.get('caseId')) : undefined,
    revisionId: scoped ? uuid(url.get('revisionId')) : undefined,
    sceneId: scoped ? uuid(url.get('sceneId')) : undefined,
    requirementId: scoped ? uuid(url.get('requirementId')) : undefined,
    versionId: scoped ? uuid(url.get('versionId')) : undefined,
    snapshot: scoped && url.get('basis') === 'snapshot',
    folder: scoped ? url.get('folder') : null,
    interfaceId:
      scoped && create === 'debug' ? uuid(url.get('fromInterface')) : undefined,
    interfaceRevisionId:
      scoped && create === 'debug' ? uuid(url.get('fromRevision')) : undefined,
    history: scoped && url.get('history') === '1',
    create:
      scoped &&
      (create === 'single' || create === 'scenario' || create === 'debug')
        ? create
        : null,
    ...(scoped &&
      (debugRun || debugCommand) && {
        restore: debugRun
          ? { kind: 'run' as const, id: debugRun }
          : { kind: 'command' as const, id: debugCommand! },
      }),
  };
}

function caseNode(row: ApiProjectCase, prefix = 'case:'): ExplorerNode {
  return {
    id: prefix + row.id,
    title: row.title,
    detail: 'r' + row.revisionNo,
    searchText: row.content.tags?.join(' ') ?? '',
    archived: Boolean(row.removedAt),
  };
}
function navigationNodes(
  list: List,
  navigation: Navigation,
  selectedRequirementId: string | undefined,
) {
  const independent = list.cases.filter((row) => !row.parentId);
  const projectScenes = list.scenarios.filter(
    (row) => !row.requirementVersionId,
  );
  const scenes = (rows: ApiProjectScenario[], prefix: string) =>
    rows.map((row): ExplorerNode => {
      const cases = list.cases.filter((record) => record.parentId === row.id);
      return {
        id: prefix + row.id,
        title: row.title,
        archived: Boolean(row.removedAt),
        count: cases.length,
        children: cases.map((entry) =>
          caseNode(
            entry,
            prefix.startsWith('requirement-scene:')
              ? prefix.replace('requirement-scene:', 'requirement-case:')
              : 'case:',
          ),
        ),
      };
    });
  return [
    { id: 'all', title: '全部用例', count: list.cases.length, kind: 'all' },
    {
      id: 'single',
      title: '单接口用例',
      count: independent.length,
      children: independent.map((row) => caseNode(row)),
    },
    {
      id: 'scenes',
      title: '场景用例',
      count: list.scenarios.length,
      children: [
        {
          id: 'project-scenes',
          title: '项目场景',
          count: projectScenes.length,
          children: scenes(projectScenes, 'scene:'),
        },
        ...navigation
          .filter(
            (requirement) =>
              requirement.id === selectedRequirementId ||
              list.scenarios.some((scene) =>
                requirement.versions.some(
                  (item) => item.id === scene.requirementVersionId,
                ),
              ),
          )
          .map((requirement): ExplorerNode => ({
            id: `requirement:${requirement.id}`,
            title: requirement.title,
            archived: requirement.archived,
            children: scenes(
              list.scenarios.filter((scene) =>
                requirement.versions.some(
                  (item) => item.id === scene.requirementVersionId,
                ),
              ),
              `requirement-scene:${requirement.id}:`,
            ),
          })),
      ],
    },
  ] satisfies ExplorerNode[];
}

export function ApiAutomationPage({
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
    <ProjectAutomation
      project={project}
      userId={userId}
      onNavigate={onNavigate}
    />
  );
}

function ProjectAutomation({
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
    `explorer:automation:${userId}:${project.id}:search`,
  );
  const [tag, setTag] = useState<string | null>(null);
  const [list, setList] = useState<List>({ scenarios: [], cases: [] });
  const [includeArchived, setIncludeArchived] = useState(false);
  const [navigation, setNavigation] = useState<Navigation>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [caseError, setCaseError] = useState<string>();
  const [endpointError, setEndpointError] = useState<string>();
  const [active, setActive] = useState<ApiProjectCase>();
  const [endpoint, setEndpoint] =
    useState<z.output<typeof apiCatalogGetResultSchema>>();
  const [reload, setReload] = useState(0);
  const [sceneDialog, setSceneDialog] = useState<{
    session: string;
    scene?: ApiProjectScenario;
  }>();
  const [archiveTarget, setArchiveTarget] = useState<ApiProjectAsset>();
  const commit = useBusinessCommand(archiveTarget?.id ?? null);
  const path = `/projects/${project.id}/api-automation`;
  const tester = project.roles.includes('tester');
  const allowed = canEditProjectAssets(project);
  const writable = allowed && !route.snapshot;
  const diagnosticOnly = route.create === 'debug';
  const canOpenRequestedEditor = diagnosticOnly
    ? tester &&
      !route.snapshot &&
      Boolean(route.interfaceId && route.interfaceRevisionId)
    : writable;
  useEffect(() => {
    const listener = () => setRoute(routeState(project.id));
    window.addEventListener('hashchange', listener);
    return () => window.removeEventListener('hashchange', listener);
  }, [project.id]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    void Promise.all([
      api(
        path,
        {
          method: 'POST',
          body: { op: 'list', includeArchived },
          signal: controller.signal,
        },
        apiAutomationListSchema,
      ),
      api(
        `/projects/${project.id}/assets/navigation?kind=UI&includeArchivedRequirements=${includeArchived}`,
        { signal: controller.signal },
        assetNavigationSchema,
      ),
    ])
      .then(
        ([rows, requirements]) => {
          if (!controller.signal.aborted) {
            setList(rows);
            setNavigation(requirements.requirements);
          }
        },
        (failure: unknown) => {
          if (!controller.signal.aborted) setError(describeError(failure));
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, project.id, includeArchived, reload]);
  useEffect(() => {
    setActive(undefined);
    setCaseError(undefined);
    if (!route.caseId) return;
    const controller = new AbortController();
    const input = apiAutomationGetInputSchema.parse({
      assetId: route.caseId,
      ...(route.revisionId && { revisionId: route.revisionId }),
    });
    void api(
      path,
      {
        method: 'POST',
        body: { op: 'get', ...input },
        signal: controller.signal,
      },
      apiProjectCaseSchema,
    ).then(
      (row) => {
        if (!controller.signal.aborted) setActive(row);
      },
      (failure: unknown) => {
        if (!controller.signal.aborted) setCaseError(describeError(failure));
      },
    );
    return () => controller.abort();
  }, [path, route.caseId, route.revisionId, reload]);
  useEffect(() => {
    setEndpoint(undefined);
    setEndpointError(undefined);
    if (
      !canOpenRequestedEditor ||
      !route.interfaceId ||
      !route.interfaceRevisionId
    )
      return;
    const controller = new AbortController();
    void api(
      `/projects/${project.id}/api-catalog/nodes/${route.interfaceId}?revisionId=${route.interfaceRevisionId}`,
      { signal: controller.signal },
      apiCatalogGetResultSchema,
    ).then(
      (result) => {
        if (!controller.signal.aborted) setEndpoint(result);
      },
      (failure: unknown) => {
        if (!controller.signal.aborted)
          setEndpointError(describeError(failure));
      },
    );
    return () => controller.abort();
  }, [
    project.id,
    route.interfaceId,
    route.interfaceRevisionId,
    canOpenRequestedEditor,
  ]);

  const scene = list.scenarios.find(
    (item) => item.id === (route.sceneId ?? active?.parentId),
  );
  const linkedAsset = active ?? scene;
  const owningRequirement = navigation.find((item) => {
    const authoredRequirementId = linkedAsset?.requirementBasis?.requirementId;
    if (authoredRequirementId) return item.id === authoredRequirementId;
    if (linkedAsset)
      return item.versions.some(
        (version) => version.id === linkedAsset.requirementVersionId,
      );
    return route.requirementId
      ? item.id === route.requirementId
      : item.versions.some((version) => version.id === route.versionId);
  });
  const ownerId = owningRequirement?.id;
  const pinnedBasis = route.snapshot ? route.versionId : undefined;
  const tree = useMemo(
    () =>
      navigationNodes(
        tag
          ? {
              ...list,
              cases: list.cases.filter((item) =>
                item.content.tags?.includes(tag),
              ),
            }
          : list,
        navigation,
        ownerId,
      ),
    [list, navigation, ownerId, tag],
  );
  const folder =
    route.folder ??
    (owningRequirement ? 'requirement:' + owningRequirement.id : 'all');
  const selected = route.caseId
    ? (ownerId ? `requirement-case:${ownerId}:` : 'case:') + route.caseId
    : route.sceneId
      ? (ownerId ? `requirement-scene:${ownerId}:` : 'scene:') + route.sceneId
      : folder;
  const crumbs = findExplorerPath(tree, selected);
  const chosenCases = list.cases
    .filter((item) => !tag || item.content.tags?.includes(tag))
    .filter((item) =>
      route.sceneId
        ? item.parentId === route.sceneId
        : pinnedBasis
          ? item.requirementVersionId === pinnedBasis
          : owningRequirement
            ? owningRequirement.versions.some(
                (version) => version.id === item.requirementVersionId,
              )
            : folder === 'single'
              ? !item.parentId
              : folder === 'project-scenes'
                ? item.parentId && !item.requirementVersionId
                : folder === 'scenes'
                  ? Boolean(item.parentId)
                  : true,
    )
    .filter(
      (item) =>
        !search.trim() ||
        [item.title, item.id, ...(item.content.tags ?? [])].some((field) =>
          field.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
        ),
    );
  const saveCase = async (
    content: ApiProjectCase['content'],
    commandId: string,
  ) => {
    const chosenScene = list.scenarios.find(
      (item) => item.id === content.scenarioId,
    );
    const requirement = navigation.find((item) =>
      item.versions.some(
        (version) => version.id === chosenScene?.requirementVersionId,
      ),
    );
    const body = active
      ? {
          op: 'revise-case',
          ...apiAutomationReviseCaseInputSchema.parse({
            commandId,
            assetId: active.id,
            baseRevisionId: active.revisionId,
            rowVersion: active.rowVersion,
            content,
          }),
        }
      : {
          op: 'create-case',
          ...apiAutomationCreateCaseInputSchema.parse({
            commandId,
            content,
            ...(requirement && {
              basisRequirementVersionId: requirement.currentVersionId,
            }),
          }),
        };
    return api(path, { method: 'POST', body }, apiProjectCaseSchema);
  };
  const cloneCase = (commandId: string, title: string) => {
    if (!active || active.removedAt) throw new Error('当前修订不能复制。');
    const chosenScene = list.scenarios.find(
      (item) => item.id === active.content.scenarioId,
    );
    const sceneVersionId = chosenScene?.requirementVersionId;
    const sourceBasis = active.requirementBasis;
    const sceneOwner = navigation.find((item) =>
      item.versions.some((version) => version.id === sceneVersionId),
    )?.id;
    const sceneBasis = chosenScene?.requirementBasis;
    const requirementId =
      sceneOwner ??
      (sceneBasis?.lockedVersionId === sceneVersionId
        ? sceneBasis?.requirementId
        : undefined);
    const basisRequirementVersionId =
      sceneVersionId &&
      sceneVersionId === active.requirementVersionId &&
      sourceBasis?.requirementId === requirementId
        ? sourceBasis?.basisVersionId
        : undefined;
    return api(
      path,
      {
        method: 'POST',
        body: {
          op: 'create-case',
          ...apiAutomationCreateCaseInputSchema.parse({
            commandId,
            content: { ...active.content, title },
            ...(basisRequirementVersionId && { basisRequirementVersionId }),
          }),
        },
      },
      apiProjectCaseSchema,
    );
  };
  function navigate(options: Record<string, string> = {}) {
    const hash = `#api-regression?${new URLSearchParams({ projectId: project.id, ...options })}`;
    if (hash !== window.location.hash) onNavigate(hash);
  }
  function openCase(id: string, revisionId?: string, requirementId = ownerId) {
    requestNavigation(() =>
      navigate({
        caseId: id,
        view: 'workbench',
        ...(revisionId && { revisionId }),
        ...(requirementId && { requirementId }),
        ...(pinnedBasis && { versionId: pinnedBasis, basis: 'snapshot' }),
      }),
    );
  }
  function saved(row: ApiProjectCase) {
    setActive(row);
    if (route.caseId !== row.id || route.revisionId)
      navigate({ caseId: row.id, view: 'workbench' });
    setReload((count) => count + 1);
  }
  function select(key: string) {
    if (key.startsWith('case:')) {
      if (route.caseId !== key.slice(5)) openCase(key.slice(5));
      return;
    }
    if (key.startsWith('requirement-case:')) {
      const [, requirementId, caseId] = key.split(':');
      if (caseId && requirementId) openCase(caseId, undefined, requirementId);
      return;
    }
    requestNavigation(() => {
      if (key.startsWith('requirement-scene:')) {
        const [, requirementId, sceneId] = key.split(':');
        if (requirementId && sceneId) navigate({ requirementId, sceneId });
      } else if (key.startsWith('scene:')) navigate({ sceneId: key.slice(6) });
      else if (key.startsWith('requirement:')) {
        navigate({ requirementId: key.slice(12) });
      } else navigate({ folder: key });
    });
  }
  function create(kind: CreateKind) {
    requestNavigation(() =>
      navigate({
        create: kind,
        ...(route.sceneId && { sceneId: route.sceneId }),
        ...(ownerId && { requirementId: ownerId }),
      }),
    );
  }
  function archive() {
    if (!archiveTarget) return;
    const input = (commandId: string) =>
      apiAutomationArchiveInputSchema.parse({
        assetId: archiveTarget.id,
        baseRevisionId: archiveTarget.revisionId,
        rowVersion: archiveTarget.rowVersion,
        commandId,
      });
    void commit
      .run((commandId) =>
        api(
          path,
          { method: 'POST', body: { op: 'archive', ...input(commandId) } },
          apiProjectAssetSchema,
        ),
      )
      .then((row) => {
        if (!row) return;
        setArchiveTarget(undefined);
        setReload((count) => count + 1);
        navigate();
        void message.success('已归档');
      });
  }
  const sourceLoading = Boolean(
    canOpenRequestedEditor && route.interfaceId && !endpoint && !endpointError,
  );
  const showEditor = Boolean(
    (route.create &&
      canOpenRequestedEditor &&
      !sourceLoading &&
      !endpointError) ||
    active,
  );
  return (
    <>
      <PageHeading
        title="自动化测试"
        description="配置独立的单接口用例和多步场景，按需关联需求。"
        actions={
          diagnosticOnly ? null : (
            <>
              {tester && !route.snapshot && !showEditor && (
                <ApiBatchDiagnostics
                  projectId={project.id}
                  cases={chosenCases.filter((item) => !item.removedAt)}
                />
              )}
              <Button
                disabled={!writable}
                icon={<PlusOutlined />}
                onClick={() =>
                  requestNavigation(() =>
                    setSceneDialog({ session: crypto.randomUUID() }),
                  )
                }
              >
                新建场景
              </Button>
              <Button
                disabled={!writable}
                type="primary"
                icon={<PlusOutlined />}
                onClick={() =>
                  create(
                    scene ||
                      (folder !== 'single' &&
                        list.scenarios.some(
                          (item) =>
                            !item.removedAt &&
                            (!owningRequirement ||
                              owningRequirement.versions.some(
                                (version) =>
                                  version.id === item.requirementVersionId,
                              )),
                        ))
                      ? 'scenario'
                      : 'single',
                  )
                }
              >
                新建用例
              </Button>
            </>
          )
        }
      />
      <div className="requirement-directory-layout api-assets-layout">
        <RequirementDirectory
          title="自动化目录"
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="搜索需求、场景、用例或标签"
          includeArchived={includeArchived}
          archiveLabel="显示已归档资产"
          onIncludeArchivedChange={setIncludeArchived}
          action={
            !diagnosticOnly && (
              <Button
                aria-label="新建场景"
                size="small"
                icon={<PlusOutlined />}
                disabled={!writable}
                onClick={() =>
                  requestNavigation(() =>
                    setSceneDialog({ session: crypto.randomUUID() }),
                  )
                }
              />
            )
          }
        >
          {loading ? (
            <Skeleton active />
          ) : (
            <ExplorerTree
              label="接口自动化目录"
              nodes={tree}
              selected={selected}
              storageKey={`explorer:automation:${userId}:${project.id}`}
              onSelect={select}
              search={search}
            />
          )}
        </RequirementDirectory>
        <div className="explorer-workspace-main api-catalog-stack">
          <nav className="api-catalog-breadcrumb" aria-label="当前用例路径">
            <Button type="link" size="small" onClick={() => select('all')}>
              自动化目录
            </Button>
            {crumbs
              .filter((item) => item.kind !== 'all')
              .map((item) => (
                <span key={item.id}>
                  {' '}
                  <span aria-hidden>›</span>{' '}
                  {item.id === selected ? (
                    <strong>{item.title}</strong>
                  ) : (
                    <Button
                      type="link"
                      size="small"
                      onClick={() => select(item.id)}
                    >
                      {item.title}
                    </Button>
                  )}
                </span>
              ))}
          </nav>
          {error && <Alert type="error" title={error} showIcon />}
          {caseError && <Alert type="error" title={caseError} showIcon />}
          {endpointError && (
            <Alert type="error" title={endpointError} showIcon />
          )}
          {route.snapshot && (
            <Alert
              type="info"
              showIcon
              title="资料快照用例范围 · 只读"
              action={
                ownerId && (
                  <Button
                    size="small"
                    onClick={() => select('requirement:' + ownerId)}
                  >
                    返回需求用例
                  </Button>
                )
              }
            />
          )}
          {showEditor ? (
            <ApiAutomationEditor
              key={
                active
                  ? active.id + ':' + active.revisionId
                  : (route.create ?? '') +
                    ':' +
                    (endpoint?.revision?.id ?? 'manual')
              }
              projectId={project.id}
              userId={userId}
              asset={active}
              projectCases={list.cases}
              scenes={list.scenarios
                .filter((item) => !item.removedAt)
                .sort(
                  (left, right) =>
                    Number(right.requirementBasis?.requirementId === ownerId) -
                    Number(left.requirementBasis?.requirementId === ownerId),
                )}
              sceneId={route.sceneId}
              preferScenario={route.create === 'scenario'}
              endpoint={endpoint}
              diagnosticOnly={diagnosticOnly}
              writable={writable && !route.revisionId && !active?.removedAt}
              canDiagnose={
                tester &&
                !route.snapshot &&
                !route.revisionId &&
                !active?.removedAt
              }
              restoration={route.restore}
              openHistory={route.history}
              saveCase={saveCase}
              onSaved={saved}
              onClone={
                writable && active && !route.revisionId && !active.removedAt
                  ? cloneCase
                  : undefined
              }
              onArchive={
                active && tester && !route.snapshot && !route.revisionId
                  ? () => setArchiveTarget(active)
                  : undefined
              }
              onOpenRevision={(caseId, revisionId) =>
                openCase(caseId, revisionId)
              }
            />
          ) : (route.caseId && !caseError) || sourceLoading ? (
            <Card>
              <Skeleton active />
            </Card>
          ) : (
            <section className="card api-catalog-detail">
              <header className="api-catalog-section-head">
                <div>
                  <h2>{scene?.title ?? crumbs.at(-1)?.title ?? '全部用例'}</h2>
                  <p className="caption">
                    {scene
                      ? scene.content.objective
                      : '按用例类型、项目场景或需求浏览。'}
                  </p>
                </div>
                {ownerId && !route.snapshot && (
                  <Button href={requirementMaterialsHref(project.id, ownerId)}>
                    需求资料
                  </Button>
                )}
                {scene && writable && !scene.removedAt && (
                  <div className="row wrap">
                    <Button
                      onClick={() =>
                        setSceneDialog({ session: crypto.randomUUID(), scene })
                      }
                    >
                      编辑场景
                    </Button>
                    {tester && (
                      <Button onClick={() => setArchiveTarget(scene)}>
                        归档场景
                      </Button>
                    )}
                  </div>
                )}
              </header>
              {scene && (
                <RequirementBasisNotice
                  projectId={project.id}
                  basis={scene.requirementBasis}
                  showLinks
                />
              )}
              <div className="row wrap">
                <Select
                  aria-label="按用例标签筛选"
                  placeholder="全部标签"
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  value={tag}
                  onChange={(value: string | undefined) =>
                    setTag(value ?? null)
                  }
                  options={[
                    ...new Set(
                      list.cases.flatMap((item) => item.content.tags ?? []),
                    ),
                  ].map((value) => ({ value, label: value }))}
                />
              </div>
              <Table
                rowKey="id"
                size="small"
                loading={loading}
                dataSource={chosenCases}
                locale={{ emptyText: '当前目录暂无用例' }}
                columns={[
                  {
                    title: '用例',
                    render: (_value, row) => (
                      <>
                        <Button type="link" onClick={() => openCase(row.id)}>
                          {row.title}
                        </Button>
                        <RequirementBasisTag basis={row.requirementBasis} />
                      </>
                    ),
                  },
                  {
                    title: '类型',
                    render: (_value, row) => (
                      <Tag>{row.parentId ? '场景用例' : '单接口用例'}</Tag>
                    ),
                  },
                  {
                    title: '标签',
                    render: (_value, row) =>
                      (row.content.tags ?? []).map((label) => (
                        <Tag key={label}>{label}</Tag>
                      )),
                  },
                  {
                    title: '编辑修订',
                    render: (_value, row) => 'r' + row.revisionNo,
                  },
                ]}
              />
            </section>
          )}
        </div>
      </div>
      {!route.caseId && !route.create && (
        <ApiDiagnosticPage project={project} />
      )}
      {sceneDialog && (
        <SceneDialog
          key={sceneDialog.session}
          path={path}
          projectId={project.id}
          dialog={sceneDialog}
          navigation={navigation}
          suggestedRequirementId={ownerId}
          onClose={() => setSceneDialog(undefined)}
          onSaved={(row) => {
            setSceneDialog(undefined);
            setReload((count) => count + 1);
            navigate({
              sceneId: row.id,
              ...(row.requirementBasis && {
                requirementId: row.requirementBasis.requirementId,
              }),
            });
            void message.success('已保存场景');
          }}
        />
      )}
      {archiveTarget && (
        <CommandDialog
          title="归档接口自动化资产"
          command={commit}
          onClose={() => setArchiveTarget(undefined)}
          open
          dirty={false}
          saveLabel="归档"
          onSave={() => {
            if (
              archiveTarget.targetType === 'scenario' &&
              list.cases.some(
                (entry) =>
                  entry.parentId === archiveTarget.id && !entry.removedAt,
              )
            ) {
              modal.confirm({
                title: '将该场景移出日常目录？',
                content: '请确认场景下的用例已经处理。',
                onOk: archive,
              });
            } else archive();
          }}
        >
          <Typography.Paragraph>
            {archiveTarget.title} · r{archiveTarget.revisionNo}
          </Typography.Paragraph>
        </CommandDialog>
      )}
    </>
  );
}

function SceneDialog({
  path,
  projectId,
  dialog,
  navigation,
  suggestedRequirementId,
  onClose,
  onSaved,
}: {
  path: string;
  projectId: string;
  dialog: { session: string; scene?: ApiProjectScenario };
  navigation: Navigation;
  suggestedRequirementId?: string | undefined;
  onClose: () => void;
  onSaved: (row: ApiProjectScenario) => void;
}) {
  const { scene } = dialog;
  const existingRequirement =
    scene?.requirementBasis?.requirementId ??
    navigation.find((requirement) =>
      requirement.versions.some(
        (version) => version.id === scene?.requirementVersionId,
      ),
    )?.id;
  const [title, setTitle] = useState(scene?.title ?? '');
  const [objective, setObjective] = useState(scene?.content.objective ?? '');
  const [preconditions, setPreconditions] = useState(
    scene?.content.sharedPreconditions.join('\n') ?? '',
  );
  const [requirementId, setRequirementId] = useState(
    scene ? existingRequirement : suggestedRequirementId,
  );
  const [dirty, setDirty] = useState(false);
  const command = useBusinessCommand(dialog.session);
  const disabled = command.pending || command.uncertain;
  async function submit() {
    const result = await command.run((commandId) => {
      const content = {
        title,
        objective,
        sharedPreconditions: preconditions
          .split('\n')
          .map((row) => row.trim())
          .filter(Boolean),
        basisRefs: scene?.content.basisRefs ?? [],
        requirementVersionId:
          scene && requirementId === existingRequirement
            ? scene.requirementVersionId
            : null,
      };
      const input = scene
        ? {
            op: 'revise-scenario',
            ...apiAutomationReviseScenarioInputSchema.parse({
              commandId,
              assetId: scene.id,
              baseRevisionId: scene.revisionId,
              rowVersion: scene.rowVersion,
              content,
              ...(requirementId &&
                requirementId !== existingRequirement && { requirementId }),
            }),
          }
        : {
            op: 'create-scenario',
            ...apiAutomationCreateScenarioInputSchema.parse({
              commandId,
              content,
              ...(requirementId && { requirementId }),
            }),
          };
      return api(
        path,
        { method: 'POST', body: input },
        apiProjectScenarioSchema,
      );
    });
    if (result) onSaved(result);
  }
  return (
    <CommandDialog
      open
      dirty={dirty}
      command={command}
      title={scene ? '编辑场景' : '新建项目场景'}
      onSave={() => void submit()}
      onClose={onClose}
      allowSave={Boolean(title.trim() && objective.trim())}
    >
      <div className="api-catalog-stack">
        <label className="api-catalog-form-field">
          <span>场景名称</span>
          <Input
            disabled={disabled}
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              setDirty(true);
            }}
          />
        </label>
        <label className="api-catalog-form-field">
          <span>场景说明</span>
          <Input.TextArea
            disabled={disabled}
            value={objective}
            onChange={(event) => {
              setObjective(event.target.value);
              setDirty(true);
            }}
          />
        </label>
        <label className="api-catalog-form-field">
          <span>公共前置条件</span>
          <Input.TextArea
            disabled={disabled}
            value={preconditions}
            onChange={(event) => {
              setPreconditions(event.target.value);
              setDirty(true);
            }}
          />
        </label>
        <label className="api-catalog-form-field">
          <span>关联需求（可选）</span>
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            disabled={disabled}
            value={requirementId}
            options={navigation
              .filter(
                (item) => !item.archived || item.id === existingRequirement,
              )
              .map((item) => ({ value: item.id, label: item.title }))}
            onChange={(value: string | undefined) => {
              setRequirementId(value);
              setDirty(true);
            }}
          />
        </label>
        {requirementId && (
          <Button href={requirementMaterialsHref(projectId, requirementId)}>
            查看当前需求资料
          </Button>
        )}
      </div>
    </CommandDialog>
  );
}
