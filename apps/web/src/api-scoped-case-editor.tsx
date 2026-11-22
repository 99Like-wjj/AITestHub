import { useEffect, useState } from 'react';
import { Alert, App, Button, Input, Select } from 'antd';
import {
  assetOperationStatusSchema,
  assetReceiptSchema,
  createScopedCaseInputSchema,
  type Asset,
} from '../../../packages/contracts/src/assets';
import { idSchema } from '../../../packages/contracts/src/base';
import { api, describeError } from './api';
import { ApiCaseFields } from './api-case-fields';
import { emptyApiDraft, serializeApiDraft } from './api-draft';
import { CommandDialog, useBusinessCommand } from './business-command';

const operation = 'assets.create-scoped-case';

export function ApiScopedCaseEditor({
  projectId,
  userId,
  requirementVersionId,
  scopeLabel,
  scenarios,
  collections,
  initialScenarioId,
  onClose,
  onSaved,
}: {
  projectId: string;
  userId: string;
  requirementVersionId: string;
  scopeLabel: string;
  scenarios: readonly Asset[];
  collections: readonly Asset[];
  initialScenarioId?: string | undefined;
  onClose: () => void;
  onSaved: (asset: Asset) => Promise<void>;
}) {
  const { message } = App.useApp();
  const [session, setSession] = useState(() => crypto.randomUUID());
  const command = useBusinessCommand(session);
  const [draft, setDraft] = useState(() => emptyApiDraft(crypto.randomUUID()));
  const [scenarioId, setScenarioId] = useState(initialScenarioId);
  const [scenarioName, setScenarioName] = useState('');
  const [objective, setObjective] = useState('');
  const [setId, setSetId] = useState<string>();
  const [dirty, setDirty] = useState(false);
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
    setDirty(true);
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
    setDirty(false);
    await onSaved(asset);
    void message.success('接口用例已保存。');
  }
  async function save() {
    if (disabled) return;
    setSaving(true);
    try {
      const result = await command.run((commandId) => {
        const content = serializeApiDraft(draft);
        const input = createScopedCaseInputSchema.parse({
          commandId,
          kind: 'API',
          requirementVersionId,
          scenario: scenarioId
            ? { scenarioId }
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

  return (
    <CommandDialog
      open
      width={960}
      title="新建接口用例"
      command={command}
      dirty={dirty}
      busy={recovering || saving}
      onClose={onClose}
      onSave={() => void save()}
      saveLabel="保存接口用例"
      allowSave={
        !disabled &&
        Boolean(draft.base.title.trim()) &&
        Boolean(
          scenarioId ||
          (scenarioName.trim() && (collections.length < 2 || setId)),
        )
      }
    >
      <div className="stack">
        <Alert
          showIcon
          title={scopeLabel + ' · API'}
          description="确认需求版本和场景。保存成功后用例才会进入目录。"
        />
        {recovery && (
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
        )}
        {!recovery && recoveryStatus && (
          <p role="status" className="caption">
            {recoveryStatus}
          </p>
        )}
        <label className="field-label">
          目标场景
          <Select
            aria-label="目标接口场景"
            value={scenarioId ?? ''}
            disabled={disabled}
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
        {!scenarioId && (
          <>
            {collections.length > 1 && (
              <label className="field-label">
                历史来源
                <Select
                  aria-label="新增场景历史归属"
                  placeholder="选择此次明确的维护范围"
                  value={setId}
                  disabled={disabled}
                  options={collections.map((entry) => ({
                    value: entry.id,
                    label: entry.title,
                  }))}
                  onChange={(value) => {
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
        <div className="api-new-case-inputs">
          <label className="field-label">
            用例名称
            <Input
              value={draft.base.title}
              maxLength={200}
              disabled={disabled}
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
            业务预期
            <Input
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
        <ApiCaseFields
          projectId={projectId}
          value={draft}
          disabled={disabled}
          onChange={(next) => {
            setDraft(next);
            markEdited();
          }}
        />
      </div>
    </CommandDialog>
  );
}
