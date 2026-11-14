import { useEffect, useRef, useState } from 'react';
import { modelDisplayLabel, modelServiceCaption } from './model-display-label';
import {
  Alert,
  Button,
  Checkbox,
  Collapse,
  Input,
  Modal,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd';
import { z } from 'zod';
import {
  automaticAuxiliaryListSchema,
  automaticAliasPreviewSchema,
  automaticAliasReceiptSchema,
  automaticAuxiliaryIntentSchema,
} from '../../../packages/contracts/src/automatic-auxiliary';
import type { ModelDataScope } from '../../../packages/contracts/src/configuration';
import { api, describeError, isUncertainMutationError, ApiError } from './api';
import {
  currentIdentityOwner,
  identityContextEpoch,
  subscribeIdentityChanges,
} from './identity-context';
import { uiLayers } from './ui-layers';
import { auxiliaryTaskReceiptSchema } from '../../../packages/contracts/src/auxiliary';
type Intent = z.infer<typeof automaticAuxiliaryIntentSchema>;
const states = {
  pendingPermission: '待资料许可',
  accepting: '受理待核对',
  accepted: '已受理',
  completed: '已完成默认名',
  failed: '未完成',
  unknown: '结果未知',
  superseded: '原来源已变化',
  cancelled: '已取消',
  localMatched: '已有本地候选',
};
const scopes = {
  syntheticPublicOnly: '仅合成/公开资料',
  authorizedRelevantTestData: '已获授权的相关内部测试资料',
};
const pendingRecordSchema = z.strictObject({
  commandId: z.uuid(),
  scopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  dataScope: z.enum(['syntheticPublicOnly', 'authorizedRelevantTestData']),
});
export function AutomaticAuxiliaryPanel({
  projectId,
  onNamesChanged,
  refreshKey,
}: {
  projectId: string | null;
  onNamesChanged: () => void;
  refreshKey?: unknown;
}) {
  const [items, setItems] = useState<Intent[]>([]),
    [modelAvailable, setModelAvailable] = useState(false),
    [nextCursor, setNextCursor] = useState<string | null>(null),
    [error, setError] = useState<string>(),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<Intent | null>(null),
    [preview, setPreview] =
      useState<z.infer<typeof automaticAliasPreviewSchema>>(),
    [scope, setScope] = useState<ModelDataScope>(),
    [consent, setConsent] = useState(false),
    [unknown, setUnknown] = useState(false),
    [taskError, setTaskError] = useState<string>();
  const generation = useRef(0),
    identity = useRef({
      owner: currentIdentityOwner(),
      epoch: identityContextEpoch(),
    }),
    seenCompleted = useRef(new Set<string>()),
    previousRefresh = useRef(refreshKey),
    contextProject = useRef(projectId);
  const [, renderIdentity] = useState(0),
    ownerId = currentIdentityOwner(),
    ownerEpoch = identityContextEpoch();
  useEffect(
    () => subscribeIdentityChanges(() => renderIdentity((value) => value + 1)),
    [],
  );
  const current = (epoch: number) =>
    epoch === generation.current &&
    identity.current.owner === currentIdentityOwner() &&
    identity.current.epoch === identityContextEpoch();
  const storageKey = (id: string) =>
    `aitesthub:automatic-name:v1:${identity.current.owner}:${id}`;
  function updateIntent(intent: Intent) {
    setItems((previous) =>
      previous.map((item) => (item.id === intent.id ? intent : item)),
    );
    if (selected?.id === intent.id && !preview) setSelected(intent);
    if (intent.state === 'completed' && !seenCompleted.current.has(intent.id)) {
      seenCompleted.current.add(intent.id);
      onNamesChanged();
    }
  }
  async function load(append = false) {
    const epoch = generation.current;
    try {
      const params = new URLSearchParams();
      if (projectId) params.set('projectId', projectId);
      if (append && nextCursor) params.set('afterId', nextCursor);
      const response = await api(
        `/me/automatic-auxiliary?${params}`,
        {},
        automaticAuxiliaryListSchema,
      );
      if (!current(epoch)) return;
      setItems((previous) =>
        append
          ? [
              ...previous,
              ...response.intents.filter(
                (item) => !previous.some((old) => old.id === item.id),
              ),
            ]
          : response.intents,
      );
      setModelAvailable(response.modelAvailable);
      setNextCursor(response.nextCursor);
      setError(undefined);
    } catch (failure) {
      if (current(epoch)) {
        setError(describeError(failure));
        if (
          failure instanceof ApiError &&
          [401, 403, 404].includes(failure.status)
        ) {
          setItems([]);
          setSelected(null);
          setPreview(undefined);
          setModelAvailable(false);
          setNextCursor(null);
        }
      }
    }
  }
  useEffect(() => {
    generation.current++;
    previousRefresh.current = refreshKey;
    contextProject.current = projectId;
    identity.current = {
      owner: currentIdentityOwner(),
      epoch: identityContextEpoch(),
    };
    setItems([]);
    setBusy(false);
    setModelAvailable(false);
    setNextCursor(null);
    setScope(undefined);
    setConsent(false);
    setTaskError(undefined);
    seenCompleted.current.clear();
    setSelected(null);
    setPreview(undefined);
    setError(undefined);
    setUnknown(false);
    void load();
    return () => {
      generation.current++;
    };
  }, [projectId, ownerId, ownerEpoch]);
  useEffect(() => {
    if (previousRefresh.current !== refreshKey) {
      previousRefresh.current = refreshKey;
      void load();
    }
  }, [refreshKey]);
  const active = items.filter((item) =>
    ['accepted', 'accepting'].includes(item.state),
  );
  useEffect(() => {
    if (!active.length) return;
    let polling = false;
    const epoch = generation.current,
      timer = setInterval(() => {
        if (polling || !current(epoch)) return;
        polling = true;
        void Promise.all(
          active.map((item) =>
            api(
              `/me/automatic-auxiliary/${item.id}`,
              {},
              automaticAliasReceiptSchema,
            ),
          ),
        )
          .then((results) => {
            if (current(epoch))
              results.forEach((result) => {
                updateIntent(result.intent);
              });
          })
          .catch((failure) => {
            if (current(epoch)) setError(describeError(failure));
          })
          .finally(() => {
            polling = false;
          });
      }, 1500);
    return () => clearInterval(timer);
  }, [active.map((item) => item.id).join(','), selected?.id, Boolean(preview)]);
  async function readOriginal(id: string) {
    const epoch = generation.current;
    try {
      const result = await api(
        `/me/automatic-auxiliary/${id}`,
        {},
        automaticAliasReceiptSchema,
      );
      if (!current(epoch)) return;
      updateIntent(result.intent);
      setSelected(result.intent);
      if (!['pendingPermission', 'accepting'].includes(result.intent.state)) {
        localStorage.removeItem(storageKey(id));
        setUnknown(false);
      } else setUnknown(true);
      setTaskError(
        result.task?.task.errorCode
          ? `辅助模型未完成：${result.task.task.errorCode}${result.task.task.errorDetails?.httpStatus ? '（HTTP ' + result.task.task.errorDetails.httpStatus + '）' : ''}`
          : undefined,
      );
    } catch (failure) {
      if (current(epoch)) {
        setUnknown(true);
        setTaskError(`原任务尚未核对；不重新发送：${describeError(failure)}`);
      }
    }
  }
  async function openPreview(item: Intent) {
    if (busy) return;
    const epoch = generation.current;
    setSelected(item);
    setPreview(undefined);
    setConsent(false);
    setScope(undefined);
    setTaskError(undefined);
    setUnknown(false);
    setBusy(true);
    try {
      const saved = localStorage.getItem(storageKey(item.id));
      if (saved) {
        pendingRecordSchema.parse(JSON.parse(saved));
        setUnknown(true);
        await readOriginal(item.id);
        return;
      }
      if (item.state !== 'pendingPermission') {
        await readOriginal(item.id);
        return;
      }
      const result = await api(
        `/me/automatic-auxiliary/${item.id}/preview`,
        { method: 'POST', body: {} },
        automaticAliasPreviewSchema,
      );
      if (current(epoch)) {
        setPreview(result);
        setSelected(result.intent);
      }
    } catch (failure) {
      if (current(epoch)) setTaskError(describeError(failure));
    } finally {
      if (current(epoch)) setBusy(false);
    }
  }
  async function accept() {
    if (!selected || !preview || !scope || !consent || busy || unknown) return;
    const epoch = generation.current,
      id = selected.id,
      record = {
        commandId: crypto.randomUUID(),
        scopeDigest: preview.intent.scopeDigest!,
        dataScope: scope,
      };
    let dispatched = false;
    setBusy(true);
    setTaskError(undefined);
    try {
      localStorage.setItem(storageKey(id), JSON.stringify(record));
      if (localStorage.getItem(storageKey(id)) !== JSON.stringify(record))
        throw new Error('无法可靠保存原确认标识，本次未发送。');
      dispatched = true;
      const result = await api(
        `/me/automatic-auxiliary/${id}/accept`,
        { method: 'POST', body: { ...record, confirmed: true } },
        automaticAliasReceiptSchema,
      );
      if (!current(epoch)) return;
      updateIntent(result.intent);
      setSelected(result.intent);
      setPreview(undefined);
      if (!['accepting', 'unknown'].includes(result.intent.state)) {
        localStorage.removeItem(storageKey(id));
        setUnknown(false);
      } else setUnknown(true);
    } catch (failure) {
      if (!current(epoch)) return;
      if (
        isUncertainMutationError(failure) ||
        (dispatched && !(failure instanceof ApiError))
      )
        setUnknown(true);
      else {
        try {
          localStorage.removeItem(storageKey(id));
        } catch {}
        setPreview(undefined);
        await readOriginal(id);
      }
      setTaskError(describeError(failure));
    } finally {
      if (current(epoch)) setBusy(false);
    }
  }
  async function stopAccepted() {
    if (!selected?.auxiliaryTaskId || busy || unknown) return;
    const epoch = generation.current,
      id = selected.id;
    setBusy(true);
    try {
      await api(
        `/me/auxiliary-tasks/${selected.auxiliaryTaskId}/cancel`,
        {
          method: 'POST',
          body: { commandId: crypto.randomUUID() },
        },
        auxiliaryTaskReceiptSchema,
      );
      if (current(epoch)) await readOriginal(id);
    } catch (failure) {
      if (current(epoch)) {
        if (isUncertainMutationError(failure)) setUnknown(true);
        setTaskError(`停止回执待核对，请查询原任务：${describeError(failure)}`);
      }
    } finally {
      if (current(epoch)) setBusy(false);
    }
  }
  async function retry(item: Intent) {
    if (busy) return;
    const epoch = generation.current;
    setBusy(true);
    try {
      const result = await api(
        `/me/automatic-auxiliary/${item.id}/retry`,
        { method: 'POST', body: {} },
        automaticAliasReceiptSchema,
      );
      if (current(epoch)) {
        setItems((previous) => [
          result.intent,
          ...previous.filter((old) => old.id !== result.intent.id),
        ]);
        await openPreview(result.intent);
      }
    } catch (failure) {
      if (current(epoch)) setError(describeError(failure));
    } finally {
      if (current(epoch)) setBusy(false);
    }
  }
  const visible = items.filter(
    (item) =>
      modelAvailable ||
      item.auxiliaryTaskId !== null ||
      ['accepting', 'unknown'].includes(item.state),
  );
  if (
    identity.current.owner !== ownerId ||
    identity.current.epoch !== ownerEpoch ||
    contextProject.current !== projectId
  )
    return null;
  if (!visible.length && !selected)
    return error ? (
      <Typography.Text type="secondary">
        自动辅助状态暂未读取，人工流程仍可使用。
      </Typography.Text>
    ) : null;
  const pending = visible.filter(
    (item) => item.state === 'pendingPermission',
  ).length;
  return (
    <>
      <Collapse
        size="small"
        className="section-alert"
        items={[
          {
            key: 'automatic-alias',
            label: `系统辅助任务${pending ? ' · ' + pending + ' 项待资料许可' : ''}`,
            children: (
              <Space direction="vertical" style={{ width: '100%' }}>
                <Typography.Text type="secondary">
                  首次形成需求分组后自动准备默认精简名。允许本次资料发送后，系统自动生成并作为默认显示；手工别名始终优先。未完成时使用正式名称。
                </Typography.Text>
                {error && <Alert type="warning" title={error} />}{' '}
                {visible.map((item) => (
                  <Space
                    key={item.id}
                    wrap
                    style={{ width: '100%', justifyContent: 'space-between' }}
                  >
                    <span>
                      {item.title} <Tag>{states[item.state]}</Tag>
                    </span>
                    <Button
                      size="small"
                      disabled={busy}
                      onClick={() => void openPreview(item)}
                    >
                      {item.state === 'pendingPermission'
                        ? '查看资料许可'
                        : '查询原任务'}
                    </Button>
                    {(['failed', 'cancelled', 'superseded'].includes(
                      item.state,
                    ) ||
                      item.errorCode === 'RESTORED_RESULT_NOT_AVAILABLE') && (
                      <Button
                        size="small"
                        disabled={busy}
                        onClick={() => void retry(item)}
                      >
                        重新准备一次
                      </Button>
                    )}
                  </Space>
                ))}
                {nextCursor && (
                  <Button size="small" onClick={() => void load(true)}>
                    更多自动任务
                  </Button>
                )}
              </Space>
            ),
          },
        ]}
      />
      <Modal
        title="系统辅助：默认精简名资料许可"
        open={selected !== null}
        width={900}
        zIndex={uiLayers.nestedDialog}
        onCancel={() => {
          if (!busy) setSelected(null);
        }}
        styles={{ body: { maxHeight: '65dvh', overflowY: 'auto' } }}
        footer={
          <Space>
            <Button disabled={busy} onClick={() => setSelected(null)}>
              关闭
            </Button>
            {selected && (
              <Button
                disabled={busy}
                onClick={() => void readOriginal(selected.id)}
              >
                查询原任务
              </Button>
            )}
            {selected?.auxiliaryTaskId &&
              ['accepted', 'accepting'].includes(selected.state) &&
              !unknown && (
                <Button disabled={busy} onClick={() => void stopAccepted()}>
                  停止辅助任务
                </Button>
              )}
            {preview && selected?.state === 'pendingPermission' && !unknown && (
              <Button
                type="primary"
                loading={busy}
                disabled={!scope || !consent || !modelAvailable}
                onClick={() => void accept()}
              >
                允许本次发送
              </Button>
            )}
          </Space>
        }
      >
        {!modelAvailable && selected && (
          <Alert
            type="warning"
            title="系统辅助配置当前不可用，原许可资料保留供核对；不会自动更换模型。"
          />
        )}
        {taskError && <Alert type="error" title={taskError} />}
        {selected?.errorCode && !taskError && (
          <Alert
            type="warning"
            title={
              selected.errorCode === 'RESTORED_RESULT_NOT_AVAILABLE'
                ? '历史任务已保留，原结果未恢复；不会重新调用模型。'
                : selected.errorCode
            }
          />
        )}{' '}
        {unknown && (
          <Alert
            type="warning"
            title="原受理结果未知，只查询原任务，不更换命令或重发。"
          />
        )}
        {selected && (
          <Typography.Paragraph>
            {selected.title} · {states[selected.state]}
          </Typography.Paragraph>
        )}
        {preview && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Typography.Text>
              接收方：{modelServiceCaption(preview.preflight.disclosure.model)}{' '}
              / {modelDisplayLabel(preview.preflight.disclosure.model)} ·
              配置修订{' '}
              {'schemaVersion' in preview.preflight.disclosure.model
                ? preview.preflight.disclosure.model.serviceRevision
                : preview.preflight.disclosure.model.configRevision}
            </Typography.Text>
            <Typography.Paragraph>
              仅发送下列名称以生成本人的默认精简名，不修改正式需求或手工别名。
            </Typography.Paragraph>
            <Input.TextArea
              rows={4}
              readOnly
              value={preview.preflight.disclosure.payloadPreview}
            />
            <Select
              style={{ width: '100%' }}
              placeholder="明确选择资料范围"
              value={scope}
              onChange={(value) => {
                setScope(value);
                setConsent(false);
              }}
              options={preview.preflight.disclosure.allowedDataScopes.map(
                (value) => ({ value, label: scopes[value] }),
              )}
            />
            <Checkbox
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            >
              我已核对接收方、内容和用途，并有权允许本次发送
            </Checkbox>
          </Space>
        )}
      </Modal>
    </>
  );
}
