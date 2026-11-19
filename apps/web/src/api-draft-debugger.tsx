import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Collapse,
  Descriptions,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { z } from 'zod';
import {
  debugStartReceiptSchema,
  debugReceiptLookupSchema,
  apiAttemptDetailSchema,
  debugTraceSchema,
  startDebugInputSchema,
  apiRegressionSaveReceiptSchema,
  apiRegressionSaveStatusSchema,
} from '../../../packages/contracts/src/api-execution';
import type { ApiCaseContent } from '../../../packages/contracts/src/domain';
import type { Asset } from '../../../packages/contracts/src/assets';
import { testConfigurationListSchema } from '../../../packages/contracts/src/test-configuration';
import type { TestConfigurationView } from '../../../packages/contracts/src/test-configuration';
import { api, ApiError, describeError } from './api';
import { idSchema } from '../../../packages/contracts/src/base';
import type { Project } from './types';
import { uiLayers } from './ui-layers';

type DebugReceipt = z.infer<typeof debugStartReceiptSchema>;
type DebugTrace = z.infer<typeof debugTraceSchema>;
type Attempt = z.infer<typeof apiAttemptDetailSchema>['attempt'];
export interface DiagnosticDraft {
  content: ApiCaseContent;
  sourceCaseId: string | null;
  sourceCaseRevisionId: string | null;
  sourceCaseRowVersion?: number;
}
type Restoration = { kind: 'command' | 'run'; id: string };
const evaluationLabels = {
  notStarted: '尚未开始判断',
  inProgress: '诊断处理中',
  notConfigured: '未配置断言，不能判为通过',
  evaluated: '已有原始判断，按逐项事实核对',
  notExecuted: '未执行',
};

export function ApiDraftDebugger({
  projectId,
  draft,
  restoration,
  userId,
  onQualified,
  onClose,
}: {
  projectId: string;
  draft: DiagnosticDraft | null;
  restoration?: Restoration | null;
  userId?: string;
  onQualified?: (asset: Asset) => Promise<void> | void;
  onClose: () => void;
}) {
  const [environments, setEnvironments] = useState<TestConfigurationView[]>([]);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [uncertain, setUncertain] = useState(false);
  const [receipt, setReceipt] = useState<DebugReceipt | null>(null);
  const [trace, setTrace] = useState<DebugTrace | null>(null);
  const [restoredRunId, setRestoredRunId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [attemptLoading, setAttemptLoading] = useState(false);
  const [receiptStatus, setReceiptStatus] = useState<string>();
  const [qualificationCommand, setQualificationCommand] = useState<string>();
  const [savingQualification, setSavingQualification] = useState(false);
  const [form] = Form.useForm<{
    environmentId: string;
    productBuild: string;
  }>();
  const commandId = useRef<string>(crypto.randomUUID());
  const epoch = useRef(0);
  const attemptEpoch = useRef(0);
  const qualificationRecoveryKey =
    draft?.sourceCaseId && userId
      ? `ath:api-qualification:v1:${userId}:${projectId}:${draft.sourceCaseId}`
      : null;
  useEffect(() => {
    try {
      const saved =
        qualificationRecoveryKey &&
        sessionStorage.getItem(qualificationRecoveryKey);
      const command = idSchema.safeParse(saved);
      setQualificationCommand(command.success ? command.data : undefined);
    } catch {
      setQualificationCommand(undefined);
    }
  }, [qualificationRecoveryKey]);
  useEffect(() => {
    epoch.current += 1;
    if (!draft && !restoration) return;
    const generation = epoch.current;
    const controller = new AbortController();
    commandId.current =
      restoration?.kind === 'command' ? restoration.id : crypto.randomUUID();
    form.resetFields();
    setReceipt(null);
    setTrace(null);
    setRestoredRunId(restoration?.kind === 'run' ? restoration.id : null);
    setAttempt(null);
    setReceiptStatus(undefined);
    setUncertain(false);
    setError(undefined);
    setEnvironments([]);
    setLoading(true);
    if (restoration) {
      if (restoration.kind === 'run') void readTrace(restoration.id);
      else void recoverReceipt();
      return () => controller.abort();
    }
    void api(
      `/projects/${projectId}/test-configuration?kind=environment`,
      { signal: controller.signal },
      testConfigurationListSchema,
    )
      .then(({ configurations }) => {
        if (!controller.signal.aborted && epoch.current === generation) {
          setEnvironments(
            configurations.filter(
              (entry) =>
                entry.content.kind === 'environment' && entry.content.active,
            ),
          );
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted && epoch.current === generation)
          setError(describeError(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted && epoch.current === generation)
          setLoading(false);
      });
    return () => controller.abort();
  }, [draft, restoration, projectId, form]);

  async function readTrace(runId = receipt?.runId ?? restoredRunId) {
    if (!runId) return;
    const generation = epoch.current;
    setLoading(true);
    setError(undefined);
    try {
      const result = await api(
        `/projects/${projectId}/api-executions/${runId}/debug-result`,
        {},
        debugTraceSchema,
      );
      if (epoch.current !== generation) return;
      if (result.runId !== runId)
        throw new Error('诊断回执标识不匹配，请保留原轮次 ID 查询。');
      setTrace(result);
    } catch (failure) {
      if (epoch.current === generation) setError(describeError(failure));
    } finally {
      if (epoch.current === generation) setLoading(false);
    }
  }
  async function recoverReceipt() {
    const generation = epoch.current;
    setLoading(true);
    setError(undefined);
    try {
      const result = await api(
        `/projects/${projectId}/api-executions/debug-receipts/${commandId.current}`,
        {},
        debugReceiptLookupSchema,
      );
      if (epoch.current !== generation) return;
      if (result.commandId !== commandId.current)
        throw new Error('原诊断提交标识不匹配。');
      setReceiptStatus(result.status);
      if (result.receipt) {
        setReceipt(result.receipt);
        setUncertain(false);
        await readTrace(result.receipt.runId);
      }
    } catch (failure) {
      if (epoch.current === generation)
        setError(
          `${describeError(failure)}；只读查询尚未取得原回执不表示原操作未受理，不能更换提交标识重发。`,
        );
    } finally {
      if (epoch.current === generation) setLoading(false);
    }
  }
  async function readAttempt(intentId: string) {
    const runId = receipt?.runId ?? restoredRunId;
    if (!runId) return;
    const generation = epoch.current;
    const request = ++attemptEpoch.current;
    setAttempt(null);
    setAttemptLoading(true);
    try {
      const result = await api(
        `/projects/${projectId}/api-executions/${runId}/attempts/${intentId}`,
        {},
        apiAttemptDetailSchema,
      );
      if (epoch.current !== generation || request !== attemptEpoch.current)
        return;
      if (result.attempt.id !== intentId)
        throw new Error('原请求意图回执不匹配。');
      setAttempt(result.attempt);
    } catch (failure) {
      if (epoch.current === generation && request === attemptEpoch.current)
        setError(describeError(failure));
    } finally {
      if (epoch.current === generation && request === attemptEpoch.current)
        setAttemptLoading(false);
    }
  }
  async function start(values: {
    environmentId: string;
    productBuild: string;
  }) {
    if (!draft || pending || receipt || uncertain) return;
    const generation = epoch.current;
    setPending(true);
    setError(undefined);
    try {
      const input = startDebugInputSchema.parse({
        commandId: commandId.current,
        environmentId: values.environmentId,
        productBuild: values.productBuild?.trim() || null,
        sourceCaseId: draft.sourceCaseId,
        sourceCaseRevisionId: draft.sourceCaseRevisionId,
        content: draft.content,
      });
      const response = await api(
        `/projects/${projectId}/api-executions/debug`,
        { method: 'POST', body: input },
        debugStartReceiptSchema,
      );
      if (epoch.current !== generation) return;
      setReceipt(response);
      await readTrace(response.runId);
    } catch (failure) {
      if (epoch.current !== generation) return;
      if (
        failure instanceof ApiError &&
        (failure.status === 0 || failure.status >= 500)
      )
        setUncertain(true);
      setError(describeError(failure));
    } finally {
      if (epoch.current === generation) setPending(false);
    }
  }
  const expectedCleanup =
    draft?.content.cleanup.mode === 'none' ? 'notConfigured' : 'succeeded';
  const eligible =
    Boolean(
      draft?.sourceCaseId &&
      draft.sourceCaseRevisionId &&
      draft.sourceCaseRowVersion &&
      receipt &&
      onQualified,
    ) &&
    trace?.state === 'completed' &&
    trace.qualificationEnvironment === true &&
    trace.scope.items[0]?.caseId === draft?.sourceCaseId &&
    trace.facts.length === 1 &&
    trace.facts[0]?.originalOutcome === 'passed' &&
    trace.facts[0].cleanupState === expectedCleanup &&
    trace.facts[0].sideEffectCertainty !== 'unknown';
  function clearQualificationRecovery() {
    setQualificationCommand(undefined);
    if (qualificationRecoveryKey) {
      try {
        sessionStorage.removeItem(qualificationRecoveryKey);
      } catch {
        /* Only a locator is stored. */
      }
    }
  }
  async function saveQualification() {
    if (
      !eligible ||
      savingQualification ||
      qualificationCommand ||
      !receipt ||
      !draft?.sourceCaseId ||
      !draft.sourceCaseRevisionId ||
      !draft.sourceCaseRowVersion
    )
      return;
    const id = crypto.randomUUID();
    setSavingQualification(true);
    setError(undefined);
    setQualificationCommand(id);
    try {
      if (qualificationRecoveryKey)
        sessionStorage.setItem(qualificationRecoveryKey, id);
    } catch {
      /* The in-page locator remains available. */
    }
    try {
      const result = await api(
        `/projects/${projectId}/api-executions/regression-qualifications`,
        {
          method: 'POST',
          body: {
            commandId: id,
            caseId: draft.sourceCaseId,
            baseRevisionId: draft.sourceCaseRevisionId,
            rowVersion: draft.sourceCaseRowVersion,
            debugRunId: receipt.runId,
            draftHash: receipt.draftHash,
            content: draft.content,
          },
        },
        apiRegressionSaveReceiptSchema,
      );
      if (
        result.asset.id !== draft.sourceCaseId ||
        result.qualification.caseId !== draft.sourceCaseId
      )
        throw new Error('保存回执不属于当前用例，请查询原操作。');
      clearQualificationRecovery();
      await onQualified?.(result.asset);
    } catch (failure) {
      if (
        failure instanceof ApiError &&
        failure.status >= 400 &&
        failure.status < 500
      )
        clearQualificationRecovery();
      setError(describeError(failure));
    } finally {
      setSavingQualification(false);
    }
  }
  async function readQualificationReceipt() {
    if (!qualificationCommand || savingQualification || !draft?.sourceCaseId)
      return;
    setSavingQualification(true);
    setError(undefined);
    try {
      const result = await api(
        `/projects/${projectId}/api-executions/regression-qualification-receipts/${qualificationCommand}`,
        {},
        apiRegressionSaveStatusSchema,
      );
      if (result.commandId !== qualificationCommand)
        throw new Error('原保存回执标识不一致。');
      if (
        result.status === 'completed' &&
        result.response?.asset.id === draft.sourceCaseId
      ) {
        clearQualificationRecovery();
        await onQualified?.(result.response.asset);
      } else if (result.status === 'failed') {
        clearQualificationRecovery();
        setError('原保存操作已明确失败。请重新检查编辑基准和调试结果。');
      } else {
        setError('保存回执尚未确定。可继续只读核对原操作。');
      }
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setSavingQualification(false);
    }
  }
  return (
    <Modal
      zIndex={uiLayers.nestedDialog}
      title={restoration ? '查看原接口调试证据' : '调试与证据'}
      open={draft !== null || Boolean(restoration)}
      onCancel={onClose}
      closable={!pending && !savingQualification}
      maskClosable={!pending && !savingQualification}
      keyboard={!pending && !savingQualification}
      width={1000}
      footer={
        <Space>
          <Button disabled={pending || savingQualification} onClick={onClose}>
            关闭诊断
          </Button>
          {receipt || restoredRunId ? (
            <Button loading={loading} onClick={() => void readTrace()}>
              只读刷新原诊断
            </Button>
          ) : restoration ? (
            <Button loading={loading} onClick={() => void recoverReceipt()}>
              只读查询原提交
            </Button>
          ) : (
            <Button
              type="primary"
              loading={pending}
              disabled={
                loading ||
                uncertain ||
                !environments.length ||
                Boolean(qualificationCommand)
              }
              onClick={() => form.submit()}
            >
              明确开始一次草稿诊断
            </Button>
          )}
          {qualificationCommand ? (
            <Button
              loading={savingQualification}
              onClick={() => void readQualificationReceipt()}
            >
              查询原资格保存回执
            </Button>
          ) : eligible && !trace?.qualificationRetained ? (
            <Button
              type="primary"
              loading={savingQualification}
              onClick={() => void saveQualification()}
            >
              保存为可回归
            </Button>
          ) : null}
        </Space>
      }
      destroyOnHidden
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {draft ? (
          <Alert
            type="warning"
            showIcon
            title="诊断会向所选环境发起真实接口请求"
            description="当前候选已固定。所选环境认可且完整调试通过后可保存为可回归。业务请求和清理遵循当前执行策略。"
          />
        ) : (
          <Alert
            type="info"
            showIcon
            title="按当前项目权限只读找回原诊断"
            description="查询原提交/轮次不会启动接口或重发未知请求。找回原回执后，再读取实际进度和安全请求事实；prepared 不等于执行完成。"
          />
        )}
        {error && <Alert type="error" title={error} showIcon />}
        {uncertain && (
          <Alert
            type="warning"
            showIcon
            title={`本次开始回执未知：${commandId.current}`}
            description="已禁重复开始。请保留此提交标识核对原诊断记录，不新建提交来推断原操作未发生。"
            action={
              <Button loading={loading} onClick={() => void recoverReceipt()}>
                只读找回原开始回执
              </Button>
            }
          />
        )}
        {receiptStatus && (
          <Typography.Text type="secondary">
            原提交查询状态：{receiptStatus}；只按取得的原轮次读取实际进度。
          </Typography.Text>
        )}
        {draft && (
          <Form
            form={form}
            layout="vertical"
            onFinish={(values) => void start(values)}
          >
            <Form.Item
              name="environmentId"
              label="明确的诊断环境"
              rules={[
                { required: true, message: '请选择本次真实请求的目标环境' },
              ]}
            >
              <Select
                loading={loading && !receipt}
                disabled={pending || Boolean(receipt) || uncertain}
                options={environments.map((entry) => ({
                  value: entry.id,
                  label:
                    entry.content.kind === 'environment' &&
                    'allowApiRegressionQualification' in entry.content &&
                    entry.content.allowApiRegressionQualification
                      ? `${entry.content.name} · 可验证回归资格`
                      : entry.content.name,
                }))}
                placeholder="请选择已确认的隔离目标"
              />
            </Form.Item>
            <Form.Item name="productBuild" label="被测版本/构建标识（可留空）">
              <Input
                maxLength={200}
                disabled={pending || Boolean(receipt) || uncertain}
              />
            </Form.Item>
          </Form>
        )}
        {draft && (
          <Collapse
            items={[
              {
                key: 'current',
                label: `本次固定草稿：${draft.content.title} · ${draft.content.steps.length} 个请求`,
                children: (
                  <pre className="message-code">
                    {JSON.stringify(draft.content, null, 2)}
                  </pre>
                ),
              },
            ]}
          />
        )}
        {receipt && (
          <Descriptions
            bordered
            size="small"
            column={1}
            items={[
              { key: 'id', label: '原诊断轮次', children: receipt.runId },
              { key: 'hash', label: '草稿摘要', children: receipt.draftHash },
              {
                key: 'state',
                label: '开始回执',
                children: 'prepared：仅已准备，实际进度以原诊断读取为准',
              },
              {
                key: 'source',
                label: '来源变化',
                children: receipt.sourceChanged
                  ? '当前草稿与保存来源有变化'
                  : '服务端未标记来源变化',
              },
              {
                key: 'cleanup',
                label: '可用清理批准引用',
                children:
                  receipt.cleanupApprovalSnapshotId ??
                  '无可用已审清理引用，不宣称清理会执行',
              },
            ]}
          />
        )}
        {trace && (
          <>
            <Space wrap>
              <Tag>非正式诊断</Tag>
              <Tag>轮次状态：{trace.state}</Tag>
              <Tag>{evaluationLabels[trace.evaluationStatus]}</Tag>
            </Space>
            <Typography.Paragraph type="secondary">
              {trace.qualificationRetained
                ? '此诊断作为可回归资格证据保留。'
                : `临时诊断于 ${trace.expiresAt} 到期。`}
              {trace.state === 'completed' &&
              draft &&
              trace.qualificationEnvironment !== true
                ? ' 当前环境配置未认可用于验证回归资格。'
                : ''}
            </Typography.Paragraph>
            <Table
              size="small"
              rowKey="runItemId"
              pagination={false}
              dataSource={trace.facts}
              scroll={{ x: 700 }}
              columns={[
                {
                  title: '原始判断',
                  render: (_, fact) =>
                    fact.originalOutcome ?? '尚无判断（不等于通过）',
                },
                { title: '说明', dataIndex: 'reason' },
                { title: '清理', dataIndex: 'cleanupState' },
                { title: '副作用确定性', dataIndex: 'sideEffectCertainty' },
              ]}
            />
            {attempt && (
              <Collapse
                defaultActiveKey={['attempt']}
                items={[
                  {
                    key: 'attempt',
                    label: `原安全请求回执：${attempt.id} · ${attempt.state} · ${attempt.outcome ?? '尚无判断'}`,
                    children: (
                      <Space direction="vertical" style={{ width: '100%' }}>
                        <Typography.Text type="secondary">
                          仅展示服务端脱敏后的请求、响应、断言和提取；未取得响应不能当请求成功。
                        </Typography.Text>
                        <pre className="message-code">
                          {JSON.stringify(attempt, null, 2)}
                        </pre>
                      </Space>
                    ),
                  },
                ]}
              />
            )}
            <Table
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={trace.steps}
              scroll={{ x: 800 }}
              columns={[
                { title: '请求意图 ID', dataIndex: 'id' },
                { title: '阶段', dataIndex: 'phase' },
                { title: '步骤', dataIndex: 'stepId' },
                { title: '状态', dataIndex: 'state' },
                {
                  title: '实际判断',
                  render: (_, step) => step.outcome ?? '尚无判断',
                },
                { title: '副作用确定性', dataIndex: 'sideEffectCertainty' },
                { title: '说明', dataIndex: 'reason' },
                {
                  title: '安全回执',
                  render: (_, step) => (
                    <Button
                      loading={attemptLoading && !attempt}
                      onClick={() => void readAttempt(step.id)}
                    >
                      查看原请求/响应
                    </Button>
                  ),
                },
              ]}
              locale={{ emptyText: '尚无实际请求意图或步骤回执。' }}
            />
          </>
        )}
        {(receipt || restoredRunId || uncertain) && (
          <Typography.Paragraph>
            <a
              href={`/#api-regression?projectId=${encodeURIComponent(projectId)}&${receipt || restoredRunId ? 'debugRunId' : 'debugCommandId'}=${encodeURIComponent(receipt?.runId ?? restoredRunId ?? commandId.current)}`}
            >
              打开此原诊断的只读找回页（可保留链接后刷新）
            </a>
          </Typography.Paragraph>
        )}
        {(!restoration || restoration.kind === 'command') && (
          <Typography.Text type="secondary">
            {restoration ? '原提交标识' : '本次提交标识'}：{commandId.current}
          </Typography.Text>
        )}
      </Space>
    </Modal>
  );
}

function readRestoration(): Restoration | null {
  const query = new URLSearchParams(window.location.hash.split('?')[1]);
  const run = idSchema.safeParse(query.get('debugRunId'));
  if (run.success) return { kind: 'run', id: run.data };
  const command = idSchema.safeParse(query.get('debugCommandId'));
  return command.success ? { kind: 'command', id: command.data } : null;
}
export function ApiDiagnosticPage({ project }: { project: Project | null }) {
  const [form] = Form.useForm<{ kind: 'command' | 'run'; id: string }>();
  const [restoration, setRestoration] = useState<Restoration | null>(
    readRestoration,
  );
  const [error, setError] = useState<string>();
  useEffect(() => {
    function update() {
      setRestoration(readRestoration());
      setError(undefined);
    }
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const queryProject = new URLSearchParams(
    window.location.hash.split('?')[1],
  ).get('projectId');
  const contextMatches = !queryProject || queryProject === project?.id;
  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card title="接口回归工作台 · 原诊断找回">
        <Typography.Paragraph>
          正式接口计划在“测试计划”的接口分类维护。当前草稿诊断从用例编辑器发起，诊断记录独立于正式报告。本页只读找回原诊断，不启动或重发请求。
        </Typography.Paragraph>
        {!project && (
          <Alert
            type="info"
            title="请选择当前有效项目，再查询该项目原诊断。"
            showIcon
          />
        )}
        {!contextMatches && (
          <Alert
            type="warning"
            showIcon
            title="链接项目与当前项目不同，请先选择原项目。"
            description="不会把同一轮次 ID 套到其他项目，也不会借链接授予项目权限。"
          />
        )}
        {error && <Alert type="error" title={error} showIcon />}
        <Form
          form={form}
          layout="vertical"
          initialValues={{ kind: 'command' }}
          onFinish={(values) => {
            const parsed = idSchema.safeParse(values.id);
            if (!parsed.success) {
              setError('请输入有效的原提交或原轮次 UUID。');
              return;
            }
            setError(undefined);
            if (project)
              window.location.hash = `api-regression?projectId=${project.id}&${values.kind === 'run' ? 'debugRunId' : 'debugCommandId'}=${parsed.data}`;
          }}
        >
          <Form.Item name="kind" label="原标识类型">
            <Select
              options={[
                { value: 'command', label: '原开始提交 commandId' },
                { value: 'run', label: '原诊断轮次 runId' },
              ]}
            />
          </Form.Item>
          <Form.Item name="id" label="原标识" rules={[{ required: true }]}>
            <Input autoComplete="off" placeholder="只查询原 ID，不新建诊断" />
          </Form.Item>
          <Button htmlType="submit" disabled={!project} type="primary">
            只读找回原诊断
          </Button>
        </Form>
      </Card>
      {project && contextMatches && restoration && (
        <ApiDraftDebugger
          key={`${project.id}:${restoration.kind}:${restoration.id}`}
          projectId={project.id}
          draft={null}
          restoration={restoration}
          onClose={() => {
            setRestoration(null);
            window.location.hash = 'api-regression';
          }}
        />
      )}
    </Space>
  );
}
