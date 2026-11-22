import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Empty,
  Modal,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
  Tree,
  Typography,
} from 'antd';
import type { TreeDataNode } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { z } from 'zod';
import {
  approvalCommitReceiptSchema,
  assetDetailSchema,
  assetListSchema,
  assetNavigationSchema,
  assetReceiptSchema,
  latestApprovedResponseSchema,
  removeAssetInputSchema,
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
import {
  RequirementDirectory,
  RequirementDirectoryLabel,
} from './requirement-directory';
import { UiCaseText } from './ui-case-reader';
import { UiReviewWorkspace } from './ui-review-workspace';
import {
  UiCaseWorkbench,
  UiReviewHistory,
  useUiCaseStages,
} from './ui-case-workbench';
import { StandaloneWorkbenchHeader } from './standalone-workbench-header';
import { UiCaseActionDialog, type UiSupplementSource } from './ui-case-actions';
import { UiCoverageCheck } from './ui-coverage-check';
import { UiCaseLibraryPane } from './ui-case-library-pane';
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
      revisionId: z.uuid().optional(),
      meetingId: z.uuid().optional(),
    })
    .safeParse({
      caseId: query.get('caseId') ?? undefined,
      revisionId: query.get('assetRevisionId') ?? undefined,
      meetingId: query.get('meetingId') ?? undefined,
    });
  return {
    mode: view === 'meeting' || view === 'workbench' ? view : null,
    archived: query.get('archived') === '1',
    history: query.get('history') === '1',
    caseId: ids.success ? ids.data.caseId : undefined,
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
  scope,
  onScopeChange,
}: {
  project: Project | null;
  userId: string;
  scope: CaseScope | null;
  onScopeChange: (scope: CaseScope | null) => void;
}) {
  const { modal, message } = App.useApp();
  const [coverage, setCoverage] = useState(false);
  const [caseRoute, setCaseRoute] = useState(caseWorkbenchRoute);
  const [reviewHistory, setReviewHistory] = useState(false);
  const [sceneScope, setSceneScope] = useState<{
    id: string;
    versionId: string;
  }>();
  const [expandedLibrary, setExpandedLibrary] = useState<string[]>([]);
  const [caseAction, setCaseAction] = useState<{
    kind: 'new' | 'import' | 'generate' | 'supplement';
    scenarioId?: string;
    source?: UiSupplementSource;
    checkpoint?: CoverageCheckpoint;
  }>();
  const recentCase = useRef(new Map<string, string>());
  const inlineDrafts = useRef(new Map<string, string>());
  const libraryScroll = useRef(0);
  const reviewWorkspace = caseRoute.mode === 'meeting';
  const readerWorkspace = caseRoute.mode === 'workbench';
  const kind = 'UI';
  const immersive = Boolean(scope) && (reviewWorkspace || readerWorkspace);
  const [navigation, setNavigation] = useState<Navigation>({
    requirements: [],
  });
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState('');
  const [directorySearch, setDirectorySearch] = useState('');
  const [reviewFilter, setReviewFilter] = useState<string>(reviewFromUrl);
  const [includeRemoved, setIncludeRemoved] = useState(false);
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
  const sets = assets.filter((asset) => asset.targetType === 'set');
  const selectedRequirement = navigation.requirements.find(
    (requirement) => requirement.id === scope?.requirementId,
  );
  const sceneId =
    sceneScope?.versionId === scope?.requirementVersionId
      ? sceneScope?.id
      : undefined;
  const canWrite = tester && !selectedRequirement?.archived;
  const scopeExists =
    scope === null ||
    Boolean(
      selectedRequirement?.versions.some(
        (version) => version.id === scope.requirementVersionId,
      ),
    );
  const scenarios = assets.filter(
    (asset) =>
      asset.targetType === 'scenario' && (!sceneId || asset.id === sceneId),
  );
  const scopeScenarios = assets.filter(
    (asset) => asset.targetType === 'scenario',
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
        includeRemoved: String(includeRemoved),
        includeArchivedRequirements: String(includeArchivedRequirements),
      });
      if (scope) query.set('requirementVersionId', scope.requirementVersionId);
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
    const context = `${project?.id}:${kind}:${scope?.requirementVersionId}:${includeRemoved}`;
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
    scope?.requirementVersionId,
    includeRemoved,
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

  useEffect(() => {
    if (!scope) return;
    const key = 'requirement:' + scope.requirementId;
    setExpandedLibrary((before) =>
      before.includes(key) ? before : [...before, key],
    );
  }, [kind, scope?.requirementId]);
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
    if (id === 'all') {
      changeScope(null);
      return;
    }
    const requirement = navigation.requirements.find((item) => item.id === id);
    const version = requirement
      ? [...requirement.versions].sort((a, b) => b.versionNo - a.versionNo)[0]
      : undefined;
    if (requirement && version)
      changeScope({
        projectId: project.id,
        requirementId: requirement.id,
        title: requirement.title,
        requirementVersionId: version.id,
        versionNo: version.versionNo,
        kind,
      });
  }
  function selectVersion(id: string) {
    if (!scope || !selectedRequirement) return;
    const version = selectedRequirement.versions.find((item) => item.id === id);
    if (version)
      changeScope({
        ...scope,
        requirementVersionId: id,
        versionNo: version.versionNo,
      });
  }
  function changeScope(next: CaseScope | null) {
    setCoverage(false);
    setReviewHistory(false);
    setSceneScope(undefined);
    onScopeChange(next);
    const query = new URLSearchParams(window.location.hash.split('?')[1]);
    query.set('kind', next?.kind ?? kind);
    if (reviewFilter !== 'all') query.set('review', reviewFilter);
    else query.delete('review');
    query.delete('assetId');
    query.delete('assetRevisionId');
    window.location.hash = `cases?${query}`;
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
  ) {
    if (!immersive) libraryScroll.current = window.scrollY;
    if (
      scope?.requirementVersionId !== next.requirementVersionId ||
      scope.kind !== next.kind
    )
      onScopeChange(next);
    setSelectedId(null);
    setReviewHistory(false);
    updateCaseLink((query) => {
      query.delete('assetId');
      query.delete('assetRevisionId');
      query.delete('meetingId');
      query.delete('caseId');
      query.delete('history');
      query.set('view', mode);
      query.set('kind', 'UI');
      query.set('projectId', next.projectId);
      query.set('requirementId', next.requirementId);
      query.set('title', next.title);
      query.set('versionId', next.requirementVersionId);
      query.set('versionNo', String(next.versionNo));
      if (includeArchivedRequirements) query.set('archived', '1');
      if (caseId) query.set('caseId', caseId);
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
        'assetRevisionId',
        'meetingId',
        'history',
      ])
        query.delete(name);
    });
    requestAnimationFrame(() => window.scrollTo(0, libraryScroll.current));
  }
  function openTeamReview() {
    if (scope) openWorkspace(scope, 'meeting');
  }
  function browseCase(id: string) {
    if (scope && !caseRoute.history)
      recentCase.current.set(scope.requirementVersionId, id);
    updateCaseLink((query) => {
      query.set('caseId', id);
      query.delete('assetRevisionId');
    }, true);
  }
  function scopeOf(asset: Asset): CaseScope | null {
    if (!project) return null;
    const requirement = navigation.requirements.find((item) =>
      item.versions.some(
        (version) => version.id === asset.requirementVersionId,
      ),
    );
    const version = requirement?.versions.find(
      (item) => item.id === asset.requirementVersionId,
    );
    if (!requirement || !version) return null;
    return {
      projectId: project.id,
      requirementId: requirement.id,
      requirementVersionId: version.id,
      title: requirement.title,
      versionNo: version.versionNo,
      kind: asset.kind,
    };
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
    if (scope?.requirementVersionId !== next.requirementVersionId)
      changeScope(next);
    setSceneScope({ id: asset.id, versionId: next.requirementVersionId });
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
    await load();
    if (
      readerWorkspace &&
      asset.kind === 'UI' &&
      asset.targetType === 'case' &&
      asset.requirementVersionId === scope?.requirementVersionId
    ) {
      setSelectedId(null);
      browseCase(asset.id);
      return;
    }
    setSelectedId(asset.id);
    if (selectedId === asset.id) await loadDetail(asset.id);
  }
  function addToScene(asset: Asset) {
    if (
      asset.kind !== 'UI' ||
      asset.targetType !== 'scenario' ||
      asset.removedAt ||
      !scope ||
      scope.requirementVersionId !== asset.requirementVersionId
    )
      return;
    setSelectedId(null);
    setCaseAction({ kind: 'new', scenarioId: asset.id });
  }
  function edit(asset: Asset) {
    if (asset.kind !== 'UI') return;
    setEditor({
      targetType: asset.targetType,
      kind: asset.kind,
      requirementVersionId: asset.requirementVersionId,
      setId: asset.setId,
      scenarioId: asset.targetType === 'case' ? asset.parentId : null,
      asset,
    });
  }
  function remove(asset: Asset) {
    if (!project) return;
    const projectId = project.id;
    modal.confirm({
      title: `显式移除${targetTypeLabels[asset.targetType]}「${asset.title}」？`,
      content:
        '历史修订与既有引用保留。批次/场景仍有有效子项时服务会拒绝，不会级联删除子项。',
      okText: '移除当前资产',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const body = removeAssetInputSchema.parse({
            commandId: crypto.randomUUID(),
            baseRevisionId: asset.revisionId,
            rowVersion: asset.rowVersion,
          });
          await api(
            `/projects/${projectId}/assets/${asset.id}`,
            { method: 'DELETE', body },
            assetReceiptSchema,
          );
          setSelectedId(null);
          await load();
        } catch (err) {
          setError(describeError(err));
          throw err;
        }
      },
    });
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

  const tree = useMemo<TreeDataNode[]>(() => {
    const keyword = directorySearch.trim().toLocaleLowerCase();
    return navigation.requirements.flatMap((requirement) => {
      const requirementMatches = `${requirement.title} ${requirement.id}`
        .toLocaleLowerCase()
        .includes(keyword);
      const children = assets
        .filter(
          (asset) =>
            asset.targetType === 'scenario' &&
            requirement.versions.some(
              (version) => version.id === asset.requirementVersionId,
            ),
        )
        .flatMap((scenario) => {
          const scenarioMatches =
            requirementMatches ||
            scenario.title.toLocaleLowerCase().includes(keyword);
          const cases = assets.filter(
            (asset) =>
              asset.targetType === 'case' &&
              asset.parentId === scenario.id &&
              (scenarioMatches ||
                (asset.title + ' ' + asset.id)
                  .toLocaleLowerCase()
                  .includes(keyword)),
          );
          if (!scenarioMatches && !cases.length) return [];
          const version = requirement.versions.find(
            (item) => item.id === scenario.requirementVersionId,
          );
          const detail = version ? 'v' + version.versionNo : undefined;
          return [
            {
              key: `scenario:${scenario.id}`,
              title: (
                <RequirementDirectoryLabel
                  title={scenario.title}
                  {...(detail ? { detail } : {})}
                />
              ),
              children: cases.map((asset) => ({
                key: `case:${asset.id}`,
                title: <RequirementDirectoryLabel title={asset.title} />,
                isLeaf: true,
              })),
            },
          ];
        });
      if (!requirementMatches && !children.length) return [];
      return [
        {
          key: `requirement:${requirement.id}`,
          title: (
            <RequirementDirectoryLabel
              title={requirement.title}
              count={`${requirement.caseCount} 条用例`}
              archived={requirement.archived}
            />
          ),
          children,
        },
      ];
    });
  }, [navigation, assets, directorySearch]);
  if (!project)
    return (
      <Card>
        <Empty description="请先选择当前有效项目，再浏览和维护用例。" />
      </Card>
    );
  return (
    <>
      {readerWorkspace && scope && (
        <UiCaseWorkbench
          key={project.id + ':' + scope.requirementVersionId}
          scope={{ ...scope, title: selectedRequirement?.title ?? scope.title }}
          projectName={project.name}
          userId={userId}
          assets={assets}
          requestedCase={caseRoute.caseId}
          requestedRevision={caseRoute.revisionId}
          meetingId={caseRoute.history ? caseRoute.meetingId : undefined}
          archived={Boolean(selectedRequirement?.archived)}
          available={scopeExists && !caseRoute.invalid}
          loading={loading}
          error={caseRoute.invalid ? '用例工作台链接无效。' : error}
          tester={canWrite}
          onBack={returnToLibrary}
          onCase={browseCase}
          onRevision={(id) =>
            updateCaseLink((query) => {
              if (id) query.set('assetRevisionId', id);
              else query.delete('assetRevisionId');
            }, true)
          }
          onApprove={startPreview}
          onEdit={edit}
          onDetails={selectAsset}
          onOpenTeam={(id) => openWorkspace(scope, 'meeting', undefined, id)}
          onSupplement={(asset, origin) => {
            setCaseAction({
              kind: 'supplement',
              source: {
                caseId: asset.id,
                revisionId: asset.revisionId,
                title: asset.title,
                scenarioId: asset.parentId,
                ...(origin ? { origin } : {}),
              },
            });
          }}
          onChanged={changed}
          inlineDrafts={inlineDrafts.current}
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
              tester={canWrite}
              onApprove={startPreview}
              updated={changed}
            />
          </main>
        </>
      )}
      {scope && (
        <>
          <UiReviewHistory
            projectId={project.id}
            requirementVersionId={scope.requirementVersionId}
            title={
              (selectedRequirement?.title ?? scope.title) +
              ' · v' +
              scope.versionNo
            }
            open={reviewHistory}
            onClose={() => setReviewHistory(false)}
            onSelect={(id) => openWorkspace(scope, 'workbench', undefined, id)}
          />
          <UiCoverageCheck
            scope={scope}
            userId={userId}
            assets={assets}
            scenarioId={sceneId}
            open={coverage}
            tester={canWrite}
            onClose={() => setCoverage(false)}
            onCase={(asset) => {
              setCoverage(false);
              openCase(asset);
            }}
            onSupplement={(checkpoint) => {
              setCoverage(false);
              setCaseAction({ kind: 'new', checkpoint });
            }}
          />
          {caseAction && canWrite && scopeExists && (
            <UiCaseActionDialog
              scope={scope}
              userId={userId}
              action={caseAction.kind}
              assets={assets}
              scenarioId={caseAction.scenarioId ?? sceneId}
              source={caseAction.source}
              checkpoint={caseAction.checkpoint}
              onClose={() => setCaseAction(undefined)}
              onChanged={async () => {
                await changed();
                setCaseAction(undefined);
                if (caseAction.checkpoint) setCoverage(true);
              }}
            />
          )}
        </>
      )}
      <div hidden={immersive} className="ui-case-library">
        <header className="ui-case-library-heading">
          <h1>UI 用例管理</h1>
          <p>按需求、版本与场景维护用例，逐条评审和批准。</p>
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
            title="当前需求版本不在本次浏览范围"
            description="可在需求目录开启“显示已归档需求”，或重新选择浏览范围。"
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
            <button
              type="button"
              className={`tree-node requirement-directory-button ${scope ? '' : 'active'}`}
              aria-pressed={!scope}
              onClick={() => selectRequirement('all')}
            >
              <RequirementDirectoryLabel
                title="全部需求"
                count={`${navigation.requirements.reduce((n, r) => n + r.caseCount, 0)} 条用例`}
              />
            </button>
            {loading ? (
              <Skeleton active />
            ) : (
              <Tree
                key={scope?.requirementVersionId ?? 'all'}
                treeData={tree}
                expandedKeys={expandedLibrary}
                onExpand={(keys) => setExpandedLibrary(keys.map(String))}
                blockNode
                selectedKeys={
                  selectedId
                    ? [
                        `${assets.find((asset) => asset.id === selectedId)?.targetType ?? 'case'}:${selectedId}`,
                      ]
                    : sceneId
                      ? [`scenario:${sceneId}`]
                      : scope
                        ? [`requirement:${scope.requirementId}`]
                        : []
                }
                onSelect={([key]) => {
                  if (typeof key !== 'string') return;
                  if (key.startsWith('requirement:'))
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
            includeRemoved={includeRemoved}
            selected={selectedKeys}
            canWrite={canWrite}
            stageOf={libraryStage}
            approving={previewLoading}
            onSearch={setSearch}
            onReview={libraryReview}
            onVersion={selectVersion}
            onCoverage={() => setCoverage(true)}
            onHistory={() => setReviewHistory(true)}
            onOpen={openScopedWorkbench}
            onReviewTeam={openTeamReview}
            onAction={(kind) => setCaseAction({ kind })}
            onOpenCase={openCase}
            onScenario={selectAsset}
            onAddToScene={addToScene}
            onSelect={setSelectedKeys}
            onApprove={startPreview}
            onIncludeRemoved={setIncludeRemoved}
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
                    {detail.asset.targetType === 'case' &&
                      detail.asset.parentId && (
                        <Button
                          onClick={() => setSelectedId(detail.asset.parentId)}
                        >
                          查看场景意见
                        </Button>
                      )}
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
            {canWrite && !detail.asset.removedAt && (
              <Space wrap>
                <Button
                  icon={<EditOutlined />}
                  onClick={() => edit(detail.asset)}
                >
                  编辑当前内容并建新修订
                </Button>
                {detail.asset.targetType === 'scenario' && scope && (
                  <Button
                    icon={<PlusOutlined />}
                    onClick={() => addToScene(detail.asset)}
                  >
                    新增用例
                  </Button>
                )}
                <Button
                  loading={previewLoading}
                  onClick={() => void startPreview([detail.asset.id])}
                >
                  预览通过此对象
                </Button>
                <Button
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => remove(detail.asset)}
                >
                  显式移除
                </Button>
              </Space>
            )}
            <AssetReviewPanel
              key={`${detail.asset.id}:${revision.id}`}
              projectId={project.id}
              asset={detail.asset}
              revisionId={revision.id}
              tester={canWrite && !detail.asset.removedAt}
              onChanged={changed}
            />
          </Space>
        )}
      </DetailDrawer>
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
