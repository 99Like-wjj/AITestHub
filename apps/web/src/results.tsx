import { useEffect, useRef, useState } from 'react';
import { ReloadOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Collapse,
  Descriptions,
  Empty,
  Form,
  Input,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { z } from 'zod';
import { idSchema } from '../../../packages/contracts/src/base';
import { runStateSchema } from '../../../packages/contracts/src/domain';
import {
  reportDetailSchema,
  reportRevisionSchema,
  runStatusSchema,
  resultReceiptStatusSchema,
} from '../../../packages/contracts/src/ui-results';
import { api, ApiError, describeError } from './api';
import { ResultDetailPanel } from './result-detail';
import { ReportWorkbench } from './report-workbench';
import { StandaloneWorkbenchHeader } from './standalone-workbench-header';
import './report-workbench.css';
import { EvidenceViewer } from './evidence-viewer';
import type { EvidenceGalleryItem } from './evidence-gallery';
import type { Project } from './types';
import { PageHeading } from './page-heading';
import { ExecutionRecords } from './execution-records';
import { UiArchiveDialog } from './ui-archive-dialog';
import { UiDeliveryPanel } from './ui-delivery-panel';
import { formatBeijingTime } from './beijing-time';
import { DeliveryStatusTag, ExecutionStateTag } from './semantic-status';
import {
  currentIdentityOwner,
  identityContextEpoch,
  subscribeIdentityChanges,
} from './identity-context';
import {
  ReportRecoveryQueryGuard,
  type ReportRecoveryKind,
  type ReportRecoveryQuery,
  type ReportRecoveryRequest,
} from './report-recovery-query';

type Report = z.infer<typeof reportDetailSchema>['report'];
const reportReasons: Record<string, string> = {
  'result-submission': '结果提交',
  'manual-export': '手动导出',
  'manual-assessment': '人工结论登记',
  'manual-evidence-addition': '人工补充证据',
  'result-amendment': '采集说明修订',
  'ui-result-amendment': 'UI采集说明修订',
  'file-verified': '文件验证完成',
};
type Facts = Report['facts'];
type Run = z.infer<typeof runStatusSchema>;
type Receipt = z.infer<typeof resultReceiptStatusSchema>;
function initialReportId() {
  const value = idSchema.safeParse(
    new URLSearchParams(window.location.hash.split('?')[1]).get('reportId'),
  );
  return value.success ? value.data : null;
}
function reportRevisionFromUrl() {
  const query = new URLSearchParams(window.location.hash.split('?')[1]);
  if (!query.has('reportId')) return 'current';
  const parsed = idSchema.safeParse(query.get('revisionId'));
  return parsed.success ? parsed.data : 'current';
}
function issueReturnLink(query: URLSearchParams, projectId: string) {
  const issueId = idSchema.safeParse(query.get('fromIssueId'));
  const path = query.get('returnTo');
  if (path?.startsWith('#issues?')) {
    const origin = new URLSearchParams(path.slice('#issues?'.length));
    if (
      origin.get('projectId') === projectId &&
      (!issueId.success || origin.get('issueId') === issueId.data)
    )
      return `#issues?${origin.toString()}`;
  }
  if (issueId.success)
    return `#issues?${new URLSearchParams({ projectId, issueId: issueId.data })}`;
  return undefined;
}

export function ResultsPage({
  project,
  userId,
}: {
  project: Project | null;
  userId: string;
}) {
  const [recordsVersion, setRecordsVersion] = useState(0);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [lookupOpen, setLookupOpen] = useState(() =>
    Boolean(
      new URLSearchParams(window.location.hash.split('?')[1]).get('runId'),
    ),
  );
  const [reportId, setReportId] = useState<string | null>(initialReportId);
  const [report, setReport] = useState<Report | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [revisionId, setRevisionId] = useState(reportRevisionFromUrl);
  const [historical, setHistorical] = useState<z.infer<
    typeof reportRevisionSchema
  > | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string>();
  const [exporting, setExporting] = useState(false);
  const [reportNotice, setReportNotice] = useState<string>();
  useEffect(() => setReportNotice(undefined), [reportId, revisionId]);
  const [selectedResult, setSelectedResult] = useState<{
    id: string;
    revisionId?: string;
    kind?: 'UI' | 'API';
    lookupRequest?: ReportRecoveryRequest;
    initialStep?: number;
    returnTo?: string;
    linked?: boolean;
  } | null>(null);
  const [preview, setPreview] = useState<EvidenceGalleryItem | null>(null);
  const [lookupForm] = Form.useForm<{
    kind: ReportRecoveryKind;
    id: string;
  }>();
  const [lookupFeedback, setLookupFeedback] = useState<{
    request: ReportRecoveryRequest;
    loading: boolean;
    error?: string;
    run?: Run;
    receipt?: Receipt;
  }>();
  const detailEpoch = useRef(0);
  const historyEpoch = useRef(0);
  const lookupGuard = useRef(new ReportRecoveryQueryGuard());
  const lookupContext = useRef({ ownerId: userId, projectId: project?.id });
  lookupContext.current = { ownerId: userId, projectId: project?.id };
  function currentLookupQuery(): ReportRecoveryQuery | null {
    const { ownerId, projectId } = lookupContext.current;
    if (!projectId || currentIdentityOwner() !== ownerId) return null;
    const values = lookupForm.getFieldsValue(true);
    return {
      ownerId,
      identityEpoch: identityContextEpoch(),
      projectId,
      kind: values.kind ?? 'run',
      value: values.id ?? '',
    };
  }
  function clearLookup() {
    lookupGuard.current.invalidate();
    setLookupFeedback(undefined);
    setSelectedResult((value) => (value?.lookupRequest ? null : value));
  }
  const currentQuery = currentLookupQuery();
  const feedback =
    lookupFeedback &&
    lookupGuard.current.accepts(lookupFeedback.request, currentQuery)
      ? lookupFeedback
      : undefined;
  const run = feedback?.run;
  const receipt = feedback?.receipt;
  const visibleResult =
    selectedResult?.lookupRequest &&
    !lookupGuard.current.accepts(selectedResult.lookupRequest, currentQuery)
      ? null
      : selectedResult;
  const queryProject = new URLSearchParams(
    window.location.hash.split('?')[1],
  ).get('projectId');
  const contextMatches = !queryProject || queryProject === project?.id;
  function load() {
    setRecordsVersion((value) => value + 1);
  }
  async function loadReport(signal?: AbortSignal) {
    const epoch = ++detailEpoch.current;
    if (!project || !reportId || !contextMatches) return;
    setDetailLoading(true);
    try {
      const response = await api(
        `/projects/${project.id}/reports/${reportId}`,
        signal ? { signal } : {},
        reportDetailSchema,
      );
      if (!signal?.aborted && epoch === detailEpoch.current) {
        setReport(response.report);
        setDetailError(undefined);
      }
    } catch (failure) {
      if (!signal?.aborted && epoch === detailEpoch.current) {
        setReport(null);
        setDetailError(describeError(failure));
      }
    } finally {
      if (!signal?.aborted && epoch === detailEpoch.current)
        setDetailLoading(false);
    }
  }
  useEffect(() => {
    setReport(null);
    setSelectedResult(null);
    setPreview(null);
    clearLookup();
    return () => lookupGuard.current.invalidate();
  }, [project?.id, userId]);
  useEffect(() => subscribeIdentityChanges(clearLookup), []);
  useEffect(() => {
    function update() {
      setReportId(initialReportId());
      setRevisionId(reportRevisionFromUrl());
    }
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setReport(null);
    setHistorical(null);
    setRevisionId(reportRevisionFromUrl());
    setDetailError(undefined);
    void loadReport(controller.signal);
    return () => controller.abort();
  }, [project?.id, reportId, contextMatches]);
  useEffect(() => {
    const epoch = ++historyEpoch.current;
    const controller = new AbortController();
    setHistorical(null);
    setHistoryLoading(false);
    setHistoryError(undefined);
    if (revisionId === 'current' || !project || !reportId) return;
    setHistoryLoading(true);
    void api(
      `/projects/${project.id}/reports/${reportId}/revisions/${revisionId}`,
      { signal: controller.signal },
      reportRevisionSchema,
    )
      .then((response) => {
        if (!controller.signal.aborted && epoch === historyEpoch.current) {
          setHistorical(response);
          setHistoryError(undefined);
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted && epoch === historyEpoch.current)
          setHistoryError(describeError(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted && epoch === historyEpoch.current)
          setHistoryLoading(false);
      });
    return () => controller.abort();
  }, [revisionId, project?.id, reportId]);
  useEffect(() => {
    function followLinkedRecord() {
      if (!project) return;
      const query = new URLSearchParams(window.location.hash.split('?')[1]);
      if (query.get('projectId') && query.get('projectId') !== project.id)
        return;
      const runId = idSchema.safeParse(query.get('runId'));
      const resultId = idSchema.safeParse(query.get('resultId'));
      if (resultId.success) {
        const revision = idSchema.safeParse(query.get('resultRevisionId'));
        const step = Number(query.get('step'));
        const returnTo = issueReturnLink(query, project.id);
        setSelectedResult({
          id: resultId.data,
          linked: true,
          ...(revision.success ? { revisionId: revision.data } : {}),
          ...(Number.isInteger(step) && step > 0 && step <= 1000
            ? { initialStep: step }
            : {}),
          ...(returnTo ? { returnTo } : {}),
        });
      } else if (runId.success) {
        lookupForm.setFieldsValue({ kind: 'run', id: runId.data });
        void lookup({ kind: 'run', id: runId.data });
      } else setSelectedResult((active) => (active?.linked ? null : active));
    }
    followLinkedRecord();
    window.addEventListener('hashchange', followLinkedRecord);
    return () => window.removeEventListener('hashchange', followLinkedRecord);
  }, [project?.id, userId]);
  function closeResult() {
    if (visibleResult?.linked) {
      const query = new URLSearchParams(window.location.hash.split('?')[1]);
      if (!query.has('reportId')) query.delete('revisionId');
      for (const key of [
        'resultId',
        'resultRevisionId',
        'step',
        'fromIssueId',
        'returnTo',
      ])
        query.delete(key);
      window.history.replaceState(
        null,
        '',
        `#reports${query.size ? `?${query}` : ''}`,
      );
    }
    setSelectedResult(null);
  }
  async function lookup(values: { kind: ReportRecoveryKind; id: string }) {
    if (!project || currentIdentityOwner() !== userId) return;
    const request = lookupGuard.current.begin({
      ownerId: userId,
      identityEpoch: identityContextEpoch(),
      projectId: project.id,
      kind: values.kind,
      value: values.id,
    });
    setLookupFeedback({ request, loading: false });
    setSelectedResult((value) => (value?.lookupRequest ? null : value));
    const parsed = idSchema.safeParse(values.id);
    if (!parsed.success) {
      setLookupFeedback({
        request,
        loading: false,
        error: '请输入有效的原轮次、结果或提交UUID。',
      });
      return;
    }
    setLookupFeedback({ request, loading: true });
    try {
      if (values.kind === 'result') {
        if (lookupGuard.current.accepts(request, currentLookupQuery()))
          setSelectedResult({ id: parsed.data, lookupRequest: request });
        return;
      }
      if (values.kind === 'run') {
        const response = await api(
          `/projects/${project.id}/ui-executions/${parsed.data}`,
          { signal: request.signal },
          runStatusSchema,
        );
        if (lookupGuard.current.accepts(request, currentLookupQuery()))
          setLookupFeedback({ request, loading: false, run: response });
      } else {
        const response = await api(
          `/projects/${project.id}/result-submissions/${parsed.data}`,
          { signal: request.signal },
          resultReceiptStatusSchema,
        );
        if (lookupGuard.current.accepts(request, currentLookupQuery()))
          setLookupFeedback({ request, loading: false, receipt: response });
      }
    } catch (failure) {
      if (lookupGuard.current.accepts(request, currentLookupQuery()))
        setLookupFeedback({
          request,
          loading: false,
          error: describeError(failure),
        });
    } finally {
      if (lookupGuard.current.accepts(request, currentLookupQuery()))
        setLookupFeedback((value) =>
          value?.request === request ? { ...value, loading: false } : value,
        );
    }
  }
  function openReport(id: string) {
    if (project) {
      const params = new URLSearchParams({
        projectId: project.id,
        reportId: id,
      });
      if (!initialReportId()) params.set('reportsBack', window.location.hash);
      window.location.hash = `reports?${params}`;
    }
  }
  async function exportReport() {
    if (!project || !reportId || exporting) return;
    const ownerEpoch = identityContextEpoch();
    setExporting(true);
    setDetailError(undefined);
    try {
      const response = await fetch(
        `/api/v1/projects/${project.id}/reports/${reportId}/export${revisionId === 'current' ? '' : `?revisionId=${encodeURIComponent(revisionId)}`}`,
        { credentials: 'same-origin', signal: AbortSignal.timeout(60000) },
      );
      if (ownerEpoch !== identityContextEpoch())
        throw new ApiError(
          '当前身份已变化，旧身份导出回执未采用，请切回原身份核对。',
          0,
          'IDENTITY_CONTEXT_CHANGED',
        );
      if (!response.ok) {
        if (response.status === 401)
          window.dispatchEvent(new Event('aitesthub:session-expired'));
        throw new ApiError(
          `报告快照导出未取得（HTTP ${response.status}），请先刷新核对原存档。`,
          response.status,
          'EXPORT_UNCONFIRMED',
        );
      }
      if (!response.headers.get('content-type')?.includes('text/html'))
        throw new ApiError(
          '导出内容类型与报告契约不一致。',
          502,
          'EXPORT_SCHEMA_MISMATCH',
        );
      const blob = await response.blob();
      if (ownerEpoch !== identityContextEpoch())
        throw new ApiError(
          '当前身份已变化，未下载旧身份报告；原导出可能已保存快照，请切回原身份只读核对。',
          0,
          'IDENTITY_CONTEXT_CHANGED',
        );
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `aitesthub-report-${reportId}-${revisionId}.html`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (revisionId === 'current') await loadReport();
    } catch (failure) {
      setDetailError(
        `${describeError(failure)}${revisionId === 'current' ? '；当前导出会保存快照，未收到下载不表示没有生成存档，请先只读刷新。' : '；历史版本只按固定修订读取，不改写存档。'}`,
      );
    } finally {
      setExporting(false);
    }
  }
  const facts: Facts | null =
    revisionId === 'current'
      ? (report?.facts ?? null)
      : (historical?.facts ?? null);
  if (!project)
    return <Empty description="请选择当前有效项目后查看执行与报告。" />;
  const explicitResult = idSchema.safeParse(
    new URLSearchParams(window.location.hash.split('?')[1]).get('resultId'),
  );
  const standalone = !!reportId || explicitResult.success;
  const hashParams = new URLSearchParams(window.location.hash.split('?')[1]);
  const prior = hashParams.get('reportsBack');
  const priorQuery = new URLSearchParams(prior?.split('?')[1]);
  const returnHash =
    prior?.startsWith('#reports?') &&
    (!priorQuery.has('projectId') ||
      priorQuery.get('projectId') === project.id) &&
    !priorQuery.has('reportId') &&
    !priorQuery.has('resultId')
      ? `#reports?${priorQuery}`
      : `#reports?${new URLSearchParams({ projectId: project.id })}`;
  const detailPanel = () => (
    <ResultDetailPanel
      project={project}
      {...(visibleResult?.kind ? { executionKind: visibleResult.kind } : {})}
      inline={standalone}
      readOnly={!!visibleResult?.revisionId}
      resultId={visibleResult?.id ?? null}
      {...(visibleResult?.revisionId
        ? { reportBasisRevisionId: visibleResult.revisionId }
        : {})}
      {...(visibleResult?.initialStep
        ? { initialStep: visibleResult.initialStep }
        : {})}
      {...(visibleResult?.returnTo ? { returnTo: visibleResult.returnTo } : {})}
      onClose={closeResult}
      onChanged={async () => {
        await loadReport();
        load();
      }}
    />
  );
  function copyReportLink() {
    if (!navigator.clipboard?.writeText) {
      setReportNotice('当前浏览器未开放复制，请从地址栏复制当前报告链接。');
      return;
    }
    const url = new URL(window.location.href);
    const query = new URLSearchParams(url.hash.split('?')[1]);
    query.delete('fromIssueId');
    query.delete('returnTo');
    query.delete('reportsBack');
    url.hash = `reports?${query}`;
    void navigator.clipboard
      .writeText(url.toString())
      .then(() => setReportNotice('链接已复制，打开时按当前账号权限读取。'))
      .catch(() => setReportNotice('链接未能复制，请从地址栏复制当前链接。'));
  }
  const reportControls = report ? (
    <div className="report-workbench-controls">
      <Select
        aria-label="报告历史快照"
        value={revisionId}
        onChange={(id: string) => {
          const query = new URLSearchParams(window.location.hash.split('?')[1]);
          if (id !== 'current') query.set('revisionId', id);
          else {
            query.delete('revisionId');
            query.delete('resultRevisionId');
          }
          window.location.hash = `reports?${query}`;
        }}
        options={[
          { value: 'current', label: '当前汇总' },
          ...report.history.map((row) => ({
            value: row.id,
            label: `历史 r${row.revisionNo} · ${formatBeijingTime(row.createdAt, true)} · ${reportReasons[row.reason] ?? '已保存快照'}`,
          })),
        ]}
      />
      <Button onClick={() => void loadReport()} loading={detailLoading}>
        刷新报告
      </Button>
      <Button onClick={copyReportLink}>复制链接</Button>
      <Button
        loading={exporting}
        disabled={revisionId !== 'current' && !historical}
        onClick={() => void exportReport()}
      >
        {revisionId === 'current' ? '导出 HTML 快照' : '下载此历史修订'}
      </Button>
    </div>
  ) : null;
  return (
    <>
      {standalone && (
        <section className="report-workbench">
          <StandaloneWorkbenchHeader
            title={reportId ? '测试报告' : '结果与证据'}
            projectName={project.name}
            backLabel="返回执行与报告"
            backHref={returnHash}
          />
          <main className="report-workbench-body">
            {!contextMatches ? (
              <Alert
                type="warning"
                showIcon
                title="报告或结果链接属于当前无权读取的项目。"
              />
            ) : reportId ? (
              <>
                {reportNotice && (
                  <p className="caption mb" role="status">
                    {reportNotice}
                  </p>
                )}
                {(detailLoading && !report) || historyLoading ? (
                  <Skeleton active />
                ) : null}
                {detailError && (
                  <Alert type="error" showIcon title={detailError} />
                )}
                {historyError && (
                  <Alert
                    type="error"
                    showIcon
                    title={`所选报告修订未取得：${historyError}`}
                  />
                )}
                {report && facts && (
                  <ReportWorkbench
                    key={`${report.id}:${revisionId}`}
                    project={project}
                    userId={userId}
                    report={report}
                    facts={facts}
                    toolbar={reportControls}
                    archived={revisionId !== 'current'}
                    viewedRevisionId={
                      revisionId === 'current' ? report.revisionId : revisionId
                    }
                    handling={
                      revisionId === 'current'
                        ? report.currentHandling
                        : (historical?.handlingAtCapture ?? null)
                    }
                    selection={visibleResult?.linked ? visibleResult : null}
                    onChanged={async () => {
                      await loadReport();
                      load();
                    }}
                    onPreview={setPreview}
                  />
                )}
              </>
            ) : (
              detailPanel()
            )}
          </main>
        </section>
      )}
      <div className="results-page" hidden={standalone}>
        <PageHeading
          eyebrow="EXECUTION & REPORTS"
          title="执行与报告"
          description="保留当轮范围、实际修订、业务结论与独立交付状态。"
          actions={
            <>
              <Button
                icon={<ReloadOutlined />}
                onClick={() => setRecordsVersion((version) => version + 1)}
              >
                刷新
              </Button>
              {project.roles.includes('tester') && (
                <Button type="primary" onClick={() => setArchiveOpen(true)}>
                  上传本地独立归档
                </Button>
              )}
            </>
          }
        />
        <UiArchiveDialog
          key={project.id}
          project={project}
          open={archiveOpen}
          onClose={() => setArchiveOpen(false)}
          onSaved={(id) => {
            setArchiveOpen(false);
            setRecordsVersion((x) => x + 1);
            openReport(id);
          }}
        />
        <ExecutionRecords
          userId={userId}
          project={project}
          refreshKey={recordsVersion}
          onReport={openReport}
          onRun={(id) => {
            setLookupOpen(true);
            lookupForm.setFieldsValue({ kind: 'run', id });
            void lookup({ kind: 'run', id });
          }}
        />
        <Collapse
          className="mt"
          activeKey={lookupOpen ? ['original'] : []}
          onChange={(keys) =>
            setLookupOpen(Array.isArray(keys) && keys.includes('original'))
          }
          items={[
            {
              key: 'original',
              label: '原轮次、结果或提交找回（只读）',
              children: (
                <Card title="执行、结果与交付完整性">
                  <Alert
                    type="info"
                    showIcon
                    title="进度不等于结果，测试结论与交付完整性分别记录"
                    description="平台本地UI执行能力只接收固定范围/进度/结果/证据，不从此页面唤醒本地AI或启动服务器UI执行器。合成协议提交必须保留来源标记。"
                    className="section-alert"
                  />
                  <Form
                    form={lookupForm}
                    layout="inline"
                    initialValues={{ kind: 'run' }}
                    onValuesChange={clearLookup}
                    onFinish={(values) => void lookup(values)}
                  >
                    <Form.Item name="kind" label="只读查询">
                      <Select
                        style={{ minWidth: 150 }}
                        options={[
                          { value: 'run', label: '原执行轮次ID' },
                          { value: 'result', label: '原结果ID' },
                          { value: 'submission', label: '本人结果提交ID' },
                        ]}
                      />
                    </Form.Item>
                    <Form.Item
                      name="id"
                      label="原UUID"
                      rules={[{ required: true }]}
                    >
                      <Input
                        placeholder="不创建/重放执行"
                        style={{ minWidth: 290 }}
                      />
                    </Form.Item>
                    <Form.Item>
                      <Button
                        type="primary"
                        htmlType="submit"
                        loading={feedback?.loading ?? false}
                      >
                        查询原记录
                      </Button>
                    </Form.Item>
                  </Form>
                  {feedback?.error && (
                    <Alert
                      type="error"
                      title={feedback.error}
                      showIcon
                      className="section-alert"
                    />
                  )}
                  {run && (
                    <Descriptions
                      className="section-alert"
                      column={1}
                      bordered
                      items={[
                        { key: 'id', label: '原执行', children: run.runId },
                        {
                          key: 'state',
                          label: '执行状态',
                          children: (() => {
                            const state = runStateSchema.safeParse(run.state);
                            return state.success ? (
                              <ExecutionStateTag state={state.data} />
                            ) : (
                              run.state
                            );
                          })(),
                        },
                        {
                          key: 'progress',
                          label: '进度声明',
                          children: `${run.completedItems}/${run.totalItems} · sequence ${run.progressSequence} · ${run.progressClosedAt ? '平台进度展示已关闭，仍按协议接收上报' : '平台进度展示未关闭'}`,
                        },
                        {
                          key: 'delivery',
                          label: '交付状态',
                          children: (
                            <DeliveryStatusTag status={run.deliveryStatus} />
                          ),
                        },
                        {
                          key: 'origin',
                          label: '执行来源',
                          children:
                            run.executionProvenance === 'protocol-synthetic'
                              ? '合成协议结果，不是真实UI执行'
                              : run.executionProvenance,
                        },
                        {
                          key: 'report',
                          label: '实际报告',
                          children: run.reportId ? (
                            <Button
                              type="link"
                              onClick={() => openReport(run.reportId!)}
                            >
                              打开已存在报告
                            </Button>
                          ) : (
                            '尚无报告，进度/文件本身不生成报告'
                          ),
                        },
                        {
                          key: 'scope',
                          label: '固定范围',
                          children: `${run.scope.items.length}项 · ${run.scope.snapshotDigest}`,
                        },
                      ]}
                    />
                  )}
                  {run?.kind === 'UI' &&
                    run.scope.sourceType !== 'uiArchive' && (
                      <UiDeliveryPanel
                        key={run.runId}
                        projectId={project.id}
                        runId={run.runId}
                        scopeItems={run.scope.items}
                      />
                    )}
                  {receipt && (
                    <Card
                      className="section-alert"
                      size="small"
                      title={`本人原提交 ${receipt.receipt.submissionId}`}
                    >
                      <Space wrap>
                        <Tag>当时接收 {receipt.receipt.resultsAccepted} 项</Tag>
                        <span className="caption">原回执</span>
                        <DeliveryStatusTag
                          status={receipt.receipt.deliveryStatus}
                        />
                        <span className="caption">当前状态</span>
                        <DeliveryStatusTag
                          status={receipt.currentDelivery.status}
                        />
                      </Space>
                      <Typography.Paragraph>
                        当前缺失文件：
                        {receipt.currentDelivery.missingFileIds.length
                          ? receipt.currentDelivery.missingFileIds.join('、')
                          : '无登记缺失文件'}
                      </Typography.Paragraph>
                      <Table
                        rowKey="objectId"
                        pagination={false}
                        dataSource={receipt.receipt.perItemResults}
                        columns={[
                          { title: '固定对象', dataIndex: 'objectId' },
                          { title: '原处理状态', dataIndex: 'status' },
                          { title: '说明', dataIndex: 'message' },
                        ]}
                      />
                    </Card>
                  )}
                </Card>
              ),
            },
          ]}
        />
      </div>
      {!standalone && detailPanel()}
      <EvidenceViewer
        fileId={preview?.fileId ?? null}
        evidenceType={preview?.manifest.type}
        source={preview?.source}
        onClose={() => setPreview(null)}
      />
    </>
  );
}
