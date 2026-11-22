import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Dropdown,
  Empty,
  Input,
  Modal,
  Skeleton,
  Space,
  Tag,
} from 'antd';
import {
  AimOutlined,
  CalendarOutlined,
  EllipsisOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { z } from 'zod';
import {
  assetDetailSchema,
  caseSupplementOriginResultSchema,
  type Asset,
} from '../../../packages/contracts/src/assets';
import {
  uiCaseReviewStageListSchema,
  uiReviewMeetingDetailSchema,
  uiReviewMeetingListSchema,
} from '../../../packages/contracts/src/ui-reviews';
import { uiPlanEligibilitySchema } from '../../../packages/contracts/src/plans';
import { api, describeError } from './api';
import { formatBeijingTime } from './beijing-time';
import { StandaloneWorkbenchHeader } from './standalone-workbench-header';
import { AppIcon } from './app-icon';
import { UiCaseReader } from './ui-case-reader';
import { UiReviewWorkspace, assessmentLabels } from './ui-review-workspace';
import type { CaseScope } from './requirements';
import './ui-case-workbench.css';

type Meeting = z.infer<typeof uiReviewMeetingDetailSchema>;
type Detail = z.infer<typeof assetDetailSchema>;
type PlanEligibility = z.infer<typeof uiPlanEligibilitySchema>['items'][number];
type SavedOrigin = z.infer<typeof caseSupplementOriginResultSchema>['origin'];
type CaseStage = z.infer<typeof uiCaseReviewStageListSchema>['items'][number];
type Filter = 'all' | CaseStage['stage'];
const filters: Record<Filter, string> = {
  all: '全部用例',
  pending: '待评审',
  needsOptimization: '待 AI 修改',
  waitingHuman: '待人工复审',
  approved: '已批准',
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
  const projectId = scope?.projectId;
  const versionId = scope?.requirementVersionId;
  useEffect(() => {
    if (
      !enabled ||
      !projectId ||
      !versionId ||
      !assets.some((asset) => asset.targetType === 'case')
    )
      return;
    const controller = new AbortController();
    const query = new URLSearchParams({ requirementVersionId: versionId });
    void api(
      '/projects/' + projectId + '/assets/ui-case-review-stages?' + query,
      { signal: controller.signal },
      uiCaseReviewStageListSchema,
    )
      .then(({ items }) => {
        if (!controller.signal.aborted) setStages(items);
      })
      .catch(() => {
        if (!controller.signal.aborted) setStages([]);
      });
    return () => controller.abort();
  }, [projectId, versionId, enabled, assets]);
  const stageByCase = useMemo(
    () => new Map(stages.map((item) => [item.caseId, item])),
    [stages],
  );
  return (asset: Asset): CaseStage['stage'] => {
    const authoritative = enabled ? stageByCase.get(asset.id) : undefined;
    return authoritative?.revisionId === asset.revisionId
      ? authoritative.stage
      : uiStageForReviewState(asset.reviewState);
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

export function UiReviewHistory({
  projectId,
  requirementVersionId,
  title,
  open,
  onClose,
  onSelect,
}: {
  projectId: string;
  requirementVersionId: string;
  title: string;
  open: boolean;
  onClose: () => void;
  onSelect: (meetingId: string) => void;
}) {
  const [rows, setRows] =
    useState<z.infer<typeof uiReviewMeetingListSchema>['meetings']>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setRows(undefined);
    setError(undefined);
    void api(
      `/projects/${projectId}/assets/ui-review-meetings?archived=true&requirementVersionId=${requirementVersionId}`,
      { signal: controller.signal },
      uiReviewMeetingListSchema,
    )
      .then(({ meetings }) => {
        if (!controller.signal.aborted) setRows(meetings);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(describeError(failure));
      });
    return () => controller.abort();
  }, [projectId, requirementVersionId, open]);
  return (
    <Modal
      title="评审历史"
      open={open}
      onCancel={onClose}
      footer={<Button onClick={onClose}>关闭</Button>}
    >
      <p className="caption">{title}</p>
      {error ? (
        <Alert type="error" showIcon title={error} />
      ) : !rows ? (
        <Skeleton active />
      ) : rows.length ? (
        <div className="ui-case-history-list">
          {rows.map((meeting) => (
            <article key={meeting.id}>
              <div>
                <strong>评审会议 {meeting.id.slice(0, 8)}</strong>
                <p className="caption">
                  {meeting.finalized ? '意见已定稿' : '记录中'} ·{' '}
                  {meeting.caseCount} 条用例 ·{' '}
                  {formatBeijingTime(meeting.createdAt, true)}
                </p>
              </div>
              <Button size="small" onClick={() => onSelect(meeting.id)}>
                查看快照
              </Button>
            </article>
          ))}
        </div>
      ) : (
        <Empty description="当前需求版本暂无已定稿评审会话。" />
      )}
    </Modal>
  );
}

export function UiCaseWorkbench({
  scope,
  projectName,
  userId,
  assets,
  requestedCase,
  requestedRevision,
  meetingId,
  archived,
  available,
  loading,
  error,
  tester,
  onBack,
  onCase,
  onRevision,
  onApprove,
  onEdit,
  onDetails,
  onOpenTeam,
  onSupplement,
  onChanged,
  inlineDrafts,
}: {
  scope: CaseScope;
  projectName: string;
  userId: string;
  assets: Asset[];
  requestedCase: string | undefined;
  requestedRevision: string | undefined;
  meetingId: string | undefined;
  archived: boolean;
  available: boolean;
  loading: boolean;
  error: string | undefined;
  tester: boolean;
  onBack: () => void;
  onCase: (caseId: string) => void;
  onRevision: (revisionId?: string) => void;
  onApprove: (ids: string[]) => Promise<void>;
  onEdit: (asset: Asset) => void;
  onDetails: (asset: Asset) => void;
  onOpenTeam: (meetingId: string) => void;
  onSupplement: (
    asset: Asset,
    origin?: { meetingId: string; opinionId: string; round: number },
  ) => void;
  onChanged: () => Promise<void>;
  inlineDrafts: Map<string, string>;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [snapshot, setSnapshot] = useState<Meeting>();
  const [detail, setDetail] = useState<Detail>();
  const [liveReview, setLiveReview] = useState<Meeting>();
  const [originRecord, setOriginRecord] = useState<{
    assetId: string;
    origin: SavedOrigin;
  }>();
  const [originError, setOriginError] = useState<{
    assetId: string;
    message: string;
  }>();
  const [comparison, setComparison] = useState<{
    assetId: string;
    from: string;
    to: string;
    key: string;
  }>();
  const [readError, setReadError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [reviewActions, setReviewActions] = useState<HTMLElement | null>(null);
  const [scopePlan, setScopePlan] = useState(false);
  const [planItems, setPlanItems] = useState<PlanEligibility[]>();
  const [planError, setPlanError] = useState<string>();
  const [choice, setChoice] = useState<string[]>([]);
  const readonly = Boolean(meetingId) || archived;
  const currentCases = useMemo(
    () =>
      assets.filter(
        (asset) =>
          asset.kind === 'UI' &&
          asset.requirementVersionId === scope.requirementVersionId &&
          asset.targetType === 'case' &&
          !asset.removedAt,
      ),
    [assets, scope.requirementVersionId],
  );
  const scenarios = useMemo(
    () =>
      new Map(
        assets
          .filter((asset) => asset.targetType === 'scenario')
          .map((asset) => [asset.id, asset.title]),
      ),
    [assets],
  );
  const cases = meetingId ? (snapshot?.cases ?? []) : currentCases;
  const caseStage = useUiCaseStages(
    scope,
    currentCases,
    !meetingId && available,
  );
  const active = requestedCase
    ? cases.find((asset) => asset.id === requestedCase)
    : cases[0];
  const activeId = active?.id;
  const activeRevision = active?.revisionId;
  const displayedRows = cases.filter(
    (asset) =>
      (filter === 'all' || caseStage(asset) === filter) &&
      [asset.title, asset.id, scenarios.get(asset.parentId ?? '') ?? ''].some(
        (value) =>
          value.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
      ),
  );
  const position = displayedRows.findIndex((asset) => asset.id === activeId);
  useEffect(() => {
    setFilter('all');
    setSearch('');
  }, [meetingId]);
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
    if (!meetingId || !available) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ archived: 'true' });
    if (requestedCase) params.set('caseId', requestedCase);
    setReadError(undefined);
    setSnapshot((current) =>
      current?.meeting.id === meetingId
        ? { ...current, revisions: [] }
        : undefined,
    );
    void api(
      `/projects/${scope.projectId}/assets/ui-review-meetings/${meetingId}?${params}`,
      { signal: controller.signal },
      uiReviewMeetingDetailSchema,
    )
      .then((response) => {
        if (controller.signal.aborted) return;
        if (
          response.meeting.requirementVersionId !== scope.requirementVersionId
        ) {
          setReadError('评审会话不属于当前需求版本。');
          return;
        }
        setSnapshot(response);
        if (!requestedCase && response.cases[0]) onCase(response.cases[0].id);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setReadError(describeError(failure));
      });
    return () => controller.abort();
  }, [
    meetingId,
    available,
    requestedCase,
    scope.projectId,
    scope.requirementVersionId,
  ]);
  useEffect(() => {
    if (meetingId || !activeId || !activeRevision || !available) return;
    const controller = new AbortController();
    setReadError(undefined);
    setDetail(undefined);
    void api(
      `/projects/${scope.projectId}/assets/${activeId}`,
      { signal: controller.signal },
      assetDetailSchema,
    )
      .then((response) => {
        if (controller.signal.aborted) return;
        if (
          response.asset.requirementVersionId !== scope.requirementVersionId ||
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
    meetingId,
    activeId,
    activeRevision,
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
          currentCases
            .filter((asset) =>
              items.some((item) => item.caseId === asset.id && item.eligible),
            )
            .map((asset) => asset.id),
        );
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setPlanError(describeError(failure));
      });
    return () => controller.abort();
  }, [scopePlan, scope.projectId, currentCases]);

  const focusedDetail = detail?.asset.id === activeId ? detail : undefined;
  const revisions =
    (meetingId ? snapshot?.revisions : focusedDetail?.revisions) ?? [];
  const latestRevision = meetingId
    ? activeRevision
    : focusedDetail?.asset.revisionId;
  const revisionId = requestedRevision ?? latestRevision;
  const earlier = Boolean(
    latestRevision && revisionId && latestRevision !== revisionId,
  );
  const writable = tester && !readonly && !earlier && !active?.removedAt;
  const eligibility = new Map(planItems?.map((item) => [item.caseId, item]));
  const eligible = currentCases.filter(
    (asset) => eligibility.get(asset.id)?.eligible,
  );
  const blocked =
    planItems &&
    currentCases.filter((asset) => !eligibility.get(asset.id)?.eligible);
  const review = meetingId ? snapshot : liveReview;
  const texts = review?.state.items.filter(
    (item) => item.basis.caseId === activeId,
  );
  const opinions = review?.state.opinions.filter(
    (opinion) => activeId && opinion.caseIds.includes(activeId),
  );
  const assessments = review?.state.assessments?.filter(
    (item) => item.caseId === activeId,
  );
  const caseRound = review?.cases.some((row) => row.id === activeId)
    ? Math.max(
        1,
        ...(texts ?? []).map((item) => item.round),
        ...(assessments ?? []).map((item) => item.round),
      )
    : null;
  const [eligibleCount, setEligibleCount] = useState<number>();
  useEffect(() => {
    if (readonly || !available || !tester || !currentCases.length) {
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
            currentCases.filter((row) =>
              items.some((item) => item.caseId === row.id && item.eligible),
            ).length,
          );
      })
      .catch(() => {
        if (!controller.signal.aborted) setEligibleCount(undefined);
      });
    return () => controller.abort();
  }, [readonly, available, tester, currentCases, scope.projectId]);
  const origin =
    originRecord?.assetId === activeId ? originRecord?.origin : undefined;
  const sourceInScope =
    origin && cases.some((asset) => asset.id === origin.caseId);
  const openedRevision = revisions.find((entry) => entry.id === revisionId);
  const displayTitle = openedRevision?.content.title ?? active?.title;
  const nextCandidate = displayedRows[position + 1];
  const previousCandidate = displayedRows[position - 1];

  function select(id: string) {
    if (!busy) onCase(id);
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
        backDisabled={busy}
      />
      <div className="ui-case-workbench-main">
        <header className="ui-case-workbench-heading">
          <div>
            <h1>{scope.title}</h1>
            <p className="caption">
              需求版本 v{scope.versionNo} ·{' '}
              {new Set(cases.map((asset) => asset.parentId)).size} 个场景 ·{' '}
              {cases.length} 条 UI 用例
              {meetingId && ' · 评审会话快照'}
              {readonly && ' · 只读'}
            </p>
          </div>
          <Button
            type="primary"
            icon={<CalendarOutlined />}
            aria-label="预览执行范围"
            disabled={!tester || readonly || earlier || busy || !cases.length}
            onClick={() => setScopePlan(true)}
          >
            预览执行范围
            {eligibleCount === undefined ? '' : ' · ' + eligibleCount}
          </Button>
        </header>
        {(error || readError) && (
          <Alert type="error" showIcon title={error ?? readError} />
        )}
        {!loading && !available && (
          <Alert
            type="info"
            showIcon
            title="此需求版本不在当前浏览范围。"
            description="返回 UI 用例管理，确认当前项目、版本和归档筛选。"
          />
        )}
        {loading || (meetingId && available && !snapshot && !readError) ? (
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
                    {[
                      ...new Set(displayedRows.map((asset) => asset.parentId)),
                    ].map((parentId) => {
                      const group = displayedRows.filter(
                        (asset) => asset.parentId === parentId,
                      );
                      return (
                        <details key={parentId ?? 'unknown'} open>
                          <summary>
                            <AppIcon name="folder-closed" />
                            {scenarios.get(parentId ?? '') ?? '用例场景'}{' '}
                            <small>{group.length}</small>
                          </summary>
                          {group.map((asset) => (
                            <button
                              key={asset.id}
                              type="button"
                              className="ui-case-directory-case"
                              aria-current={asset.id === activeId}
                              disabled={busy}
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
                          ))}
                        </details>
                      );
                    })}
                    {!displayedRows.length && (
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
                    {active ? (
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
                            <UiCaseStageBadge stage={caseStage(active)} />
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
                            frozen={Boolean(meetingId)}
                            comparison={
                              comparison?.assetId === active.id
                                ? comparison
                                : undefined
                            }
                            timeline={
                              origin ||
                              originError?.assetId === active.id ||
                              texts?.length ||
                              opinions?.length ||
                              assessments?.length ? (
                                <Space direction="vertical">
                                  {origin && (
                                    <article className="ui-review-opinion">
                                      <h3>补充来源</h3>
                                      <p className="caption">
                                        {origin.caseId} · 修订{' '}
                                        {origin.revisionId}
                                        {origin.round &&
                                          ' · 第 ' + origin.round + ' 轮'}
                                      </p>
                                      <p className="preserve-lines">
                                        {origin.note}
                                      </p>
                                      {sourceInScope && !meetingId && (
                                        <Button
                                          size="small"
                                          disabled={busy}
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
                                  {opinions?.map((opinion) => (
                                    <p
                                      className="preserve-lines"
                                      key={opinion.id}
                                    >
                                      {opinion.body}
                                    </p>
                                  ))}
                                  {texts?.map((item) => (
                                    <article
                                      key={item.opinionId + ':' + item.round}
                                    >
                                      <b>
                                        第 {item.round} 轮 · r
                                        {item.basis.revisionNo}
                                      </b>
                                      {item.reply && (
                                        <p className="preserve-lines">
                                          {item.reply.body}
                                        </p>
                                      )}
                                      {item.instruction && (
                                        <p className="preserve-lines">
                                          {item.instruction}
                                        </p>
                                      )}
                                    </article>
                                  ))}
                                  {assessments?.map((entry) => (
                                    <article
                                      key={entry.caseId + ':' + entry.time}
                                    >
                                      <b>
                                        第 {entry.round} 轮 ·{' '}
                                        {assessmentLabels[entry.outcome]}
                                      </b>
                                      <p className="preserve-lines">
                                        {entry.note}
                                      </p>
                                      {entry.instruction && (
                                        <p className="preserve-lines">
                                          {entry.instruction}
                                        </p>
                                      )}
                                    </article>
                                  ))}
                                </Space>
                              ) : undefined
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
                  aria-label="评审与复审"
                >
                  <header className="ui-case-column-head">
                    <h2>评审与复审</h2>
                    {(readonly || earlier || caseRound) && (
                      <span className="ui-case-round">
                        {readonly || earlier
                          ? '只读'
                          : '第 ' + caseRound + ' 轮'}
                      </span>
                    )}
                  </header>
                  <div className="ui-case-pane-scroll ui-case-review-content">
                    {active && (
                      <div className="ui-case-review-summary">
                        {earlier ? (
                          <Tag>历史修订</Tag>
                        ) : (
                          <UiCaseStageBadge stage={caseStage(active)} />
                        )}
                        <span className="ui-case-asset-code" title={active.id}>
                          {active.id} · r
                          {openedRevision?.revisionNo ?? active.revisionNo}
                        </span>
                      </div>
                    )}
                    {readonly || earlier ? (
                      <Alert
                        type="info"
                        showIcon
                        title={
                          earlier ? '当前阅读的是历史修订。' : '当前范围只读。'
                        }
                      />
                    ) : (
                      active &&
                      focusedDetail?.asset.revisionId === active.revisionId && (
                        <>
                          <Space wrap size={6}>
                            {writable && (
                              <Button
                                size="small"
                                icon={<AppIcon name="spark" />}
                                disabled={busy}
                                onClick={() => onSupplement(active)}
                              >
                                请 AI 补充用例
                              </Button>
                            )}
                            <Dropdown
                              trigger={['click']}
                              menu={{
                                items: [
                                  ...(writable
                                    ? [{ key: 'edit', label: '编辑当前内容' }]
                                    : []),
                                  { key: 'details', label: '查看资产详情' },
                                ],
                                onClick: ({ key }) =>
                                  key === 'edit'
                                    ? onEdit(active)
                                    : onDetails(active),
                              }}
                            >
                              <Button
                                size="small"
                                icon={<EllipsisOutlined />}
                                aria-label="更多资产操作"
                                disabled={busy}
                              />
                            </Dropdown>
                          </Space>
                          {caseStage(active) === 'approved' && (
                            <article className="ui-case-approved-note">
                              <strong>当前修订已批准</strong>
                              <p>
                                批准修订 r{active.revisionNo}
                                。通过执行范围预览核对本轮可带入的用例。
                              </p>
                            </article>
                          )}
                          <UiReviewWorkspace
                            key={active.id}
                            projectId={scope.projectId}
                            userId={userId}
                            requirementVersionId={scope.requirementVersionId}
                            requirementTitle={scope.title}
                            versionNo={scope.versionNo}
                            assets={currentCases}
                            scenarioTitles={scenarios}
                            initialCases={[active.id]}
                            inlineCaseId={active.id}
                            inlineActions={reviewActions}
                            onOpenTeam={onOpenTeam}
                            inlineDrafts={inlineDrafts}
                            onRead={setLiveReview}
                            onCompare={(from, to) =>
                              setComparison({
                                assetId: active.id,
                                from,
                                to,
                                key: crypto.randomUUID(),
                              })
                            }
                            tester={writable}
                            onApprove={onApprove}
                            updated={onChanged}
                            onBusyChange={setBusy}
                            onSupplement={(origin) =>
                              onSupplement(active, origin)
                            }
                          />
                        </>
                      )
                    )}
                  </div>
                  <footer
                    ref={setReviewActions}
                    className="ui-case-column-foot ui-case-review-actions"
                  >
                    {writable && active && caseStage(active) === 'approved' && (
                      <Button
                        size="small"
                        type="primary"
                        aria-label="从当前用例预览执行范围"
                        onClick={() => setScopePlan(true)}
                      >
                        预览执行范围
                      </Button>
                    )}
                  </footer>
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
          disabled: !choice.some((id) =>
            eligible.some((asset) => asset.id === id),
          ),
        }}
        onOk={() => {
          const query = new URLSearchParams({
            projectId: scope.projectId,
            kind: 'UI',
            versionId: scope.requirementVersionId,
          });
          for (const id of choice)
            if (eligible.some((asset) => asset.id === id))
              query.append('caseId', id);
          window.location.hash = 'plans?' + query.toString();
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
                className="ui-review-start-list"
                aria-label="计划用例"
                value={choice}
                onChange={setChoice}
              >
                {eligible.map((asset) => (
                  <Checkbox key={asset.id} value={asset.id}>
                    {asset.title} · r{asset.revisionNo}
                  </Checkbox>
                ))}
              </Checkbox.Group>
            ) : (
              <p>当前范围暂无可带入计划的批准修订。</p>
            )}
            {blocked && blocked.length > 0 && (
              <details open className="ui-review-diff">
                <summary>暂无计划资格 · {blocked.length} 条</summary>
                {blocked.map((asset) => (
                  <article key={asset.id}>
                    <b>
                      {asset.title} · r{asset.revisionNo}
                    </b>
                    <p className="caption">
                      {eligibility.get(asset.id)?.reasons.join('；') ||
                        '本次未取得可纳入计划的依据。'}
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
