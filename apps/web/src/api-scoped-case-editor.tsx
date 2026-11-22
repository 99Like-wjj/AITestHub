import { useEffect, useState } from 'react';
import { Alert, App, Button, Input, Modal, Select } from 'antd';
import {
  assetOperationStatusSchema,
  assetReceiptSchema,
  createScopedCaseInputSchema,
  type Asset,
} from '../../../packages/contracts/src/assets';
import { idSchema } from '../../../packages/contracts/src/base';
import { api, describeError } from './api';
import { ApiCaseFields } from './api-case-fields';
import { emptyApiDraft, serializeApiDraft, type ApiDraft } from './api-draft';
import { useBusinessCommand } from './business-command';
import { registerNavigationBlocker } from './navigation-guard';
import { StandaloneWorkbenchHeader } from './standalone-workbench-header';
import { ApiDraftDebugger } from './api-draft-debugger';
import { ApiCaseComposition } from './api-case-composition';
import { ApiDefinitionLibrary } from './api-definition-library';
import { StatusTag } from './semantic-status';
import { AppIcon } from './app-icon';

const operation = 'assets.create-scoped-case';

type RequirementChoice = {
  id: string;
  title: string;
  archived: boolean;
  versions: readonly { id: string; versionNo: number }[];
};

export function ApiScopedCaseEditor({
  projectId,
  projectName,
  userId,
  requirements,
  assets,
  initialVersionId,
  initialScenarioId,
  onStage,
  onClose,
  onSaved,
}: {
  projectId: string;
  projectName: string;
  userId: string;
  requirements: readonly RequirementChoice[];
  assets: readonly Asset[];
  initialVersionId?: string | undefined;
  initialScenarioId?: string | undefined;
  onStage: (draftRouteId: string) => void;
  onClose: () => void;
  onSaved: (asset: Asset) => Promise<void>;
}) {
  const { message, modal } = App.useApp();
  const [session, setSession] = useState(() => crypto.randomUUID());
  const command = useBusinessCommand(session);
  const [draftRouteId] = useState(() => crypto.randomUUID());
  const [draft, setDraft] = useState<ApiDraft>(() => ({
    ...emptyApiDraft(crypto.randomUUID()),
    requests: [],
  }));
  const allowed = requirements.filter(
    (record) => !record.archived && record.versions.length > 0,
  );
  const initialRequirement = allowed.find((item) =>
    item.versions.some((version) => version.id === initialVersionId),
  );
  const [requirementId, setRequirementId] = useState(initialRequirement?.id);
  const [requirementVersionId, setRequirementVersionId] = useState(
    initialRequirement ? initialVersionId : undefined,
  );
  const requirement = allowed.find((item) => item.id === requirementId);
  const currentVersion = requirement?.versions.find(
    (item) => item.id === requirementVersionId,
  );
  const [scenarioId, setScenarioId] = useState(
    initialScenarioId ??
      assets.find(
        (item) =>
          item.targetType === 'scenario' &&
          item.requirementVersionId === initialVersionId &&
          !item.removedAt,
      )?.id,
  );
  const [scenarioName, setScenarioName] = useState('');
  const [objective, setObjective] = useState('');
  const [setId, setSetId] = useState<string>();
  const [staged, setStaged] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [environmentHost, setEnvironmentHost] = useState<HTMLDivElement | null>(
    null,
  );
  const [previewEnvironmentId, setPreviewEnvironmentId] = useState<string>();
  const [requestFocus, setRequestFocus] = useState<{
    stepId: string;
    tab: 'parameters';
    nonce: string;
  }>();
  const scenarios = assets.filter(
    (item) =>
      item.targetType === 'scenario' &&
      item.requirementVersionId === requirementVersionId &&
      !item.removedAt,
  );
  const collections = assets.filter(
    (item) =>
      item.targetType === 'set' &&
      item.requirementVersionId === requirementVersionId &&
      !item.removedAt,
  );
  const selectedScene = scenarios.find((item) => item.id === scenarioId);
  const sceneLabel = selectedScene?.title ?? scenarioName.trim();
  const scopeReady = Boolean(
    requirement &&
    currentVersion &&
    draft.base.title.trim() &&
    (selectedScene ||
      (scenarioName.trim() && (collections.length < 2 || setId))),
  );
  const key = 'aitesthub:scoped-api-case:' + userId + ':' + projectId;
  const [recovery, setRecovery] = useState<string>();
  const [recovering, setRecovering] = useState(false);
  const [recoveryStatus, setRecoveryStatus] = useState<string>();
  const [saving, setSaving] = useState(false);
  const disabled =
    command.pending || command.uncertain || Boolean(recovery) || saving;

  useEffect(() => {
    try {
      const value = idSchema.safeParse(localStorage.getItem(key));
      if (value.success) setRecovery(value.data);
    } catch {
      // Only the receipt locator is persisted.
    }
  }, [key]);
  useEffect(() => {
    if (!command.uncertain) return;
    setRecovery(command.commandId);
    try {
      localStorage.setItem(key, command.commandId);
    } catch {
      setRecoveryStatus('浏览器未能保留原标识，请手动记录提交 ID。');
    }
  }, [command.uncertain, command.commandId, key]);

  function markEdited() {
    if (command.error) setSession(crypto.randomUUID());
  }
  function clearReceipt() {
    setRecovery(undefined);
    try {
      localStorage.removeItem(key);
    } catch {
      // The in-page copy was already cleared.
    }
  }
  async function accepted(asset: Asset) {
    if (
      asset.projectId !== projectId ||
      asset.kind !== 'API' ||
      asset.targetType !== 'case'
    )
      throw Error('原回执不属于当前项目的接口用例。');
    clearReceipt();
    await onSaved(asset);
    void message.success('接口用例已保存。');
  }
  async function save() {
    if (
      disabled ||
      !scopeReady ||
      !requirementVersionId ||
      !draft.requests.length
    )
      return;
    setSaving(true);
    try {
      const result = await command.run((commandId) => {
        const { scenarioId: _localScenario, ...content } =
          serializeApiDraft(draft);
        const input = createScopedCaseInputSchema.parse({
          commandId,
          kind: 'API',
          requirementVersionId,
          scenario: selectedScene
            ? { scenarioId: selectedScene.id }
            : {
                title: scenarioName.trim(),
                objective: objective.trim(),
                sharedPreconditions: [],
                basisRefs: [],
                ...(setId ? { setId } : {}),
              },
          content,
        });
        return api(
          '/projects/' + projectId + '/assets/scoped-cases',
          { method: 'POST', body: input },
          assetReceiptSchema,
        );
      });
      if (result) await accepted(result.asset);
    } catch (failure) {
      command.setError(describeError(failure));
    } finally {
      setSaving(false);
    }
  }
  async function recover() {
    if (!recovery || recovering) return;
    setRecovering(true);
    try {
      const receipt = await api(
        '/projects/' +
          projectId +
          '/assets/receipts/' +
          recovery +
          '?operation=' +
          operation,
        {},
        assetOperationStatusSchema,
      );
      if (receipt.commandId !== recovery || receipt.operation !== operation)
        throw Error('原提交标识不匹配，保留原标识。');
      if (receipt.status === 'completed' && receipt.response) {
        await accepted(receipt.response.asset);
      } else if (receipt.status === 'failed') {
        clearReceipt();
        setSession(crypto.randomUUID());
        setRecoveryStatus('原写入已明确失败。当前草稿可继续编辑。');
      } else setRecoveryStatus('尚未确认原保存结果，继续查询原标识。');
    } catch (failure) {
      setRecoveryStatus(describeError(failure));
    } finally {
      setRecovering(false);
    }
  }

  function chooseVersion(id: string | undefined) {
    setRequirementVersionId(id);
    setScenarioId(
      assets.find(
        (item) =>
          item.targetType === 'scenario' &&
          item.requirementVersionId === id &&
          !item.removedAt,
      )?.id,
    );
    setSetId(undefined);
  }

  function confirmLeave(next: () => void) {
    if (saving || command.pending || recovering) return;
    void modal.confirm({
      title: '离开未保存的新建用例？',
      content: recovery
        ? '原提交标识已保留。稍后可从新建用例入口读取原回执。'
        : '离开后会结束当前工作草稿。',
      okText: '返回',
      cancelText: '继续编辑',
      onOk: next,
    });
  }
  useEffect(() => {
    if (!staged) return;
    return registerNavigationBlocker(confirmLeave);
  }, [staged, saving, command.pending, recovering, recovery]);
  useEffect(() => {
    if (!staged) return;
    const preserve = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', preserve);
    return () => window.removeEventListener('beforeunload', preserve);
  }, [staged]);

  const notice = recovery ? (
    <Alert
      type="warning"
      showIcon
      title={'待核对原保存 ' + recovery}
      description={recoveryStatus}
      action={
        <Button
          size="small"
          loading={recovering}
          onClick={() => void recover()}
        >
          查询原回执
        </Button>
      }
    />
  ) : (
    recoveryStatus && (
      <p role="status" className="caption">
        {recoveryStatus}
      </p>
    )
  );

  if (!staged)
    return (
      <Modal
        open
        title="新建接口用例"
        width={520}
        centered
        rootClassName="api-new-scope-modal"
        onCancel={onClose}
        footer={
          <div className="api-new-scope-footer">
            <Button onClick={onClose}>取消</Button>
            <Button
              type="primary"
              disabled={!scopeReady || disabled || recovering}
              onClick={() => {
                setStaged(true);
                onStage(draftRouteId);
              }}
            >
              进入用例草稿
            </Button>
          </div>
        }
      >
        <div className="api-new-scope-form stack">
          {notice}
          <label className="field-label">
            需求
            <Select
              aria-label="需求"
              placeholder="选择需求"
              value={requirementId ?? null}
              disabled={disabled}
              showSearch
              optionFilterProp="label"
              options={allowed.map((item) => ({
                value: item.id,
                label: item.title,
              }))}
              onChange={(id: string) => {
                setRequirementId(id);
                chooseVersion(
                  allowed.find((item) => item.id === id)?.versions[0]?.id,
                );
              }}
            />
          </label>
          <div className="api-new-case-inputs">
            <label className="field-label">
              需求版本
              <Select
                aria-label="需求版本"
                value={requirementVersionId ?? null}
                placeholder="选择版本"
                disabled={disabled || !requirement}
                options={(requirement?.versions ?? []).map((item) => ({
                  value: item.id,
                  label: 'v' + item.versionNo,
                }))}
                onChange={(id: string) => chooseVersion(id)}
              />
            </label>
            <label className="field-label">
              场景
              <Select
                aria-label="目标接口场景"
                value={scenarioId ?? ''}
                disabled={disabled || !currentVersion}
                showSearch
                optionFilterProp="label"
                options={[
                  { value: '', label: '随本次用例新增场景' },
                  ...scenarios.map((item) => ({
                    value: item.id,
                    label:
                      item.title +
                      (collections.length > 1
                        ? ' · ' +
                          (collections.find((group) => group.id === item.setId)
                            ?.title ?? item.setId)
                        : ''),
                  })),
                ]}
                onChange={(value) => {
                  setScenarioId(value || undefined);
                  markEdited();
                }}
              />
            </label>
          </div>
          {!selectedScene && currentVersion && (
            <>
              {collections.length > 1 && (
                <label className="field-label">
                  历史来源
                  <Select
                    aria-label="新增场景历史归属"
                    placeholder="选择此次明确的维护范围"
                    value={setId ?? null}
                    disabled={disabled}
                    options={collections.map((entry) => ({
                      value: entry.id,
                      label: entry.title,
                    }))}
                    onChange={(value: string) => {
                      setSetId(value);
                      markEdited();
                    }}
                  />
                </label>
              )}
              <div className="api-new-case-inputs">
                <label className="field-label">
                  场景名称
                  <Input
                    value={scenarioName}
                    maxLength={200}
                    disabled={disabled}
                    onChange={(event) => {
                      setScenarioName(event.target.value);
                      markEdited();
                    }}
                  />
                </label>
                <label className="field-label">
                  场景目标
                  <Input
                    value={objective}
                    maxLength={4000}
                    disabled={disabled}
                    onChange={(event) => {
                      setObjective(event.target.value);
                      markEdited();
                    }}
                  />
                </label>
              </div>
            </>
          )}
          <label className="field-label">
            用例名称
            <Input
              placeholder="描述要验证的接口行为"
              value={draft.base.title}
              maxLength={200}
              disabled={disabled}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  base: { ...draft.base, title: event.target.value },
                })
              }
            />
          </label>
        </div>
      </Modal>
    );

  return (
    <div className="api-new-case-workspace">
      <StandaloneWorkbenchHeader
        title="接口自动化工作台"
        projectName={projectName}
        backLabel="返回接口用例管理"
        onBack={() => confirmLeave(onClose)}
        backDisabled={command.pending || saving || recovering}
      />
      <main className="api-immersive-content">
        <header className="api-proto-intro">
          <p className="api-proto-path">
            <span>{requirement?.title}</span>
            <span aria-hidden="true">/</span>
            <span>v{currentVersion?.versionNo}</span>
            <span aria-hidden="true">/</span>
            <span>{sceneLabel}</span>
          </p>
          <div className="api-proto-intro-row">
            <div className="api-proto-intro-main">
              <div className="api-proto-title-line">
                <h1>{draft.base.title}</h1>
                <StatusTag tone="warning">未保存</StatusTag>
              </div>
              <p>
                {draft.requests.length} 个请求，
                {draft.requests.reduce(
                  (total, step) => total + step.assertions.length,
                  0,
                )}{' '}
                条断言
              </p>
            </div>
            <div className="api-proto-intro-actions">
              <Button
                type="text"
                aria-label="编辑用例说明"
                title="编辑用例说明"
                icon={<AppIcon name="settings" />}
                onClick={() => setSettingsOpen(true)}
              />
              <Button
                icon={<AppIcon name="check" />}
                disabled={disabled || !scopeReady || !draft.requests.length}
                loading={saving || command.pending}
                onClick={() => void save()}
              >
                保存草稿
              </Button>
              <div ref={setEnvironmentHost} />
              <Button
                type="primary"
                icon={<AppIcon name="play" />}
                disabled
                title="首次保存后可运行调试"
              >
                运行调试
              </Button>
            </div>
          </div>
        </header>
        {notice}
        {command.error && <Alert type="error" showIcon title={command.error} />}
        <div className="api-workbench-split">
          <div className="api-workbench-editor">
            <ApiCaseFields
              projectId={projectId}
              value={draft}
              disabled={disabled}
              presentation="workbench"
              environmentHost={environmentHost}
              previewEnvironmentId={previewEnvironmentId}
              onPreviewEnvironmentChange={setPreviewEnvironmentId}
              {...(requestFocus ? { ruleFocus: requestFocus } : {})}
              onChange={(next) => {
                setDraft(next);
                markEdited();
              }}
              workspaceSummary={
                <div className="api-proto-summary">
                  <p>
                    <strong>当前用例</strong>
                    <span>新建草稿</span>
                  </p>
                  <p>
                    <span>编辑修订</span>
                    <StatusTag tone="warning">未保存</StatusTag>
                  </p>
                </div>
              }
              workspacePanels={{
                data: (
                  <ApiCaseComposition
                    value={draft.base}
                    cases={[]}
                    disabled={disabled}
                    onApply={(composition) => {
                      setDraft({
                        ...draft,
                        base: { ...draft.base, ...composition },
                      });
                      markEdited();
                    }}
                  />
                ),
                revisions: (
                  <p className="caption">保存有效草稿后产生首个正式修订。</p>
                ),
                sources:
                  requirement && currentVersion ? (
                    <ApiDefinitionLibrary
                      projectId={projectId}
                      requirementId={requirement.id}
                      versionId={currentVersion.id}
                      {...(!disabled
                        ? {
                            onAdopt: (step, basis) => {
                              setDraft({
                                ...draft,
                                requests: [...draft.requests, step],
                                base: {
                                  ...draft.base,
                                  basisRefs: [...draft.base.basisRefs, basis],
                                },
                              });
                              setRequestFocus({
                                stepId: step.stepId,
                                tab: 'parameters',
                                nonce: crypto.randomUUID(),
                              });
                              markEdited();
                            },
                          }
                        : {})}
                    />
                  ) : undefined,
              }}
            />
          </div>
          <ApiDraftDebugger
            projectId={projectId}
            draft={null}
            onClose={() => undefined}
          />
        </div>
      </main>
      <Modal
        title="用例名称与说明"
        open={settingsOpen}
        onCancel={() => setSettingsOpen(false)}
        footer={<Button onClick={() => setSettingsOpen(false)}>完成</Button>}
      >
        <div className="stack">
          <label className="field-label">
            用例名称
            <Input
              value={draft.base.title}
              disabled={disabled}
              maxLength={200}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  base: { ...draft.base, title: event.target.value },
                });
                markEdited();
              }}
            />
          </label>
          <label className="field-label">
            测试点
            <Input.TextArea
              value={draft.base.testPoint}
              disabled={disabled}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  base: { ...draft.base, testPoint: event.target.value },
                });
                markEdited();
              }}
            />
          </label>
          <label className="field-label">
            业务预期
            <Input.TextArea
              value={draft.base.expected}
              disabled={disabled}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  base: { ...draft.base, expected: event.target.value },
                });
                markEdited();
              }}
            />
          </label>
        </div>
      </Modal>
    </div>
  );
}
