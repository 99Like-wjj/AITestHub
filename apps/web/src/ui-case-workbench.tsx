import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Empty,
  Input,
  Modal,
  Skeleton,
  Space,
  Tag,
  Typography,
} from 'antd';
import {
  AimOutlined,
  CalendarOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { z } from 'zod';
import {
  approvalCommitReceiptSchema,
  assetDetailSchema,
  caseSupplementOriginResultSchema,
  type Asset,
} from '../../../packages/contracts/src/assets';
import {
  uiCaseReviewStageListSchema,
  uiCaseReviewDetailSchema,
} from '../../../packages/contracts/src/ui-reviews';
import { uiPlanEligibilitySchema } from '../../../packages/contracts/src/plans';
import { precisePreviewSchema } from '../../../packages/contracts/src/domain';
import { api, describeError, isUncertainMutationError } from './api';
import { formatBeijingTime } from './beijing-time';
import { StandaloneWorkbenchHeader } from './standalone-workbench-header';
import { AppIcon } from './app-icon';
import { UiCaseReader } from './ui-case-reader';
import { UiCaseReviewPane } from './ui-case-review-pane';
import type { CaseScope } from './requirements';
import { UiRequirementBasis } from './ui-requirement-basis';
import { AssetReviewPanel } from './asset-review-panel';
import {
  matchingApproval,
  uiPlanHandoffHash,
  type UiPlanEligibility,
} from './ui-case-plan-handoff';
import {
  assertApprovalReceipt,
  forgetApproval,
  readApprovalRecovery,
  recoveredApprovalSchema,
  rememberApproval,
  type ApprovalRecovery,
} from './ui-case-approval';
import './ui-case-workbench.css';

type CaseReview = z.infer<typeof uiCaseReviewDetailSchema>;
type ApprovalReceipt = z.infer<typeof approvalCommitReceiptSchema>;
type Detail = z.infer<typeof assetDetailSchema>;
type SavedOrigin = z.infer<typeof caseSupplementOriginResultSchema>['origin'];
type CaseStage = z.infer<typeof uiCaseReviewStageListSchema>['items'][number];
type Filter = 'all' | CaseStage['stage'];
const filters: Record<Filter, string> = {
  all: '全部用例',
  pending: '待评审',
  needsOptimization: '待修改',
  waitingHuman: '待人工复审',
  approved: '已通过',
};

export function uiStageForReviewState(
  state: Asset['reviewState'],
): CaseStage['stage'] {
  return state === 'aiOptimized' ? 'waitingHuman' : state;
}

export function useUiCaseStages(
  scope: CaseScope | null,
  assets: Asset[],
  enabled: boolean,
) {
  const [stages, setStages] = useState<CaseStage[]>([]);
  const [error, setError] = useState<string>();
  const projectId = scope?.projectId;
  const basisId = scope?.historical
    ? scope.requirementVersionId
    : scope?.requirementId;
  const basisField = scope?.historical
    ? 'requirementVersionId'
    : 'requirementId';
  useEffect(() => {
    if (
      !enabled ||
      !projectId ||
      !basisId ||
      !assets.some((asset) => asset.targetType === 'case')
    )
      return;
    const controller = new AbortController();
    setError(undefined);
    const query = new URLSearchParams({ [basisField]: basisId });
    void api(
      '/projects/' + projectId + '/assets/ui-case-review-stages?' + query,
      { signal: controller.signal },
      uiCaseReviewStageListSchema,
    )
      .then(({ items }) => {
        if (!controller.signal.aborted) setStages(items);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) {
          setStages([]);
          setError(describeError(failure));
        }
      });
    return () => controller.abort();
  }, [projectId, basisField, basisId, enabled, assets]);
  const stageByCase = useMemo(
    () => new Map(stages.map((item) => [item.caseId, item])),
    [stages],
  );
  function statusOf(asset: Asset) {
    const entry = enabled ? stageByCase.get(asset.id) : undefined;
    return entry?.revisionId === asset.revisionId &&
      entry.rowVersion === asset.rowVersion
      ? entry
      : undefined;
  }
  return {
    statusOf,
    error,
    stageOf: (asset: Asset) =>
      statusOf(asset)?.stage ?? uiStageForReviewState(asset.reviewState),
  };
}

export function UiCaseStageBadge({ stage }: { stage: CaseStage['stage'] }) {
  return (
    <span className="ui-case-stage" data-stage={stage}>
      <i aria-hidden="true" />
      {filters[stage]}
    </span>
  );
}

export function UiCaseWorkbench({
  scope,
  projectName,
  userId,
  assets,
  requestedCase,
  requestedScene,
  requestedRevision,
  archived,
  available,
  loading,
  error,
  tester,
  onBack,
  onCase,
  onScene,
  onRevision,
  onChanged,
}: {
  scope: CaseScope;
  projectName: string;
  userId: string;
  assets: Asset[];
  requestedCase: string | undefined;
  requestedScene: string | undefined;
  requestedRevision: string | undefined;
  archived: boolean;
  available: boolean;
  loading: boolean;
  error: string | undefined;
  tester: boolean;
  onBack: () => void;
  onCase: (caseId: string) => void;
  onScene: (sceneId: string) => void;
  onRevision: (revisionId?: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [detail, setDetail] = useState<Detail>();
  const [removedLink, setRemovedLink] = useState<Detail>();
  const [caseReviewRecord, setCaseReviewRecord] = useState<{
    data: CaseReview;
    rowVersion: number;
  }>();
  const [selectedCases, setSelectedCases] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [approving, setApproving] = useState(false);
  const approvalInFlight = useRef(false);
  const approvalKey =
    'aitesthub:asset-approval:' + userId + ':' + scope.projectId + ':UI';
  const [recovery, setRecovery] = useState<ApprovalRecovery>();
  const [approvalError, setApprovalError] = useState<string>();
  const [receipt, setReceipt] = useState<ApprovalReceipt>();
  useEffect(() => {
    try {
      setRecovery(readApprovalRecovery(approvalKey) ?? undefined);
    } catch (failure: unknown) {
      setApprovalError(describeError(failure));
    }
  }, [approvalKey]);
  const [originRecord, setOriginRecord] = useState<{
    assetId: string;
    origin: SavedOrigin;
  }>();
  const [originError, setOriginError] = useState<{
    assetId: string;
    message: string;
  }>();
  const [readError, setReadError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [scopePlan, setScopePlan] = useState(false);
  const [planItems, setPlanItems] = useState<UiPlanEligibility[]>();
  const [planError, setPlanError] = useState<string>();
  const [choice, setChoice] = useState<string[]>([]);
  const linkedRemoved =
    removedLink?.asset.id === requestedCase ? removedLink : undefined;
  const readonly =
    archived || Boolean(scope.historical) || Boolean(linkedRemoved);
  const cases = useMemo(
    () =>
      assets.filter(
        (asset) =>
          asset.kind === 'UI' &&
          asset.targetType === 'case' &&
          !asset.removedAt,
      ),
    [assets],
  );
  const sceneAssets = useMemo(
    () =>
      assets.filter(
        (asset) => asset.targetType === 'scenario' && !asset.removedAt,
      ),
    [assets],
  );
  const scenarios = new Map(
    sceneAssets.map((asset) => [asset.id, asset.title]),
  );
  const needsLinkedRead = Boolean(
    requestedCase &&
    !cases.some((item) => item.id === requestedCase) &&
    available &&
    !loading,
  );
  useEffect(() => {
    if (!needsLinkedRead || !requestedCase) return;
    const controller = new AbortController();
    void api(
      `/projects/${scope.projectId}/assets/${requestedCase}`,
      { signal: controller.signal },
      assetDetailSchema,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        const { asset } = result;
        if (
          asset.targetType !== 'case' ||
          asset.kind !== 'UI' ||
          !asset.removedAt
        )
          return;
        const sameScope =
          scope.historical || !asset.requirementBasis
            ? asset.requirementVersionId === scope.requirementVersionId
            : asset.requirementBasis.requirementId === scope.requirementId;
        if (sameScope) setRemovedLink(result);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setReadError(describeError(failure));
      });
    return () => controller.abort();
  }, [
    needsLinkedRead,
    requestedCase,
    scope.projectId,
    scope.requirementId,
    scope.requirementVersionId,
    scope.historical,
  ]);
  const {
    stageOf: caseStage,
    statusOf,
    error: stageError,
  } = useUiCaseStages(scope, cases, available);
  const activeScene = requestedScene
    ? sceneAssets.find((asset) => asset.id === requestedScene)
    : !requestedCase && !cases.length
      ? sceneAssets[0]
      : undefined;
  const active = activeScene
    ? undefined
    : requestedCase
      ? (cases.find((asset) => asset.id === requestedCase) ??
        linkedRemoved?.asset)
      : cases[0];
  const planVersionId =
    active?.requirementVersionId ??
    activeScene?.requirementVersionId ??
    scope.requirementVersionId;
  const planCases = useMemo(
    () => cases.filter((asset) => asset.requirementVersionId === planVersionId),
    [cases, planVersionId],
  );
  const activeId = active?.id;
  const activeRevision = active?.revisionId;
  const activeRowVersion = active?.rowVersion;
  const displayedRows = cases.filter(
    (asset) =>
      (filter === 'all' || caseStage(asset) === filter) &&
      [asset.title, asset.id, scenarios.get(asset.parentId ?? '') ?? ''].some(
        (value) =>
          value.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
      ),
  );
  const position = displayedRows.findIndex((asset) => asset.id === activeId);
  const visibleSceneIds = new Set(displayedRows.map((asset) => asset.parentId));
  if (filter === 'all') {
    for (const scene of sceneAssets) {
      if (
        scene.title
          .toLocaleLowerCase()
          .includes(search.trim().toLocaleLowerCase())
      )
        visibleSceneIds.add(scene.id);
    }
  }
  useEffect(() => {
    if (requestedScene) setReadError(undefined);
  }, [requestedScene]);
  useEffect(() => {
    if (!activeId || !available) return;
    const controller = new AbortController();
    void api(
      `/projects/${scope.projectId}/assets/${activeId}/supplement-origin`,
      { signal: controller.signal },
      caseSupplementOriginResultSchema,
    )
      .then(({ origin }) => {
        if (!controller.signal.aborted) {
          setOriginRecord({ assetId: activeId, origin });
          setOriginError(undefined);
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setOriginError({
            assetId: activeId,
            message: describeError(failure),
          });
      });
    return () => controller.abort();
  }, [scope.projectId, activeId, available]);

  useEffect(() => {
    if (!activeId || activeRowVersion === undefined || !available) return;
    const controller = new AbortController();
    void api(
      `/projects/${scope.projectId}/assets/${activeId}/case-review`,
      { signal: controller.signal },
      uiCaseReviewDetailSchema,
    )
      .then((data) => {
        if (!controller.signal.aborted)
          setCaseReviewRecord({ data, rowVersion: activeRowVersion });
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setReadError(describeError(failure));
      });
    return () => controller.abort();
  }, [activeId, activeRowVersion, available, scope.projectId]);
  useEffect(() => {
    if (linkedRemoved || !activeId || !activeRevision || !available) return;
    const controller = new AbortController();
    setReadError(undefined);
    setDetail((entry) =>
      entry?.asset.id === activeId &&
      entry.asset.rowVersion === activeRowVersion
        ? entry
        : undefined,
    );
    void api(
      `/projects/${scope.projectId}/assets/${activeId}`,
      { signal: controller.signal },
      assetDetailSchema,
    )
      .then((response) => {
        if (controller.signal.aborted) return;
        if (
          response.asset.requirementVersionId !==
            active?.requirementVersionId ||
          response.asset.kind !== 'UI' ||
          response.asset.targetType !== 'case'
        ) {
          setReadError('此链接未定位到当前需求版本的 UI 用例。');
          return;
        }
        setDetail(response);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setReadError(describeError(failure));
      });
    return () => controller.abort();
  }, [
    linkedRemoved,
    activeId,
    activeRevision,
    activeRowVersion,
    available,
    scope.projectId,
    scope.requirementVersionId,
  ]);
  useEffect(() => {
    if (!scopePlan) return;
    const controller = new AbortController();
    setPlanItems(undefined);
    setPlanError(undefined);
    setChoice([]);
    void api(
      `/projects/${scope.projectId}/plans/ui-eligibility`,
      { signal: controller.signal },
      uiPlanEligibilitySchema,
    )
      .then(({ items }) => {
        if (controller.signal.aborted) return;
        setPlanItems(items);
        setChoice(
          planCases
            .filter((asset) =>
              items.some((item) => Boolean(matchingApproval(asset, item))),
            )
            .map((asset) => asset.id),
        );
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setPlanError(describeError(failure));
      });
    return () => controller.abort();
  }, [scopePlan, scope.projectId, planCases]);

  const focusedDetail =
    linkedRemoved ?? (detail?.asset.id === activeId ? detail : undefined);
  const currentAsset = focusedDetail?.asset;
  const currentRowVersion = currentAsset?.rowVersion;
  useEffect(() => {
    if (
      activeRowVersion === undefined ||
      currentRowVersion === undefined ||
      currentRowVersion <= activeRowVersion
    )
      return;
    let activeRead = true;
    void onChanged().catch((failure: unknown) => {
      if (activeRead) setReadError(describeError(failure));
    });
    return () => {
      activeRead = false;
    };
  }, [activeId, activeRowVersion, currentRowVersion]);
  const revisions = focusedDetail?.revisions ?? [];
  const latestRevision = focusedDetail?.asset.revisionId;
  const revisionId = requestedRevision ?? latestRevision;
  const earlier = Boolean(
    latestRevision && revisionId && latestRevision !== revisionId,
  );
  const writable = tester && !readonly && !earlier && !currentAsset?.removedAt;
  const displayedReview =
    caseReviewRecord?.data.caseId === activeId &&
    caseReviewRecord?.data.revisionId === currentAsset?.revisionId &&
    caseReviewRecord?.rowVersion === activeRowVersion
      ? caseReviewRecord?.data
      : undefined;
  const draftKey = (asset: Asset) => asset.id + ':' + asset.revisionId;
  const eligibleForReview = writable
    ? cases.filter(
        (asset) =>
          statusOf(asset)?.reasons.length === 0 &&
          !drafts[draftKey(asset)]?.trim(),
      )
    : [];
  const eligibleIds = new Set(eligibleForReview.map((asset) => asset.id));
  const selected = eligibleForReview.filter((asset) =>
    selectedCases.includes(asset.id),
  );
  const selectedSet = new Set(selected.map((asset) => asset.id));
  const allSelected =
    eligibleForReview.length > 0 &&
    selected.length === eligibleForReview.length;
  const selectedOutsideFilter = selected.filter(
    (asset) => !displayedRows.some((row) => row.id === asset.id),
  ).length;
  const approvedCount =
    receipt?.results.filter((row) => row.status === 'approved').length ?? 0;
  const eligibility = new Map(planItems?.map((item) => [item.caseId, item]));
  const eligible = planCases.flatMap((asset) => {
    const approvalSnapshotId = matchingApproval(
      asset,
      eligibility.get(asset.id),
    );
    return approvalSnapshotId ? [{ asset, approvalSnapshotId }] : [];
  });
  const chosenApprovals = choice.flatMap(
    (id) => eligible.find(({ asset }) => asset.id === id) ?? [],
  );
  const blocked =
    planItems &&
    planCases.filter(
      (asset) => !matchingApproval(asset, eligibility.get(asset.id)),
    );
  const [eligibleCount, setEligibleCount] = useState<number>();
  useEffect(() => {
    if (readonly || !available || !tester || !planCases.length) {
      setEligibleCount(undefined);
      return;
    }
    const controller = new AbortController();
    void api(
      '/projects/' + scope.projectId + '/plans/ui-eligibility',
      { signal: controller.signal },
      uiPlanEligibilitySchema,
    )
      .then(({ items }) => {
        if (!controller.signal.aborted)
          setEligibleCount(
            planCases.filter((row) =>
              items.some((item) => Boolean(matchingApproval(row, item))),
            ).length,
          );
      })
      .catch(() => {
        if (!controller.signal.aborted) setEligibleCount(undefined);
      });
    return () => controller.abort();
  }, [readonly, available, tester, planCases, scope.projectId]);
  const origin =
    originRecord?.assetId === activeId ? originRecord?.origin : undefined;
  const sourceInScope =
    origin && cases.some((asset) => asset.id === origin.caseId);
  const openedRevision = revisions.find((entry) => entry.id === revisionId);
  const displayTitle = openedRevision?.content.title ?? active?.title;
  const nextCandidate = displayedRows[position + 1];
  const previousCandidate = displayedRows[position - 1];

  function select(id: string) {
    if (!busy && !approving) onCase(id);
  }
  async function acceptReceipt(
    record: ApprovalRecovery,
    result: ApprovalReceipt,
  ) {
    assertApprovalReceipt(record, result);
    forgetApproval(approvalKey);
    setRecovery(undefined);
    setReceipt(result);
    setSelectedCases([]);
    await onChanged();
  }

  async function approveCases(targets: Asset[]) {
    if (
      approvalInFlight.current ||
      !writable ||
      busy ||
      recovery ||
      !targets.length
    )
      return;
    approvalInFlight.current = true;
    setApproving(true);
    setApprovalError(undefined);
    setReceipt(undefined);
    try {
      const pending = readApprovalRecovery(approvalKey);
      if (pending) {
        setRecovery(pending);
        return;
      }
      const objectIds = targets.map((asset) => asset.id);
      const basis = targets.map((asset) => ({
        id: asset.id,
        revisionId: asset.revisionId,
        rowVersion: asset.rowVersion,
      }));
      const preview = await api(
        `/projects/${scope.projectId}/assets/approval-previews`,
        {
          method: 'POST',
          body: {
            commandId: crypto.randomUUID(),
            kind: 'UI',
            objectIds,
            baselines: basis,
          },
        },
        precisePreviewSchema,
      );
      const record = {
        commandId: crypto.randomUUID(),
        scopeDigest: preview.scopeDigest,
        objectIds,
      };
      rememberApproval(approvalKey, userId, record);
      let result;
      try {
        result = await api(
          `/projects/${scope.projectId}/assets/approve`,
          {
            method: 'POST',
            body: { ...record, previewId: preview.previewId },
          },
          approvalCommitReceiptSchema,
        );
      } catch (failure: unknown) {
        if (isUncertainMutationError(failure)) setRecovery(record);
        else forgetApproval(approvalKey);
        throw failure;
      }
      setRecovery(record);
      await acceptReceipt(record, result);
    } catch (failure: unknown) {
      setApprovalError(describeError(failure));
    } finally {
      approvalInFlight.current = false;
      setApproving(false);
    }
  }

  async function recoverApproval() {
    if (!recovery || approvalInFlight.current) return;
    approvalInFlight.current = true;
    setApproving(true);
    try {
      const result = await api(
        `/projects/${scope.projectId}/assets/approval-receipts/${recovery.commandId}`,
        {},
        recoveredApprovalSchema,
      );
      if (result.status === 'completed' && result.response) {
        setApprovalError(undefined);
        await acceptReceipt(recovery, result.response);
      } else if (result.status === 'failed') {
        forgetApproval(approvalKey);
        setRecovery(undefined);
        setApprovalError('原审批未完成，请刷新用例后重新选择。');
      } else setApprovalError('原审批结果暂未返回，请稍后核对。');
    } catch (failure: unknown) {
      setApprovalError(describeError(failure));
    } finally {
      approvalInFlight.current = false;
      setApproving(false);
    }
  }

  function locate() {
    setFilter('all');
    setSearch('');
    requestAnimationFrame(() => {
      const node = document.querySelector<HTMLElement>(
        '[data-ui-case-workbench] [aria-current="true"]',
      );
      const group = node?.closest('details');
      if (group) group.open = true;
      node?.scrollIntoView({ block: 'nearest' });
      node?.focus({ preventScroll: true });
    });
  }

  return (
    <section className="ui-case-workbench" data-ui-case-workbench>
      <StandaloneWorkbenchHeader
        title="UI 用例工作台"
        projectName={projectName}
        backLabel="返回 UI 用例管理"
        onBack={onBack}
        backDisabled={busy || approving}
      />
      <div className="ui-case-workbench-main">
        <header className="ui-case-workbench-heading">
          <div>
            <div className="row wrap">
              <h1>{scope.title}</h1>
              <UiRequirementBasis scope={scope} cases={cases} />
            </div>
            <p className="caption">
              {scope.historical && `资料快照 v${scope.versionNo} · `}
              {sceneAssets.length} 个场景 · {cases.length} 条 UI 用例
              {readonly && ' · 只读'}
            </p>
          </div>
          <Button
            type="primary"
            icon={<CalendarOutlined />}
            aria-label="预览执行范围"
            disabled={
              !tester ||
              readonly ||
              earlier ||
              busy ||
              approving ||
              !cases.length
            }
            onClick={() => setScopePlan(true)}
          >
            预览执行范围
            {eligibleCount === undefined ? '' : ' · ' + eligibleCount}
          </Button>
        </header>
        {writable && !loading && available && (
          <div className="ui-case-batch-actions" aria-label="批量审批">
            <Checkbox
              checked={allSelected}
              indeterminate={selected.length > 0 && !allSelected}
              disabled={
                !eligibleForReview.length ||
                busy ||
                approving ||
                Boolean(recovery)
              }
              onChange={(event) =>
                setSelectedCases(
                  event.target.checked
                    ? eligibleForReview.map((asset) => asset.id)
                    : [],
                )
              }
            >
              全选本需求可审批用例
            </Checkbox>
            <span role="status" className="caption">
              已选 {selected.length} / 可审批 {eligibleForReview.length}
              {selectedOutsideFilter > 0 &&
                ' · ' + selectedOutsideFilter + ' 条在当前筛选外'}
            </span>
            {selected.length > 0 && (
              <details className="ui-case-selected-list">
                <summary>查看已选名单</summary>
                <ul>
                  {selected.map((asset) => (
                    <li key={asset.id}>{asset.title}</li>
                  ))}
                </ul>
              </details>
            )}
            <Button
              type="primary"
              size="small"
              loading={approving}
              disabled={!selected.length || busy || Boolean(recovery)}
              onClick={() => void approveCases(selected)}
            >
              批量审批（{selected.length}）
            </Button>
          </div>
        )}
        {stageError && (
          <Alert
            type="error"
            showIcon
            title={'审批资格读取失败。' + stageError}
          />
        )}
        {(approvalError || recovery) && (
          <Alert
            type={recovery ? 'warning' : 'error'}
            showIcon
            title={approvalError ?? '请核对原审批结果。'}
            action={
              recovery ? (
                <Button
                  size="small"
                  loading={approving}
                  onClick={() => void recoverApproval()}
                >
                  查询原结果
                </Button>
              ) : undefined
            }
          />
        )}
        {receipt && (
          <Alert
            type={
              approvedCount === receipt.results.length ? 'success' : 'warning'
            }
            showIcon
            closable
            onClose={() => setReceipt(undefined)}
            title={`已审批通过 ${approvedCount} 条${approvedCount !== receipt.results.length ? '，跳过 ' + (receipt.results.length - approvedCount) + ' 条' : ''}`}
            description={
              receipt.results.some((row) => row.status !== 'approved') ? (
                <ul className="ui-case-approval-skips">
                  {receipt.results
                    .filter((row) => row.status !== 'approved')
                    .map((row) => (
                      <li key={row.id}>
                        {cases.find((asset) => asset.id === row.id)?.title ??
                          '已退出当前列表的用例'}{' '}
                        ·{' '}
                        {row.status === 'conflict'
                          ? '用例内容或评审信息已更新。'
                          : row.status === 'skipped'
                            ? row.reasons.join(' ')
                            : ''}
                      </li>
                    ))}
                </ul>
              ) : undefined
            }
          />
        )}
        {(error || readError) && (
          <Alert type="error" showIcon title={error ?? readError} />
        )}
        {!loading && !available && (
          <Alert
            type="info"
            showIcon
            title="此需求不在当前浏览范围。"
            description="返回 UI 用例管理，确认当前项目和归档筛选。"
          />
        )}
        {loading && !cases.length ? (
          <Skeleton active />
        ) : (
          available && (
            <>
              <div className="ui-case-metrics">
                {(Object.entries(filters) as [Filter, string][]).map(
                  ([key, label]) => (
                    <button
                      type="button"
                      key={key}
                      aria-pressed={filter === key}
                      onClick={() => setFilter(key)}
                    >
                      <span className="ui-case-measure" data-stage={key}>
                        <i aria-hidden="true" />
                        {label}
                      </span>
                      <strong>
                        {key === 'all'
                          ? cases.length
                          : cases.filter((asset) => caseStage(asset) === key)
                              .length}
                      </strong>
                    </button>
                  ),
                )}
              </div>
              <div className="ui-case-workbench-grid">
                <aside
                  className="ui-case-workbench-column ui-case-directory"
                  aria-label="场景与用例"
                >
                  <header className="ui-case-column-head">
                    <h2>场景与用例</h2>
                    <span aria-live="polite" className="caption">
                      {displayedRows.length} / {cases.length} 条
                    </span>
                  </header>
                  <div className="ui-case-directory-search">
                    <Input
                      size="small"
                      allowClear
                      prefix={<SearchOutlined />}
                      aria-label="搜索用例目录"
                      placeholder="搜索场景、编号或标题"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                    <Button
                      size="small"
                      icon={<AimOutlined />}
                      title="定位当前用例"
                      aria-label="定位当前用例"
                      onClick={locate}
                    />
                  </div>
                  <div className="ui-case-pane-scroll ui-case-tree">
                    {[...visibleSceneIds].map((parentId) => {
                      const group = displayedRows.filter(
                        (asset) => asset.parentId === parentId,
                      );
                      return (
                        <details key={parentId ?? 'unknown'} open>
                          <summary>
                            <AppIcon name="folder-closed" />
                            {parentId ? (
                              <button
                                type="button"
                                className="ui-case-directory-scene"
                                aria-current={parentId === activeScene?.id}
                                disabled={busy}
                                onClick={(event) => {
                                  event.preventDefault();
                                  onScene(parentId);
                                }}
                              >
                                {scenarios.get(parentId) ?? '用例场景'}
                              </button>
                            ) : (
                              (scenarios.get(parentId ?? '') ?? '用例场景')
                            )}{' '}
                            <small>{group.length}</small>
                          </summary>
                          {group.map((asset) => (
                            <div
                              className="ui-case-directory-entry"
                              key={asset.id}
                            >
                              {eligibleIds.has(asset.id) && (
                                <Checkbox
                                  aria-label={'选择' + asset.title}
                                  checked={selectedSet.has(asset.id)}
                                  disabled={
                                    busy || approving || Boolean(recovery)
                                  }
                                  onChange={(event) =>
                                    setSelectedCases((previous) =>
                                      event.target.checked
                                        ? [...previous, asset.id]
                                        : previous.filter(
                                            (id) => id !== asset.id,
                                          ),
                                    )
                                  }
                                />
                              )}
                              <button
                                type="button"
                                className="ui-case-directory-case"
                                aria-current={asset.id === activeId}
                                disabled={busy || approving}
                                onClick={() => select(asset.id)}
                              >
                                <strong>{asset.title}</strong>
                                <span className="ui-case-directory-revision">
                                  r{asset.revisionNo}
                                </span>
                                <span
                                  className="ui-case-asset-code"
                                  title={asset.id}
                                >
                                  {asset.id}
                                </span>
                                <UiCaseStageBadge stage={caseStage(asset)} />
                              </button>
                            </div>
                          ))}
                          {!group.length && (
                            <p className="caption ui-case-library-no-rows">
                              该场景暂无用例。
                            </p>
                          )}
                        </details>
                      );
                    })}
                    {!visibleSceneIds.size && (
                      <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description="没有匹配用例。"
                      />
                    )}
                  </div>
                  <footer className="ui-case-column-foot">
                    <span>
                      {activeId && position < 0
                        ? '当前用例在筛选之外'
                        : '目录仅作用于当前工作台范围'}
                    </span>
                    {(search || filter !== 'all') && (
                      <Button
                        size="small"
                        type="text"
                        onClick={() => {
                          setFilter('all');
                          setSearch('');
                        }}
                      >
                        清除筛选
                      </Button>
                    )}
                  </footer>
                </aside>
                <section
                  className="ui-case-workbench-column ui-case-workbench-reader"
                  aria-label="用例内容"
                >
                  <header className="ui-case-column-head">
                    <h2>
                      用例内容
                      {position < 0
                        ? ''
                        : ' · ' + (position + 1) + ' / ' + displayedRows.length}
                    </h2>
                    <Space size={4}>
                      <Button
                        size="small"
                        disabled={busy || position <= 0}
                        onClick={() =>
                          previousCandidate && select(previousCandidate.id)
                        }
                      >
                        上一条
                      </Button>
                      <Button
                        size="small"
                        disabled={busy || position < 0 || !nextCandidate}
                        onClick={() =>
                          nextCandidate && select(nextCandidate.id)
                        }
                      >
                        下一条
                      </Button>
                    </Space>
                  </header>
                  <div
                    className="ui-case-pane-scroll ui-case-reader-content"
                    tabIndex={0}
                  >
                    {activeScene && 'objective' in activeScene.content ? (
                      <>
                        <h2 className="ui-case-reading-title">
                          {activeScene.title}
                        </h2>
                        <p className="caption">
                          {
                            cases.filter(
                              (item) => item.parentId === activeScene.id,
                            ).length
                          }{' '}
                          条用例
                        </p>
                        <h3>场景测试目标</h3>
                        <p className="preserve-lines">
                          {activeScene.content.objective}
                        </p>
                        {activeScene.content.sharedPreconditions.length > 0 && (
                          <section>
                            <h3>共享前置条件</h3>
                            <ul>
                              {activeScene.content.sharedPreconditions.map(
                                (condition, index) => (
                                  <li key={index}>{condition}</li>
                                ),
                              )}
                            </ul>
                          </section>
                        )}
                        {activeScene.content.basisRefs.length > 0 && (
                          <section>
                            <h3>资料依据</h3>
                            <ul>
                              {activeScene.content.basisRefs.map(
                                (basis, index) => (
                                  <li key={index}>
                                    {basis.description}
                                    {basis.locator && ' · ' + basis.locator}
                                  </li>
                                ),
                              )}
                            </ul>
                          </section>
                        )}
                      </>
                    ) : active ? (
                      <>
                        <div className="ui-case-reading-meta">
                          <span
                            className="ui-case-asset-code"
                            title={active.id}
                          >
                            {active.id}
                          </span>
                          <span>
                            {scenarios.get(active.parentId ?? '') ?? '用例场景'}
                          </span>
                          {earlier ? (
                            <Tag>历史修订</Tag>
                          ) : (
                            <UiCaseStageBadge
                              stage={caseStage(currentAsset ?? active)}
                            />
                          )}
                        </div>
                        <h2 className="ui-case-reading-title">
                          {displayTitle}
                        </h2>
                        {latestRevision && revisionId && revisions.length ? (
                          <UiCaseReader
                            key={active.id}
                            revisions={[...revisions].sort(
                              (a, b) => b.revisionNo - a.revisionNo,
                            )}
                            currentRevisionId={latestRevision}
                            revisionId={revisionId}
                            onRevision={(id) => {
                              if (!busy)
                                onRevision(
                                  id === latestRevision ? undefined : id,
                                );
                            }}
                            timeline={
                              <Space
                                direction="vertical"
                                className="ui-case-history"
                              >
                                {displayedReview && (
                                  <>
                                    <Typography.Text type="secondary">
                                      所属测试集 · {displayedReview.setTitle}
                                    </Typography.Text>
                                    {displayedReview.latestApproval && (
                                      <Typography.Text>
                                        最近审批通过 r
                                        {
                                          displayedReview.latestApproval
                                            .revisionNo
                                        }{' '}
                                        ·{' '}
                                        {formatBeijingTime(
                                          displayedReview.latestApproval
                                            .approvedAt,
                                          true,
                                        )}
                                      </Typography.Text>
                                    )}
                                  </>
                                )}
                                {origin && (
                                  <article>
                                    <strong>补充来源</strong>
                                    <p className="preserve-lines">
                                      {origin.note}
                                    </p>
                                    {sourceInScope && (
                                      <Button
                                        size="small"
                                        onClick={() => {
                                          onCase(origin.caseId);
                                          onRevision(origin.revisionId);
                                        }}
                                      >
                                        查看源用例修订
                                      </Button>
                                    )}
                                  </article>
                                )}
                                {originError?.assetId === active.id && (
                                  <Alert
                                    type="error"
                                    showIcon
                                    title={originError.message}
                                  />
                                )}
                                <AssetReviewPanel
                                  key={active.id + ':' + revisionId}
                                  projectId={scope.projectId}
                                  asset={currentAsset ?? active}
                                  revisionId={revisionId}
                                  tester={false}
                                  onChanged={onChanged}
                                />
                              </Space>
                            }
                          />
                        ) : readError ? null : (
                          <Skeleton active />
                        )}
                      </>
                    ) : (
                      <Empty
                        description={
                          requestedCase
                            ? '所选用例不在此范围。'
                            : '此需求版本暂无 UI 用例。'
                        }
                      />
                    )}
                  </div>
                </section>
                <aside
                  className="ui-case-workbench-column ui-case-workbench-review"
                  aria-label={activeScene ? '场景意见' : '用例评审'}
                >
                  <header className="ui-case-column-head">
                    <h2>{activeScene ? '场景意见' : '用例评审'}</h2>
                    {(readonly || earlier) && <Tag>只读</Tag>}
                  </header>
                  <div className="ui-case-pane-scroll ui-case-review-content">
                    {active && (
                      <div className="ui-case-review-summary">
                        <UiCaseStageBadge
                          stage={caseStage(currentAsset ?? active)}
                        />
                        <span className="caption">
                          r{openedRevision?.revisionNo ?? active.revisionNo}
                        </span>
                      </div>
                    )}
                    {activeScene ? (
                      <AssetReviewPanel
                        key={activeScene.id + ':' + activeScene.revisionId}
                        projectId={scope.projectId}
                        asset={activeScene}
                        revisionId={activeScene.revisionId}
                        tester={tester && !readonly}
                        onChanged={onChanged}
                      />
                    ) : earlier ? (
                      <Button size="small" onClick={() => onRevision()}>
                        切到当前修订
                      </Button>
                    ) : currentAsset && displayedReview ? (
                      <UiCaseReviewPane
                        key={draftKey(currentAsset)}
                        asset={currentAsset}
                        review={displayedReview}
                        draft={drafts[draftKey(currentAsset)] ?? ''}
                        writable={writable && !recovery}
                        approving={approving}
                        approvalReasons={statusOf(currentAsset)?.reasons}
                        onDraft={(value) =>
                          setDrafts((previous) => ({
                            ...previous,
                            [draftKey(currentAsset)]: value,
                          }))
                        }
                        onBusy={setBusy}
                        onApprove={() => void approveCases([currentAsset])}
                        onChanged={onChanged}
                      />
                    ) : active && !readError ? (
                      <Skeleton active paragraph={{ rows: 2 }} />
                    ) : null}
                  </div>
                </aside>
              </div>
            </>
          )
        )}
      </div>
      <Modal
        title="预览 UI 计划执行范围"
        open={scopePlan}
        onCancel={() => setScopePlan(false)}
        okText="带入计划"
        okButtonProps={{
          disabled: chosenApprovals.length === 0,
        }}
        onOk={() => {
          if (!chosenApprovals.length) return;
          window.location.hash = uiPlanHandoffHash(
            scope.projectId,
            planVersionId,
            chosenApprovals,
          );
        }}
      >
        {planError ? (
          <Alert type="error" showIcon title={planError} />
        ) : !planItems ? (
          <Skeleton active />
        ) : (
          <>
            {eligible.length ? (
              <Checkbox.Group
                className="ui-case-plan-list"
                aria-label="计划用例"
                value={choice}
                onChange={setChoice}
              >
                {eligible.map(({ asset }) => (
                  <Checkbox key={asset.id} value={asset.id}>
                    {asset.title} · r{asset.revisionNo}
                  </Checkbox>
                ))}
              </Checkbox.Group>
            ) : (
              <p>当前范围暂无可带入计划的批准修订。</p>
            )}
            {blocked && blocked.length > 0 && (
              <details open className="ui-case-diff">
                <summary>暂无计划资格 · {blocked.length} 条</summary>
                {blocked.map((asset) => (
                  <article key={asset.id}>
                    <b>
                      {asset.title} · r{asset.revisionNo}
                    </b>
                    <p className="caption">
                      {eligibility.get(asset.id)?.reasons.join('；') ||
                        (eligibility.get(asset.id)?.eligible
                          ? '计划资格中的批准修订与当前用例不一致，请刷新范围核对。'
                          : '本次未取得可纳入计划的依据。')}
                    </p>
                  </article>
                ))}
              </details>
            )}
          </>
        )}
      </Modal>
    </section>
  );
}
