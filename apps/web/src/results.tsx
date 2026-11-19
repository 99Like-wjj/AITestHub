import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Collapse,
  Descriptions,
  Modal,
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
import {
  reportDetailSchema,
  reportRevisionSchema,
  runStatusSchema,
  resultReceiptStatusSchema,
} from '../../../packages/contracts/src/ui-results';
import { api, ApiError, describeError } from './api';
import { ResultDetailPanel, outcomeLabels } from './result-detail';
import { EvidenceViewer } from './evidence-viewer';
import type { Project } from './types';
import { PageHeading } from './page-heading';
import { ExecutionRecords } from './execution-records';
import { UiArchiveDialog } from './ui-archive-dialog';
import {
  ArchiveFindingDialog,
  type ArchiveFinding,
} from './archive-finding-dialog';
import { ReportHandlingPanel } from './report-handling-panel';
import { UiDeliveryPanel } from './ui-delivery-panel';
import { uiLayers } from './ui-layers';
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
const executionLabels: Record<string, string> = {
  prepared: '已准备',
  queued: '排队中',
  running: '执行中',
  stopping: '终止中',
  completed: '已完成',
  terminated: '已终止',
  interrupted: '已中断',
  recoveryRequired: '需核对恢复',
};
const deliveryLabels: Record<string, string> = {
  notSubmitted: '尚未提交',
  receiving: '接收中',
  incomplete: '待补传',
  complete: '完整',
};
const cleanupLabels: Record<string, string> = {
  notConfigured: '未配置',
  pending: '待清理',
  running: '清理中',
  succeeded: '清理成功',
  failed: '清理失败',
  skipped: '已跳过',
  interrupted: '清理中断',
};
const originLabels: Record<string, string> = {
  'protocol-synthetic': '合成协议结果（不是本地UI真实执行）',
  'local-ai': '用户本地 AI 执行',
  'platform-api': '平台接口执行',
  unknown: '来源未核实',
};
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
  const parsed = idSchema.safeParse(
    new URLSearchParams(window.location.hash.split('?')[1]).get('revisionId'),
  );
  return parsed.success ? parsed.data : 'current';
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
  const [archiveFinding, setArchiveFinding] = useState<ArchiveFinding>();
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
  } | null>(null);
  const [fileId, setFileId] = useState<string | null>(null);
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
    setFileId(null);
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
      if (runId.success) {
        lookupForm.setFieldsValue({ kind: 'run', id: runId.data });
        void lookup({ kind: 'run', id: runId.data });
      } else if (resultId.success) setSelectedResult({ id: resultId.data });
    }
    followLinkedRecord();
    window.addEventListener('hashchange', followLinkedRecord);
    return () => window.removeEventListener('hashchange', followLinkedRecord);
  }, [project?.id, userId]);
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
    if (project)
      window.location.hash = `reports?projectId=${project.id}&reportId=${id}`;
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
  const currentHandling = [report?.currentHandling, historical?.currentHandling]
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
    .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt))[0];
  if (!project)
    return <Empty description="请选择当前有效项目后查看执行与报告。" />;
  return (
    <div className="results-page">
      <PageHeading
        eyebrow="EXECUTION & REPORTS"
        title="执行与报告"
        description="保留当轮范围、实际修订、业务结论与独立交付状态。"
      />
      {project.roles.includes('tester') && (
        <div className="toolbar mb">
          <Button onClick={() => setArchiveOpen(true)}>上传本地独立归档</Button>
        </div>
      )}
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
      <ArchiveFindingDialog
        project={project}
        finding={archiveFinding}
        onClose={() => setArchiveFinding(undefined)}
        onSaved={() => void loadReport()}
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
                      { key: 'state', label: '执行状态', children: run.state },
                      {
                        key: 'progress',
                        label: '进度声明',
                        children: `${run.completedItems}/${run.totalItems} · sequence ${run.progressSequence} · ${run.progressClosedAt ? '平台进度展示已关闭，仍按协议接收上报' : '平台进度展示未关闭'}`,
                      },
                      {
                        key: 'delivery',
                        label: '交付状态',
                        children: run.deliveryStatus,
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
                {run?.kind === 'UI' && run.scope.sourceType !== 'uiArchive' && (
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
                      <Tag>原回执交付：{receipt.receipt.deliveryStatus}</Tag>
                      <Tag>当前交付：{receipt.currentDelivery.status}</Tag>
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
      {!contextMatches && reportId && (
        <Alert
          type="warning"
          title="报告链接属于其他项目，请明确选择原项目后读取。"
          showIcon
        />
      )}
      <Modal
        open={Boolean(reportId && contextMatches)}
        title="报告快照、结果与证据"
        className="report-modal"
        width={1030}
        centered
        zIndex={uiLayers.drawer}
        onCancel={() => {
          setReportId(null);
          window.location.hash = 'reports';
        }}
        footer={
          <Space wrap>
            <Button
              loading={exporting}
              disabled={!report || (revisionId !== 'current' && !historical)}
              onClick={() => void exportReport()}
            >
              {revisionId === 'current'
                ? '生成当前HTML快照并下载'
                : '下载此历史修订HTML'}
            </Button>
            <Button
              disabled={!report}
              onClick={() => {
                if (!navigator.clipboard?.writeText) {
                  setReportNotice(
                    '当前浏览器未开放复制，请从地址栏复制当前报告链接。',
                  );
                  return;
                }
                const url = new URL(window.location.href);
                url.hash = `reports?projectId=${encodeURIComponent(project.id)}&reportId=${encodeURIComponent(reportId!)}${revisionId === 'current' ? '' : `&revisionId=${encodeURIComponent(revisionId)}`}`;
                void navigator.clipboard
                  .writeText(url.toString())
                  .then(() =>
                    setReportNotice(
                      '报告链接已复制；打开时仍按当前账号权限读取。',
                    ),
                  )
                  .catch(() =>
                    setReportNotice(
                      '链接未能复制，请从地址栏复制当前报告链接。',
                    ),
                  );
              }}
            >
              复制报告链接
            </Button>
          </Space>
        }
        destroyOnHidden
      >
        {reportNotice && (
          <p className="caption mb" role="status">
            {reportNotice}
          </p>
        )}
        {detailLoading && <Skeleton active />}
        {detailError && (
          <Alert
            type="error"
            title={detailError}
            showIcon
            className="section-alert"
          />
        )}
        {historyError && (
          <Alert
            type="error"
            title={`所选报告修订未取得：${historyError}`}
            showIcon
            className="section-alert"
          />
        )}
        {report && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Select
              aria-label="报告历史快照"
              style={{ width: '100%' }}
              value={revisionId}
              onChange={(id: string) => {
                setRevisionId(id);
                window.location.hash = `reports?projectId=${project.id}&reportId=${report!.id}${id === 'current' ? '' : `&revisionId=${id}`}`;
              }}
              options={[
                { value: 'current', label: '当前汇总（含读取时的文件可用性）' },
                ...report.history.map((row) => ({
                  value: row.id,
                  label: `历史 r${row.revisionNo} · ${new Date(row.createdAt).toLocaleString('zh-CN')} · ${reportReasons[row.reason] ?? '已保存快照'}`,
                })),
              ]}
            />
            <Space wrap>
              <Button onClick={() => void loadReport()}>
                只读刷新当前汇总
              </Button>
            </Space>
            <Typography.Text type="secondary">
              当前汇总导出会保存新快照；历史导出只读取选定存档。证据原件仍独立鉴权下载，不借当前事实补写旧存档。
            </Typography.Text>
            {historyLoading && <Skeleton active />}
            {facts && (
              <>
                <div className="between">
                  <div>
                    <h2>
                      {facts.kind === 'UI'
                        ? 'UI 自主测试执行报告'
                        : '接口回归执行报告'}
                    </h2>
                    <p className="caption">
                      事实截取于{' '}
                      {new Date(facts.capturedAt).toLocaleString('zh-CN')}
                      {facts.scope.productBuild
                        ? ` · 被测版本 ${facts.scope.productBuild}`
                        : ''}
                    </p>
                  </div>
                  <span className="badge">
                    {executionLabels[facts.executionState] ??
                      facts.executionState}
                  </span>
                </div>
                <div className="row wrap">
                  <span className="caption">当前有效口径</span>
                  <span className="badge green">
                    通过 {facts.statistics.effective.passed}
                  </span>
                  <span className="badge red">
                    失败 {facts.statistics.effective.failed}
                  </span>
                  <span className="badge amber">
                    未执行 {facts.statistics.effective.notExecuted}
                  </span>
                  {BigInt(facts.statistics.effective.inconclusive) > 0n && (
                    <span className="badge">
                      证据不足 {facts.statistics.effective.inconclusive}
                    </span>
                  )}
                  {BigInt(facts.statistics.effective.blocked) > 0n && (
                    <span className="badge amber">
                      受阻 {facts.statistics.effective.blocked}
                    </span>
                  )}
                  <span
                    className={`badge ${facts.deliveryStatus === 'complete' ? 'green' : 'amber'}`}
                  >
                    交付
                    {deliveryLabels[facts.deliveryStatus] ??
                      facts.deliveryStatus}
                  </span>
                </div>
                {facts.executionProvenance === 'protocol-synthetic' && (
                  <div className="notice">
                    数据来源：合成协议结果，没有执行真实 UI 目标。
                  </div>
                )}
                <p className="caption">
                  固定 {facts.statistics.denominator} 项 · 已回传{' '}
                  {facts.statistics.reportedItems} 项 · 缺失文件{' '}
                  {facts.missingFileIds.length} 个 · 清理
                  {cleanupLabels[facts.cleanupState] ?? facts.cleanupState}
                </p>
                <Collapse
                  items={[
                    {
                      key: 'record-identifiers',
                      label: '查看轮次、快照与范围标识',
                      children: (
                        <Descriptions
                          bordered
                          size="small"
                          column={1}
                          items={[
                            {
                              key: 'report',
                              label: '报告ID',
                              children: report.id,
                            },
                            {
                              key: 'revision',
                              label: '当前查看',
                              children:
                                revisionId === 'current'
                                  ? `当前汇总 · 当前保存快照 ${report.revisionId}`
                                  : `存档 ${historical?.revisionId ?? revisionId}`,
                            },
                            {
                              key: 'captured',
                              label: '事实截取时间',
                              children: facts.capturedAt,
                            },
                            {
                              key: 'run',
                              label: '执行轮次/状态',
                              children: `${facts.runId} / ${executionLabels[facts.executionState] ?? facts.executionState}`,
                            },
                            {
                              key: 'origin',
                              label: '执行来源',
                              children:
                                originLabels[facts.executionProvenance] ??
                                facts.executionProvenance,
                            },
                            {
                              key: 'cleanup',
                              label: '清理状态',
                              children:
                                cleanupLabels[facts.cleanupState] ??
                                facts.cleanupState,
                            },
                            {
                              key: 'delivery',
                              label: '交付完整性',
                              children: `${deliveryLabels[facts.deliveryStatus] ?? facts.deliveryStatus} · 缺失文件${facts.missingFileIds.length}个`,
                            },
                            {
                              key: 'denom',
                              label: '固定统计分母',
                              children: `${facts.statistics.denominator}项；已回传${facts.statistics.reportedItems}项；范围摘要${facts.scope.snapshotDigest}`,
                            },
                          ]}
                        />
                      ),
                    },
                  ]}
                />
                <Table
                  size="small"
                  rowKey="policy"
                  pagination={false}
                  dataSource={[
                    {
                      policy: '首次采集原始判断',
                      ...facts.statistics.original,
                    },
                    {
                      policy: '当前采集修订判断',
                      ...facts.statistics.reported,
                    },
                    { policy: '独立人工最终结论', ...facts.statistics.final },
                    {
                      policy: '有效结论（人工优先，否则当前采集）',
                      ...facts.statistics.effective,
                    },
                  ]}
                  scroll={{ x: 850 }}
                  columns={[
                    { title: '口径', dataIndex: 'policy' },
                    ...[
                      'passed',
                      'failed',
                      'blocked',
                      'inconclusive',
                      'notExecuted',
                      'notReported',
                      'notAssessed',
                    ].map((key) => ({
                      title: outcomeLabels[key],
                      dataIndex: key,
                      render: (value: number | undefined) =>
                        value === undefined ? '不适用' : value,
                    })),
                  ]}
                />
                {facts.scope.sourceType === 'uiArchive' && (
                  <Alert
                    type="info"
                    showIcon
                    title="独立执行归档"
                    description="此报告记录本地已发生的事实。可登记问题，统计独立于正式计划与复测。"
                  />
                )}
                <Table
                  rowKey={(row) => row.scopeItem.runItemId}
                  pagination={{ pageSize: 10 }}
                  dataSource={facts.items}
                  scroll={{ x: 1150 }}
                  columns={[
                    {
                      title: '场景/用例',
                      render: (_, row) => (
                        <>
                          <Typography.Text>
                            {row.scopeItem.scenario.title}
                          </Typography.Text>
                          <br />
                          <Typography.Text strong>
                            {row.scopeItem.content.title}
                          </Typography.Text>
                          {'localItemId' in row.scopeItem && (
                            <div className="caption">
                              {row.scopeItem.localItemId} ·{' '}
                              {row.scopeItem.caseId
                                ? '关联平台用例修订'
                                : '本地条目'}
                            </div>
                          )}
                        </>
                      ),
                    },
                    {
                      title: '首次采集',
                      render: (_, row) =>
                        outcomeLabels[
                          row.result?.initialOutcome ?? 'notReported'
                        ],
                    },
                    {
                      title: '当前采集',
                      render: (_, row) =>
                        outcomeLabels[
                          row.result?.reportedOutcome ?? 'notReported'
                        ],
                    },
                    {
                      title: '人工最终',
                      render: (_, row) =>
                        outcomeLabels[
                          row.result?.finalOutcome ??
                            (row.result ? 'notAssessed' : 'notReported')
                        ],
                    },
                    {
                      title: '清理',
                      render: (_, row) =>
                        row.result
                          ? (cleanupLabels[row.result.cleanupState] ??
                            row.result.cleanupState)
                          : '无回传事实',
                    },
                    {
                      title: '结果详情',
                      render: (_, row) =>
                        row.result ? (
                          <Space direction="vertical">
                            <Button
                              onClick={() =>
                                setSelectedResult({
                                  id: row.result!.id,
                                  revisionId: row.result!.revisionId,
                                  kind: facts.kind,
                                })
                              }
                            >
                              事实、人工结论与证据
                            </Button>
                            {'localItemId' in row.scopeItem &&
                              project.roles.includes('tester') &&
                              revisionId === 'current' && (
                                <Button
                                  onClick={() =>
                                    setArchiveFinding({
                                      title: row.scopeItem.content.title,
                                      runId: facts.runId,
                                      resultId: row.result!.id,
                                      requirementId:
                                        'requirementId' in row.scopeItem
                                          ? row.scopeItem.requirementId
                                          : '',
                                      requirementVersionId:
                                        row.scopeItem.requirementVersionId,
                                      observations:
                                        row.result!.content.actualObservations,
                                      evidenceRefs:
                                        row.result!.content.evidenceRefs,
                                    })
                                  }
                                >
                                  登记问题
                                </Button>
                              )}
                            {row.result.assessmentBasisChanged && (
                              <Typography.Text type="warning">
                                人工结论基准与当前采集修订不同
                              </Typography.Text>
                            )}
                          </Space>
                        ) : (
                          '未回传，不构造通过/失败'
                        ),
                    },
                  ]}
                />
                {facts.kind === 'UI' &&
                  facts.scope.sourceType !== 'uiArchive' && (
                    <UiDeliveryPanel
                      key={facts.runId}
                      projectId={project.id}
                      runId={facts.runId}
                      scopeItems={facts.scope.items}
                    />
                  )}
                {currentHandling && (
                  <ReportHandlingPanel
                    projectId={project.id}
                    handling={currentHandling}
                    label="读取时的当前问题与缺陷处理"
                    factsCapturedAt={facts.capturedAt}
                  />
                )}
                {revisionId !== 'current' && historical && (
                  <Collapse
                    items={[
                      {
                        key: 'handling-at-capture',
                        label: '查看此历史修订保存时的处理状态',
                        children: historical.handlingAtCapture ? (
                          <ReportHandlingPanel
                            projectId={project.id}
                            handling={historical.handlingAtCapture}
                            label={`历史 r${historical.revisionNo} 保存时的处理快照`}
                            factsCapturedAt={historical.facts.capturedAt}
                          />
                        ) : (
                          <p className="caption">
                            此旧存档未记录当时处理状态，未以当前数据补填。
                          </p>
                        ),
                      },
                    ]}
                  />
                )}
                <Card size="small" title="报告证据清单">
                  <Table
                    rowKey="id"
                    dataSource={facts.evidence}
                    pagination={{ pageSize: 10 }}
                    scroll={{ x: 900 }}
                    columns={[
                      {
                        title: '原件',
                        render: (_, row) => (
                          <Button
                            type="link"
                            onClick={() => setFileId(row.fileId)}
                          >
                            {row.originalName}
                          </Button>
                        ),
                      },
                      {
                        title: '来源/采集',
                        render: (_, row) =>
                          `${row.manifest.source} / ${row.manifest.captureCompleteness}`,
                      },
                      { title: '类型', render: (_, row) => row.manifest.type },
                      {
                        title: '记录时字节状态',
                        dataIndex: 'lastKnownFileStatus',
                      },
                      {
                        title: 'SHA-256',
                        render: (_, row) => (
                          <Typography.Text code>
                            {row.manifest.sha256}
                          </Typography.Text>
                        ),
                      },
                    ]}
                  />
                </Card>
              </>
            )}
          </Space>
        )}
      </Modal>
      <ResultDetailPanel
        project={project}
        {...(visibleResult?.kind ? { executionKind: visibleResult.kind } : {})}
        resultId={visibleResult?.id ?? null}
        {...(visibleResult?.revisionId
          ? { reportBasisRevisionId: visibleResult.revisionId }
          : {})}
        onClose={() => setSelectedResult(null)}
        onChanged={async () => {
          await loadReport();
          await load();
        }}
      />
      <EvidenceViewer fileId={fileId} onClose={() => setFileId(null)} />
    </div>
  );
}
