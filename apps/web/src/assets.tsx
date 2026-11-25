import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Dropdown,
  Empty,
  Skeleton,
  Tooltip,
} from 'antd';
import { ExplorerTree, type ExplorerNode } from './explorer-tree';
import { EllipsisOutlined, PlusOutlined } from '@ant-design/icons';
import { z } from 'zod';
import {
  assetDetailSchema,
  assetListSchema,
  assetNavigationSchema,
} from '../../../packages/contracts/src/assets';
import type { Asset } from '../../../packages/contracts/src/assets';
import { api, describeError } from './api';
import { AssetEditor } from './asset-editor';
import type { AssetEditorTarget } from './asset-editor';
import { reviewLabels } from './semantic-status';
import type { CaseScope } from './requirements';
import type { Project } from './types';
import { RequirementDirectory } from './requirement-directory';
import { UiCaseWorkbench, useUiCaseStages } from './ui-case-workbench';
import { StandaloneWorkbenchHeader } from './standalone-workbench-header';
import { openUiScenarioDraft } from './ui-scenario-draft';
import { UiCaseImportDialog } from './ui-case-import-dialog';
import { UiAssetRemoval } from './ui-asset-removal';
import { UiCoverageCheck } from './ui-coverage-check';
import { UiCaseLibraryPane } from './ui-case-library-pane';
import { canEditProjectAssets } from './project-access';
import type { CoverageCheckpoint } from '../../../packages/contracts/src/coverage-checkpoints';

type Navigation = z.infer<typeof assetNavigationSchema>;
function caseWorkbenchRoute() {
  const query = new URLSearchParams(window.location.hash.split('?')[1]);
  const view = query.get('view');
  const ids = z
    .object({
      caseId: z.uuid().optional(),
      sceneId: z.uuid().optional(),
      revisionId: z.uuid().optional(),
    })
    .safeParse({
      caseId: query.get('caseId') ?? undefined,
      sceneId: query.get('sceneId') ?? undefined,
      revisionId: query.get('assetRevisionId') ?? undefined,
    });
  return {
    projectId: z.uuid().safeParse(query.get('projectId')).data,
    requirementId: z.uuid().safeParse(query.get('requirementId')).data,
    mode: view === 'workbench' ? view : null,
    archived: query.get('archived') === '1',
    snapshot: query.get('basis') === 'snapshot',
    caseId: ids.success ? ids.data.caseId : undefined,
    sceneId: ids.success ? ids.data.sceneId : undefined,
    revisionId: ids.success ? ids.data.revisionId : undefined,
    invalid: !ids.success,
  };
}
function reviewFromUrl() {
  const value = new URLSearchParams(window.location.hash.split('?')[1]).get(
    'review',
  );
  return value && ['unapproved', ...Object.keys(reviewLabels)].includes(value)
    ? value
    : 'all';
}
export function AssetsPage({
  project,
  userId,
  scope: linkedScope,
}: {
  project: Project | null;
  userId: string;
  scope: CaseScope | null;
}) {
  const { message } = App.useApp();
  const [coverage, setCoverage] = useState(false);
  const [caseRoute, setCaseRoute] = useState(caseWorkbenchRoute);
  const [sceneScope, setSceneScope] = useState<{
    id: string;
    requirementId: string;
  }>();
  const [importScope, setImportScope] = useState<CaseScope | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Asset | null>(null);
  const recentCase = useRef(new Map<string, string>());
  const libraryScroll = useRef(0);
  const readerWorkspace = caseRoute.mode === 'workbench';
  const kind = 'UI';
  const [navigation, setNavigation] = useState<Navigation>({
    requirements: [],
  });
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState('');
  const [directorySearch, setDirectorySearch] = useState('');
  const [reviewFilter, setReviewFilter] = useState<string>(reviewFromUrl);
  const [includeArchivedRequirements, setIncludeArchivedRequirements] =
    useState(() => caseWorkbenchRoute().archived);
  const [editor, setEditor] = useState<AssetEditorTarget | null>(null);
  const loadEpoch = useRef(0);
  const browseContext = useRef<string | null>(null);
  const tester = project?.roles.includes('tester') ?? false;
  const canDraft = canEditProjectAssets(project);
  const requirementId =
    caseRoute.projectId === project?.id ? caseRoute.requirementId : undefined;
  const selectedRequirement = navigation.requirements.find(
    (requirement) => requirement.id === requirementId,
  );
  const currentVersion = selectedRequirement?.versions.find(
    (version) => version.id === selectedRequirement.currentVersionId,
  );
  const pinnedVersion =
    linkedScope?.requirementId === requirementId && caseRoute.snapshot
      ? linkedScope
      : null;
  const currentScope =
    project && selectedRequirement && currentVersion
      ? ({
          projectId: project.id,
          requirementId: selectedRequirement.id,
          requirementVersionId: currentVersion.id,
          title: selectedRequirement.title,
          versionNo: currentVersion.versionNo,
          kind,
        } as const)
      : null;
  const scope = pinnedVersion ?? currentScope;
  const immersive = Boolean(requirementId) && readerWorkspace;
  const sceneId =
    sceneScope?.requirementId === requirementId ? sceneScope?.id : undefined;
  const writableScope = !caseRoute.snapshot && !selectedRequirement?.archived;
  const canWrite = canDraft && writableScope;
  const canReview = tester && writableScope;
  const scopeExists =
    requirementId === undefined ||
    Boolean(
      selectedRequirement?.versions.some(
        (version) => version.id === scope?.requirementVersionId,
      ),
    );
  const scenarios = assets.filter(
    (asset) =>
      asset.targetType === 'scenario' && (!sceneId || asset.id === sceneId),
  );
  const scopeScenarios = assets.filter(
    (asset) => asset.targetType === 'scenario' && !asset.removedAt,
  );
  const oldBasisCases = assets.filter(
    (asset) =>
      asset.targetType === 'case' &&
      !asset.removedAt &&
      asset.requirementBasis?.warning,
  );
  const keyword = search.trim().toLocaleLowerCase();
  const { stageOf: libraryStage } = useUiCaseStages(
    scope,
    assets,
    !immersive && scopeExists,
  );
  const cases = assets.filter(
    (asset) =>
      asset.targetType === 'case' &&
      (!sceneId || asset.parentId === sceneId) &&
      (reviewFilter === 'all' ||
        (reviewFilter === 'unapproved'
          ? libraryStage(asset) !== 'approved'
          : libraryStage(asset) ===
            (reviewFilter === 'aiOptimized'
              ? 'waitingHuman'
              : reviewFilter))) &&
      `${asset.id} ${asset.title} ${'testPoint' in asset.content ? asset.content.testPoint : ''} ${assets.find((parent) => parent.id === asset.parentId)?.title ?? ''}`
        .toLocaleLowerCase()
        .includes(keyword),
  );
  async function load(signal?: AbortSignal) {
    const epoch = ++loadEpoch.current;
    if (!project) {
      setAssets([]);
      setNavigation({ requirements: [] });
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const query = new URLSearchParams({
        kind,
        includeArchivedRequirements: String(includeArchivedRequirements),
      });
      if (pinnedVersion)
        query.set('requirementVersionId', pinnedVersion.requirementVersionId);
      else if (requirementId) query.set('requirementId', requirementId);
      const [map, data] = await Promise.all([
        api(
          `/projects/${project.id}/assets/navigation?kind=${kind}&includeArchivedRequirements=${includeArchivedRequirements}`,
          signal ? { signal } : {},
          assetNavigationSchema,
        ),
        api(
          `/projects/${project.id}/assets?${query}`,
          signal ? { signal } : {},
          assetListSchema,
        ),
      ]);
      if (!signal?.aborted && epoch === loadEpoch.current) {
        setNavigation(map);
        setAssets(data.assets);
        setError(undefined);
      }
    } catch (err) {
      if (!signal?.aborted && epoch === loadEpoch.current) {
        setAssets([]);
        setNavigation({ requirements: [] });
        setError(describeError(err));
      }
    } finally {
      if (!signal?.aborted && epoch === loadEpoch.current) setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    const context = `${project?.id}:${kind}:${requirementId}:${pinnedVersion?.requirementVersionId}`;
    const changedContext = browseContext.current !== context;
    browseContext.current = context;
    setAssets([]);
    if (changedContext) {
      setEditor(null);
      setSearch('');
      setReviewFilter(reviewFromUrl());
    }
    void load(controller.signal);
    return () => controller.abort();
  }, [
    project?.id,
    kind,
    requirementId,
    pinnedVersion?.requirementVersionId,
    includeArchivedRequirements,
  ]);
  useEffect(() => {
    const update = () => {
      setReviewFilter(reviewFromUrl());
      const route = caseWorkbenchRoute();
      setCaseRoute(route);
      if (route.archived) setIncludeArchivedRequirements(true);
    };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => {
    if (!project || loading || readerWorkspace) return;
    const query = new URLSearchParams(window.location.hash.split('?')[1]);
    const assetId = z.uuid().safeParse(query.get('assetId'));
    if (!assetId.success) return;
    const controller = new AbortController();
    void api(
      `/projects/${project.id}/assets/${assetId.data}`,
      { signal: controller.signal },
      assetDetailSchema,
    )
      .then(({ asset }) => {
        if (controller.signal.aborted) return;
        const next = scopeOf(asset);
        if (!next) return;
        const revision = query.get('assetRevisionId');
        openWorkspace(
          next,
          asset.targetType === 'case' ? asset.id : undefined,
          asset.targetType === 'scenario' ? asset.id : undefined,
        );
        if (asset.targetType === 'case' && revision)
          updateCaseLink(
            (params) => params.set('assetRevisionId', revision),
            true,
          );
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(describeError(failure));
      });
    return () => controller.abort();
  }, [project?.id, loading, readerWorkspace, navigation]);

  function libraryReview(value: string) {
    setReviewFilter(value);
    const query = new URLSearchParams(window.location.hash.split('?')[1]);
    if (value === 'all') query.delete('review');
    else query.set('review', value);
    window.history.replaceState(
      null,
      '',
      '#cases' + (query.size ? '?' + query.toString() : ''),
    );
  }
  function openScopedWorkbench() {
    if (!scope) return;
    if (sceneId) {
      openWorkspace(scope, undefined, sceneId);
      return;
    }
    const previous = recentCase.current.get(scope.requirementVersionId);
    const inScene = assets.find(
      (row) =>
        row.targetType === 'case' && !row.removedAt && row.parentId === sceneId,
    );
    const availablePrevious = assets.some(
      (row) =>
        row.id === previous &&
        !row.removedAt &&
        (!sceneId || row.parentId === sceneId),
    );
    openWorkspace(
      scope,
      (availablePrevious ? previous : undefined) ?? inScene?.id,
    );
  }
  function selectRequirement(id: string) {
    if (!project) return;
    if (id === 'all' || navigation.requirements.some((item) => item.id === id))
      changeScope(id === 'all' ? null : id);
  }
  function changeScope(nextRequirementId: string | null) {
    if (!project) return;
    setCoverage(false);
    setSceneScope(undefined);
    const query = new URLSearchParams({ projectId: project.id });
    if (nextRequirementId) query.set('requirementId', nextRequirementId);
    if (reviewFilter !== 'all') query.set('review', reviewFilter);
    if (includeArchivedRequirements) query.set('archived', '1');
    window.location.hash = `cases?${query}`;
    setCaseRoute(caseWorkbenchRoute());
  }
  function updateCaseLink(
    change: (query: URLSearchParams) => void,
    replace = false,
  ) {
    const query = new URLSearchParams(window.location.hash.split('?')[1]);
    change(query);
    const hash = 'cases' + (query.size ? '?' + query.toString() : '');
    if (replace) window.history.replaceState(null, '', '#' + hash);
    else window.location.hash = hash;
    setCaseRoute(caseWorkbenchRoute());
  }
  function openWorkspace(next: CaseScope, caseId?: string, sceneId?: string) {
    if (!immersive) libraryScroll.current = window.scrollY;
    updateCaseLink((query) => {
      query.delete('assetId');
      query.delete('assetRevisionId');
      query.delete('caseId');
      query.delete('sceneId');
      query.set('view', 'workbench');
      query.set('projectId', next.projectId);
      query.set('requirementId', next.requirementId);
      if (next.historical) {
        query.set('kind', 'UI');
        query.set('title', next.title);
        query.set('versionId', next.requirementVersionId);
        query.set('versionNo', String(next.versionNo));
        if (next.historical) query.set('basis', 'snapshot');
      } else {
        for (const name of ['kind', 'title', 'versionId', 'versionNo', 'basis'])
          query.delete(name);
      }
      if (includeArchivedRequirements) query.set('archived', '1');
      if (caseId) query.set('caseId', caseId);
      if (sceneId) query.set('sceneId', sceneId);
    });
    requestAnimationFrame(() => window.scrollTo(0, 0));
  }
  function returnToLibrary() {
    updateCaseLink((query) => {
      for (const name of ['view', 'caseId', 'sceneId', 'assetRevisionId'])
        query.delete(name);
      if (!caseRoute.snapshot) {
        for (const name of ['kind', 'title', 'versionId', 'versionNo', 'basis'])
          query.delete(name);
      }
    });
    requestAnimationFrame(() => window.scrollTo(0, libraryScroll.current));
  }
  function browseCase(id: string) {
    if (scope) recentCase.current.set(scope.requirementVersionId, id);
    updateCaseLink((query) => {
      query.set('caseId', id);
      query.delete('sceneId');
      query.delete('assetRevisionId');
    }, true);
  }
  function browseScene(id: string) {
    updateCaseLink((query) => {
      query.delete('caseId');
      query.delete('assetRevisionId');
      query.set('sceneId', id);
    }, true);
  }
  function requirementScope(id: string, versionId?: string): CaseScope | null {
    if (!project) return null;
    const requirement = navigation.requirements.find((item) => item.id === id);
    const version = requirement?.versions.find(
      (item) => item.id === (versionId ?? requirement.currentVersionId),
    );
    if (!requirement || !version) return null;
    return {
      projectId: project.id,
      requirementId: requirement.id,
      requirementVersionId: version.id,
      title: requirement.title,
      versionNo: version.versionNo,
      kind,
      ...(caseRoute.snapshot && { historical: true }),
    };
  }
  function scopeOf(asset: Asset, exact = false): CaseScope | null {
    const requirement = navigation.requirements.find((item) =>
      item.versions.some(
        (version) => version.id === asset.requirementVersionId,
      ),
    );
    return requirement
      ? requirementScope(
          requirement.id,
          exact || caseRoute.snapshot ? asset.requirementVersionId : undefined,
        )
      : null;
  }
  function openCase(asset: Asset) {
    if (asset.kind !== 'UI' || asset.targetType !== 'case') return;
    const next = scopeOf(asset);
    if (!next) {
      void message.warning('此用例所属需求版本未在当前目录取得。');
      return;
    }
    recentCase.current.set(next.requirementVersionId, asset.id);
    openWorkspace(next, asset.id);
  }
  function selectDirectoryAsset(asset: Asset) {
    if (asset.kind !== 'UI' || asset.targetType !== 'scenario') {
      openCase(asset);
      return;
    }
    const next = scopeOf(asset);
    if (!next) return;
    if (scope?.requirementId !== next.requirementId)
      changeScope(next.requirementId);
    setSceneScope({ id: asset.id, requirementId: next.requirementId });
  }
  async function changed() {
    await load();
  }
  async function saved(asset: Asset) {
    if (editor?.requirementId && editor.requirementId !== requirementId) {
      changeScope(editor.requirementId);
    } else {
      await load();
    }
    if (asset.targetType === 'scenario' && editor) {
      setSceneScope({ id: asset.id, requirementId: editor.requirementId });
    }
    if (editor?.checkpoint) setCoverage(true);
    void message.success(
      asset.targetType === 'scenario' ? '已保存场景' : '已保存待评审用例',
    );
  }
  function canEditAsset(asset: Asset) {
    const owner = scopeOf(asset);
    return (
      canWrite &&
      !asset.removedAt &&
      asset.kind === 'UI' &&
      asset.targetType !== 'set' &&
      Boolean(owner) &&
      !navigation.requirements.find((item) => item.id === owner?.requirementId)
        ?.archived
    );
  }
  function createScene(id: string) {
    const target = requirementScope(id);
    if (
      !target ||
      !canWrite ||
      navigation.requirements.find((item) => item.id === id)?.archived
    )
      return;
    setEditor({
      targetType: 'scenario',
      requirementId: target.requirementId,
      requirementVersionId: target.requirementVersionId,
      requirementTitle: target.title,
    });
  }
  function createCase(scene?: Asset, checkpoint?: CoverageCheckpoint) {
    if (!canWrite || (scene && !canEditAsset(scene))) return;
    const target = scene ? scopeOf(scene) : scope;
    if (!target) return;
    const choices = scopeScenarios.filter(
      (item) =>
        scopeOf(item)?.requirementId === target.requirementId &&
        (!checkpoint ||
          item.requirementVersionId === checkpoint.requirementVersionId),
    );
    if (scene && !choices.some((item) => item.id === scene.id))
      choices.push(scene);
    if (!choices.length) {
      if (checkpoint) {
        void message.info('此验收点暂无可用场景。请先在需求目录新增场景。');
        return;
      }
      createScene(target.requirementId);
      return;
    }
    setEditor({
      targetType: 'case',
      requirementId: target.requirementId,
      requirementVersionId: target.requirementVersionId,
      requirementTitle: target.title,
      scenarios: choices,
      ...((scene?.id || checkpoint?.scenarioId) && {
        scenarioId: scene?.id ?? checkpoint?.scenarioId ?? '',
      }),
      ...(checkpoint && { checkpoint }),
    });
  }
  function edit(asset: Asset) {
    if (asset.targetType === 'set' || !canEditAsset(asset)) return;
    const target = scopeOf(asset);
    if (!target) return;
    setEditor({
      targetType: asset.targetType,
      requirementId: target.requirementId,
      requirementVersionId: target.requirementVersionId,
      requirementTitle: target.title,
      asset,
    });
  }
  function remove(asset: Asset) {
    if (tester && canEditAsset(asset)) setRemoveTarget(asset);
  }
  function generateFor(scene: Asset) {
    if (!canEditAsset(scene)) return;
    const target = scopeOf(scene);
    if (target) openUiScenarioDraft({ scope: target, scene, userId });
  }
  const tree = useMemo<ExplorerNode[]>(
    () => [
      {
        id: 'all',
        title: '全部需求',
        kind: 'all',
        count: `${navigation.requirements.reduce((sum, item) => sum + item.caseCount, 0)} 条用例`,
      },
      ...navigation.requirements.map((requirement) => ({
        id: `requirement:${requirement.id}`,
        title: requirement.title,
        count: `${requirement.caseCount} 条用例`,
        archived: requirement.archived,
        children: assets
          .filter(
            (asset) =>
              asset.targetType === 'scenario' &&
              requirement.versions.some(
                (version) => version.id === asset.requirementVersionId,
              ),
          )
          .map((scenario) => {
            return {
              id: `scenario:${scenario.id}`,
              title: scenario.title,
              children: assets
                .filter(
                  (asset) =>
                    asset.targetType === 'case' &&
                    asset.parentId === scenario.id,
                )
                .map((asset) => ({
                  id: `case:${asset.id}`,
                  title: asset.title,
                  kind: 'ui-case' as const,
                })),
            };
          }),
      })),
    ],
    [navigation, assets],
  );
  if (!project)
    return (
      <Card>
        <Empty description="请先选择当前有效项目，再浏览和维护用例。" />
      </Card>
    );
  return (
    <>
      {immersive && !scope && (
        <>
          <StandaloneWorkbenchHeader
            title="UI 用例工作台"
            projectName={project.name}
            backLabel="返回 UI 用例管理"
            onBack={returnToLibrary}
          />
          <main className="ui-case-workbench-main">
            {loading ? (
              <Skeleton active />
            ) : (
              <Empty description={error ?? '未找到此需求。'} />
            )}
          </main>
        </>
      )}
      {readerWorkspace && scope && (
        <UiCaseWorkbench
          key={project.id + ':' + scope.requirementVersionId}
          scope={{ ...scope, title: selectedRequirement?.title ?? scope.title }}
          projectName={project.name}
          userId={userId}
          assets={assets}
          requestedCase={caseRoute.caseId}
          requestedScene={caseRoute.sceneId}
          requestedRevision={caseRoute.revisionId}
          archived={Boolean(selectedRequirement?.archived)}
          available={scopeExists && !caseRoute.invalid}
          loading={loading}
          error={caseRoute.invalid ? '用例工作台链接无效。' : error}
          tester={canReview}
          onBack={returnToLibrary}
          onCase={browseCase}
          onScene={browseScene}
          onRevision={(id) =>
            updateCaseLink((query) => {
              if (id) query.set('assetRevisionId', id);
              else query.delete('assetRevisionId');
            }, true)
          }
          onChanged={changed}
        />
      )}
      {scope && (
        <>
          <UiCoverageCheck
            scope={scope}
            userId={userId}
            assets={assets}
            scenarioId={
              scopeScenarios.some(
                (item) =>
                  item.id === sceneId &&
                  item.requirementVersionId === scope.requirementVersionId,
              )
                ? sceneId
                : undefined
            }
            open={coverage}
            tester={canReview}
            onClose={() => setCoverage(false)}
            onCase={(asset) => {
              setCoverage(false);
              openCase(asset);
            }}
            onSupplement={(checkpoint) => {
              setCoverage(false);
              createCase(
                scopeScenarios.find(
                  (item) => item.id === checkpoint.scenarioId,
                ),
                checkpoint,
              );
            }}
          />
        </>
      )}
      <div hidden={immersive} className="ui-case-library">
        <header className="ui-case-library-heading">
          <h1>UI 用例管理</h1>
          <p>按需求和场景维护用例，逐条评审和批准。</p>
        </header>
        {error && (
          <Alert
            type="error"
            showIcon
            title={error}
            className="section-alert"
            action={<Button onClick={() => void load()}>刷新范围</Button>}
          />
        )}
        {!loading && !error && !scopeExists && (
          <Alert
            type="info"
            showIcon
            title="当前需求不在本次浏览范围"
            description="可在需求目录开启“显示已归档需求”，或重新选择需求。"
            className="section-alert"
          />
        )}
        <div className="asset-workspace live-asset-workspace requirement-directory-layout">
          <RequirementDirectory
            includeArchived={includeArchivedRequirements}
            archiveDisabled={editor !== null}
            onIncludeArchivedChange={(value) => {
              loadEpoch.current += 1;
              if (!value && selectedRequirement?.archived) {
                selectRequirement('all');
              }
              setAssets([]);
              setNavigation({ requirements: [] });
              setLoading(true);
              setIncludeArchivedRequirements(value);
              updateCaseLink((query) => {
                if (value) query.set('archived', '1');
                else query.delete('archived');
              }, true);
            }}
            search={directorySearch}
            onSearchChange={setDirectorySearch}
            searchPlaceholder="搜索需求、场景或用例"
          >
            {loading ? (
              <Skeleton active />
            ) : (
              <ExplorerTree
                nodes={tree}
                label="UI 用例目录"
                search={directorySearch}
                storageKey={`explorer:ui-cases:${userId}:${project.id}`}
                renderAction={(node) => {
                  if (
                    node.id.startsWith('requirement:') &&
                    canWrite &&
                    !node.archived
                  ) {
                    return (
                      <Tooltip title="新增场景">
                        <Button
                          size="small"
                          type="text"
                          icon={<PlusOutlined />}
                          aria-label={`新增场景 · ${node.title}`}
                          onClick={() => createScene(node.id.slice(12))}
                        />
                      </Tooltip>
                    );
                  }
                  const scene = node.id.startsWith('scenario:')
                    ? scopeScenarios.find(
                        (item) => item.id === node.id.slice(9),
                      )
                    : undefined;
                  if (!scene || !canEditAsset(scene)) return null;
                  return (
                    <Dropdown
                      trigger={['click']}
                      menu={{
                        items: [
                          { key: 'edit', label: '改名及编辑场景' },
                          { key: 'add', label: '手动新增用例' },
                          { key: 'generate', label: '按此场景生成用例' },
                          ...(tester
                            ? [
                                {
                                  key: 'remove',
                                  label: '删除场景',
                                  danger: true,
                                },
                              ]
                            : []),
                        ],
                        onClick: ({ key }) => {
                          if (key === 'edit') edit(scene);
                          else if (key === 'add') createCase(scene);
                          else if (key === 'generate') generateFor(scene);
                          else if (key === 'remove') remove(scene);
                        },
                      }}
                    >
                      <Button
                        size="small"
                        type="text"
                        icon={<EllipsisOutlined />}
                        aria-label={`场景操作 · ${scene.title}`}
                      />
                    </Dropdown>
                  );
                }}
                selected={
                  sceneId
                    ? `scenario:${sceneId}`
                    : scope
                      ? `requirement:${scope.requirementId}`
                      : 'all'
                }
                onSelect={(key) => {
                  if (key === 'all') selectRequirement(key);
                  else if (key.startsWith('requirement:'))
                    selectRequirement(key.slice(12));
                  else {
                    const asset = assets.find(
                      (item) => item.id === key.split(':')[1],
                    );
                    if (asset) selectDirectoryAsset(asset);
                  }
                }}
              />
            )}
          </RequirementDirectory>
          <UiCaseLibraryPane
            scope={scope}
            requirement={selectedRequirement}
            requirements={navigation.requirements}
            available={scopeExists && !error}
            loading={loading}
            scenarios={scenarios}
            cases={cases}
            sceneId={sceneId}
            sceneCount={
              sceneId
                ? assets.filter(
                    (asset) =>
                      asset.parentId === sceneId && asset.targetType === 'case',
                  ).length
                : undefined
            }
            search={search}
            review={reviewFilter}
            canWrite={canWrite}
            oldBasisCases={oldBasisCases}
            stageOf={libraryStage}
            onSearch={setSearch}
            onReview={libraryReview}
            onCurrent={() => {
              if (scope) selectRequirement(scope.requirementId);
            }}
            onCoverage={() => setCoverage(true)}
            onOpen={openScopedWorkbench}
            onAdd={() =>
              createCase(scopeScenarios.find((item) => item.id === sceneId))
            }
            onImport={() => setImportScope(scope)}
            onOpenCase={openCase}
            onAddToScene={createCase}
            canEdit={canEditAsset}
            canRemove={(asset) => tester && canEditAsset(asset)}
            onEdit={edit}
            onRemove={remove}
          />
        </div>
      </div>
      {importScope && (
        <UiCaseImportDialog
          key={importScope.requirementId}
          scope={importScope}
          userId={userId}
          scenes={scopeScenarios}
          onClose={() => setImportScope(null)}
          onImported={async () => changed()}
        />
      )}
      {removeTarget && (
        <UiAssetRemoval
          key={removeTarget.id}
          asset={removeTarget}
          userId={userId}
          onClose={() => setRemoveTarget(null)}
          onRemoved={async () => {
            if (sceneId === removeTarget.id) setSceneScope(undefined);
            await load();
            void message.success(
              removeTarget.targetType === 'scenario'
                ? '场景已移除'
                : '用例已移除',
            );
          }}
        />
      )}
      <AssetEditor
        userId={userId}
        projectId={project.id}
        target={editor}
        onClose={() => setEditor(null)}
        onSaved={saved}
      />
    </>
  );
}
