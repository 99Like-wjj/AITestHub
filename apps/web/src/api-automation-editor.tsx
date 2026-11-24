import { useEffect, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Space,
} from 'antd';
import { PlayCircleOutlined } from '@ant-design/icons';
import { z } from 'zod';
import {
  apiAutomationRevisionsSchema,
  type ApiProjectCase,
  type ApiProjectScenario,
} from '../../../packages/contracts/src/api-automation';
import type { ApiCatalogGetResult } from '../../../packages/contracts/src/api-catalog';
import {
  apiRegressionQualificationListSchema,
  debugHistorySchema,
} from '../../../packages/contracts/src/api-execution';
import { api, describeError } from './api';
import { ApiCaseFields } from './api-case-fields';
import { ApiCaseComposition } from './api-case-composition';
import {
  ApiDraftDebugger,
  type DiagnosticDraft,
  type DiagnosticRestoration,
} from './api-draft-debugger';
import {
  apiDraftFromContent,
  composeDraftFlow,
  emptyApiDraft,
  serializeApiDraft,
  type ApiDraft,
} from './api-draft';
import { makeCatalogRequest } from './api-catalog-source';
import { CommandDialog, useBusinessCommand } from './business-command';
import { registerNavigationBlocker } from './navigation-guard';
import { StatusTag } from './semantic-status';
import { BeijingTime } from './beijing-time';
import { ApiAutomationSources, ApiFlowEditor } from './api-automation-flow';
import { ApiStageFields } from './api-stage-fields';
import {
  RequirementBasisNotice,
  RequirementBasisTag,
  requirementMaterialsHref,
} from './requirement-basis';
import './api-workbench.css';

type Qualification = z.output<
  typeof apiRegressionQualificationListSchema
>['qualifications'][number];

function initialDraft(
  asset?: ApiProjectCase,
  endpoint?: ApiCatalogGetResult,
  scenarioId: string | null = null,
): ApiDraft {
  if (asset) return apiDraftFromContent(asset.content);
  const draft = emptyApiDraft(scenarioId);
  if (!endpoint?.revision) return draft;
  const { request, variables } = makeCatalogRequest(endpoint);
  return {
    ...draft,
    base: { ...draft.base, title: endpoint.revision.title },
    requests: [request],
    variableEntries: variables,
  };
}

export function ApiAutomationEditor({
  projectId,
  userId,
  asset,
  projectCases,
  scenes,
  sceneId,
  preferScenario,
  endpoint,
  diagnosticOnly,
  writable,
  canDiagnose,
  restoration,
  openHistory,
  saveCase,
  onSaved,
  onClone,
  onArchive,
  onOpenRevision,
}: {
  projectId: string;
  userId: string;
  asset: ApiProjectCase | undefined;
  projectCases: ApiProjectCase[];
  scenes: ApiProjectScenario[];
  sceneId: string | undefined;
  preferScenario: boolean;
  endpoint: ApiCatalogGetResult | undefined;
  diagnosticOnly: boolean;
  writable: boolean;
  canDiagnose: boolean;
  restoration?: DiagnosticRestoration | undefined;
  openHistory?: boolean;
  saveCase: (
    content: ApiProjectCase['content'],
    commandId: string,
  ) => Promise<ApiProjectCase>;
  onSaved: (asset: ApiProjectCase) => void;
  onClone?:
    ((commandId: string, title: string) => Promise<ApiProjectCase>) | undefined;
  onArchive?: (() => void) | undefined;
  onOpenRevision: (caseId: string, revisionId?: string) => void;
}) {
  const { modal, message } = App.useApp();
  const [draft, setDraft] = useState(() =>
    initialDraft(
      asset,
      endpoint,
      sceneId ?? (preferScenario ? scenes[0]?.id : undefined) ?? null,
    ),
  );
  const [kind, setKind] = useState<'single' | 'scenario'>(() =>
    asset
      ? asset.parentId
        ? 'scenario'
        : 'single'
      : preferScenario
        ? 'scenario'
        : 'single',
  );
  const [dirty, setDirty] = useState(false);
  const [diagnostic, setDiagnostic] = useState<DiagnosticDraft | null>(null);
  const [diagnosticBase, setDiagnosticBase] = useState<ApiDraft>();
  const [restore, setRestore] = useState<DiagnosticRestoration | null>(
    restoration ?? null,
  );
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [diagError, setDiagError] = useState<string>();
  const [history, setHistory] = useState(openHistory ?? false);
  const [metadata, setMetadata] = useState(!asset && !diagnosticOnly);
  const [flowOpen, setFlowOpen] = useState(false);
  const [stagesOpen, setStagesOpen] = useState(false);
  const [environmentHost, setEnvironmentHost] = useState<HTMLDivElement | null>(
    null,
  );
  const [previewEnvironmentId, setPreviewEnvironmentId] = useState<string>();
  const [ruleFocus, setRuleFocus] = useState<{
    stepId: string;
    tab: 'extractors' | 'assertions';
    nonce: string;
  }>();
  const [qualifications, setQualifications] = useState<Qualification[]>([]);
  const [revisions, setRevisions] = useState<
    z.output<typeof apiAutomationRevisionsSchema>['revisions']
  >([]);
  const [qualError, setQualError] = useState<string>();
  const [qualReload, setQualReload] = useState(0);
  const [withdraw, setWithdraw] = useState<Qualification>();
  const [withdrawReason, setWithdrawReason] = useState('');
  const [session, setSession] = useState(() => crypto.randomUUID());
  const command = useBusinessCommand(session);
  const [cloneSession, setCloneSession] = useState<string | null>(null);
  const [cloneTitle, setCloneTitle] = useState('');
  const cloneCommand = useBusinessCommand(cloneSession);
  const withdrawCommand = useBusinessCommand(withdraw?.snapshotId ?? null);
  const currentCase = projectCases.find((item) => item.id === asset?.id);
  const activeQualification = qualifications.find(
    (item) => item.caseId === asset?.id,
  );
  const currentScene = scenes.find((item) => item.id === draft.base.scenarioId);
  const noEnabledRows = Boolean(
    draft.base.dataRows?.length &&
    draft.base.dataRows.every((row) => row.enabled === false),
  );
  const authoredFlow = composeDraftFlow(draft.base.flow, draft.requests);
  const noEnabledSteps =
    authoredFlow.length > 0 &&
    authoredFlow.every((node) => node.enabled === false);
  const disabled =
    !writable || diagnosticBusy || command.pending || command.uncertain;
  const diagnosticMatch = !diagnostic || diagnosticBase === draft;
  useEffect(() => {
    const controller = new AbortController();
    setQualError(undefined);
    void api(
      `/projects/${projectId}/api-executions/regression-qualifications`,
      { signal: controller.signal },
      apiRegressionQualificationListSchema,
    ).then(
      ({ qualifications }) => {
        if (!controller.signal.aborted) setQualifications(qualifications);
      },
      (failure: unknown) => {
        if (!controller.signal.aborted) setQualError(describeError(failure));
      },
    );
    return () => controller.abort();
  }, [projectId, qualReload, asset?.revisionId]);
  useEffect(() => {
    if (!asset) return;
    const controller = new AbortController();
    void api(
      `/projects/${projectId}/api-automation`,
      {
        method: 'POST',
        body: { op: 'revisions', assetId: asset.id },
        signal: controller.signal,
      },
      apiAutomationRevisionsSchema,
    ).then(
      ({ revisions }) => {
        if (!controller.signal.aborted) setRevisions(revisions);
      },
      (failure: unknown) => {
        if (!controller.signal.aborted) setQualError(describeError(failure));
      },
    );
    return () => controller.abort();
  }, [projectId, asset?.id, asset?.revisionId]);
  useEffect(() => {
    if (
      !dirty &&
      !diagnosticBusy &&
      !command.pending &&
      !command.uncertain &&
      !cloneCommand.pending
    )
      return;
    return registerNavigationBlocker((proceed) => {
      if (diagnosticBusy || command.pending || cloneCommand.pending) return;
      modal.confirm({
        title: command.uncertain
          ? '保存回执待核对，离开编辑？'
          : '放弃尚未保存的编排修改？',
        okText: '离开',
        cancelText: '继续编辑',
        onOk: proceed,
      });
    });
  }, [
    dirty,
    diagnosticBusy,
    command.pending,
    command.uncertain,
    cloneCommand.pending,
    modal,
  ]);
  useEffect(
    () => setRestore(restoration ?? null),
    [restoration?.kind, restoration?.id],
  );

  function change(value: ApiDraft) {
    setDraft(value);
    setDirty(true);
  }
  function validContent() {
    if (kind === 'scenario' && !draft.base.scenarioId)
      throw new Error('场景用例需要选择项目场景。');
    return serializeApiDraft(draft);
  }
  async function save() {
    if (diagnosticOnly || !writable) return;
    const result = await command.run((commandId) =>
      saveCase(validContent(), commandId),
    );
    if (result) {
      setDirty(false);
      setSession(crypto.randomUUID());
      onSaved(result);
      void message.success('已保存草稿修订 r' + result.revisionNo);
    }
  }
  function run(stepId?: string) {
    if (!canDiagnose) return;
    setDiagError(undefined);
    try {
      if (noEnabledRows) throw new Error('当前用例没有已启用的数据行。');
      if (!stepId && noEnabledSteps)
        throw new Error('当前用例没有已启用的编排节点。');
      const content = validContent();
      setRestore(null);
      setDiagnosticBase(draft);
      setDiagnostic({
        content,
        sourceCaseId: asset?.id ?? null,
        sourceCaseRevisionId: asset?.revisionId ?? null,
        ...(asset && { sourceCaseRowVersion: asset.rowVersion }),
        ...(previewEnvironmentId && { previewEnvironmentId }),
        ...(stepId && { stepId }),
      });
    } catch (failure) {
      setDiagError(describeError(failure));
      if (!draft.base.title || !draft.base.testPoint || !draft.base.expected)
        setMetadata(true);
    }
  }
  function validate() {
    setDiagError(undefined);
    try {
      validContent();
      void message.success('编排结构、请求和变量引用校验通过。');
    } catch (failure) {
      setDiagError(describeError(failure));
    }
  }
  const scope = diagnosticOnly
    ? '本次请求诊断'
    : kind === 'single'
      ? '项目级 · 独立单接口用例'
      : currentScene
        ? '项目场景 · ' + currentScene.title
        : '项目场景待选择';
  return (
    <article className="card api-catalog-detail api-automation-editor api-immersive-content">
      <header className="api-catalog-section-head">
        <div>
          <div className="row wrap">
            <StatusTag tone="info">
              {diagnosticOnly
                ? '请求调试'
                : kind === 'single'
                  ? '单接口用例'
                  : '场景用例'}
            </StatusTag>
            <h2>
              {draft.base.title ||
                (diagnosticOnly ? '请求调试' : '新建接口用例')}
            </h2>
            {asset && <StatusTag tone="neutral">r{asset.revisionNo}</StatusTag>}
            <RequirementBasisTag basis={asset?.requirementBasis} />
            {activeQualification && (
              <StatusTag tone="success">
                可回归 r{activeQualification.revisionNo}
              </StatusTag>
            )}
          </div>
          <p className="caption">
            {scope} · {draft.requests.length} 个请求步骤
          </p>
        </div>
        {writable && (
          <Space wrap>
            {!diagnosticOnly && (
              <Button
                disabled={disabled}
                loading={command.pending}
                onClick={() => void save()}
              >
                保存草稿
              </Button>
            )}
            {canDiagnose && (
              <Button
                type="primary"
                icon={<PlayCircleOutlined />}
                disabled={disabled || noEnabledRows || noEnabledSteps}
                onClick={() => run()}
              >
                运行调试
              </Button>
            )}
          </Space>
        )}
      </header>
      {!writable && asset && (
        <Alert showIcon type="info" title="当前修订为只读。" />
      )}
      {asset ? (
        <RequirementBasisNotice
          projectId={projectId}
          basis={asset.requirementBasis}
          showLinks
        />
      ) : currentScene?.requirementBasis ? (
        <div>
          <Button
            size="small"
            href={requirementMaterialsHref(
              projectId,
              currentScene.requirementBasis.requirementId,
            )}
          >
            查看当前需求资料
          </Button>
        </div>
      ) : null}
      {command.error && <Alert showIcon type="error" title={command.error} />}
      {command.uncertain && (
        <Alert
          showIcon
          type="warning"
          title={'保存回执待核对 · ' + command.commandId}
        />
      )}
      {diagError && <Alert showIcon type="error" title={diagError} />}
      {noEnabledRows && (
        <Alert
          showIcon
          type="info"
          title="当前用例没有已启用的数据行，启用后可调试。"
        />
      )}
      <div className="api-automation-toolbar row wrap">
        {!diagnosticOnly && (
          <Button size="small" onClick={() => setMetadata(true)}>
            用例说明
          </Button>
        )}
        <Button size="small" onClick={() => setFlowOpen(true)}>
          执行流程
        </Button>
        <Button size="small" onClick={() => setStagesOpen(true)}>
          用例前后置
        </Button>
        <Button size="small" disabled={!asset} onClick={() => setHistory(true)}>
          诊断记录
        </Button>
        {asset && onClone && (
          <Button
            size="small"
            disabled={
              dirty || diagnosticBusy || command.pending || command.uncertain
            }
            onClick={() => {
              setCloneTitle(asset.title.slice(0, 196) + '（副本）');
              setCloneSession(crypto.randomUUID());
            }}
          >
            复制此修订
          </Button>
        )}
        <div ref={setEnvironmentHost} />
      </div>
      {noEnabledSteps && (
        <Alert
          showIcon
          type="info"
          title="当前编排节点均已停用。可重新启用或对明确选择的请求做单步诊断。"
        />
      )}
      <div className="api-workbench-split api-automation-split">
        <div className="api-workbench-editor stack">
          <ApiCaseFields
            projectId={projectId}
            value={draft}
            onChange={change}
            disabled={disabled}
            maxRequests={kind === 'single' ? 1 : 100}
            workspaceKey={asset && `${userId}:${projectId}:${asset.id}`}
            presentation="workbench"
            {...(canDiagnose && !noEnabledRows && { onSingleDiagnostic: run })}
            onValidate={validate}
            ruleFocus={ruleFocus}
            previewEnvironmentId={previewEnvironmentId}
            onPreviewEnvironmentChange={setPreviewEnvironmentId}
            environmentHost={environmentHost}
            workspaceSummary={
              <div className="api-proto-summary">
                {asset && (
                  <p>
                    <span>用例 ID</span>
                    <code title={asset.id}>{asset.id}</code>
                  </p>
                )}
                <p>
                  <span>回归资格</span>
                  <b>
                    {activeQualification
                      ? 'r' + activeQualification.revisionNo
                      : '待完整诊断'}
                  </b>
                </p>
              </div>
            }
            workspacePanels={{
              data: (
                <ApiCaseComposition
                  value={draft.base}
                  cases={projectCases.flatMap((record) => {
                    const qualified = qualifications.find(
                      (entry) => entry.caseId === record.id,
                    );
                    return qualified && record.id !== asset?.id
                      ? [
                          {
                            ...record,
                            revisionId: qualified.revisionId,
                            revisionNo: qualified.revisionNo,
                          },
                        ]
                      : [];
                  })}
                  disabled={disabled}
                  onApply={(parts) =>
                    change({ ...draft, base: { ...draft.base, ...parts } })
                  }
                />
              ),
              revisions: (
                <div className="api-catalog-stack">
                  <div className="row wrap">
                    <strong>修订与资格</strong>
                    {asset && (
                      <span>
                        r{asset.revisionNo} · <code>{asset.revisionId}</code>
                      </span>
                    )}
                  </div>
                  {qualError && (
                    <Alert type="error" title={qualError} showIcon />
                  )}
                  {asset && revisions.length > 0 && (
                    <div className="row wrap" aria-label="用例修订列表">
                      {revisions.map((item) => (
                        <Button
                          key={item.revisionId}
                          size="small"
                          type={
                            item.revisionId === asset.revisionId
                              ? 'primary'
                              : 'default'
                          }
                          onClick={() =>
                            onOpenRevision(asset.id, item.revisionId)
                          }
                        >
                          r{item.revisionNo} ·{' '}
                          <BeijingTime value={item.createdAt} />
                        </Button>
                      ))}
                    </div>
                  )}
                  {currentCase &&
                    currentCase.revisionId !== asset?.revisionId && (
                      <Button onClick={() => onOpenRevision(currentCase.id)}>
                        查看当前修订 r{currentCase.revisionNo}
                      </Button>
                    )}
                  {activeQualification &&
                    activeQualification.revisionId !== asset?.revisionId && (
                      <Button
                        onClick={() =>
                          onOpenRevision(
                            activeQualification.caseId,
                            activeQualification.revisionId,
                          )
                        }
                      >
                        查看可回归修订 r{activeQualification.revisionNo}
                      </Button>
                    )}
                  {canDiagnose && activeQualification && (
                    <div className="row wrap">
                      <Button
                        href={`#plans?${new URLSearchParams({ projectId, kind: 'API', caseId: activeQualification.caseId })}`}
                      >
                        加入回归计划
                      </Button>
                      <Button
                        danger
                        disabled={disabled}
                        onClick={() => {
                          setWithdraw(activeQualification);
                          setWithdrawReason('');
                        }}
                      >
                        停止使用此资格
                      </Button>
                    </div>
                  )}
                  {asset && onArchive && (
                    <div>
                      <Button danger disabled={disabled} onClick={onArchive}>
                        归档用例
                      </Button>
                    </div>
                  )}
                </div>
              ),
              sources: (
                <ApiAutomationSources
                  caseId={asset?.id}
                  projectId={projectId}
                  draft={draft}
                  onChange={change}
                  projectCases={projectCases}
                  disabled={disabled}
                  standalone={kind === 'single'}
                />
              ),
            }}
          />
        </div>
        <ApiDraftDebugger
          projectId={projectId}
          draft={diagnostic}
          restoration={restore}
          userId={userId}
          candidateCurrent={diagnosticMatch}
          {...(asset && { expectedCaseId: asset.id })}
          onOpenHistory={() => setHistory(true)}
          onBusyChange={setDiagnosticBusy}
          {...(canDiagnose &&
            writable &&
            !diagnosticOnly && { onQualified: onSaved })}
          onClose={() => {
            setDiagnostic(null);
            setRestore(null);
          }}
          {...(!disabled && {
            onRule: (stepId, rule) => {
              if (!draft.requests.some((step) => step.stepId === stepId))
                return '该请求步骤不在当前草稿。';
              if (
                rule.kind === 'extractor' &&
                draft.requests.some((step) =>
                  step.extractors.some((entry) => entry.name === rule.name),
                )
              )
                return '此用例已存在同名提取变量。';
              change({
                ...draft,
                requests: draft.requests.map((step) => {
                  if (step.stepId !== stepId) return step;
                  if (rule.kind === 'assertion')
                    return {
                      ...step,
                      assertions: [
                        ...step.assertions,
                        {
                          id: crypto.randomUUID(),
                          source: 'json',
                          path: rule.path,
                          operator: 'equals',
                          expectedText: JSON.stringify(rule.expected),
                        },
                      ],
                    };
                  return {
                    ...step,
                    extractors: [
                      ...step.extractors,
                      {
                        name: rule.name,
                        path: rule.path,
                        source: 'json',
                        required: true,
                        sensitive: rule.sensitive,
                      },
                    ],
                  };
                }),
              });
              setRuleFocus({
                stepId,
                tab: rule.kind === 'assertion' ? 'assertions' : 'extractors',
                nonce: crypto.randomUUID(),
              });
              return undefined;
            },
          })}
        />
      </div>
      <Modal
        title="用例名称与说明"
        open={metadata}
        onCancel={() => setMetadata(false)}
        footer={
          <Button type="primary" onClick={() => setMetadata(false)}>
            完成
          </Button>
        }
      >
        <Form layout="vertical">
          {!asset && (
            <Form.Item label="用例类型">
              <Select
                value={kind}
                disabled={disabled}
                options={[
                  { value: 'single', label: '单接口用例' },
                  { value: 'scenario', label: '场景用例' },
                ]}
                onChange={(next: 'single' | 'scenario') => {
                  setKind(next);
                  change({
                    ...draft,
                    base: {
                      ...draft.base,
                      scenarioId:
                        next === 'scenario' ? (scenes[0]?.id ?? null) : null,
                    },
                  });
                }}
              />
            </Form.Item>
          )}
          {kind === 'scenario' && (
            <Form.Item label="项目场景">
              <Select
                value={draft.base.scenarioId}
                disabled={disabled || Boolean(asset)}
                options={scenes.map((row) => ({
                  value: row.id,
                  label: row.title,
                }))}
                onChange={(scenarioId: string) =>
                  change({ ...draft, base: { ...draft.base, scenarioId } })
                }
              />
            </Form.Item>
          )}
          <Form.Item label="用例名称">
            <Input
              value={draft.base.title}
              disabled={disabled}
              onChange={(event) =>
                change({
                  ...draft,
                  base: { ...draft.base, title: event.target.value },
                })
              }
            />
          </Form.Item>
          <Form.Item label="标签">
            <Select
              aria-label="用例标签"
              mode="tags"
              tokenSeparators={[',', '，']}
              maxCount={20}
              maxTagCount="responsive"
              value={draft.base.tags ?? []}
              disabled={disabled}
              onChange={(value: string[]) =>
                change({
                  ...draft,
                  base: {
                    ...draft.base,
                    tags: [
                      ...new Set(
                        value.map((tag) => tag.trim()).filter(Boolean),
                      ),
                    ],
                  },
                })
              }
            />
          </Form.Item>
          <Form.Item label="测试目标">
            <Input.TextArea
              value={draft.base.testPoint}
              disabled={disabled}
              onChange={(event) =>
                change({
                  ...draft,
                  base: { ...draft.base, testPoint: event.target.value },
                })
              }
            />
          </Form.Item>
          <Form.Item label="前置条件">
            <Input.TextArea
              value={draft.base.preconditions.join('\n')}
              disabled={disabled}
              onChange={(event) =>
                change({
                  ...draft,
                  base: {
                    ...draft.base,
                    preconditions: event.target.value.split('\n'),
                  },
                })
              }
            />
          </Form.Item>
          <Form.Item label="预期结果">
            <Input.TextArea
              value={draft.base.expected}
              disabled={disabled}
              onChange={(event) =>
                change({
                  ...draft,
                  base: { ...draft.base, expected: event.target.value },
                })
              }
            />
          </Form.Item>
        </Form>
      </Modal>
      {asset && cloneSession && onClone && (
        <CommandDialog
          open
          title="复制用例修订"
          command={cloneCommand}
          dirty={false}
          onClose={() => setCloneSession(null)}
          saveLabel="创建副本"
          allowSave={Boolean(cloneTitle.trim())}
          onSave={() =>
            void cloneCommand
              .run((commandId) => onClone(commandId, cloneTitle))
              .then((created) => {
                if (!created) return;
                setCloneSession(null);
                onSaved(created);
              })
          }
        >
          <p className="caption">
            基于 r{asset.revisionNo}{' '}
            创建新的待诊断用例。副本拥有自己的修订与资格。
          </p>
          <label className="api-catalog-form-field">
            <span>副本名称</span>
            <Input
              value={cloneTitle}
              maxLength={200}
              disabled={cloneCommand.pending || cloneCommand.uncertain}
              onChange={(event) => setCloneTitle(event.target.value)}
            />
          </label>
        </CommandDialog>
      )}
      {flowOpen && (
        <ApiFlowEditor
          projectId={projectId}
          projectCases={projectCases}
          caseId={asset?.id}
          draft={draft}
          disabled={disabled}
          allowStructure={kind === 'scenario'}
          onChange={change}
          onClose={() => setFlowOpen(false)}
        />
      )}
      {stagesOpen && (
        <Modal
          open
          title="用例级前后置操作"
          width={800}
          onCancel={() => setStagesOpen(false)}
          footer={
            <Button type="primary" onClick={() => setStagesOpen(false)}>
              完成
            </Button>
          }
        >
          <ApiStageFields
            projectId={projectId}
            value={draft.base.stageSettings}
            disabled={disabled}
            onChange={(stageSettings) =>
              change({ ...draft, base: { ...draft.base, stageSettings } })
            }
          />
        </Modal>
      )}
      {history && asset && (
        <DiagnosticHistory
          projectId={projectId}
          caseId={asset.id}
          onClose={() => setHistory(false)}
          onSelect={(id) => {
            setDiagnostic(null);
            setRestore({ kind: 'run', id });
            setHistory(false);
          }}
        />
      )}
      {withdraw && (
        <Modal
          title="停止使用回归资格"
          open
          onCancel={() => setWithdraw(undefined)}
          confirmLoading={withdrawCommand.pending}
          okButtonProps={{
            disabled: !withdrawReason.trim() || withdrawCommand.uncertain,
          }}
          onOk={() =>
            void withdrawCommand
              .run((commandId) =>
                api(
                  `/projects/${projectId}/api-executions/regression-qualifications/withdraw`,
                  {
                    method: 'POST',
                    body: {
                      commandId,
                      snapshotId: withdraw.snapshotId,
                      reason: withdrawReason,
                    },
                  },
                ),
              )
              .then((result) => {
                if (result) {
                  setWithdraw(undefined);
                  setQualReload((count) => count + 1);
                }
              })
          }
        >
          {withdrawCommand.error && (
            <Alert type="error" title={withdrawCommand.error} showIcon />
          )}
          <label className="api-catalog-form-field">
            <span>停用原因</span>
            <Input.TextArea
              value={withdrawReason}
              maxLength={1000}
              onChange={(event) => setWithdrawReason(event.target.value)}
            />
          </label>
        </Modal>
      )}
    </article>
  );
}

function DiagnosticHistory({
  projectId,
  caseId,
  onClose,
  onSelect,
}: {
  projectId: string;
  caseId: string;
  onClose: () => void;
  onSelect: (runId: string) => void;
}) {
  const [rounds, setRounds] =
    useState<z.output<typeof debugHistorySchema>['rounds']>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    void api(
      `/projects/${projectId}/api-executions/debug-history?caseId=${caseId}`,
      { signal: controller.signal },
      debugHistorySchema,
    ).then(
      ({ rounds }) => {
        if (!controller.signal.aborted) setRounds(rounds);
      },
      (failure: unknown) => {
        if (!controller.signal.aborted) setError(describeError(failure));
      },
    );
    return () => controller.abort();
  }, [projectId, caseId]);
  return (
    <Modal
      title="诊断记录"
      open
      onCancel={onClose}
      footer={<Button onClick={onClose}>关闭</Button>}
    >
      {error ? (
        <Alert type="error" title={error} showIcon />
      ) : rounds?.length ? (
        <div className="api-catalog-stack">
          {rounds.map((row) => (
            <div className="api-catalog-usage-row" key={row.runId}>
              <span>
                <BeijingTime value={row.createdAt} /> ·{' '}
                {row.diagnosticStepId ? '单步' : '完整诊断'}
              </span>
              <Button type="link" onClick={() => onSelect(row.runId)}>
                查看{row.sourceRevisionNo && ' r' + row.sourceRevisionNo}
              </Button>
            </div>
          ))}
        </div>
      ) : rounds ? (
        <Empty description="当前用例暂无诊断记录。" />
      ) : (
        <p role="status">正在读取诊断记录…</p>
      )}
    </Modal>
  );
}
