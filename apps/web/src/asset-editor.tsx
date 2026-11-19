import { AuxiliaryAction } from './auxiliary-action';
import { apiCaseContentSchema } from '../../../packages/contracts/src/domain';
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Space,
  Tag,
  Typography,
} from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { z } from 'zod';
import {
  assetReceiptSchema,
  assetOperationStatusSchema,
  assetReceiptOperationSchema,
  createCaseInputSchema,
  createScenarioInputSchema,
  createSetInputSchema,
  reviseAssetInputSchema,
} from '../../../packages/contracts/src/assets';
import type {
  Asset,
  AssetTargetType,
} from '../../../packages/contracts/src/assets';
import { basisRefSchema } from '../../../packages/contracts/src/domain';
import { api, isUncertainMutationError, describeError } from './api';
import { idSchema } from '../../../packages/contracts/src/base';
import {
  ApiCaseFields,
  apiDraftFromContent,
  emptyApiDraft,
  serializeApiDraft,
} from './api-case-fields';
import type { ApiDraft } from './api-case-fields';
import { ApiDraftDebugger } from './api-draft-debugger';
import type { DiagnosticDraft } from './api-draft-debugger';
import { uiLayers } from './ui-layers';

export interface AssetEditorTarget {
  targetType: AssetTargetType;
  kind: 'UI' | 'API';
  requirementVersionId: string;
  setId: string | null;
  scenarioId: string | null;
  asset: Asset | null;
}
type Basis = z.infer<typeof basisRefSchema>;
interface Fields {
  title: string;
  objective: string;
  preconditions: string;
  expected: string;
  testPoint: string;
  steps: { action: string; expected?: string | undefined }[];
}
const lines = (value: string | undefined) =>
  (value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
const caseCommon = (values: Fields, basis: Basis[]) => ({
  title: values.title,
  testPoint: values.testPoint,
  preconditions: lines(values.preconditions),
  expected: values.expected,
  basisRefs: basis,
});
export const targetTypeLabels = {
  set: '测试集/生成批次',
  scenario: '场景',
  case: '用例',
};

export function AssetEditor({
  projectId,
  userId,
  target,
  onClose,
  onSaved,
}: {
  projectId: string;
  userId: string;
  target: AssetEditorTarget | null;
  onClose: () => void;
  onSaved: (asset: Asset) => Promise<void>;
}) {
  const [form] = Form.useForm<Fields>();
  const [basis, setBasis] = useState<Basis[]>([]);
  const [apiDraft, setApiDraft] = useState<ApiDraft | null>(null);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [receiptStatus, setReceiptStatus] = useState<string>();
  const [knownFailed, setKnownFailed] = useState(false);
  const busy = useRef(false);
  const generation = useRef(0);
  const pendingOperation =
    useRef<z.infer<typeof assetReceiptOperationSchema>>('assets.revise');
  const recoveryKey = `aitesthub:asset-editor-receipt:v1:${userId}:${projectId}`;
  const [error, setError] = useState<string>();
  const [dirty, setDirty] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [diagnosticDraft, setDiagnosticDraft] =
    useState<DiagnosticDraft | null>(null);
  const commandId = useRef<string>(crypto.randomUUID());
  useEffect(() => {
    if (!target) return;
    generation.current += 1;
    commandId.current = crypto.randomUUID();
    pendingOperation.current = target.asset
      ? 'assets.revise'
      : target.targetType === 'set'
        ? 'assets.create-set'
        : target.targetType === 'scenario'
          ? 'assets.create-scenario'
          : 'assets.create-case';
    busy.current = false;
    setUncertain(false);
    setRecovering(false);
    setKnownFailed(false);
    setReceiptStatus(undefined);
    try {
      const raw = localStorage.getItem(recoveryKey);
      if (raw) {
        const record = z
          .strictObject({
            commandId: idSchema,
            operation: assetReceiptOperationSchema,
          })
          .safeParse(JSON.parse(raw));
        if (record.success) {
          commandId.current = record.data.commandId;
          pendingOperation.current = record.data.operation;
          setUncertain(true);
          setReceiptStatus('有一笔原资产写入待核对，新保存已禁用。');
        }
      }
    } catch {
      setReceiptStatus(
        '浏览器无法读取待核对标识，请使用此前保留的原commandId。',
      );
    }
    form.resetFields();
    setError(undefined);
    setDirty(false);
    setDiscardOpen(false);
    setDiagnosticDraft(null);
    const content = target.asset?.content;
    form.setFieldsValue({
      title: content?.title ?? '',
      objective: content && 'objective' in content ? content.objective : '',
      preconditions:
        content && 'sharedPreconditions' in content
          ? content.sharedPreconditions.join('\n')
          : content && 'preconditions' in content
            ? content.preconditions.join('\n')
            : '',
      expected: content && 'expected' in content ? content.expected : '',
      testPoint: content && 'testPoint' in content ? content.testPoint : '',
      steps:
        content &&
        'kind' in content &&
        content.kind === 'UI' &&
        'steps' in content
          ? (content.steps ?? [{ action: '' }])
          : [{ action: '' }],
    });
    setBasis(content?.basisRefs ?? []);
    setApiDraft(
      content && 'dslVersion' in content
        ? apiDraftFromContent(content)
        : target.kind === 'API' &&
            target.targetType === 'case' &&
            target.scenarioId
          ? emptyApiDraft(target.scenarioId)
          : null,
    );
    return () => {
      generation.current += 1;
    };
  }, [target, form, recoveryKey]);
  function requestClose() {
    if (pending) return;
    if (dirty || uncertain) setDiscardOpen(true);
    else onClose();
  }
  async function prepareDiagnostic() {
    if (
      !target ||
      !apiDraft ||
      target.targetType !== 'case' ||
      target.kind !== 'API'
    )
      return;
    setError(undefined);
    try {
      const values = await form.validateFields();
      const content = serializeApiDraft({
        ...apiDraft,
        base: { ...apiDraft.base, ...caseCommon(values, basis) },
      });
      setDiagnosticDraft({
        content,
        sourceCaseId: target.asset?.id ?? null,
        sourceCaseRevisionId: target.asset?.revisionId ?? null,
      });
    } catch (failure) {
      setError(
        failure instanceof z.ZodError
          ? failure.issues
              .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
              .join('；')
          : failure instanceof Error
            ? describeError(failure)
            : '请先补齐当前草稿的必填信息，再准备诊断。',
      );
    }
  }
  async function save(values: Fields) {
    if (!target || busy.current || uncertain) return;
    busy.current = true;
    const currentGeneration = generation.current;
    setPending(true);
    setError(undefined);
    try {
      let content: unknown;
      if (target.targetType === 'set')
        content = { title: values.title, basisRefs: basis };
      else if (target.targetType === 'scenario')
        content = {
          kind: target.kind,
          requirementVersionId: target.requirementVersionId,
          setId: target.setId,
          title: values.title,
          objective: values.objective,
          sharedPreconditions: lines(values.preconditions),
          basisRefs: basis,
        };
      else {
        const common = caseCommon(values, basis);
        if (target.kind === 'API') {
          if (!apiDraft) throw new Error('接口请求草稿尚未就绪。');
          content = serializeApiDraft({
            ...apiDraft,
            base: { ...apiDraft.base, ...common },
          });
        } else
          content = {
            kind: 'UI',
            scenarioId: target.scenarioId,
            ...common,
            steps: values.steps.map(({ action, expected }) => ({
              action,
              ...(expected?.trim() ? { expected } : {}),
            })),
          };
      }
      let body: unknown;
      let path: string;
      if (target.asset) {
        body = reviseAssetInputSchema.parse({
          commandId: commandId.current,
          baseRevisionId: target.asset.revisionId,
          rowVersion: target.asset.rowVersion,
          content,
        });
        path = `/${target.asset.id}`;
      } else if (target.targetType === 'set') {
        body = createSetInputSchema.parse({
          commandId: commandId.current,
          kind: target.kind,
          requirementVersionId: target.requirementVersionId,
          content,
        });
        path = '/sets';
      } else if (target.targetType === 'scenario') {
        body = createScenarioInputSchema.parse({
          commandId: commandId.current,
          setId: target.setId,
          content,
        });
        path = '/scenarios';
      } else {
        body = createCaseInputSchema.parse({
          commandId: commandId.current,
          scenarioId: target.scenarioId,
          content,
        });
        path = '/cases';
      }
      const response = await api(
        `/projects/${projectId}/assets${path}`,
        { method: target.asset ? 'PUT' : 'POST', body },
        assetReceiptSchema,
      );
      if (currentGeneration !== generation.current) return;
      setDirty(false);
      await onSaved(response.asset);
      onClose();
    } catch (err) {
      if (currentGeneration !== generation.current) return;
      if (isUncertainMutationError(err)) {
        setUncertain(true);
        try {
          localStorage.setItem(
            recoveryKey,
            JSON.stringify({
              commandId: commandId.current,
              operation: pendingOperation.current,
            }),
          );
        } catch {
          setReceiptStatus(
            '无法在本浏览器保留标识，请抄下原commandId后再离开。',
          );
        }
      }
      setError(
        err instanceof z.ZodError
          ? err.issues
              .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
              .join('；')
          : describeError(err),
      );
    } finally {
      if (currentGeneration === generation.current) {
        busy.current = false;
        setPending(false);
      }
    }
  }
  async function recover() {
    if (recovering) return;
    setRecovering(true);
    const currentGeneration = generation.current;
    setReceiptStatus(undefined);
    try {
      const receipt = await api(
        `/projects/${projectId}/assets/receipts/${commandId.current}?operation=${pendingOperation.current}`,
        {},
        assetOperationStatusSchema,
      );
      if (currentGeneration !== generation.current) return;
      if (
        receipt.commandId !== commandId.current ||
        receipt.operation !== pendingOperation.current
      )
        throw Error('原回执操作或标识不符，保持禁重发。');
      if (receipt.status === 'completed' && receipt.response) {
        if (receipt.response.asset.projectId !== projectId)
          throw Error('原回执项目不符，保持禁重发。');
        try {
          localStorage.removeItem(recoveryKey);
        } catch {
          /* The acknowledged ID remains visible in this modal. */
        }
        if (
          receipt.response.asset.kind !== target?.kind ||
          receipt.response.asset.requirementVersionId !==
            target.requirementVersionId
        ) {
          setUncertain(false);
          setKnownFailed(false);
          setError(undefined);
          setReceiptStatus(
            `原 ${receipt.response.asset.kind} 写入已完成：「${receipt.response.asset.title}」（${receipt.response.asset.id}），属于另一类型或需求版本；请到对应范围查看。本窗口内容尚未保存。`,
          );
          commandId.current = crypto.randomUUID();
          pendingOperation.current = target?.asset
            ? 'assets.revise'
            : target?.targetType === 'set'
              ? 'assets.create-set'
              : target?.targetType === 'scenario'
                ? 'assets.create-scenario'
                : 'assets.create-case';
          return;
        }
        setUncertain(false);
        setDirty(false);
        await onSaved(receipt.response.asset);
        onClose();
      } else if (receipt.status === 'failed') {
        setKnownFailed(true);
        setReceiptStatus('原操作已明确失败，当前输入保留。');
      } else
        setReceiptStatus(
          receipt.status === 'pending'
            ? '原操作仍在处理，稍后只读查询。'
            : '原操作仍未知，保持禁重发。',
        );
    } catch (failure) {
      if (currentGeneration !== generation.current) return;
      setReceiptStatus(`${describeError(failure)}；未查到不能解释为未受理。`);
    } finally {
      if (currentGeneration === generation.current) setRecovering(false);
    }
  }
  return (
    <>
      <Modal
        open={target !== null}
        zIndex={uiLayers.dialog}
        title={
          target
            ? `${target.asset ? '保存新修订' : '新建'} · ${target.kind} ${targetTypeLabels[target.targetType]}`
            : '资产编辑'
        }
        width={
          target?.kind === 'API' && target.targetType === 'case' ? 1150 : 850
        }
        onCancel={requestClose}
        closable={!pending}
        maskClosable={!pending}
        keyboard={!pending}
        footer={
          <Space>
            {apiDraft && target?.targetType === 'case' && (
              <Button
                disabled={pending || uncertain}
                onClick={() => void prepareDiagnostic()}
              >
                诊断当前 API 草稿
              </Button>
            )}
            <Button disabled={pending} onClick={requestClose}>
              取消
            </Button>
            <Button
              type="primary"
              loading={pending}
              disabled={uncertain}
              onClick={() => form.submit()}
            >
              保存为待确认内容
            </Button>
          </Space>
        }
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary">
          保存保留历史修订与已审快照，不自动批准。UI
          用例描述业务目标，不强制预写点击步骤；UI/API
          的批次、场景和用例身份独立。
        </Typography.Paragraph>
        {target?.asset && (
          <Alert
            type="info"
            showIcon
            title={`正在编辑 r${target.asset.revisionNo}`}
            description="并发修改会保留本次输入并显示冲突，不覆盖他人的新修订。"
            className="section-alert"
          />
        )}
        {error && (
          <Alert
            type="error"
            title={error}
            showIcon
            className="section-alert"
          />
        )}
        <Form
          form={form}
          layout="vertical"
          onValuesChange={() => setDirty(true)}
          onFinish={(values: Fields) => void save(values)}
        >
          <Form.Item
            name="title"
            label="标题"
            rules={[
              {
                required: true,
                whitespace: true,
                max: 200,
                message: '请输入明确标题（不超过 200 字符）',
              },
            ]}
          >
            <Input disabled={pending || uncertain} maxLength={200} />
          </Form.Item>
          {target?.targetType === 'scenario' && (
            <Form.Item
              name="objective"
              label="场景业务目标"
              rules={[
                {
                  required: true,
                  whitespace: true,
                  message: '请输入此场景的业务目标',
                },
              ]}
            >
              <Input.TextArea
                rows={4}
                disabled={pending || uncertain}
                maxLength={100000}
              />
            </Form.Item>
          )}
          {target?.targetType === 'case' && (
            <Form.Item
              name="testPoint"
              label="测试点"
              rules={[
                {
                  required: true,
                  whitespace: true,
                  message: '请输入可独立判断的测试点',
                },
              ]}
            >
              <Input.TextArea
                rows={3}
                disabled={pending || uncertain}
                maxLength={100000}
              />
            </Form.Item>
          )}
          {target?.targetType !== 'set' && (
            <Form.Item
              name="preconditions"
              label={
                target?.targetType === 'scenario'
                  ? '共享前提（每行一项）'
                  : '用例前提（每行一项）'
              }
            >
              <Input.TextArea rows={3} disabled={pending || uncertain} />
            </Form.Item>
          )}
          {target?.targetType === 'case' && target.kind === 'UI' && (
            <Form.List
              name="steps"
              rules={[
                {
                  validator: async (_rule, steps: unknown) => {
                    if (!Array.isArray(steps) || !steps.length)
                      throw new Error('请至少添加一个业务步骤。');
                  },
                },
              ]}
            >
              {(fields, { add, remove, move }, { errors }) => (
                <section aria-label="业务步骤">
                  <Typography.Title level={5}>业务步骤</Typography.Title>
                  {fields.map(({ key, name, ...field }, index) => (
                    <div key={key} className="panel pad mb">
                      <Space wrap className="mb">
                        <strong>步骤 {index + 1}</strong>
                        <Button
                          size="small"
                          disabled={pending || uncertain || index === 0}
                          onClick={() => move(index, index - 1)}
                        >
                          上移
                        </Button>
                        <Button
                          size="small"
                          disabled={
                            pending || uncertain || index === fields.length - 1
                          }
                          onClick={() => move(index, index + 1)}
                        >
                          下移
                        </Button>
                        <Button
                          size="small"
                          danger
                          disabled={pending || uncertain || fields.length === 1}
                          onClick={() => remove(name)}
                        >
                          移除
                        </Button>
                      </Space>
                      <Form.Item
                        {...field}
                        name={[name, 'action']}
                        label="业务动作"
                        rules={[
                          {
                            required: true,
                            whitespace: true,
                            message: '请输入需要执行的业务动作',
                          },
                        ]}
                      >
                        <Input.TextArea
                          rows={2}
                          disabled={pending || uncertain}
                          maxLength={10000}
                        />
                      </Form.Item>
                      <Form.Item
                        {...field}
                        name={[name, 'expected']}
                        label="逐步预期（可选）"
                      >
                        <Input.TextArea
                          rows={2}
                          disabled={pending || uncertain}
                          maxLength={10000}
                        />
                      </Form.Item>
                    </div>
                  ))}
                  <Form.ErrorList errors={errors} />
                  <Button
                    className="mb"
                    icon={<PlusOutlined />}
                    disabled={pending || uncertain || fields.length >= 100}
                    onClick={() => add({ action: '' })}
                  >
                    添加业务步骤
                  </Button>
                </section>
              )}
            </Form.List>
          )}
          {target?.targetType === 'case' && (
            <Form.Item
              name="expected"
              label="用例整体预期"
              rules={[
                {
                  required: true,
                  whitespace: true,
                  message: '请输入可以判断的业务预期',
                },
              ]}
            >
              <Input.TextArea
                rows={4}
                disabled={pending || uncertain}
                maxLength={100000}
              />
            </Form.Item>
          )}
        </Form>
        <Typography.Title level={5}>依据</Typography.Title>
        <Space direction="vertical" style={{ width: '100%' }}>
          {basis.map((item, index) => (
            <Space.Compact block key={index}>
              <Tag>{item.kind}</Tag>
              <Input
                aria-label={`依据说明 ${index + 1}`}
                placeholder="依据说明；不假称已读取资料"
                value={item.description}
                disabled={pending || uncertain}
                onChange={(event) => {
                  setDirty(true);
                  setBasis((current) =>
                    current.map((entry, at) =>
                      at === index
                        ? { ...entry, description: event.target.value }
                        : entry,
                    ),
                  );
                }}
              />
              <Button
                aria-label={`移除依据 ${index + 1}`}
                danger
                icon={<DeleteOutlined />}
                disabled={pending || uncertain}
                onClick={() => {
                  setDirty(true);
                  setBasis((current) =>
                    current.filter((_, at) => at !== index),
                  );
                }}
              />
            </Space.Compact>
          ))}
          <Button
            icon={<PlusOutlined />}
            disabled={pending || uncertain || basis.length >= 100}
            onClick={() => {
              setDirty(true);
              setBasis((current) => [
                ...current,
                {
                  kind: 'explicitStatement',
                  description: '',
                  readability: 'notChecked',
                },
              ]);
            }}
          >
            添加明确依据说明
          </Button>
        </Space>
        {apiDraft && target?.targetType === 'case' && (
          <div className="section-alert">
            {target.asset &&
              apiCaseContentSchema.safeParse(target.asset.content).success && (
                <Space wrap>
                  {(() => {
                    const content = apiCaseContentSchema.parse(
                      target.asset.content,
                    );
                    return content.cleanup.mode === 'none'
                      ? null
                      : content.cleanup.steps
                          .filter((step) => step.type === 'sql')
                          .map((step) => (
                            <AuxiliaryAction
                              key={step.cleanupStepId}
                              label={`AI审核SQL · ${step.cleanupStepId}`}
                              disabled={dirty || pending || uncertain}
                              source={() => ({
                                purpose: 'sqlReview',
                                projectId,
                                caseId: target.asset!.id,
                                caseRevisionId: target.asset!.revisionId,
                                cleanupStepId: step.cleanupStepId,
                              })}
                            />
                          ));
                  })()}
                  <Typography.Text type="secondary">
                    可选审核使用已保存修订；有未保存修改时请先保存，审核不执行SQL，也不锁定保存或运行。
                  </Typography.Text>
                </Space>
              )}
            <ApiCaseFields
              projectId={projectId}
              value={apiDraft}
              disabled={pending || uncertain}
              onChange={(value) => {
                setApiDraft(value);
                setDirty(true);
              }}
            />
          </div>
        )}
        {uncertain && (
          <Alert
            className="section-alert"
            type="warning"
            showIcon
            title={`原资产写入回执未知：${commandId.current}`}
            description={
              <Space direction="vertical">
                <span>
                  新保存已禁用；只在本浏览器保存本人、项目及命令标识，不保存内容或凭据。关闭后重新打开资产编辑仍可核对原操作。
                </span>
                <Button loading={recovering} onClick={() => void recover()}>
                  查询原资产写入回执
                </Button>
                {knownFailed && (
                  <Button
                    onClick={() => {
                      try {
                        localStorage.removeItem(recoveryKey);
                      } catch {}
                      commandId.current = crypto.randomUUID();
                      pendingOperation.current = target?.asset
                        ? 'assets.revise'
                        : target?.targetType === 'set'
                          ? 'assets.create-set'
                          : target?.targetType === 'scenario'
                            ? 'assets.create-scenario'
                            : 'assets.create-case';
                      setUncertain(false);
                      setKnownFailed(false);
                      setError(undefined);
                      setReceiptStatus(
                        '已知失败已核对；输入保留，继续保存需明确操作。',
                      );
                    }}
                  >
                    已知失败，继续编辑
                  </Button>
                )}
              </Space>
            }
          />
        )}
        {receiptStatus && (
          <p className="caption mt" role="status">
            {receiptStatus}
          </p>
        )}
      </Modal>
      <ApiDraftDebugger
        projectId={projectId}
        draft={diagnosticDraft}
        onClose={() => setDiagnosticDraft(null)}
      />
      <Modal
        open={discardOpen}
        zIndex={uiLayers.confirmation}
        title="当前资产有未保存的修改"
        onCancel={() => setDiscardOpen(false)}
        footer={
          <Space>
            <Button onClick={() => setDiscardOpen(false)}>继续编辑</Button>
            <Button
              danger
              onClick={() => {
                setDiscardOpen(false);
                onClose();
              }}
            >
              放弃修改
            </Button>
            <Button
              type="primary"
              disabled={uncertain}
              onClick={() => {
                setDiscardOpen(false);
                form.submit();
              }}
            >
              保存
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph>
          保存会创建新修订；放弃仅丢弃本次未保存输入。回执未知时，原操作标识继续保留，不会自动重发。
        </Typography.Paragraph>
      </Modal>
    </>
  );
}
