import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Collapse,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Select,
  Skeleton,
  Space,
  Table,
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
  supplementaryEvidenceInputSchema,
  assessmentReceiptSchema,
  amendmentReceiptSchema,
  evidenceAdditionReceiptSchema,
  runStatusSchema,
} from '../../../packages/contracts/src/ui-results';
import type { FileMetadata } from '../../../packages/contracts/src/files';
import { api, ApiError, describeError } from './api';
import { uploadProjectFile } from './file-channel';
import { EvidenceViewer } from './evidence-viewer';
import type { Project } from './types';
import { uiLayers } from './ui-layers';

type Result = z.infer<typeof resultDetailSchema>['result'];
export const outcomeLabels: Record<string, string> = {
  passed: '通过',
  failed: '失败',
  blocked: '受阻',
  inconclusive: '证据不足',
  notExecuted: '未执行',
  notReported: '未回传',
  notAssessed: '尚无人工最终结论',
};
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
  onClose,
  onChanged,
}: {
  project: Project;
  executionKind?: 'UI' | 'API';
  resultId: string | null;
  reportBasisRevisionId?: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [result, setResult] = useState<Result | null>(null);
  const [resolvedKind, setResolvedKind] = useState<'UI' | 'API' | null>(
    executionKind ?? null,
  );
  const [kindError, setKindError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [fileId, setFileId] = useState<string | null>(null);
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
  const canAssess = project.roles.includes('tester');
  async function load(signal?: AbortSignal) {
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
        setResult(response.result);
        setRevisionId(response.result.revisionId);
        setError(undefined);
        if (!executionKind) {
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
    setFileId(null);
    setEvidenceTarget(null);
    void load(controller.signal);
    return () => controller.abort();
  }, [project.id, resultId, executionKind]);
  const revision = result?.history.find((row) => row.id === revisionId);
  const content = revision?.content ?? result?.content;
  const assessment = result?.assessments.find(
    (row) => row.id === result.assessmentRevisionId,
  );
  function openEditor(mode: 'assess' | 'amend') {
    if (!result) return;
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
    if (!editor || pending || uncertain) return;
    setPending(true);
    setEditError(undefined);
    try {
      if (editor.mode === 'assess') {
        const body = finalAssessmentInputSchema.parse({
          commandId: editor.commandId,
          baseResultRevisionId: editor.basis.revisionId,
          baseAssessmentRevisionId: editor.basis.assessmentRevisionId,
          finalOutcome: values.outcome,
          reason: values.reason ?? '',
        });
        const response = await api(
          `/projects/${project.id}/results/${editor.basis.id}/assessment`,
          { method: 'POST', body },
          assessmentReceiptSchema,
        );
        if (response.resultId !== editor.basis.id)
          throw new Error('人工结论回执不匹配。');
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
      await load();
      await onChanged();
    } catch (failure) {
      if (unknownWrite(failure)) setUncertain(true);
      setEditError(errors(failure));
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <Drawer
        open={resultId !== null}
        zIndex={uiLayers.detail}
        title="结果事实、人工结论与证据"
        width={1100}
        onClose={onClose}
        destroyOnHidden
      >
        {loading && <Skeleton active />}
        {error && <Alert type="error" showIcon title={error} />}
        {result && content && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Descriptions
              bordered
              size="small"
              column={1}
              items={[
                { key: 'id', label: '结果ID', children: result.id },
                {
                  key: 'run',
                  label: '执行/范围项',
                  children: `${result.runId} / ${result.runItemId}`,
                },
                {
                  key: 'original',
                  label: '首次采集原始判断',
                  children:
                    outcomeLabels[
                      result.history.find((row) => row.revisionNo === 1)
                        ?.content.originalOutcome ?? 'notReported'
                    ],
                },
                {
                  key: 'reported',
                  label: '当前采集修订判断',
                  children: outcomeLabels[result.content.originalOutcome],
                },
                {
                  key: 'final',
                  label: '当前人工最终结论',
                  children: assessment
                    ? outcomeLabels[assessment.finalOutcome]
                    : '尚无人工最终结论',
                },
                {
                  key: 'finalreason',
                  label: '当前人工结论依据',
                  children: assessment?.reason ?? '尚未登记',
                },
              ]}
            />
            {reportBasisRevisionId &&
              reportBasisRevisionId !== result.revisionId && (
                <Alert
                  type="info"
                  title={`来源报告绑定 ${reportBasisRevisionId}；此详情查询当前结果 ${result.revisionId}，不能把当前内容套进旧存档。`}
                  showIcon
                />
              )}
            <Space wrap>
              <Button onClick={() => void load()}>只读刷新当前结果</Button>
              <Button
                disabled={!canAssess}
                onClick={() => openEditor('assess')}
              >
                登记人工最终结论
              </Button>
              <Button
                disabled={
                  !canAssess || !result.history.length || resolvedKind !== 'UI'
                }
                onClick={() => openEditor('amend')}
              >
                申请更正 UI 采集事实
              </Button>
              <Button
                disabled={!canAssess}
                onClick={() => setEvidenceTarget(result)}
              >
                人工补充证据
              </Button>
            </Space>
            <Typography.Text type="secondary">
              接口原始事实更正会由服务端拒绝，使用独立人工最终结论；项目管理员不自动取得测试角色。人工判断、补证不执行测试、不改变缺陷状态。
            </Typography.Text>
            {kindError && (
              <Alert
                type="warning"
                title={`未取得原执行类型，暂不开采集更正入口：${kindError}`}
                showIcon
              />
            )}
            <Select
              aria-label="结果采集修订历史"
              value={revisionId}
              onChange={setRevisionId}
              style={{ width: '100%' }}
              options={result.history.map((row) => ({
                value: row.id,
                label: `r${row.revisionNo}${row.id === result.revisionId ? '（当前采集修订）' : ''} · ${row.createdAt} · ${row.reason ?? '原始采集'}`,
              }))}
            />
            <Card
              size="small"
              title={`正在查看的采集修订：${revision?.id ?? result.revisionId} · ${outcomeLabels[content.originalOutcome]}`}
            >
              <Typography.Paragraph className="message-prose">
                {content.actualObservations}
              </Typography.Paragraph>
              {content.reason && (
                <Typography.Paragraph>
                  说明：{content.reason}
                </Typography.Paragraph>
              )}
              <Typography.Paragraph type="secondary">
                副作用确定性：{content.sideEffectCertainty}；开始：
                {content.startedAt ?? '未记录'}；结束：
                {content.endedAt ?? '未记录'}。
              </Typography.Paragraph>
              <Collapse
                items={[
                  {
                    key: 'actual',
                    label: '实际动作与资料依据',
                    children: (
                      <pre className="message-code">
                        {JSON.stringify(
                          {
                            actions: content.actualActions ?? [],
                            basis: content.basis ?? [],
                            evidenceRefs: content.evidenceRefs,
                          },
                          null,
                          2,
                        )}
                      </pre>
                    ),
                  },
                ]}
              />
            </Card>
            <Card size="small" title="独立的人工结论历史">
              <Table
                rowKey="id"
                pagination={false}
                dataSource={result.assessments}
                scroll={{ x: 700 }}
                columns={[
                  {
                    title: '判断',
                    render: (_, row) => (
                      <Space>
                        <Tag>{outcomeLabels[row.finalOutcome]}</Tag>
                        {row.id === result.assessmentRevisionId && '当前'}
                      </Space>
                    ),
                  },
                  { title: '原因', dataIndex: 'reason' },
                  { title: '操作者', dataIndex: 'actorId' },
                  { title: '时间', dataIndex: 'createdAt' },
                ]}
                locale={{ emptyText: '尚无人工最终结论，不伪造为通过。' }}
              />
            </Card>
            <Card size="small" title="结果证据与来源">
              <Table
                rowKey="id"
                pagination={false}
                dataSource={result.evidence}
                scroll={{ x: 700 }}
                columns={[
                  {
                    title: '证据',
                    render: (_, row) => (
                      <Button type="link" onClick={() => setFileId(row.fileId)}>
                        {row.manifest.localEvidenceId}
                      </Button>
                    ),
                  },
                  { title: '类型', render: (_, row) => row.manifest.type },
                  {
                    title: '关联来源',
                    render: (_, row) =>
                      row.source === 'manualAddition'
                        ? '人工补证'
                        : '原采集关联',
                  },
                  {
                    title: '采集声明',
                    render: (_, row) =>
                      `${row.manifest.source} / ${row.manifest.captureCompleteness}`,
                  },
                  { title: '文件ID', dataIndex: 'fileId' },
                ]}
              />
            </Card>
          </Space>
        )}
      </Drawer>
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
        okButtonProps={{ disabled: uncertain }}
        okText="保存新历史记录"
        cancelText="取消"
        width={750}
        destroyOnHidden
      >
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
      <EvidenceViewer fileId={fileId} onClose={() => setFileId(null)} />
    </>
  );
}
