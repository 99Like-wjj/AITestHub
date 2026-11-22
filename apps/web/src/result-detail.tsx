import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Collapse,
  Descriptions,
  Form,
  Input,
  Modal,
  Select,
  Skeleton,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  Upload,
} from 'antd';
import { z } from 'zod';
import {
  resultAmendmentSchema,
  evidenceManifestItemSchema,
  uiOutcomeSchema,
} from '../../../packages/contracts/src/domain';
import {
  resultDetailSchema,
  finalAssessmentInputSchema,
  webFinalAssessmentInputSchema,
  supplementaryEvidenceInputSchema,
  assessmentReceiptSchema,
  amendmentReceiptSchema,
  evidenceAdditionReceiptSchema,
  runStatusSchema,
} from '../../../packages/contracts/src/ui-results';
import type { FileMetadata } from '../../../packages/contracts/src/files';
import type { ReportProblemReviewScope } from '../../../packages/contracts/src/issues';
import { api, ApiError, describeError } from './api';
import { uploadProjectFile } from './file-channel';
import { EvidenceViewer } from './evidence-viewer';
import { EvidenceGallery } from './evidence-gallery';
import type { EvidenceGalleryItem } from './evidence-gallery';
import {
  EvidenceGapList,
  outcomeLabels,
  OverallObservation,
  ResultOutcomeTag,
  ResultUiSteps,
} from './result-steps';
import { ApiResultTrace } from './api-result-trace';
import type { Project } from './types';
import { uiLayers } from './ui-layers';
import { DetailDrawer } from './detail-drawer';
import { BeijingTime } from './beijing-time';
import {
  ReportReceiptControl,
  useReportCommandRecovery,
} from './report-command-recovery';

type Result = z.infer<typeof resultDetailSchema>['result'];
export { outcomeLabels } from './result-steps';
const errors = (failure: unknown) =>
  failure instanceof z.ZodError
    ? failure.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('；')
    : describeError(failure);
const unknownWrite = (failure: unknown) =>
  failure instanceof ApiError &&
  (failure.status === 0 || failure.status >= 500);

function EvidenceAddition({
  projectId,
  result,
  onClose,
  onSaved,
}: {
  projectId: string;
  result: Result | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form] = Form.useForm<{
    type: z.infer<typeof evidenceManifestItemSchema>['type'];
    captureCompleteness: z.infer<
      typeof evidenceManifestItemSchema
    >['captureCompleteness'];
    capturedAt: string;
  }>();
  const [file, setFile] = useState<File | null>(null);
  const [uploaded, setUploaded] = useState<FileMetadata | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string>();
  const localFileId = useRef<string>(crypto.randomUUID());
  const evidenceId = useRef<string>(crypto.randomUUID());
  const commandId = useRef<string>(crypto.randomUUID());
  useEffect(() => {
    form.resetFields();
    setFile(null);
    setUploaded(null);
    setError(undefined);
    setUncertain(false);
    localFileId.current = crypto.randomUUID();
    evidenceId.current = crypto.randomUUID();
    commandId.current = crypto.randomUUID();
  }, [result, form]);
  async function upload(selected = file) {
    if (!selected || !result || uploading) return;
    setUploading(true);
    setError(undefined);
    try {
      setUploaded(
        await uploadProjectFile(
          projectId,
          selected,
          localFileId.current,
          result.runId,
        ),
      );
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setUploading(false);
    }
  }
  async function save(values: {
    type: z.infer<typeof evidenceManifestItemSchema>['type'];
    captureCompleteness: z.infer<
      typeof evidenceManifestItemSchema
    >['captureCompleteness'];
    capturedAt: string;
  }) {
    if (!result || !uploaded || pending || uncertain) return;
    setPending(true);
    setError(undefined);
    try {
      const body = supplementaryEvidenceInputSchema.parse({
        commandId: commandId.current,
        resultId: result.id,
        evidenceManifest: [
          {
            localEvidenceId: evidenceId.current,
            fileId: uploaded.id,
            sha256: uploaded.sha256,
            bytes: uploaded.bytes,
            type: values.type,
            captureCompleteness: values.captureCompleteness,
            source: 'manualAddition',
            ...(values.capturedAt
              ? { capturedAt: new Date(values.capturedAt).toISOString() }
              : {}),
          },
        ],
      });
      const response = await api(
        `/projects/${projectId}/results/${result.id}/evidence-additions`,
        { method: 'POST', body },
        evidenceAdditionReceiptSchema,
      );
      if (response.resultId !== result.id)
        throw new Error('补证回执结果标识不匹配。');
      await onSaved();
      onClose();
    } catch (failure) {
      if (unknownWrite(failure)) setUncertain(true);
      setError(errors(failure));
    } finally {
      setPending(false);
    }
  }
  return (
    <Modal
      open={result !== null}
      zIndex={uiLayers.dialog}
      title="人工补充证据"
      onCancel={onClose}
      closable={!pending && !uploading}
      maskClosable={!pending && !uploading}
      keyboard={!pending && !uploading}
      onOk={() => form.submit()}
      confirmLoading={pending}
      okButtonProps={{ disabled: !uploaded || uncertain || uploading }}
      okText="关联此证据，不改变结论"
      cancelText="关闭"
      destroyOnHidden
    >
      <Alert
        type="info"
        showIcon
        title="人工补证单独标记，不冒充原始采集"
        description="文件完整上传并验证字节后才关联。补证不重新执行测试，不自动修改原始或人工结论。关闭未关联窗口不产生补证成功回执。"
        className="section-alert"
      />
      {error && (
        <Alert type="error" showIcon title={error} className="section-alert" />
      )}
      {uncertain && (
        <Alert
          type="warning"
          showIcon
          title={`补证回执未知：${commandId.current}`}
          description="已禁重发；只读刷新当前结果核对关联，不新建标识重放未知操作。"
        />
      )}
      <Upload
        showUploadList={false}
        disabled={pending || uploading || uncertain}
        beforeUpload={(selected) => {
          localFileId.current = crypto.randomUUID();
          setFile(selected);
          setUploaded(null);
          void upload(selected);
          return false;
        }}
      >
        <Button loading={uploading} disabled={pending || uncertain}>
          选择并完整上传文件
        </Button>
      </Upload>
      {file && (
        <Typography.Paragraph>
          {file.name} ·{' '}
          {uploaded ? '字节已验证，尚待明确关联' : '尚未取得字节验证回执'}
        </Typography.Paragraph>
      )}
      {file && !uploaded && !uploading && (
        <Button disabled={pending || uncertain} onClick={() => void upload()}>
          完整重传同一文件
        </Button>
      )}
      <Form
        form={form}
        layout="vertical"
        onFinish={(values) => void save(values)}
      >
        <Form.Item name="type" label="证据类型" rules={[{ required: true }]}>
          <Select
            disabled={pending}
            options={evidenceManifestItemSchema.shape.type.options.map(
              (value) => ({ value, label: value }),
            )}
          />
        </Form.Item>
        <Form.Item
          name="captureCompleteness"
          label="采集完整性（人工声明）"
          rules={[{ required: true }]}
        >
          <Select
            disabled={pending}
            options={evidenceManifestItemSchema.shape.captureCompleteness.options.map(
              (value) => ({ value, label: value }),
            )}
          />
        </Form.Item>
        <Form.Item name="capturedAt" label="原采集时间（人工声明，可留空）">
          <Input type="datetime-local" disabled={pending} />
        </Form.Item>
      </Form>
      <Typography.Text type="secondary">
        本地证据ID：{evidenceId.current} · 提交：{commandId.current}
      </Typography.Text>
    </Modal>
  );
}

export function ResultDetailPanel({
  project,
  executionKind,
  resultId,
  reportBasisRevisionId,
  initialStep,
  returnTo,
  inline = false,
  archivedAssessment,
  reportReview,
  readOnly = false,
  onRevisionSelect,
  onStepSelect,
  onClose,
  onChanged,
}: {
  project: Project;
  executionKind?: 'UI' | 'API';
  resultId: string | null;
  reportBasisRevisionId?: string;
  initialStep?: number;
  returnTo?: string;
  inline?: boolean;
  archivedAssessment?: { outcome: string | null; reason: string | null };
  reportReview?: ReportProblemReviewScope;
  readOnly?: boolean;
  onRevisionSelect?: (id: string) => void;
  onStepSelect?: (ordinal: number) => void;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [loadedResult, setResult] = useState<{
    projectId: string;
    result: Result;
  } | null>(null);
  const result =
    loadedResult?.projectId === project.id &&
    loadedResult.result.id === resultId
      ? loadedResult.result
      : null;
  const [resolvedKind, setResolvedKind] = useState<'UI' | 'API' | null>(
    executionKind ?? null,
  );
  const [kindError, setKindError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<EvidenceGalleryItem | null>(null);
  const [evidenceTarget, setEvidenceTarget] = useState<Result | null>(null);
  const [editor, setEditor] = useState<{
    mode: 'assess' | 'amend';
    basis: Result;
    commandId: string;
  } | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [discardEditor, setDiscardEditor] = useState(false);
  const [pending, setPending] = useState(false);
  const [editError, setEditError] = useState<string>();
  const [uncertain, setUncertain] = useState(false);
  const [form] = Form.useForm<{
    outcome: string;
    reason: string;
    observations: string;
    actions: string;
    sideEffectCertainty: string;
  }>();
  const generation = useRef(0);
  const canAssess =
    !readOnly && !archivedAssessment && project.roles.includes('tester');
  const recovery = useReportCommandRecovery(
    project.id,
    'results.assess',
    reportReview?.resultId ?? null,
  );
  async function load(
    signal?: AbortSignal,
    selection: 'initial' | 'preserve' | 'latest' = 'preserve',
  ) {
    const epoch = ++generation.current;
    if (!resultId) return;
    setLoading(true);
    try {
      const response = await api(
        `/projects/${project.id}/results/${resultId}`,
        signal ? { signal } : {},
        resultDetailSchema,
      );
      if (!signal?.aborted && epoch === generation.current) {
        setResult({ projectId: project.id, result: response.result });
        setRevisionId((current) =>
          selection === 'latest'
            ? response.result.revisionId
            : selection === 'initial'
              ? (reportBasisRevisionId ?? response.result.revisionId)
              : (current ??
                reportBasisRevisionId ??
                response.result.revisionId),
        );
        setError(undefined);
        const kind = executionKind ?? response.result.scopeItem?.kind;
        if (kind) {
          setResolvedKind(kind);
          setKindError(undefined);
        } else {
          try {
            const run = await api(
              `/projects/${project.id}/ui-executions/${response.result.runId}`,
              signal ? { signal } : {},
              runStatusSchema,
            );
            if (!signal?.aborted && epoch === generation.current) {
              setResolvedKind(run.kind);
              setKindError(undefined);
            }
          } catch (failure) {
            if (!signal?.aborted && epoch === generation.current)
              setKindError(describeError(failure));
          }
        }
      }
    } catch (failure) {
      if (!signal?.aborted && epoch === generation.current) {
        setResult(null);
        setError(describeError(failure));
      }
    } finally {
      if (!signal?.aborted && epoch === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    setResolvedKind(executionKind ?? null);
    setKindError(undefined);
    setEditor(null);
    setEvidence(null);
    setEvidenceTarget(null);
    setRevisionId(null);
    setError(undefined);
    setLoading(false);
    void load(controller.signal, 'initial');
    return () => controller.abort();
  }, [project.id, resultId, executionKind, reportBasisRevisionId]);
  const revision = result?.history.find((row) => row.id === revisionId);
  const viewingCurrent = !!result && revisionId === result.revisionId;
  const content =
    revision?.content ?? (viewingCurrent ? result?.content : undefined);
  const refs = new Set(content?.evidenceRefs ?? []);
  const linkedEvidence = (result?.evidence ?? [])
    .filter((item) => refs.has(item.manifest.localEvidenceId))
    .map((item) => ({
      ...item,
      source:
        item.source === 'manualAddition' ? item.source : item.manifest.source,
    }));
  const manualEvidence = (result?.evidence ?? []).filter(
    (item) =>
      item.source === 'manualAddition' &&
      !refs.has(item.manifest.localEvidenceId),
  );
  const assessment = result?.assessments.find(
    (row) => row.id === result.assessmentRevisionId,
  );
  function openEditor(mode: 'assess' | 'amend') {
    if (!result || !viewingCurrent || !canAssess) return;
    setEditor({ mode, basis: result, commandId: crypto.randomUUID() });
    setEditorDirty(false);
    setDiscardEditor(false);
    setEditError(undefined);
    setUncertain(false);
    form.resetFields();
    form.setFieldsValue({
      outcome:
        mode === 'assess'
          ? (assessment?.finalOutcome ?? result.content.originalOutcome)
          : result.content.originalOutcome,
      reason: '',
      observations: result.content.actualObservations,
      actions: result.content.actualActions?.join('\n') ?? '',
      sideEffectCertainty: result.content.sideEffectCertainty,
    });
  }
  function closeEditor() {
    if (pending) return;
    if (editorDirty) setDiscardEditor(true);
    else setEditor(null);
  }
  async function save(values: {
    outcome: string;
    reason: string;
    observations: string;
    actions: string;
    sideEffectCertainty: string;
  }) {
    if (!editor || pending || uncertain || recovery.commandId || !canAssess)
      return;
    setPending(true);
    setEditError(undefined);
    try {
      if (editor.mode === 'assess') {
        const body = (
          reportReview
            ? webFinalAssessmentInputSchema
            : finalAssessmentInputSchema
        ).parse({
          commandId: editor.commandId,
          baseResultRevisionId: editor.basis.revisionId,
          baseAssessmentRevisionId: editor.basis.assessmentRevisionId,
          finalOutcome: values.outcome,
          reason: values.reason ?? '',
          ...(reportReview ? { reportReview } : {}),
        });
        const request = async () => {
          const response = await api(
            `/projects/${project.id}/results/${editor.basis.id}/assessment`,
            { method: 'POST', body },
            assessmentReceiptSchema,
          );
          if (response.resultId !== editor.basis.id)
            throw new ApiError(
              '人工结论回执不匹配。',
              502,
              'RECEIPT_SCOPE_MISMATCH',
            );
          return response;
        };
        await (reportReview
          ? recovery.send(editor.commandId, request)
          : request());
      } else {
        const body = resultAmendmentSchema.parse({
          schemaVersion: 'ath.result-amendment.v1',
          runId: editor.basis.runId,
          amendmentId: editor.commandId,
          resultId: editor.basis.id,
          baseResultRevisionId: editor.basis.revisionId,
          reason: values.reason,
          replacement: {
            ...editor.basis.content,
            originalOutcome: values.outcome,
            actualObservations: values.observations,
            actualActions: values.actions.split('\n').filter(Boolean),
            sideEffectCertainty: values.sideEffectCertainty,
          },
        });
        const response = await api(
          `/projects/${project.id}/result-amendments`,
          { method: 'POST', body },
          amendmentReceiptSchema,
        );
        if (response.resultId !== editor.basis.id)
          throw new Error('事实更正回执不匹配。');
      }
      setEditor(null);
      setEditorDirty(false);
      await load(undefined, editor.mode === 'amend' ? 'latest' : 'preserve');
      await onChanged();
    } catch (failure) {
      if (unknownWrite(failure)) setUncertain(true);
      setEditError(errors(failure));
    } finally {
      setPending(false);
    }
  }
  function recoverAssessment() {
    if (!reportReview) return;
    void recovery.check(
      assessmentReceiptSchema,
      async (value) => {
        if (value.resultId !== reportReview.resultId)
          throw new Error('原人工判断回执不属于当前结果。');
        setEditor(null);
        setEditorDirty(false);
        setUncertain(false);
        await load();
        await onChanged();
      },
      () => {
        setUncertain(false);
        setEditor((previous) =>
          previous ? { ...previous, commandId: crypto.randomUUID() } : null,
        );
      },
    );
  }
  function selectRevision(id: string) {
    if (onRevisionSelect) onRevisionSelect(id);
    else setRevisionId(id);
  }
  const detail = (
    <>
      {loading && <Skeleton active />}
      {error && <Alert type="error" showIcon title={error} />}
      {result && (
        <div className="result-review">
          <div className="result-review-header">
            <div>
              {inline && <h2>{result.scopeItem?.title ?? '执行结果详情'}</h2>}
              {result.scopeItem?.dataRow && (
                <Tag color="cyan">
                  数据行 {result.scopeItem.dataRow.name} ·{' '}
                  {result.scopeItem.dataRow.id}
                </Tag>
              )}
              {result.scopeItem?.preparationSources?.length ? (
                <Tag>
                  固定准备修订 {result.scopeItem.preparationSources.length} 项
                </Tag>
              ) : null}
              {inline && (
                <small className="result-review-muted result-review-id">
                  原执行 {result.runId}
                </small>
              )}
            </div>
            {inline && returnTo && <Button href={returnTo}>返回缺陷</Button>}
          </div>
          <div className="result-review-meta">
            <div>
              <small>用例快照</small>
              <strong>
                {result.scopeItem?.revisionNo
                  ? `r${result.scopeItem.revisionNo}`
                  : (result.scopeItem?.revisionId ?? '未记录修订')}
              </strong>
            </div>
            <div>
              <small>
                采集判断 · {revision ? `r${revision.revisionNo}` : '所选修订'}
              </small>
              <div>
                {content ? (
                  <ResultOutcomeTag outcome={content.originalOutcome} />
                ) : (
                  '未取得所选修订'
                )}
              </div>
            </div>
            <div>
              <small>
                {archivedAssessment ? '存档时的人工结论' : '当前人工最终结论'}
              </small>
              <div>
                <ResultOutcomeTag
                  outcome={
                    (archivedAssessment
                      ? archivedAssessment.outcome
                      : assessment?.finalOutcome) ?? 'notAssessed'
                  }
                />
              </div>
            </div>
          </div>
          <div className="result-review-basis">
            <div>
              <strong>
                {reportBasisRevisionId && revisionId === reportBasisRevisionId
                  ? '来源绑定的采集修订'
                  : viewingCurrent
                    ? '当前采集修订'
                    : '历史采集修订'}
              </strong>
              <div className="result-review-muted">
                {revision && `r${revision.revisionNo}`}
                {revision?.createdAt && (
                  <>
                    {' '}
                    · <BeijingTime value={revision.createdAt} detail />
                  </>
                )}
                {revision?.reason && ` · ${revision.reason}`}
              </div>
            </div>
            <Select
              aria-label="结果采集修订历史"
              value={revisionId}
              disabled={!!archivedAssessment}
              onChange={selectRevision}
              options={result.history.map((row) => ({
                value: row.id,
                label: `r${row.revisionNo}${row.id === reportBasisRevisionId ? ' · 来源绑定' : ''}${row.id === result.revisionId ? ' · 当前' : ''}`,
              }))}
            />
            {!viewingCurrent && !archivedAssessment && (
              <Button onClick={() => selectRevision(result.revisionId)}>
                查看当前修订
              </Button>
            )}
          </div>
          {kindError && (
            <Alert
              type="warning"
              title="未取得执行类型"
              description={kindError}
              showIcon
            />
          )}
          {!content ? (
            <Alert
              type="warning"
              showIcon
              title="来源引用的采集修订未取得"
              description="可选择其他有记录的修订。"
            />
          ) : (
            <Tabs
              key={`${result.id}:${resolvedKind ?? ''}`}
              items={[
                {
                  key: 'steps',
                  label: resolvedKind === 'API' ? '请求与断言' : '步骤与证据',
                  children:
                    resolvedKind === 'API' ? (
                      <div className="result-review-content">
                        <ApiResultTrace
                          key={`${result.runId}:${result.runItemId}:${initialStep ?? ''}`}
                          projectId={project.id}
                          runId={result.runId}
                          runItemId={result.runItemId}
                          initialStep={initialStep}
                        />
                        <Collapse
                          items={[
                            {
                              key: 'original',
                              label: '原始诊断记录',
                              children: (
                                <OverallObservation content={content} />
                              ),
                            },
                          ]}
                        />
                      </div>
                    ) : (
                      <ResultUiSteps
                        key={`${revisionId}:${initialStep ?? ''}`}
                        content={content}
                        scope={result.scopeItem}
                        evidence={linkedEvidence}
                        initialStep={initialStep}
                        onStepSelect={onStepSelect}
                        onOpen={setEvidence}
                      />
                    ),
                },
                {
                  key: 'evidence',
                  label: '证据清单',
                  children: (
                    <div className="result-review-content">
                      <h3>所选修订关联的证据</h3>
                      <EvidenceGallery
                        key={revisionId}
                        items={linkedEvidence}
                        onOpen={setEvidence}
                      />
                      {content.evidenceGaps?.length ? (
                        <>
                          <h3>待处理的证据</h3>
                          <EvidenceGapList gaps={content.evidenceGaps} />
                        </>
                      ) : null}
                      {!archivedAssessment &&
                        viewingCurrent &&
                        manualEvidence.length > 0 && (
                          <>
                            <h3>人工补证</h3>
                            <EvidenceGallery
                              items={manualEvidence}
                              onOpen={setEvidence}
                            />
                          </>
                        )}
                    </div>
                  ),
                },
                {
                  key: 'handling',
                  label: '判断记录',
                  children: (
                    <div className="result-review-content">
                      <Descriptions
                        size="small"
                        bordered
                        column={2}
                        items={[
                          {
                            key: 'initial',
                            label: '首次采集原始判断',
                            children: (
                              <ResultOutcomeTag
                                outcome={
                                  result.history.find(
                                    (row) => row.revisionNo === 1,
                                  )?.content.originalOutcome ?? 'notReported'
                                }
                              />
                            ),
                          },
                          {
                            key: 'current',
                            label: '当前采集修订判断',
                            children: (
                              <ResultOutcomeTag
                                outcome={result.content.originalOutcome}
                              />
                            ),
                          },
                          {
                            key: 'certainty',
                            label: '所选修订副作用确定性',
                            children: content.sideEffectCertainty,
                          },
                          {
                            key: 'times',
                            label: '执行时间',
                            children: `${content.startedAt ?? '未记录'} — ${content.endedAt ?? '未记录'}`,
                          },
                        ]}
                      />
                      {archivedAssessment ? (
                        <Typography.Paragraph>
                          {archivedAssessment.reason ??
                            '本报告修订未保存人工结论说明。'}
                        </Typography.Paragraph>
                      ) : (
                        <>
                          <Space wrap>
                            <Button onClick={() => void load()}>
                              刷新结果记录
                            </Button>
                            <Button
                              disabled={
                                !canAssess ||
                                !viewingCurrent ||
                                !!recovery.commandId
                              }
                              onClick={() => openEditor('assess')}
                            >
                              登记人工最终结论
                            </Button>
                            <Button
                              disabled={
                                !canAssess ||
                                !viewingCurrent ||
                                !result.history.length ||
                                resolvedKind !== 'UI'
                              }
                              onClick={() => openEditor('amend')}
                            >
                              申请更正 UI 采集事实
                            </Button>
                            <Button
                              disabled={!canAssess || !viewingCurrent}
                              onClick={() => setEvidenceTarget(result)}
                            >
                              人工补充证据
                            </Button>
                          </Space>
                          <Table
                            rowKey="id"
                            pagination={false}
                            dataSource={result.assessments}
                            scroll={{ x: 700 }}
                            columns={[
                              {
                                title: '人工判断',
                                render: (_, row) => (
                                  <Space>
                                    <ResultOutcomeTag
                                      outcome={row.finalOutcome}
                                    />
                                    {row.id === result.assessmentRevisionId &&
                                      '当前'}
                                  </Space>
                                ),
                              },
                              { title: '原因', dataIndex: 'reason' },
                              { title: '操作者', dataIndex: 'actorId' },
                              {
                                title: '时间',
                                dataIndex: 'createdAt',
                                render: (value: string) => (
                                  <BeijingTime value={value} />
                                ),
                              },
                            ]}
                            locale={{ emptyText: '尚无人工最终结论' }}
                          />
                        </>
                      )}
                    </div>
                  ),
                },
              ]}
            />
          )}
        </div>
      )}
    </>
  );
  return (
    <>
      {inline ? (
        detail
      ) : (
        <DetailDrawer
          open={resultId !== null}
          title={result?.scopeItem?.title ?? '结果事实、人工结论与证据'}
          meta={result && `原执行 ${result.runId}`}
          extra={returnTo && <Button href={returnTo}>返回缺陷</Button>}
          wide
          onClose={onClose}
        >
          {detail}
        </DetailDrawer>
      )}
      {reportReview && !archivedAssessment && (
        <ReportReceiptControl recovery={recovery} onCheck={recoverAssessment} />
      )}
      <Modal
        open={editor !== null}
        zIndex={uiLayers.dialog}
        title={
          editor?.mode === 'assess'
            ? '登记独立人工最终结论'
            : '显式更正 UI 采集事实'
        }
        onCancel={closeEditor}
        closable={!pending}
        maskClosable={!pending}
        keyboard={!pending}
        confirmLoading={pending}
        onOk={() => form.submit()}
        okButtonProps={{
          disabled: uncertain || !!recovery.commandId || !canAssess,
        }}
        okText="保存新历史记录"
        cancelText="取消"
        width={750}
        destroyOnHidden
      >
        {reportReview && (
          <ReportReceiptControl
            recovery={recovery}
            onCheck={recoverAssessment}
          />
        )}
        <Alert
          type="info"
          showIcon
          title={
            editor?.mode === 'assess'
              ? '原始事实继续保留；人工最终结论独立记录'
              : '只创建新采集修订，不覆盖原件或重新执行'
          }
          description={`固定基准：${editor?.basis.revisionId ?? ''}；当前人工基准：${editor?.basis.assessmentRevisionId ?? '无'}。并发变化会拒绝旧基准并保留当前输入。`}
          className="section-alert"
        />
        {editError && (
          <Alert
            type="error"
            title={editError}
            showIcon
            className="section-alert"
          />
        )}
        {uncertain && (
          <Alert
            type="warning"
            title={`保存回执未知：${editor?.commandId ?? ''}`}
            description="已禁重发，请只读刷新结果核对原操作，不自动新建标识。"
            showIcon
          />
        )}
        <Form
          form={form}
          layout="vertical"
          onValuesChange={() => setEditorDirty(true)}
          onFinish={(values) => void save(values)}
        >
          <Form.Item
            name="outcome"
            label={
              editor?.mode === 'assess' ? '人工最终结论' : '新采集修订判断'
            }
            rules={[{ required: true }]}
          >
            <Select
              disabled={pending}
              options={uiOutcomeSchema.options.map((value) => ({
                value,
                label: outcomeLabels[value],
              }))}
            />
          </Form.Item>
          <Form.Item
            name="reason"
            label="本次原因与依据"
            rules={
              editor?.mode === 'amend'
                ? [{ required: true, whitespace: true, max: 10000 }]
                : [{ max: 10000 }]
            }
          >
            <Input.TextArea rows={4} disabled={pending} />
          </Form.Item>
          {editor?.mode === 'amend' && (
            <>
              <Form.Item
                name="observations"
                label="实际观察"
                rules={[{ required: true, whitespace: true }]}
              >
                <Input.TextArea rows={5} disabled={pending} />
              </Form.Item>
              <Form.Item name="actions" label="实际动作（每行一项）">
                <Input.TextArea rows={4} disabled={pending} />
              </Form.Item>
              <Form.Item name="sideEffectCertainty" label="副作用确定性">
                <Select
                  disabled={pending}
                  options={['known', 'unknown', 'notApplicable'].map(
                    (value) => ({ value, label: value }),
                  )}
                />
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>
      <Modal
        open={discardEditor}
        zIndex={uiLayers.confirmation}
        title="判断内容有未保存修改"
        onCancel={() => setDiscardEditor(false)}
        footer={
          <Space>
            <Button onClick={() => setDiscardEditor(false)}>继续编辑</Button>
            <Button
              danger
              onClick={() => {
                setDiscardEditor(false);
                setEditor(null);
              }}
            >
              放弃修改
            </Button>
            <Button
              type="primary"
              disabled={uncertain}
              onClick={() => {
                setDiscardEditor(false);
                form.submit();
              }}
            >
              保存
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph>
          保存创建新历史记录；放弃只丢弃当前未保存输入，不改变已保存的判断或事实。
        </Typography.Paragraph>
      </Modal>
      <EvidenceAddition
        projectId={project.id}
        result={evidenceTarget}
        onClose={() => setEvidenceTarget(null)}
        onSaved={async () => {
          await load();
          await onChanged();
        }}
      />
      <EvidenceViewer
        fileId={evidence?.fileId ?? null}
        evidenceType={evidence?.manifest.type}
        onClose={() => setEvidence(null)}
      />
    </>
  );
}
