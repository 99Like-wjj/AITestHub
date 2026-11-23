import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  Button,
  Collapse,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Tabs,
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
import { AppIcon } from './app-icon';
import { ApiAttemptEvidence, type ResponseRule } from './api-attempt-evidence';
import { RecoveryBlock, RecoveryQueryForm } from './recovery-block';

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
export const diagnosticLookupOptions = [
  { value: 'run', label: '原诊断轮次 ID' },
  { value: 'command', label: '原提交 ID' },
];
const attemptLabels: Record<string, string> = {
  intent: '已登记',
  completed: '已完成',
  failed: '失败',
  unknown: '待核实',
  skipped: '已跳过',
};
const cleanupLabels: Record<string, string> = {
  notConfigured: '未配置',
  pending: '待清理',
  succeeded: '清理成功',
  failed: '清理失败',
  skipped: '已跳过',
  unknown: '待核实',
};
const certaintyLabels: Record<string, string> = {
  known: '已确认',
  unknown: '待核实',
  notApplicable: '不适用',
};
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
  candidateCurrent = true,
  expectedCaseId,
  onRule,
  onBusyChange,
  onOpenHistory,
}: {
  projectId: string;
  draft: DiagnosticDraft | null;
  restoration?: DiagnosticRestoration | null;
  userId?: string;
  onQualified?: (asset: Asset) => Promise<void> | void;
  onClose: () => void;
  candidateCurrent?: boolean;
  expectedCaseId?: string;
  onRule?: (stepId: string, rule: ResponseRule) => string | undefined;
  onBusyChange?: (busy: boolean) => void;
  onOpenHistory?: () => void;
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
  const firstAttempt = useRef<string | undefined>(undefined);
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
    firstAttempt.current = undefined;
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
  useEffect(() => {
    if (!trace?.steps.length || firstAttempt.current === trace.runId) return;
    const selected =
      trace.steps.find((step) => step.phase === 'business') ?? trace.steps[0];
    if (!selected) return;
    firstAttempt.current = trace.runId;
    void readAttempt(selected.id);
  }, [trace?.runId, trace?.steps.length]);
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
  const startActions = (
    <Space wrap>
      <Button disabled={pending || savingQualification} onClick={onClose}>
        关闭诊断
      </Button>
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
      {qualificationCommand && (
        <Button
          loading={savingQualification}
          onClick={() => void readQualificationReceipt()}
        >
          查询原资格保存回执
        </Button>
      )}
    </Space>
  );
  const preflight = (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
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
      {error && <Alert type="error" title={error} showIcon />}
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

      <Typography.Text type="secondary">
        本次提交标识：{commandId.current}
      </Typography.Text>
    </Space>
  );
  const selecting = Boolean(draft && !receipt && !restoredRunId && !uncertain);
  const fact = trace?.facts[0];
  const names = new Map(
    trace?.scope.items[0]?.content.steps.map((step) => [
      step.stepId,
      step.name,
    ]),
  );
  const runId = receipt?.runId ?? restoredRunId;
  const cleanupBody: ReactNode = fact ? (
    <div className="api-proof-cleanup">
      <p>
        <strong>清理</strong>{' '}
        {cleanupLabels[fact.cleanupState] ?? fact.cleanupState}
      </p>
      <p className="caption">
        副作用确定性{' '}
        {certaintyLabels[fact.sideEffectCertainty] ?? fact.sideEffectCertainty}
      </p>
      {trace?.steps
        .filter(
          (step) => step.phase === 'cleanupHttp' || step.phase === 'cleanupSql',
        )
        .map((step) => (
          <Button
            key={step.id}
            type="link"
            onClick={() => void readAttempt(step.id)}
          >
            {step.phase === 'cleanupSql' ? 'SQL 清理' : 'HTTP 清理'} ·{' '}
            {step.stepId}
          </Button>
        ))}
    </div>
  ) : (
    <p className="caption">尚未取得清理记录。</p>
  );
  const logBody = trace ? (
    <div className="stack">
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
      <details>
        <summary>原诊断元数据</summary>
        <dl className="api-proof-metadata">
          <dt>原诊断轮次</dt>
          <dd>{trace.runId}</dd>
          <dt>原草稿摘要</dt>
          <dd>{trace.draftHash}</dd>
          <dt>状态</dt>
          <dd>{trace.state}</dd>
          <dt>临时保留截至</dt>
          <dd>
            {trace.qualificationRetained
              ? '作为回归资格证据保留'
              : trace.expiresAt}
          </dd>
          <dt>原清理批准引用</dt>
          <dd>{trace.scope.cleanupApprovalSnapshotId ?? '未使用'}</dd>
          {receipt && (
            <>
              <dt>来源变化</dt>
              <dd>
                {receipt.sourceChanged
                  ? '当前草稿与保存来源有变化'
                  : '服务端未标记来源变化'}
              </dd>
            </>
          )}
        </dl>
        <a
          href={`/#api-regression?projectId=${encodeURIComponent(projectId)}&debugRunId=${encodeURIComponent(trace.runId)}`}
        >
          打开原诊断只读链接
        </a>
      </details>
    </div>
  ) : (
    <p className="caption">尚未取得运行记录。</p>
  );
  const text =
    !draft && !restoration
      ? '完成调试后可申请回归资格。'
      : singleStep
        ? '单步诊断仅用于排查。'
        : trace?.qualificationRetained
          ? '此诊断作为回归资格证据保留。'
          : restoration || restoredFromLocator
            ? '只读查看原诊断。'
            : !candidateCurrent
              ? '当前草稿已改变，请重新调试后保存资格。'
              : trace?.state === 'completed' &&
                  trace.qualificationEnvironment !== true
                ? '本次环境未认可用于验证回归资格。'
                : '完整调试及所需清理成功后可保存资格。';
  return (
    <>
      <aside
        className="api-proto-pane api-workbench-evidence"
        aria-label="调试与证据"
      >
        <div className="api-proto-pane-heading">
          <AppIcon name="play" />
          <h2>调试与证据</h2>
          <Space size={0}>
            {fact && fact.cleanupState !== 'notConfigured' && (
              <Tag>{cleanupLabels[fact.cleanupState] ?? fact.cleanupState}</Tag>
            )}
            {runId && (
              <Button
                type="text"
                size="small"
                loading={loading}
                title="只读刷新原诊断"
                aria-label="只读刷新原诊断"
                icon={<AppIcon name="arrow" />}
                onClick={() => void readTrace()}
              />
            )}
            {onOpenHistory && (
              <Button
                type="text"
                size="small"
                aria-label="查询原诊断回执"
                title="查询原诊断回执"
                icon={<AppIcon name="book" />}
                onClick={onOpenHistory}
                disabled={pending || savingQualification}
              />
            )}
          </Space>
        </div>
        {(trace || runId) && (
          <div className="api-proto-trace-meta">
            <Space size={5} wrap>
              {fact?.originalOutcome && (
                <Tag
                  color={
                    fact.originalOutcome === 'passed' ? 'success' : 'default'
                  }
                >
                  {fact.originalOutcome === 'passed'
                    ? '业务通过'
                    : fact.originalOutcome === 'failed'
                      ? '业务失败'
                      : '未执行'}
                </Tag>
              )}
              {singleStep && <Tag>单步诊断 · 仅供排查</Tag>}
              {Boolean(restoration || restoredFromLocator) && (
                <Tag>历史回执</Tag>
              )}
              {!fact && trace && (
                <Tag>{evaluationLabels[trace.evaluationStatus]}</Tag>
              )}
            </Space>
            {runId && (
              <p className="caption" title={runId}>
                诊断 {runId.slice(0, 8)}
              </p>
            )}
          </div>
        )}
        {trace && trace.steps.length > 0 && (
          <div className="api-proto-attempts">
            {trace.steps.map((step, index) => (
              <button
                key={step.id}
                type="button"
                className={`api-proto-attempt${attempt?.id === step.id ? ' selected' : ''}`}
                onClick={() => void readAttempt(step.id)}
              >
                <span aria-hidden="true">
                  {step.outcome === 'passed'
                    ? '✓'
                    : step.outcome === 'failed'
                      ? '×'
                      : '·'}
                </span>
                <span title={step.stepId}>
                  {index + 1}. {names.get(step.stepId) ?? step.stepId}
                </span>
                <small>
                  {step.sideEffectCertainty === 'unknown'
                    ? '待核实'
                    : step.phase === 'business'
                      ? attempt?.id === step.id && attempt.response_safe?.status
                        ? attempt.response_safe.status
                        : (attemptLabels[step.state] ?? step.state)
                      : step.phase === 'cleanupSql'
                        ? 'SQL'
                        : step.phase === 'cleanupHttp'
                          ? 'HTTP 清理'
                          : '认证'}
                </small>
              </button>
            ))}
          </div>
        )}
        <div className="api-proto-scroll api-proof-scroll">
          {!selecting && error && <Alert type="error" showIcon title={error} />}
          {uncertain && (
            <RecoveryBlock
              variant="pending"
              title="核对调试回执"
              description="用本次提交标识查询是否已受理。"
              reference={commandId.current}
              actions={
                <Button
                  size="small"
                  loading={loading}
                  onClick={() => void recoverReceipt()}
                >
                  查询原回执
                </Button>
              }
            />
          )}
          {receiptStatus && (
            <p className="caption api-proof-receipt-status">
              原提交查询状态：{receiptStatus}
            </p>
          )}
          {restoration?.kind === 'command' && !receipt && !uncertain && (
            <RecoveryBlock
              title="查询原调试提交"
              reference={restoration.id}
              actions={
                <Button
                  size="small"
                  loading={loading}
                  onClick={() => void recoverReceipt()}
                >
                  查询原回执
                </Button>
              }
            />
          )}
          {attempt ? (
            <ApiAttemptEvidence
              key={attempt.id}
              attempt={attempt}
              cleanup={cleanupBody}
              logs={logBody}
              {...(onRule
                ? {
                    onRule: (rule: ResponseRule) =>
                      onRule(attempt.step_id, rule),
                  }
                : {})}
            />
          ) : (
            <Tabs
              size="small"
              items={[
                ...['响应', '请求', '断言', '提取'].map((label) => ({
                  key: label,
                  label,
                  children: (
                    <p className="api-proof-placeholder">
                      {attemptLoading || (loading && (draft || restoration))
                        ? '正在读取原诊断证据。'
                        : '运行调试后，可在这里查看步骤的请求、响应、断言和变量提取。'}
                    </p>
                  ),
                })),
                { key: 'cleanup', label: '清理', children: cleanupBody },
                { key: 'logs', label: '日志', children: logBody },
              ]}
            />
          )}
        </div>
        <div className="api-proto-pane-foot">
          {qualificationCommand ? (
            <RecoveryBlock
              variant="pending"
              title="核对回归资格保存"
              reference={qualificationCommand}
              actions={
                <Button
                  size="small"
                  loading={savingQualification}
                  onClick={() => void readQualificationReceipt()}
                >
                  查询原回执
                </Button>
              }
            />
          ) : (
            <Button
              block
              type={
                eligible && !trace?.qualificationRetained
                  ? 'primary'
                  : 'default'
              }
              disabled={!eligible || Boolean(trace?.qualificationRetained)}
              loading={savingQualification}
              icon={<AppIcon name="check" />}
              onClick={() => void saveQualification()}
            >
              保存为可回归
            </Button>
          )}
          <p className="caption">{text}</p>
        </div>
      </aside>
      <Modal
        zIndex={uiLayers.nestedDialog}
        title={singleStep ? '确认单步诊断' : '确认完整调试范围'}
        open={selecting}
        onCancel={onClose}
        closable={!pending}
        maskClosable={!pending}
        keyboard={!pending}
        footer={startActions}
        destroyOnHidden
      >
        {selecting && preflight}
      </Modal>
    </>
  );
}

export function readDiagnosticRestoration(): DiagnosticRestoration | null {
  const query = new URLSearchParams(window.location.hash.split('?')[1]);
  const run = idSchema.safeParse(query.get('debugRunId'));
  if (run.success) return { kind: 'run', id: run.data };
  const command = idSchema.safeParse(query.get('debugCommandId'));
  return command.success ? { kind: 'command', id: command.data } : null;
}
export function ApiDiagnosticPage({ project }: { project: Project | null }) {
  const [form] = Form.useForm<{ kind: 'command' | 'run'; id: string }>();
  const [restoration, setRestoration] = useState<DiagnosticRestoration | null>(
    readDiagnosticRestoration,
  );
  const [error, setError] = useState<string>();
  useEffect(() => {
    function update() {
      setRestoration(readDiagnosticRestoration());
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
      <RecoveryBlock
        title="查询原接口诊断"
        description="按原诊断轮次或提交标识查看当前项目的调试记录。"
      >
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
        <RecoveryQueryForm
          form={form}
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
          <Form.Item name="kind" label="记录类型">
            <Select options={diagnosticLookupOptions} />
          </Form.Item>
          <Form.Item name="id" label="原标识" rules={[{ required: true }]}>
            <Input autoComplete="off" placeholder="输入原记录标识" />
          </Form.Item>
          <Form.Item className="recovery-query-submit">
            <Button htmlType="submit" disabled={!project} type="primary">
              查询原记录
            </Button>
          </Form.Item>
        </RecoveryQueryForm>
      </RecoveryBlock>
      {project && contextMatches && restoration && (
        <Modal
          open
          width={900}
          title="查看原接口调试证据"
          zIndex={uiLayers.dialog}
          rootClassName="api-history-dialog"
          onCancel={() => setRestoration(null)}
          footer={<Button onClick={() => setRestoration(null)}>关闭</Button>}
          destroyOnHidden
        >
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
        </Modal>
      )}
    </Space>
  );
}
