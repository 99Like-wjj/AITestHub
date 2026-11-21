import { useMemo, useState } from 'react';
import { CheckOutlined, SearchOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Collapse,
  Descriptions,
  Empty,
  Input,
  Pagination,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd';
import type { z } from 'zod';
import type { reportDetailSchema } from '../../../packages/contracts/src/ui-results';
import type { ReportHandling } from '../../../packages/contracts/src/report-handling';
import type { ReportProblemReviewScope } from '../../../packages/contracts/src/issues';
import { EvidenceGallery } from './evidence-gallery';
import type { EvidenceGalleryItem } from './evidence-gallery';
import { ArchiveFindingDialog } from './archive-finding-dialog';
import type { ArchiveFinding } from './archive-finding-dialog';
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
const deliveryLabels: Record<string, string> = {
  complete: '已完整交付',
  incomplete: '交付待补',
  pending: '待提交',
  partial: '部分交付',
  notSubmitted: '未提交',
  missingFiles: '文件待补',
};
const resultStatus = (item: Item) =>
  item.result?.reportedOutcome ?? 'notReported';
function scenarioKey(item: Item) {
  const scope = item.scopeItem;
  return 'scenarioId' in scope
    ? scope.scenarioId
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
  const ordinal =
    requested ??
    observations.find((step) => step.outcome === 'failed')?.ordinal;
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

export function ReportWorkbench({
  project,
  userId,
  report,
  facts,
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
  const [archiveFinding, setArchiveFinding] = useState<ArchiveFinding>();
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
        label: item.scopeItem.scenario.title,
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
          item.scopeItem.scenario.title,
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
    setArchiveFinding(undefined);
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
    setArchiveFinding(undefined);
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
  function scopeForArchive(item: Item) {
    if (!item.result || !('requirementId' in item.scopeItem)) return;
    const source = reportScope(report.id, report.revisionId, item)!;
    const ordinal = reviewStep(item, selection?.initialStep);
    if (ordinal) source.stepOrdinal = ordinal;
    setArchiveFinding({
      runId: facts.runId,
      resultId: item.result.id,
      requirementId: item.scopeItem.requirementId,
      requirementVersionId: item.scopeItem.requirementVersionId,
      title: item.scopeItem.content.title,
      observations: item.result.content.actualObservations,
      evidenceRefs: item.result.content.evidenceRefs,
      reportReview: source,
    });
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
          <p className="caption">场景 · {item.scopeItem.scenario.title}</p>
        </Card>
      );
    return (
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
          chooseResultRevision(result.id, id === result.revisionId ? null : id)
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
    const step = reviewStep(item, selection?.initialStep);
    if (step) scope.stepOrdinal = step;
    const issues =
      handling?.issues.filter(
        (issue) =>
          issue.resultIds.includes(result.id) ||
          candidates.some((candidate) => candidate.issueIds.includes(issue.id)),
      ) ?? [];
    return (
      <>
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
            <ResultOutcomeTag outcome={result.finalOutcome ?? 'notAssessed'} />
          </div>
          {issues.length > 0 && (
            <div>
              <span>正式缺陷</span>
              <Space wrap>
                {issues.map((issue) => (
                  <a key={issue.id} href={issueLink(issue.id)}>
                    {issue.number}
                  </a>
                ))}
              </Space>
            </div>
          )}
        </div>
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
        {candidates.length ? (
          candidates.map((candidate) => (
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
          ))
        ) : (
          <Typography.Text type="secondary">
            当前结果没有关联的候选问题。
          </Typography.Text>
        )}
        {!candidates.length &&
          writableDetail &&
          facts.scope.sourceType === 'uiArchive' && (
            <Button onClick={() => scopeForArchive(item)}>
              登记待确认问题
            </Button>
          )}
        {archiveFinding?.resultId === result.id && writableDetail && (
          <ArchiveFindingDialog
            key={result.id}
            project={project}
            finding={archiveFinding}
            onSaved={() => {
              void onChanged();
            }}
            onClose={() => setArchiveFinding(undefined)}
          />
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
  return (
    <div className="report-workbench-content">
      <div className="report-workbench-heading">
        <div>
          <Space wrap size={[6, 0]}>
            <Tag color={facts.kind === 'UI' ? 'blue' : 'cyan'}>
              {facts.kind}
            </Tag>
            <Tag>{sourceLabels[facts.scope.sourceType]}</Tag>
            <Tag>{provenanceLabels[facts.executionProvenance]}</Tag>
          </Space>
          <Typography.Title level={2}>
            {'title' in facts.scope
              ? facts.scope.title
              : `${facts.kind === 'UI' ? 'UI' : '接口'}测试报告`}
          </Typography.Title>
          <Typography.Text type="secondary">
            执行 {facts.runId} ·{' '}
            {deliveryLabels[facts.deliveryStatus] ?? facts.deliveryStatus} ·{' '}
            {new Date(facts.capturedAt).toLocaleString('zh-CN')}
          </Typography.Text>
        </div>
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
          onClick={() => {
            setFilter('all');
            resetSelection();
          }}
        >
          <span>执行范围</span>
          <strong>{facts.statistics.denominator}</strong>
          <small>
            已覆盖场景 {coverage}/{groups.size}
          </small>
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
                    children: facts.scope.environmentId,
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
      <div className="report-workbench-filters">
        <Input
          aria-label="搜索范围、用例或场景"
          allowClear
          prefix={<SearchOutlined />}
          value={search}
          placeholder="搜索用例或场景"
          onChange={(event) => {
            setSearch(event.target.value);
            resetSelection();
          }}
        />
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
        <Typography.Text type="secondary">
          {matched.length}/{facts.statistics.denominator} 项
        </Typography.Text>
      </div>
      {writableDetail && (
        <div className="report-batch-toolbar">
          <Space wrap>
            <Button
              icon={<CheckOutlined />}
              disabled={eligible.size === 0 || Boolean(batch)}
              onClick={() => {
                setSelected(new Set([...eligible.keys()].slice(0, 100)));
                setBatch(null);
              }}
            >
              全选待确认的失败用例
            </Button>
            <Button
              disabled={selectedRows.length === 0}
              type="primary"
              onClick={() =>
                setBatch({ items: selectedRows, id: crypto.randomUUID() })
              }
            >
              预览批量转换（{selectedRows.length} 项）
            </Button>
            <Button
              type="text"
              disabled={selectedRows.length === 0}
              onClick={() => {
                setSelected(new Set());
                setBatch(null);
              }}
            >
              清空选择
            </Button>
          </Space>
          <Typography.Text type="secondary">
            仅当前筛选页可批量处理的结果
            {eligible.size > 100 ? '，每批最多 100 项' : ''}
          </Typography.Text>
        </div>
      )}
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
        <aside className="report-review-rail" aria-label="人工复核">
          <h2>人工复核</h2>
          {review(focused)}
        </aside>
      </div>
      {matched.length > pageSize && (
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
      )}
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
