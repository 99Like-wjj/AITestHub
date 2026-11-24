import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Dropdown,
  Empty,
  Modal,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { ExplorerTree, type ExplorerNode } from './explorer-tree';
import { EllipsisOutlined, PlusOutlined } from '@ant-design/icons';
import { z } from 'zod';
import {
  approvalCommitReceiptSchema,
  assetDetailSchema,
  assetListSchema,
  assetNavigationSchema,
  latestApprovedResponseSchema,
} from '../../../packages/contracts/src/assets';
import type {
  Asset,
  AssetContent,
} from '../../../packages/contracts/src/assets';
import { precisePreviewSchema } from '../../../packages/contracts/src/domain';
import { api, describeError, isUncertainMutationError } from './api';
import { AssetEditor, targetTypeLabels } from './asset-editor';
import type { AssetEditorTarget } from './asset-editor';
import { AssetReviewPanel } from './asset-review-panel';
import { ReviewStateTag, reviewLabels } from './semantic-status';
import { formatBeijingTime } from './beijing-time';
import { DetailDrawer } from './detail-drawer';
import type { CaseScope } from './requirements';
import type { Project } from './types';
import { RequirementDirectory } from './requirement-directory';
import { UiCaseText } from './ui-case-reader';
import { UiReviewWorkspace } from './ui-review-workspace';
import type { UiCaseReviewDraft } from './ui-case-review-pane';
import {
  UiCaseWorkbench,
  UiReviewHistory,
  useUiCaseStages,
} from './ui-case-workbench';
import { StandaloneWorkbenchHeader } from './standalone-workbench-header';
import {
  openUiScenarioDraft,
  type UiSupplementSource,
} from './ui-scenario-draft';
import { UiCaseImportDialog } from './ui-case-import-dialog';
import { UiAssetRemoval } from './ui-asset-removal';
import { UiCoverageCheck } from './ui-coverage-check';
import { UiCaseLibraryPane } from './ui-case-library-pane';
import { canEditProjectAssets } from './project-access';
import {
  assertApprovalReceipt,
  forgetApproval,
  readApprovalRecovery,
  recoveredApprovalSchema,
  rememberApproval,
  type ApprovalRecovery,
} from './ui-case-approval';
import type { CoverageCheckpoint } from '../../../packages/contracts/src/coverage-checkpoints';

type Navigation = z.infer<typeof assetNavigationSchema>;
type Detail = z.infer<typeof assetDetailSchema>;
type Preview = z.infer<typeof precisePreviewSchema>;
type ApprovalReceipt = z.infer<typeof approvalCommitReceiptSchema>;
type Approved = z.infer<typeof latestApprovedResponseSchema>;

function caseWorkbenchRoute() {
  const query = new URLSearchParams(window.location.hash.split('?')[1]);
  const view = query.get('view');
  const ids = z
    .object({
      caseId: z.uuid().optional(),
      sceneId: z.uuid().optional(),
      revisionId: z.uuid().optional(),
      meetingId: z.uuid().optional(),
    })
    .safeParse({
      caseId: query.get('caseId') ?? undefined,
      sceneId: query.get('sceneId') ?? undefined,
      revisionId: query.get('assetRevisionId') ?? undefined,
      meetingId: query.get('meetingId') ?? undefined,
    });
  return {
    projectId: z.uuid().safeParse(query.get('projectId')).data,
    requirementId: z.uuid().safeParse(query.get('requirementId')).data,
    mode: view === 'meeting' || view === 'workbench' ? view : null,
    archived: query.get('archived') === '1',
    history: query.get('history') === '1',
    snapshot: query.get('basis') === 'snapshot',
    caseId: ids.success ? ids.data.caseId : undefined,
    sceneId: ids.success ? ids.data.sceneId : undefined,
    revisionId: ids.success ? ids.data.revisionId : undefined,
    meetingId: ids.success ? ids.data.meetingId : undefined,
    invalid:
      !ids.success || (query.get('history') === '1' && !ids.data?.meetingId),
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
function ContentView({ content }: { content: AssetContent }) {
  if ('testPoint' in content) return <UiCaseText content={content} />;
  return (
    <>
      {'objective' in content && (
        <Descriptions
          column={1}
          items={[
            {
              key: 'objective',
              label: '场景目标',
              children: (
                <span className="preserve-lines">{content.objective}</span>
              ),
            },
            {
              key: 'preconditions',
              label: '共享前提',
              children: content.sharedPreconditions.length ? (
                <ul>
                  {content.sharedPreconditions.map((value, index) => (
                    <li key={index}>{value}</li>
                  ))}
                </ul>
              ) : (
                '未设置'
              ),
            },
          ]}
        />
      )}
      {content.basisRefs.length > 0 && (
        <section>
          <b>需求依据</b>
          <ul>
            {content.basisRefs.map((ref, index) => (
              <li key={index}>{ref.description}</li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
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
  const [reviewHistory, setReviewHistory] = useState(false);
  const [sceneScope, setSceneScope] = useState<{
    id: string;
    requirementId: string;
  }>();
  const [importScope, setImportScope] = useState<CaseScope | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Asset | null>(null);
  const recentCase = useRef(new Map<string, string>());
  const caseReviewDrafts = useRef(new Map<string, UiCaseReviewDraft>());
  const libraryScroll = useRef(0);
  const reviewWorkspace = caseRoute.mode === 'meeting';
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
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [revisionId, setRevisionId] = useState<string>();
  const [latestApproved, setLatestApproved] = useState<Approved | null>(null);
  const [approvalError, setApprovalError] = useState<string>();
  const [editor, setEditor] = useState<AssetEditorTarget | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [receipt, setReceipt] = useState<ApprovalReceipt | null>(null);
  const [commitError, setCommitError] = useState<string>();
  const [committing, setCommitting] = useState(false);
  const commitCommand = useRef(crypto.randomUUID());
  const approvalKey = project
    ? 'aitesthub:asset-approval:' + userId + ':' + project.id + ':' + kind
    : '';
  const [approvalRecovery, setApprovalRecovery] = useState<ApprovalRecovery>();
  const loadEpoch = useRef(0);
  const detailEpoch = useRef(0);
  const browseContext = useRef<string | null>(null);
  const tester = project?.roles.includes('tester') ?? false;
  const canDraft = canEditProjectAssets(project);
  const sets = assets.filter((asset) => asset.targetType === 'set');
  const requirementId =
    caseRoute.projectId === project?.id ? caseRoute.requirementId : undefined;
  const selectedRequirement = navigation.requirements.find(
    (requirement) => requirement.id === requirementId,
  );
  const currentVersion = selectedRequirement?.versions.find(
    (version) => version.id === selectedRequirement.currentVersionId,
  );
  const pinnedVersion =
    linkedScope?.requirementId === requirementId &&
    (caseRoute.snapshot || caseRoute.history || reviewWorkspace)
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
  const immersive =
    Boolean(requirementId) && (reviewWorkspace || readerWorkspace);
  const sceneId =
    sceneScope?.requirementId === requirementId ? sceneScope?.id : undefined;
  const writableScope =
    !caseRoute.snapshot && !caseRoute.history && !selectedRequirement?.archived;
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
  const libraryStage = useUiCaseStages(
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
  const revision =
    detail?.revisions.find((item) => item.id === revisionId) ??
    detail?.revisions.find((item) => item.id === detail.asset.revisionId);

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
        setSelectedId(null);
        setError(describeError(err));
      }
    } finally {
      if (!signal?.aborted && epoch === loadEpoch.current) setLoading(false);
    }
  }
  async function loadDetail(id: string, signal?: AbortSignal) {
    if (!project) return;
    const epoch = ++detailEpoch.current;
    setDetailLoading(true);
    setDetailError(undefined);
    try {
      const response = await api(
        `/projects/${project.id}/assets/${id}`,
        signal ? { signal } : {},
        assetDetailSchema,
      );
      if (!signal?.aborted && epoch === detailEpoch.current) {
        setDetail(response);
        setRevisionId((current) =>
          response.revisions.some(
            (item) =>
              item.id ===
              new URLSearchParams(window.location.hash.split('?')[1]).get(
                'assetRevisionId',
              ),
          )
            ? (new URLSearchParams(window.location.hash.split('?')[1]).get(
                'assetRevisionId',
              ) ?? response.asset.revisionId)
            : response.revisions.some((item) => item.id === current)
              ? current
              : response.asset.revisionId,
        );
      }
    } catch (err) {
      if (!signal?.aborted && epoch === detailEpoch.current) {
        setDetail(null);
        setDetailError(describeError(err));
      }
    } finally {
      if (!signal?.aborted && epoch === detailEpoch.current)
        setDetailLoading(false);
    }
  }
  useEffect(() => {
    if (!approvalKey) return;
    try {
      setApprovalRecovery(readApprovalRecovery(approvalKey));
    } catch (failure) {
      setCommitError('无法读取原批准操作记录。' + describeError(failure));
    }
  }, [approvalKey]);
  useEffect(() => {
    const controller = new AbortController();
    const context = `${project?.id}:${kind}:${requirementId}:${pinnedVersion?.requirementVersionId}`;
    const changedContext = browseContext.current !== context;
    browseContext.current = context;
    setAssets([]);
    setSelectedKeys([]);
    setPreview(null);
    if (changedContext) {
      setSelectedId(null);
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
    const parsed = z
      .uuid()
      .safeParse(
        new URLSearchParams(window.location.hash.split('?')[1]).get('assetId'),
      );
    if (!parsed.success || loading) return;
    const asset = assets.find((item) => item.id === parsed.data);
    if (asset) selectAsset(asset);
    else setSelectedId(parsed.data);
  }, [project?.id, kind, loading, assets]);
  useEffect(() => {
    if (!selectedId) {
      detailEpoch.current += 1;
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    setDetail(null);
    setRevisionId(undefined);
    void loadDetail(selectedId, controller.signal);
    return () => controller.abort();
  }, [selectedId, project?.id]);
  useEffect(() => {
    const controller = new AbortController();
    setLatestApproved(null);
    setApprovalError(undefined);
    if (!project || !detail || detail.asset.targetType !== 'case') return;
    void api(
      `/projects/${project.id}/assets/${detail.asset.id}/latest-approved?kind=${kind}`,
      { signal: controller.signal },
      latestApprovedResponseSchema,
    )
      .then((response) => {
        if (!controller.signal.aborted) setLatestApproved(response);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setApprovalError(describeError(err));
      });
    return () => controller.abort();
  }, [project?.id, detail?.asset.id, detail?.asset.rowVersion, kind]);

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
      openWorkspace(scope, 'workbench', undefined, undefined, sceneId);
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
      'workbench',
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
    setReviewHistory(false);
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
  function openWorkspace(
    next: CaseScope,
    mode: 'workbench' | 'meeting',
    caseId?: string,
    meetingId?: string,
    sceneId?: string,
  ) {
    if (!immersive) libraryScroll.current = window.scrollY;
    setSelectedId(null);
    setReviewHistory(false);
    updateCaseLink((query) => {
      query.delete('assetId');
      query.delete('assetRevisionId');
      query.delete('meetingId');
      query.delete('caseId');
      query.delete('sceneId');
      query.delete('history');
      query.set('view', mode);
      query.set('projectId', next.projectId);
      query.set('requirementId', next.requirementId);
      if (next.historical || meetingId || mode === 'meeting') {
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
      if (meetingId) {
        query.set('meetingId', meetingId);
        if (mode === 'workbench') query.set('history', '1');
      }
    });
    requestAnimationFrame(() => window.scrollTo(0, 0));
  }
  function returnToLibrary() {
    updateCaseLink((query) => {
      for (const name of [
        'view',
        'caseId',
        'sceneId',
        'assetRevisionId',
        'meetingId',
        'history',
      ])
        query.delete(name);
      if (!caseRoute.snapshot) {
        for (const name of ['kind', 'title', 'versionId', 'versionNo', 'basis'])
          query.delete(name);
      }
    });
    requestAnimationFrame(() => window.scrollTo(0, libraryScroll.current));
  }
  function openTeamReview() {
    const scene = scopeScenarios.find((asset) => asset.id === sceneId);
    const cohort = scene ? scopeOf(scene, true) : scope;
    if (cohort) openWorkspace(cohort, 'meeting');
  }
  function browseCase(id: string) {
    if (scope && !caseRoute.history)
      recentCase.current.set(scope.requirementVersionId, id);
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
    if (asset.kind !== 'UI' || asset.targetType !== 'case' || asset.removedAt) {
      selectAsset(asset);
      return;
    }
    const next = scopeOf(asset);
    if (!next) {
      void message.warning('此用例所属需求版本未在当前目录取得。');
      return;
    }
    recentCase.current.set(next.requirementVersionId, asset.id);
    openWorkspace(next, 'workbench', asset.id);
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
    setSelectedKeys([]);
  }
  function selectAsset(asset: Asset) {
    setSelectedId(asset.id);
    const query = new URLSearchParams(window.location.hash.split('?')[1]);
    if (query.has('assetId') && query.get('assetId') !== asset.id) {
      query.set('assetId', asset.id);
      query.delete('assetRevisionId');
      window.location.hash = `cases?${query}`;
    }
  }
  async function changed() {
    await load();
    if (selectedId) await loadDetail(selectedId);
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
  function generateFor(scene: Asset, source?: UiSupplementSource) {
    if (!canEditAsset(scene)) return;
    const target = scopeOf(scene);
    if (target) openUiScenarioDraft({ scope: target, scene, userId, source });
  }
  async function startPreview(objectIds: string[]) {
    if (!project || !approvalKey || committing) return;
    try {
      const original = readApprovalRecovery(approvalKey);
      if (original) {
        setApprovalRecovery(original);
        return;
      }
    } catch (failure) {
      setError('无法读取原批准操作记录。' + describeError(failure));
      return;
    }
    const targets = assets.filter(
      (asset) => objectIds.includes(asset.id) && !asset.removedAt,
    );
    if (!targets.length || targets.length !== new Set(objectIds).size) {
      setError('没有完整可预览的有效对象，请先刷新范围。');
      return;
    }
    setPreviewLoading(true);
    setError(undefined);
    setCommitError(undefined);
    setReceipt(null);
    try {
      const result = await api(
        `/projects/${project.id}/assets/approval-previews`,
        {
          method: 'POST',
          body: { commandId: crypto.randomUUID(), kind, objectIds },
        },
        precisePreviewSchema,
      );
      commitCommand.current = crypto.randomUUID();
      setPreview(result);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPreviewLoading(false);
    }
  }
  async function adoptApproval(
    record: ApprovalRecovery,
    result: ApprovalReceipt,
  ) {
    assertApprovalReceipt(record, result);
    forgetApproval(approvalKey);
    setApprovalRecovery(undefined);
    setReceipt(result);
    setCommitError(undefined);
    await changed();
    setSelectedKeys([]);
  }
  async function approve() {
    if (!project || !preview || !approvalKey || committing || approvalRecovery)
      return;
    const record = {
      commandId: commitCommand.current,
      scopeDigest: preview.scopeDigest,
      objectIds: preview.items.map((item) => item.id),
    };
    setCommitting(true);
    setCommitError(undefined);
    try {
      rememberApproval(approvalKey, userId, record);
      let result;
      try {
        result = await api(
          '/projects/' + project.id + '/assets/approve',
          { method: 'POST', body: { ...record, previewId: preview.previewId } },
          approvalCommitReceiptSchema,
        );
      } catch (failure) {
        if (isUncertainMutationError(failure)) setApprovalRecovery(record);
        else forgetApproval(approvalKey);
        throw failure;
      }
      try {
        await adoptApproval(record, result);
      } catch (failure) {
        setApprovalRecovery(record);
        throw failure;
      }
    } catch (failure) {
      setCommitError(describeError(failure));
    } finally {
      setCommitting(false);
    }
  }
  async function recoverApproval() {
    if (!project || !approvalRecovery || !approvalKey || committing) return;
    setCommitting(true);
    setCommitError(undefined);
    try {
      const result = await api(
        '/projects/' +
          project.id +
          '/assets/approval-receipts/' +
          approvalRecovery.commandId,
        {},
        recoveredApprovalSchema,
      );
      if (result.status === 'completed' && result.response) {
        await adoptApproval(approvalRecovery, result.response);
      } else if (result.status === 'failed') {
        forgetApproval(approvalKey);
        setApprovalRecovery(undefined);
        setCommitError('已确认原批准失败，请重新核对范围。');
        setPreview(null);
      } else {
        setCommitError('原批准结果尚未确认。保留原提交标识，稍后核对。');
      }
    } catch (error) {
      setCommitError(describeError(error));
    } finally {
      setCommitting(false);
    }
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
          meetingId={caseRoute.history ? caseRoute.meetingId : undefined}
          archived={Boolean(selectedRequirement?.archived)}
          available={scopeExists && !caseRoute.invalid}
          loading={loading}
          error={caseRoute.invalid ? '用例工作台链接无效。' : error}
          tester={canReview}
          canEdit={canWrite}
          onBack={returnToLibrary}
          onCase={browseCase}
          onScene={browseScene}
          onRevision={(id) =>
            updateCaseLink((query) => {
              if (id) query.set('assetRevisionId', id);
              else query.delete('assetRevisionId');
            }, true)
          }
          onApprove={startPreview}
          onDetails={selectAsset}
          onOpenTeam={(id, asset) => {
            const cohort = scopeOf(asset, true);
            if (cohort) openWorkspace(cohort, 'meeting', undefined, id);
          }}
          onOpenHistory={(id, caseId) => {
            const asset = assets.find((item) => item.id === caseId);
            const cohort = asset ? scopeOf(asset, true) : scope;
            if (cohort) openWorkspace(cohort, 'workbench', caseId, id);
          }}
          onSupplement={(asset, origin) => {
            const scene = scopeScenarios.find(
              (item) => item.id === asset.parentId,
            );
            if (scene)
              generateFor(scene, {
                caseId: asset.id,
                revisionId: asset.revisionId,
                ...origin,
              });
          }}
          onChanged={changed}
          reviewDrafts={caseReviewDrafts.current}
        />
      )}
      {reviewWorkspace && scope && (
        <>
          <StandaloneWorkbenchHeader
            title="UI 用例评审"
            projectName={project.name}
            backLabel="返回 UI 用例管理"
            onBack={returnToLibrary}
          />
          <main className="ui-case-workbench-main">
            <UiReviewWorkspace
              key={project.id + ':' + scope.requirementVersionId}
              userId={userId}
              projectId={project.id}
              requirementVersionId={scope.requirementVersionId}
              requirementTitle={scope.title}
              versionNo={scope.versionNo}
              assets={assets.filter(
                (asset) =>
                  !asset.removedAt &&
                  asset.targetType === 'case' &&
                  asset.requirementVersionId === scope.requirementVersionId,
              )}
              scenarioTitles={
                new Map(scopeScenarios.map((asset) => [asset.id, asset.title]))
              }
              initialCases={selectedKeys}
              tester={canReview}
              onApprove={startPreview}
              updated={changed}
            />
          </main>
        </>
      )}
      {scope && (
        <>
          <UiReviewHistory
            scope={scope}
            title={selectedRequirement?.title ?? scope.title}
            open={reviewHistory}
            onClose={() => setReviewHistory(false)}
            onSelect={(id, requirementVersionId) => {
              const version = selectedRequirement?.versions.find(
                (item) => item.id === requirementVersionId,
              );
              if (version)
                openWorkspace(
                  {
                    ...scope,
                    requirementVersionId,
                    versionNo: version.versionNo,
                  },
                  'workbench',
                  undefined,
                  id,
                );
            }}
          />
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
            archiveDisabled={editor !== null || preview !== null || committing}
            onIncludeArchivedChange={(value) => {
              loadEpoch.current += 1;
              if (!value && selectedRequirement?.archived) {
                selectRequirement('all');
                setSelectedId(null);
              }
              setAssets([]);
              setNavigation({ requirements: [] });
              setSelectedKeys([]);
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
                  selectedId
                    ? `${assets.find((asset) => asset.id === selectedId)?.targetType ?? 'case'}:${selectedId}`
                    : sceneId
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
            selected={selectedKeys}
            canWrite={canWrite}
            canReview={canReview}
            oldBasisCases={oldBasisCases}
            stageOf={libraryStage}
            approving={previewLoading}
            onSearch={setSearch}
            onReview={libraryReview}
            onCurrent={() => {
              if (scope) selectRequirement(scope.requirementId);
            }}
            onCoverage={() => setCoverage(true)}
            onHistory={() => setReviewHistory(true)}
            onOpen={openScopedWorkbench}
            onReviewTeam={openTeamReview}
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
            onSelect={setSelectedKeys}
            onApprove={startPreview}
          />
        </div>
      </div>
      <DetailDrawer
        open={selectedId !== null}
        title={detail?.asset.title ?? '资产内容与评审'}
        meta={
          detail && (
            <>
              {targetTypeLabels[detail.asset.targetType]} · {kind} · 当前编辑 r
              {detail.asset.revisionNo}
            </>
          )
        }
        onClose={() => setSelectedId(null)}
      >
        {detailLoading && <Skeleton active />}
        {detailError && <Alert type="error" showIcon title={detailError} />}
        {detail && revision && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Space wrap>
              <span className="caption">当前评审</span>
              <ReviewStateTag state={detail.asset.reviewState} />
              {detail.asset.removedAt && <Tag>已移除，历史保留</Tag>}
            </Space>
            <Select
              aria-label="资产修订历史"
              value={revision.id}
              onChange={setRevisionId}
              options={detail.revisions.map((item) => ({
                value: item.id,
                label: `r${item.revisionNo}${item.id === detail.asset.revisionId ? '（当前编辑）' : '（历史内容）'} · ${formatBeijingTime(item.createdAt, true)}`,
              }))}
            />
            {detail.asset.targetType === 'case' && (
              <>
                <Typography.Text>
                  最新可取得的已审快照：
                  {latestApproved
                    ? `r${latestApproved.snapshot.case.revisionNo} · ${latestApproved.approval.id}`
                    : '尚未取得'}
                </Typography.Text>
                {approvalError && (
                  <Alert type="info" title={approvalError} showIcon />
                )}
              </>
            )}
            {detail.asset.targetType !== 'set' && (
              <Alert
                type="info"
                showIcon
                title={`历史归属 · ${sets.find((item) => item.id === detail.asset.setId)?.title ?? detail.asset.setId}`}
                description={
                  <Space wrap>
                    <Button onClick={() => setSelectedId(detail.asset.setId)}>
                      查看归属意见
                    </Button>
                  </Space>
                }
              />
            )}
            <Card
              title={`正在查看 r${revision.revisionNo}：${revision.content.title}`}
              size="small"
            >
              <ContentView content={revision.content} />
            </Card>
            <AssetReviewPanel
              key={`${detail.asset.id}:${revision.id}`}
              projectId={project.id}
              asset={detail.asset}
              revisionId={revision.id}
              tester={false}
              onChanged={changed}
            />
          </Space>
        )}
      </DetailDrawer>
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
            setSelectedId(null);
            setSelectedKeys((keys) =>
              keys.filter((key) => key !== removeTarget.id),
            );
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
      <Modal
        title="人工批准 · 精确范围预览"
        open={preview !== null || Boolean(approvalRecovery) || receipt !== null}
        width={1050}
        onCancel={() => {
          if (committing || approvalRecovery) return;
          setPreview(null);
          setReceipt(null);
        }}
        closable={!committing && !approvalRecovery}
        maskClosable={!committing && !approvalRecovery}
        keyboard={!committing && !approvalRecovery}
        footer={
          <Space>
            <Button
              disabled={committing || Boolean(approvalRecovery)}
              onClick={() => {
                setPreview(null);
                setReceipt(null);
              }}
            >
              {receipt ? '关闭回执' : '取消'}
            </Button>
            {approvalRecovery ? (
              <Button
                type="primary"
                loading={committing}
                onClick={() => void recoverApproval()}
              >
                查询原批准回执
              </Button>
            ) : (
              !receipt &&
              preview && (
                <Button
                  type="primary"
                  loading={committing}
                  disabled={!preview.items.some((item) => item.eligible)}
                  onClick={() => void approve()}
                >
                  确认批准预览中的精确对象
                </Button>
              )
            )}
          </Space>
        }
        destroyOnHidden
      >
        <Typography.Paragraph>
          确认绑定下列
          ID、修订、基准和摘要，不重新扩大筛选。逐项冲突或上层阻塞会独立返回；没有可批准项时不能确认。
        </Typography.Paragraph>
        {(commitError || approvalRecovery) && (
          <Alert
            type={approvalRecovery ? 'warning' : 'error'}
            title={commitError ?? '有原批准操作等待核对。'}
            description={approvalRecovery?.commandId}
            showIcon
            className="section-alert"
          />
        )}
        {!preview && receipt && (
          <ul>
            {receipt.results.map((entry) => (
              <li key={entry.id}>
                {entry.id} ·{' '}
                {entry.status === 'approved'
                  ? '已批准'
                  : entry.status === 'conflict'
                    ? '编辑基准已变化'
                    : entry.reasons.join('；')}
              </li>
            ))}
          </ul>
        )}
        {preview && (
          <>
            <Typography.Paragraph type="secondary">
              预览 {preview.previewId} · scopeDigest {preview.scopeDigest}
            </Typography.Paragraph>
            <Table
              size="small"
              rowKey="id"
              pagination={{ pageSize: 20 }}
              dataSource={preview.items}
              columns={[
                {
                  title: '对象',
                  render: (_, item) => (
                    <Space direction="vertical" size={0}>
                      <Typography.Text>{item.title}</Typography.Text>
                      <Typography.Text code>{item.id}</Typography.Text>
                    </Space>
                  ),
                },
                {
                  title: '固定修订/基准',
                  render: (_, item) => (
                    <Space direction="vertical" size={0}>
                      <Typography.Text code>{item.revisionId}</Typography.Text>
                      <Typography.Text>
                        rowVersion {item.rowVersion}
                      </Typography.Text>
                    </Space>
                  ),
                },
                {
                  title: '可批准性',
                  render: (_, item) => (
                    <Space direction="vertical" size={0}>
                      <Tag color={item.eligible ? 'green' : 'gold'}>
                        {item.eligible ? '可批准' : '将跳过'}
                      </Tag>
                      {item.reasons.map((reason) => (
                        <Typography.Text key={reason}>{reason}</Typography.Text>
                      ))}
                    </Space>
                  ),
                },
                {
                  title: '实际回执',
                  render: (_, item) => {
                    const result = receipt?.results.find(
                      (row) => row.id === item.id,
                    );
                    return result ? (
                      <Space direction="vertical" size={0}>
                        <Tag
                          color={
                            result.status === 'approved'
                              ? 'green'
                              : result.status === 'conflict'
                                ? 'red'
                                : 'gold'
                          }
                        >
                          {
                            {
                              approved: '已批准',
                              conflict: '基准冲突',
                              skipped: '已跳过',
                            }[result.status]
                          }
                        </Tag>
                        {result.status === 'skipped' &&
                          result.reasons.map((reason) => (
                            <Typography.Text key={reason}>
                              {reason}
                            </Typography.Text>
                          ))}
                      </Space>
                    ) : (
                      '尚未提交'
                    );
                  },
                },
              ]}
            />
            <Typography.Paragraph type="secondary">
              批准提交标识：{commitCommand.current}
            </Typography.Paragraph>
          </>
        )}
      </Modal>
    </>
  );
}
