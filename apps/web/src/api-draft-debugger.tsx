import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Collapse,
  Descriptions,
  Empty,
  List,
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
import { apiAuthoringVariableIssues } from '../../../packages/contracts/src/api-variable-refs';
import { configuredEnvironment } from './api-variable-fields';
import type { Project } from './types';
import { uiLayers } from './ui-layers';
import { ApiAttemptEvidence, type ResponseRule } from './api-attempt-evidence';

type DebugReceipt = z.infer<typeof debugStartReceiptSchema>;
type DebugTrace = z.infer<typeof debugTraceSchema>;
type Attempt = z.infer<typeof apiAttemptDetailSchema>['attempt'];
export interface DiagnosticDraft {
  content: ApiCaseContent;
  sourceCaseId: string | null;
  sourceCaseRevisionId: string | null;
  sourceCaseRowVersion?: number;
  previewEnvironmentId?: string;
  stepId?: string;
}
export type DiagnosticRestoration = { kind: 'command' | 'run'; id: string };
type Restoration = DiagnosticRestoration;
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
  presentation = 'modal',
  candidateCurrent = true,
  expectedCaseId,
  onRule,
  onBusyChange,
}: {
  projectId: string;
  draft: DiagnosticDraft | null;
  restoration?: Restoration | null;
  userId?: string;
  onQualified?: (asset: Asset) => Promise<void> | void;
  onClose: () => void;
  presentation?: 'modal' | 'inline';
  candidateCurrent?: boolean;
  expectedCaseId?: string;
  onRule?: (stepId: string, rule: ResponseRule) => string | undefined;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [environments, setEnvironments] = useState<TestConfigurationView[]>([]);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [uncertain, setUncertain] = useState(false);
  const [restoredFromLocator, setRestoredFromLocator] = useState(false);
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
    dataRowId?: string;
    productBuild: string;
  }>();
  useEffect(() => {
    onBusyChange?.(pending || savingQualification);
    return () => onBusyChange?.(false);
  }, [pending, savingQualification, onBusyChange]);
  const commandId = useRef<string>(crypto.randomUUID());
  const epoch = useRef(0);
  const attemptEpoch = useRef(0);
  const diagnosticRecoveryKey =
    draft?.sourceCaseId && userId
      ? 'ath:api-diagnostic:v1:' +
        userId +
        ':' +
        projectId +
        ':' +
        draft.sourceCaseId
      : null;
  const clearDiagnosticLocator = (id: string) => {
    if (!diagnosticRecoveryKey) return;
    try {
      if (localStorage.getItem(diagnosticRecoveryKey) === id)
        localStorage.removeItem(diagnosticRecoveryKey);
    } catch {
      // The on-screen receipt remains usable.
    }
  };
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
    let originalLocator: string | undefined;
    if (diagnosticRecoveryKey && !restoration) {
      try {
        const cached = idSchema.safeParse(
          localStorage.getItem(diagnosticRecoveryKey),
        );
        if (cached.success) originalLocator = cached.data;
      } catch {
        /* Storage access is optional when no original locator was saved. */
      }
    }
    commandId.current =
      restoration?.kind === 'command'
        ? restoration.id
        : (originalLocator ?? crypto.randomUUID());
    form.resetFields();
    setReceipt(null);
    setTrace(null);
    setRestoredRunId(restoration?.kind === 'run' ? restoration.id : null);
    setAttempt(null);
    setReceiptStatus(undefined);
    setUncertain(Boolean(originalLocator));
    setRestoredFromLocator(Boolean(originalLocator));
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
          const active = configurations.filter(
            (entry) =>
              entry.content.kind === 'environment' && entry.content.active,
          );
          setEnvironments(active);
          if (
            draft?.previewEnvironmentId &&
            active.some((entry) => entry.id === draft.previewEnvironmentId) &&
            !form.getFieldValue('environmentId')
          )
            form.setFieldValue('environmentId', draft.previewEnvironmentId);
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
  }, [draft, restoration, projectId, form, diagnosticRecoveryKey]);

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
      if (expectedCaseId && result.scope.items[0]?.caseId !== expectedCaseId)
        throw new Error('原诊断回执不属于当前接口用例。');
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
        clearDiagnosticLocator(result.commandId);
        setReceipt(result.receipt);
        setUncertain(false);
        await readTrace(result.receipt.runId);
      } else if (result.status === 'failed' && !restoration) {
        clearDiagnosticLocator(result.commandId);
        commandId.current = crypto.randomUUID();
        setUncertain(false);
        setRestoredFromLocator(false);
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
    dataRowId?: string;
    productBuild: string;
  }) {
    if (!draft || pending || receipt || uncertain) return;
    const generation = epoch.current;
    setPending(true);
    setError(undefined);
    let sent = false;
    try {
      const selected = environments.find(
        (entry) => entry.id === values.environmentId,
      );
      const configurationCandidate = draft.stepId
        ? {
            ...draft.content,
            steps: draft.content.steps.filter(
              (step) => step.stepId === draft.stepId,
            ),
            preparations: undefined,
            cleanup: { mode: 'none' as const },
          }
        : draft.content;
      const invalid = apiAuthoringVariableIssues(
        configurationCandidate,
        configuredEnvironment(selected),
      )[0];
      if (invalid)
        throw new Error(`${invalid.path.join('/')}：${invalid.message}`);
      const input = startDebugInputSchema.parse({
        commandId: commandId.current,
        environmentId: values.environmentId,
        ...(values.dataRowId ? { dataRowId: values.dataRowId } : {}),
        productBuild: values.productBuild?.trim() || null,
        sourceCaseId: draft.sourceCaseId,
        sourceCaseRevisionId: draft.sourceCaseRevisionId,
        ...(draft.stepId ? { stepId: draft.stepId } : {}),
        content: draft.content,
      });
      if (diagnosticRecoveryKey) {
        try {
          localStorage.setItem(diagnosticRecoveryKey, input.commandId);
        } catch {
          /* The on-screen command locator still protects the current editing session. */
        }
      }
      sent = true;
      const response = await api(
        `/projects/${projectId}/api-executions/debug`,
        { method: 'POST', body: input },
        debugStartReceiptSchema,
      );
      if (epoch.current !== generation) return;
      clearDiagnosticLocator(input.commandId);
      setReceipt(response);
      await readTrace(response.runId);
    } catch (failure) {
      if (epoch.current !== generation) return;
      if (sent) {
        if (
          failure instanceof ApiError &&
          failure.status >= 400 &&
          failure.status < 500
        )
          clearDiagnosticLocator(commandId.current);
        else setUncertain(true);
      }
      setError(describeError(failure));
    } finally {
      if (epoch.current === generation) setPending(false);
    }
  }
  const expectedCleanup =
    draft?.content.cleanup.mode === 'none' ? 'notConfigured' : 'succeeded';
  const singleStep =
    draft?.stepId ?? trace?.scope.diagnosticStepId ?? receipt?.diagnosticStepId;
  const eligible =
    singleStep === undefined &&
    !restoredFromLocator &&
    candidateCurrent &&
    Boolean(
      draft?.sourceCaseId &&
      draft.sourceCaseRevisionId &&
      draft.sourceCaseRowVersion &&
      receipt &&
      onQualified,
    ) &&
    !receipt?.sourceChanged &&
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
  const actions = (
    <Space wrap>
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
          {singleStep ? '确认执行所选步骤' : '确认完整调试'}
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
  );
  const evidence = (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {draft ? (
        <Alert
          type="warning"
          showIcon
          title={
            singleStep
              ? '单步诊断会向所选环境发起真实请求'
              : '完整调试会向所选环境发起真实请求'
          }
          description={
            singleStep
              ? '只执行所选步骤，按项目配置处理必要认证。不会执行准备、前序步骤和清理。需要的前序变量无法解析时不发送请求，单步结果不能用于回归资格。'
              : '当前候选已固定。所选环境认可且完整调试通过后可保存为可回归。业务请求和清理遵循当前执行策略。'
          }
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
          {draft.content.dataRows?.length ? (
            <Form.Item
              name="dataRowId"
              label="本轮调试数据行"
              initialValue={draft.content.dataRows[0]?.id}
              rules={[{ required: true }]}
            >
              <Select
                disabled={pending || Boolean(receipt) || uncertain}
                options={draft.content.dataRows.map((row) => ({
                  value: row.id,
                  label: `${row.name} · ${row.id}`,
                }))}
              />
            </Form.Item>
          ) : null}
          <Form.Item name="productBuild" label="被测版本/构建标识（可留空）">
            <Input
              maxLength={200}
              disabled={pending || Boolean(receipt) || uncertain}
            />
          </Form.Item>
        </Form>
      )}
      {draft && !candidateCurrent && (
        <Alert
          type="info"
          showIcon
          title="当前编辑已改变，原诊断仍可读取"
          description="完整调试必须对应当前候选才能保存为回归资格。"
        />
      )}
      {draft && (
        <Collapse
          items={[
            {
              key: 'current',
              label: singleStep
                ? '本次固定请求步骤'
                : `本次固定草稿：${draft.content.title} · ${draft.content.steps.length} 个请求`,
              children: (
                <pre className="message-code">
                  {JSON.stringify(
                    singleStep
                      ? draft.content.steps.find(
                          (step) => step.stepId === singleStep,
                        )
                      : draft.content,
                    null,
                    2,
                  )}
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
            <Tag>{singleStep ? '单步诊断 · 仅供排查' : '完整草稿调试'}</Tag>
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
            {...(presentation === 'modal' ? { scroll: { x: 700 } } : {})}
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
          <List
            className="api-attempt-list"
            size="small"
            header="运行步骤与清理"
            dataSource={trace.steps}
            locale={{ emptyText: '尚无实际请求意图或步骤回执。' }}
            renderItem={(step) => (
              <List.Item
                key={step.id}
                actions={[
                  <Button
                    key="read"
                    type="link"
                    size="small"
                    loading={attemptLoading && !attempt}
                    onClick={() => void readAttempt(step.id)}
                  >
                    查看证据
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  title={step.stepId}
                  description={
                    <div className="api-attempt-summary">
                      <Tag>{step.phase}</Tag>
                      <span>{step.outcome ?? step.state}</span>
                      {step.sideEffectCertainty === 'unknown' && (
                        <Tag color="warning">待核实</Tag>
                      )}
                      {step.reason && <div>{step.reason}</div>}
                    </div>
                  }
                />
              </List.Item>
            )}
          />
          {attempt && (
            <Card
              size="small"
              title="原请求与响应"
              extra={<Tag>{attempt.state}</Tag>}
            >
              <ApiAttemptEvidence
                key={attempt.id}
                attempt={attempt}
                {...(onRule
                  ? {
                      onRule: (rule: ResponseRule) =>
                        onRule(attempt.step_id, rule),
                    }
                  : {})}
              />
            </Card>
          )}
          <details>
            <summary>运行与回执记录</summary>
            <pre className="message-code">
              {JSON.stringify(
                trace.steps.map(({ id, phase, stepId, state, reason }) => ({
                  id,
                  phase,
                  stepId,
                  state,
                  reason,
                })),
                null,
                2,
              )}
            </pre>
          </details>
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
  );

  if (presentation === 'inline') {
    return (
      <Card size="small" className="api-workbench-evidence" title="调试与证据">
        {draft || restoration ? (
          <div className="stack">
            {actions}
            {evidence}
          </div>
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="运行调试、单步诊断或打开原回执后，可在此查看请求、响应和判断。"
          />
        )}
      </Card>
    );
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
      footer={actions}
      destroyOnHidden
    >
      {evidence}
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
