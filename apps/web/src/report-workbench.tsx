import { useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CheckOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Collapse,
  Descriptions,
  Empty,
  Pagination,
  Select,
  Space,
  Typography,
} from 'antd';
import type { z } from 'zod';
import type { reportDetailSchema } from '../../../packages/contracts/src/ui-results';
import type { ReportHandling } from '../../../packages/contracts/src/report-handling';
import type { ReportProblemReviewScope } from '../../../packages/contracts/src/issues';
import { EvidenceGallery } from './evidence-gallery';
import type { EvidenceGalleryItem } from './evidence-gallery';
import { ReportResultReview } from './report-result-review';
import type { ReviewPendingFile } from './review-image-attachments';
import { ResultDetailPanel } from './result-detail';
import { outcomeLabels, ResultOutcomeTag } from './result-steps';
import {
  ReportReviewPanel,
  ReportReviewBatch,
  ReportBatchRecovery,
  isBatchReviewable,
  reportProblemLabel,
} from './report-review';
import type { Project } from './types';
import { BulkActionBar } from './bulk-action-bar';
import { BeijingTime } from './beijing-time';
import { DeliveryStatusTag } from './semantic-status';
import { ResultFilters, ResultPagination } from './result-list';

type Report = z.infer<typeof reportDetailSchema>['report'];
type Facts = Report['facts'];
type Item = Facts['items'][number];
type Candidate = ReportHandling['problems'][number];
type Filter = 'all' | keyof Facts['statistics']['reported'];
type ReviewFilter = 'all' | 'pending' | 'retest' | 'confirmed' | 'dismissed';
type ReportSelection = {
  id: string;
  revisionId?: string;
  initialStep?: number;
  returnTo?: string;
};
type SelectedReview = {
  candidate: Candidate;
  scope: ReportProblemReviewScope;
  title: string;
  evidence: string;
};

const pageSize = 20;
const statusKeys = [
  'passed',
  'failed',
  'inconclusive',
  'blocked',
  'notExecuted',
  'notReported',
] as const;
const reviewFilters: { value: ReviewFilter; label: string }[] = [
  { value: 'all', label: '全部处理状态' },
  { value: 'pending', label: '待复核' },
  { value: 'retest', label: '待复测 / 已登记复测' },
  { value: 'confirmed', label: '已确认' },
  { value: 'dismissed', label: '已排除' },
];
const sourceLabels = {
  plan: '测试计划',
  retestPreparation: '正式缺陷复测',
  debug: '调试',
  uiArchive: '本地独立归档',
} as const;
const provenanceLabels = {
  'local-ai': '本地 AI 执行',
  'protocol-synthetic': '合成协议执行',
  unknown: '执行来源未确认',
  'platform-api': '平台接口 Worker',
} as const;
const resultStatus = (item: Item) =>
  item.result?.reportedOutcome ?? 'notReported';
function scenarioKey(item: Item) {
  const scope = item.scopeItem;
  return 'scenarioId' in scope
    ? (scope.scenarioId ?? 'independent-api-cases')
    : JSON.stringify([
        scope.requirementId,
        scope.requirementVersionId,
        scope.scenario.title,
      ]);
}
function itemNumber(item: Item) {
  return `#${item.scopeItem.ordinal + 1}`;
}
function caseReference(item: Item) {
  const scope = item.scopeItem;
  return 'localItemId' in scope ? scope.localItemId : scope.caseId;
}
function observed(item: Item) {
  return (
    !!item.result &&
    item.result.reportedOutcome !== 'notExecuted' &&
    (item.result.content.actualObservations.trim().length > 0 ||
      (item.result.content.stepObservations?.length ?? 0) > 0 ||
      (item.result.content.observations?.length ?? 0) > 0 ||
      (item.result.content.actualActions?.length ?? 0) > 0 ||
      item.result.content.evidenceRefs.length > 0)
  );
}
function matchesReview(problems: Candidate[], filter: ReviewFilter) {
  if (filter === 'all') return true;
  return problems.some((problem) => {
    if (filter === 'pending')
      return (
        problem.state === 'pendingConfirmation' && !problem.latestReviewRetest
      );
    if (filter === 'retest')
      return (
        problem.state === 'pendingConfirmation' && !!problem.latestReviewRetest
      );
    return problem.state === filter;
  });
}
function reportScope(
  reportId: string,
  reportRevisionId: string,
  item: Item,
): ReportProblemReviewScope | null {
  return item.result
    ? {
        reportId,
        reportRevisionId,
        resultId: item.result.id,
        resultRevisionId: item.result.revisionId,
      }
    : null;
}
function reviewStep(item: Item, requested?: number) {
  const content = item.scopeItem.content;
  if (content.kind !== 'UI' || !item.result) return undefined;
  const observations = item.result.content.stepObservations ?? [];
  const failedAssertion = item.result.content.assertionResults?.find(
    (entry) => entry.outcome === 'failed',
  );
  const failedStep =
    failedAssertion &&
    item.result.content.observations?.find(
      (entry) =>
        entry.assertionIds?.includes(failedAssertion.assertionId) &&
        entry.stepOrdinals?.length,
    )?.stepOrdinals?.[0];
  const ordinal =
    requested ??
    observations.find((step) => step.outcome === 'failed')?.ordinal ??
    failedStep;
  if (!ordinal || ordinal > 100) return undefined;
  return observations.some((step) => step.ordinal === ordinal) ||
    ('steps' in content && !!content.steps?.[ordinal - 1])
    ? ordinal
    : undefined;
}
function displayCoverage(rows: Item[]) {
  const covered = rows.filter(observed).length;
  return `${covered}/${rows.length} 已执行`;
}

function reportEvidenceCoverage(facts: Facts) {
  const missing = new Set(facts.missingFileIds);
  const files = new Map(
    facts.evidence.map((item) => [item.localEvidenceId, item]),
  );
  const available = (refs: readonly string[]) =>
    refs.some((ref) => {
      const file = files.get(ref);
      return (
        file?.lastKnownFileStatus === 'verified' &&
        file.fileAvailable !== false &&
        !missing.has(file.fileId)
      );
    });
  let steps = 0,
    observedSteps = 0,
    evidencedSteps = 0;
  let assertions = 0,
    observedAssertions = 0,
    evidencedAssertions = 0;
  let refs = 0,
    gaps = 0;
  const distinct = new Set<string>();
  for (const row of facts.items) {
    const {
      scopeItem: { content },
      result,
    } = row;
    const stepsForItem =
      content.kind === 'UI' && 'steps' in content ? (content.steps ?? []) : [];
    const assertionsForItem =
      'assertions' in content ? (content.assertions ?? []) : [];
    const observations = result?.content.observations ?? [];
    const legacy = result?.content.stepObservations ?? [];
    steps += stepsForItem.length;
    assertions += assertionsForItem.length;
    for (const [index] of stepsForItem.entries()) {
      const ordinal = index + 1;
      const records = [
        ...legacy.filter((entry) => entry.ordinal === ordinal),
        ...observations.filter((entry) =>
          entry.stepOrdinals?.includes(ordinal),
        ),
      ];
      if (records.length) observedSteps++;
      if (records.some((entry) => available(entry.evidenceRefs ?? [])))
        evidencedSteps++;
    }
    for (const { id } of assertionsForItem) {
      const records = observations.filter((entry) =>
        entry.assertionIds?.includes(id),
      );
      if (records.length) observedAssertions++;
      if (records.some((entry) => available(entry.evidenceRefs ?? [])))
        evidencedAssertions++;
    }
    for (const ref of result?.content.evidenceRefs ?? []) {
      refs++;
      const file = files.get(ref);
      if (file) distinct.add(file.fileId);
    }
    gaps += result?.content.evidenceGaps?.length ?? 0;
  }
  return {
    steps,
    observedSteps,
    evidencedSteps,
    assertions,
    observedAssertions,
    evidencedAssertions,
    refs,
    gaps,
    distinct: distinct.size,
  };
}

export function ReportWorkbench({
  project,
  userId,
  report,
  facts,
  toolbar,
  archived,
  handling,
  selection,
  viewedRevisionId,
  onChanged,
  onPreview,
}: {
  project: Project;
  userId: string;
  report: Report;
  facts: Facts;
  toolbar: ReactNode;
  archived: boolean;
  handling: ReportHandling | null;
  selection: ReportSelection | null;
  viewedRevisionId: string;
  onChanged: () => Promise<void>;
  onPreview: (item: EvidenceGalleryItem) => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('all');
  const [scenario, setScenario] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [unreportedItemId, setUnreportedItemId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [batch, setBatch] = useState<{
    items: SelectedReview[];
    id: string;
  } | null>(null);
  const [receivedIssue, setReceivedIssue] = useState<{
    id: string;
    number: string;
  }>();
  const reviewPendingFiles = useRef(new Map<string, ReviewPendingFile[]>());
  const byResult = useMemo(() => {
    const map = new Map<string, Candidate[]>();
    for (const problem of handling?.problems ?? [])
      for (const resultId of problem.resultIds) {
        const existing = map.get(resultId) ?? [];
        existing.push(problem);
        map.set(resultId, existing);
      }
    return map;
  }, [handling]);
  const groups = useMemo(() => {
    const map = new Map<string, { label: string; rows: Item[] }>();
    for (const item of facts.items) {
      const key = scenarioKey(item);
      const group = map.get(key) ?? {
        label: item.scopeItem.scenario?.title ?? '独立单接口用例',
        rows: [],
      };
      group.rows.push(item);
      map.set(key, group);
    }
    return map;
  }, [facts.items]);
  const canReview = !archived && report.canReview === true;
  const needle = search.trim().toLocaleLowerCase();
  const matched = facts.items.filter(
    (item) =>
      (!scenario || scenarioKey(item) === scenario) &&
      (filter === 'all' || resultStatus(item) === filter) &&
      matchesReview(
        item.result ? (byResult.get(item.result.id) ?? []) : [],
        reviewFilter,
      ) &&
      (!needle ||
        [
          item.scopeItem.content.title,
          item.scopeItem.scenario?.title,
          itemNumber(item),
          caseReference(item),
          item.result?.id,
          'dataRow' in item.scopeItem
            ? item.scopeItem.dataRow?.name
            : undefined,
        ].some((part) => part?.toLocaleLowerCase().includes(needle))),
  );
  const currentPage = Math.min(
    page,
    Math.max(1, Math.ceil(matched.length / pageSize)),
  );
  const pageItems = matched.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );
  const linked = selection
    ? facts.items.find((item) => item.result?.id === selection.id)
    : undefined;
  const focused =
    linked ??
    pageItems.find((item) => item.scopeItem.runItemId === unreportedItemId) ??
    pageItems[0];
  const focusedRevision = linked ? selection?.revisionId : undefined;
  const previousRevision =
    focusedRevision && focused?.result?.revisionId !== focusedRevision;
  const detached = selection && !linked;
  const writableDetail = canReview && !previousRevision && !detached;
  const eligible = new Map<string, SelectedReview>();
  function candidateRows(item: Item) {
    if (!writableDetail || resultStatus(item) !== 'failed' || !item.result)
      return [];
    return (byResult.get(item.result.id) ?? []).filter((candidate) => {
      if (!isBatchReviewable(candidate)) return false;
      const origin =
        candidate.resultSources?.find(
          (source) => source.resultId === item.result?.id,
        )?.sourceRevisionId ??
        (candidate.sourceResultId === item.result?.id
          ? candidate.sourceResultRevisionId
          : null);
      return !origin || origin === item.result?.revisionId;
    });
  }
  for (const item of pageItems) {
    const scope = reportScope(report.id, report.revisionId, item);
    if (!scope) continue;
    for (const candidate of candidateRows(item))
      if (!eligible.has(candidate.id))
        eligible.set(candidate.id, {
          candidate,
          scope,
          title: item.scopeItem.content.title,
          evidence:
            item.result?.content.actualObservations.slice(0, 170) ||
            '本次未登记实际观察摘要',
        });
  }
  const selectedRows = [...selected].flatMap((id) => {
    const row = eligible.get(id);
    return row ? [row] : [];
  });

  function resetSelection() {
    setSelected(new Set());
    setBatch(null);
    setPage(1);
    clearFocusedResult();
  }
  function clearFocusedResult() {
    setUnreportedItemId(null);
    if (selection)
      setHash((query) => {
        for (const key of [
          'resultId',
          'resultRevisionId',
          'step',
          'returnTo',
          'fromIssueId',
        ])
          query.delete(key);
      });
  }
  function setHash(update: (query: URLSearchParams) => void) {
    const query = new URLSearchParams(window.location.hash.split('?')[1]);
    update(query);
    window.location.hash = `reports?${query}`;
  }
  function focus(item: Item) {
    setUnreportedItemId(item.result ? null : item.scopeItem.runItemId);
    setHash((query) => {
      for (const key of [
        'resultId',
        'resultRevisionId',
        'step',
        'returnTo',
        'fromIssueId',
      ])
        query.delete(key);
      if (item.result) query.set('resultId', item.result.id);
    });
  }
  function toggle(ids: string[], checked: boolean) {
    setBatch(null);
    setSelected((previous) => {
      const next = new Set(previous);
      for (const id of ids) {
        if (checked && next.size < 100) next.add(id);
        else if (!checked) next.delete(id);
      }
      return next;
    });
  }
  function issueLink(id: string) {
    return `#issues?${new URLSearchParams({ projectId: project.id, issueId: id })}`;
  }
  function chooseResultRevision(resultId: string, revisionId: string | null) {
    setHash((query) => {
      query.set('resultId', resultId);
      if (revisionId) query.set('resultRevisionId', revisionId);
      else query.delete('resultRevisionId');
    });
  }
  function renderRow(item: Item) {
    const candidates = item.result ? (byResult.get(item.result.id) ?? []) : [];
    const ids = candidateRows(item).map((candidate) => candidate.id);
    const count = ids.filter((id) => selected.has(id)).length;
    const active = focused?.scopeItem.runItemId === item.scopeItem.runItemId;
    return (
      <div
        key={item.scopeItem.runItemId}
        className={`report-item ${active ? 'report-item-selected' : ''}`}
      >
        {ids.length > 0 && (
          <Checkbox
            aria-label={`选择 ${item.scopeItem.content.title}`}
            checked={count === ids.length}
            indeterminate={count > 0 && count < ids.length}
            disabled={!count && selectedRows.length >= 100}
            onChange={(event) => toggle(ids, event.target.checked)}
          />
        )}
        <button
          className="report-item-select"
          type="button"
          aria-current={active ? 'true' : undefined}
          onClick={() => focus(item)}
        >
          <strong>{item.scopeItem.content.title}</strong>
          <span>
            {itemNumber(item)}
            {candidates.length > 0
              ? ` · ${candidates.map(reportProblemLabel).join('、')}`
              : ''}
          </span>
        </button>
        <ResultOutcomeTag outcome={resultStatus(item)} />
      </div>
    );
  }
  function detail(item: Item | undefined) {
    if (!item) return <Empty description="没有符合筛选条件的执行项" />;
    const result = item.result;
    if (!result)
      return (
        <Card size="small" title={item.scopeItem.content.title}>
          <Alert
            type="info"
            showIcon
            title="未回传执行结果"
            description="此项在冻结范围内，当前没有收到执行事实。"
          />
          <p className="caption">
            {item.scopeItem.scenario
              ? `场景 · ${item.scopeItem.scenario.title}`
              : '独立单接口用例'}
          </p>
        </Card>
      );
    const scope = item.scopeItem;
    return (
      <>
        {facts.kind === 'API' && scope.caseId && scope.caseRevisionId && (
          <a
            href={`#api-regression?${new URLSearchParams({
              projectId: project.id,
              caseId: scope.caseId,
              revisionId: scope.caseRevisionId,
              view: 'workbench',
            })}`}
          >
            查看本轮冻结用例修订
          </a>
        )}
        <ResultDetailPanel
          key={item.scopeItem.runItemId}
          project={project}
          resultId={result.id}
          executionKind={facts.kind}
          inline
          reportBasisRevisionId={focusedRevision ?? result.revisionId}
          {...(selection?.initialStep
            ? { initialStep: selection.initialStep }
            : {})}
          {...(selection?.returnTo ? { returnTo: selection.returnTo } : {})}
          {...(archived
            ? {
                archivedAssessment: {
                  outcome: result.finalOutcome,
                  reason: result.assessmentReason,
                },
              }
            : {})}
          {...(reportScope(report.id, report.revisionId, item)
            ? { reportReview: reportScope(report.id, report.revisionId, item)! }
            : {})}
          readOnly={!writableDetail}
          onRevisionSelect={(id) =>
            chooseResultRevision(
              result.id,
              id === result.revisionId ? null : id,
            )
          }
          onStepSelect={(id) =>
            setHash((query) => {
              query.set('resultId', result.id);
              query.set('step', String(id));
            })
          }
          onClose={() => undefined}
          onChanged={onChanged}
        />
      </>
    );
  }
  function review(item: Item | undefined) {
    if (!item?.result)
      return (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="有结果后可查看复核状态"
        />
      );
    const result = item.result;
    const candidates = byResult.get(result.id) ?? [];
    const scope = reportScope(report.id, viewedRevisionId, item)!;
    if (focusedRevision) scope.resultRevisionId = focusedRevision;
    const step = reviewStep(item, selection?.initialStep);
    if (step) scope.stepOrdinal = step;
    const reason = archived
      ? '历史报告只读，可查看该来源的复测与缺陷。'
      : previousRevision
        ? '历史结果修订只读。返回当前结果后可登记复测和提缺陷。'
        : detached
          ? '请重新选择此报告的结果后处理。'
          : !canReview
            ? '仅有项目测试角色可登记复测、提单和指派。'
            : undefined;
    const draftKey = `${userId}:${project.id}:${scope.resultRevisionId}`;
    const issues =
      handling?.issues.filter(
        (issue) =>
          issue.resultIds.includes(result.id) ||
          candidates.some((candidate) => candidate.issueIds.includes(issue.id)),
      ) ?? [];
    return (
      <>
        <ReportResultReview
          key={draftKey}
          projectId={project.id}
          userId={userId}
          scope={scope}
          item={item}
          runId={facts.runId}
          environment={facts.environmentName ?? facts.scope.environmentId}
          issues={issues}
          summary={
            <div className="report-review-status">
              <div>
                <span>执行原判</span>
                <ResultOutcomeTag outcome={result.initialOutcome} />
              </div>
              <div>
                <span>当前上报</span>
                <ResultOutcomeTag outcome={result.reportedOutcome} />
              </div>
              <div>
                <span>人工最终结论</span>
                <ResultOutcomeTag
                  outcome={result.finalOutcome ?? 'notAssessed'}
                />
              </div>
            </div>
          }
          readOnlyReason={reason}
          pendingFiles={reviewPendingFiles.current.get(draftKey)}
          onPendingFiles={(files) => {
            if (files.length) reviewPendingFiles.current.set(draftKey, files);
            else reviewPendingFiles.current.delete(draftKey);
          }}
          onOpenFile={onPreview}
          onIssueSaved={(issue) => {
            setReceivedIssue(issue);
            void onChanged();
          }}
        />
        {receivedIssue &&
          issues.some((issue) => issue.id === receivedIssue.id) && (
            <Alert
              showIcon
              type="success"
              title={
                <>
                  已确认{' '}
                  <a href={issueLink(receivedIssue.id)}>
                    {receivedIssue.number}
                  </a>
                </>
              }
            />
          )}
        {previousRevision && (
          <Alert
            type="warning"
            showIcon
            title="正在查阅旧结果修订"
            action={
              <Button size="small" onClick={() => focus(item)}>
                返回当前结果
              </Button>
            }
          />
        )}
        {candidates.length > 0 && (
          <details className="report-review-history">
            <summary>候选问题与原处理记录 · {candidates.length}</summary>
            {candidates.map((candidate) => (
              <ReportReviewPanel
                key={candidate.id}
                candidate={candidate}
                project={project}
                userId={userId}
                item={item}
                facts={facts}
                scope={scope}
                readOnly={!writableDetail}
                snapshot={archived}
                onChanged={onChanged}
                onConfirmed={(issue) => setReceivedIssue(issue)}
                onPreview={onPreview}
              />
            ))}
          </details>
        )}
      </>
    );
  }
  const scenePageGroups = [...groups]
    .map(([id, group]) => ({
      id,
      label: group.label,
      total: group.rows,
      visible: pageItems.filter((row) => scenarioKey(row) === id),
    }))
    .filter((group) => group.visible.length > 0);
  const coverage = [...groups.values()].filter((group) =>
    group.rows.some(observed),
  ).length;
  const evidenceCoverage = reportEvidenceCoverage(facts);
  return (
    <div className="report-workbench-content">
      <div className="report-workbench-heading">
        <div>
          <Typography.Title level={2}>
            {'title' in facts.scope
              ? facts.scope.title
              : facts.kind === 'UI'
                ? 'UI 测试报告'
                : '接口测试报告'}
          </Typography.Title>
          <Space className="report-workbench-meta" wrap size={[8, 3]}>
            <Typography.Text type="secondary">
              {facts.environmentName ?? sourceLabels[facts.scope.sourceType]} ·{' '}
              {provenanceLabels[facts.executionProvenance]}
            </Typography.Text>
            <DeliveryStatusTag status={facts.deliveryStatus} />
            <Typography.Text type="secondary">
              <BeijingTime value={facts.capturedAt} detail />
            </Typography.Text>
          </Space>
        </div>
        {toolbar}
      </div>
      {archived && (
        <Alert
          type="info"
          showIcon
          title="历史报告只读"
          description="本页展示该修订保存时的结果、证据与处理状态。"
        />
      )}
      {detached && (
        <Alert
          type="warning"
          showIcon
          title="链接结果不属于此报告修订的范围"
          description="仍可在有权限时单独打开原链接结果。"
          action={
            <Button
              href={`#reports?${new URLSearchParams({ projectId: project.id, resultId: selection.id, ...(selection.revisionId ? { resultRevisionId: selection.revisionId } : {}) })}`}
            >
              查看原结果
            </Button>
          }
        />
      )}
      <div className="report-metrics">
        <button
          type="button"
          aria-pressed={filter === 'all'}
          title={'已覆盖场景 ' + coverage + '/' + groups.size}
          onClick={() => {
            setFilter('all');
            resetSelection();
          }}
        >
          <span>执行范围</span>
          <strong>{facts.statistics.denominator}</strong>
        </button>
        {statusKeys.map((key) => (
          <button
            type="button"
            aria-pressed={filter === key}
            key={key}
            onClick={() => {
              setFilter(key);
              resetSelection();
            }}
          >
            <span>
              {key === 'passed' || key === 'failed' ? '当前 ' : ''}
              {outcomeLabels[key]}
            </span>
            <strong>{facts.statistics.reported[key]}</strong>
          </button>
        ))}
      </div>
      <div className="report-evidence-coverage" aria-label="观察与证据覆盖">
        <div>
          <span>关键观察</span>
          <strong>
            {evidenceCoverage.assertions
              ? `${evidenceCoverage.observedAssertions}/${evidenceCoverage.assertions} 个业务断言`
              : `${evidenceCoverage.observedSteps}/${evidenceCoverage.steps} 个冻结步骤`}
          </strong>
        </div>
        <div>
          <span>已核验证据</span>
          <strong>
            {evidenceCoverage.assertions
              ? `${evidenceCoverage.evidencedAssertions}/${evidenceCoverage.assertions} 个业务断言`
              : `${evidenceCoverage.evidencedSteps}/${evidenceCoverage.steps} 个冻结步骤`}
          </strong>
        </div>
        <div>
          <span>原件与引用</span>
          <strong>
            {evidenceCoverage.distinct} 件 · {evidenceCoverage.refs} 次引用
          </strong>
        </div>
        <div>
          <span>文件交付与采集</span>
          <strong>
            待核验 {facts.missingFileIds.length} 件 · 缺口{' '}
            {evidenceCoverage.gaps} 项
          </strong>
        </div>
      </div>
      {batch && (
        <ReportReviewBatch
          key={batch.id}
          project={project}
          userId={userId}
          rows={batch.items}
          session={batch.id}
          onClose={() => setBatch(null)}
          onSaved={async () => {
            setSelected(new Set());
            await onChanged();
          }}
        />
      )}
      {!archived && !batch && (
        <ReportBatchRecovery
          projectId={project.id}
          reportId={report.id}
          onChanged={onChanged}
        />
      )}
      <div className="report-desk-grid">
        <section className="report-case-list" aria-label="场景与用例">
          <h2>场景与用例</h2>
          <ResultFilters
            search={{
              label: '搜索范围、用例或场景',
              placeholder: '搜索用例或场景',
              value: search,
              onChange: (value) => {
                setSearch(value);
                resetSelection();
              },
            }}
            onReset={() => {
              setFilter('all');
              setScenario(null);
              setReviewFilter('all');
              setSearch('');
              resetSelection();
            }}
            summary={`${matched.length}/${facts.statistics.denominator} 项`}
          >
            <Select
              aria-label="按场景筛选"
              allowClear
              placeholder="全部场景"
              value={scenario}
              options={[...groups].map(([id, group]) => ({
                value: id,
                label: group.label,
              }))}
              onChange={(value?: string) => {
                setScenario(value ?? null);
                resetSelection();
              }}
            />
            <Select
              aria-label="人工处理状态"
              value={reviewFilter}
              options={reviewFilters}
              onChange={(value) => {
                setReviewFilter(value);
                resetSelection();
              }}
            />
          </ResultFilters>
          {writableDetail && (
            <BulkActionBar
              selected={selectedRows.length}
              scope={`仅当前筛选页的可处理结果${eligible.size > 100 ? '，每批最多 100 项' : ''}`}
              onClear={() => {
                setSelected(new Set());
                setBatch(null);
              }}
              selectionActions={
                <Button
                  size="small"
                  icon={<CheckOutlined />}
                  disabled={eligible.size === 0 || Boolean(batch)}
                  onClick={() => {
                    setSelected(new Set([...eligible.keys()].slice(0, 100)));
                    setBatch(null);
                  }}
                >
                  全选待确认的失败用例
                </Button>
              }
            >
              <Button
                size="small"
                type="primary"
                onClick={() =>
                  setBatch({ items: selectedRows, id: crypto.randomUUID() })
                }
              >
                预览批量转换
              </Button>
            </BulkActionBar>
          )}
          {!scenePageGroups.length && (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="没有匹配结果"
            />
          )}
          {scenePageGroups.map((group) => (
            <section key={group.id}>
              <div className="report-scene-label">
                <span>{group.label}</span>
                <small>{displayCoverage(group.total)}</small>
              </div>
              {group.visible.map(renderRow)}
            </section>
          ))}
        </section>
        <section className="report-result-pane" aria-label="执行结果">
          {detail(focused)}
        </section>
        <aside className="report-review-rail" aria-label="人工复核与缺陷">
          <h2>人工复核与缺陷</h2>
          {review(focused)}
        </aside>
      </div>
      {matched.length > pageSize && (
        <ResultPagination summary={`共 ${matched.length} 项结果`}>
          <Pagination
            current={currentPage}
            pageSize={pageSize}
            total={matched.length}
            showSizeChanger={false}
            onChange={(value) => {
              setPage(value);
              setSelected(new Set());
              setBatch(null);
              clearFocusedResult();
            }}
          />
        </ResultPagination>
      )}
      <Collapse
        items={[
          {
            key: 'source',
            label: '执行来源、需求快照与交付',
            children: (
              <Descriptions
                size="small"
                column={{ xs: 1, sm: 2 }}
                items={[
                  { key: 'run', label: '执行编号', children: facts.runId },
                  {
                    key: 'source',
                    label: '来源修订',
                    children: facts.scope.sourceRevisionId,
                  },
                  {
                    key: 'build',
                    label: '验证构建',
                    children: facts.scope.productBuild ?? '未记录',
                  },
                  {
                    key: 'env',
                    label: '冻结环境',
                    children:
                      facts.environmentName ?? facts.scope.environmentId,
                  },
                  {
                    key: 'observations',
                    label: '全轮冻结步骤',
                    children: `${evidenceCoverage.steps} 步 · 已记录 ${evidenceCoverage.observedSteps} · 有可读证据 ${evidenceCoverage.evidencedSteps}`,
                  },
                  {
                    key: 'state',
                    label: '执行状态',
                    children: facts.executionState,
                  },
                  {
                    key: 'versions',
                    label: '需求修订',
                    children:
                      [
                        ...new Set(
                          facts.scope.items.flatMap((item) =>
                            item.requirementVersionId
                              ? [item.requirementVersionId]
                              : [],
                          ),
                        ),
                      ].join('、') || '未记录',
                  },
                  {
                    key: 'file',
                    label: '附件核验',
                    children: facts.missingFileIds.length
                      ? `待补原件 ${facts.missingFileIds.length} 项`
                      : '无登记缺失附件',
                  },
                ]}
              />
            ),
          },
        ]}
      />
      {facts.evidence.length > 0 && (
        <Collapse
          items={[
            {
              key: 'evidence',
              label: `报告证据清单 · ${facts.evidence.length} 件`,
              children: (
                <EvidenceGallery
                  items={facts.evidence.map((row) => ({
                    fileId: row.fileId,
                    manifest: row.manifest,
                    originalName: row.originalName,
                    fileStatus: row.lastKnownFileStatus,
                    ...(row.fileAvailable !== undefined
                      ? { fileAvailable: row.fileAvailable }
                      : {}),
                    source: row.manifest.source,
                  }))}
                  onOpen={onPreview}
                />
              ),
            },
          ]}
        />
      )}
    </div>
  );
}
