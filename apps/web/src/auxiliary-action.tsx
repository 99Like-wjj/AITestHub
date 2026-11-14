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
import { RobotOutlined } from '@ant-design/icons';
import { z } from 'zod';
import {
  auxiliaryPreflightReceiptSchema,
  auxiliaryTaskReceiptSchema,
  type AuxiliarySourceInput,
  auxiliaryResultSchema,
} from '../../../packages/contracts/src/auxiliary';
import type { ModelDataScope } from '../../../packages/contracts/src/configuration';
import { api, ApiError, describeError, isUncertainMutationError } from './api';
import { currentIdentityOwner, identityContextEpoch } from './identity-context';
import { uiLayers } from './ui-layers';
const recordSchema = z.strictObject({
  commandId: z.uuid(),
  taskId: z.uuid().optional(),
});
const stateLabels = {
  accepted: '已受理',
  running: '分析中',
  cancelling: '正在停止',
  completed: '已完成建议',
  cancelled: '已取消',
  failed: '未完成',
  unknown: '结果未知',
};
const scopeLabels = {
  syntheticPublicOnly: '仅合成或公开资料',
  authorizedRelevantTestData: '本人已获授权的相关内部测试资料',
};
type Result = z.infer<typeof auxiliaryResultSchema>;
export function AuxiliaryAction({
  label,
  source,
  disabled = false,
  onUse,
}: {
  label: string;
  source: () => AuxiliarySourceInput | Promise<AuxiliarySourceInput>;
  disabled?: boolean;
  onUse?: (result: Result) => void;
}) {
  const [open, setOpen] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string>(),
    [preview, setPreview] =
      useState<z.infer<typeof auxiliaryPreflightReceiptSchema>>(),
    [task, setTask] = useState<z.infer<typeof auxiliaryTaskReceiptSchema>>(),
    [input, setInput] = useState<AuxiliarySourceInput>(),
    [scope, setScope] = useState<ModelDataScope>(),
    [consent, setConsent] = useState(false),
    [unknown, setUnknown] = useState(false),
    [recovered, setRecovered] = useState(false);
  const record = useRef<z.infer<typeof recordSchema> | undefined>(undefined),
    key = useRef(''),
    identity = useRef({
      owner: currentIdentityOwner(),
      epoch: identityContextEpoch(),
    });
  const current = () =>
    identity.current.owner === currentIdentityOwner() &&
    identity.current.epoch === identityContextEpoch();
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => {
      if (!current()) {
        setOpen(false);
        setTask(undefined);
        setPreview(undefined);
      }
    }, 300);
    return () => clearInterval(timer);
  }, [open]);
  async function show() {
    if (pending) return;
    setPending(true);
    setOpen(true);
    setError(undefined);
    setTask(undefined);
    setRecovered(false);
    setPreview(undefined);
    setConsent(false);
    setScope(undefined);
    identity.current = {
      owner: currentIdentityOwner(),
      epoch: identityContextEpoch(),
    };
    try {
      if (!identity.current.owner) throw new Error('请先确认当前登录身份。');
      const next = await source();
      if (!current()) return;
      setInput(next);
      const target =
        'conversationId' in next
          ? next.conversationId
          : 'caseId' in next
            ? next.caseId
            : 'issueId' in next
              ? next.issueId
              : 'requirementId' in next
                ? next.requirementId
                : 'draft';
      key.current = `aitesthub:auxiliary-receipt:v1:${identity.current.owner}:${next.purpose}:${'projectId' in next ? (next.projectId ?? 'personal') : 'personal'}:${target ?? 'draft'}:${'mode' in next ? next.mode : 'cleanupStepId' in next ? next.cleanupStepId : 'default'}`;
      const saved = localStorage.getItem(key.current);
      record.current = saved
        ? recordSchema.parse(JSON.parse(saved))
        : undefined;
      setUnknown(Boolean(record.current));
      if (record.current) {
        await recover();
        return;
      }
      const response = await api(
        '/me/auxiliary-tasks/preflight',
        { method: 'POST', body: { source: next } },
        auxiliaryPreflightReceiptSchema,
      );
      if (current()) setPreview(response);
    } catch (err) {
      if (current()) setError(describeError(err));
    } finally {
      setPending(false);
    }
  }
  async function recover() {
    if (!record.current) return;
    const saved = record.current;
    try {
      const response = await api(
        saved.taskId
          ? `/me/auxiliary-tasks/${saved.taskId}`
          : `/me/auxiliary-tasks/by-command/${encodeURIComponent(saved.commandId)}`,
        {},
        auxiliaryTaskReceiptSchema,
      );
      if (!current()) return;
      setTask(response);
      setRecovered(true);
      setUnknown(false);
      record.current = { ...saved, taskId: response.task.id };
      localStorage.setItem(key.current, JSON.stringify(record.current));
      if (
        ['completed', 'cancelled', 'failed', 'unknown'].includes(
          response.task.state,
        )
      ) {
        localStorage.removeItem(key.current);
        record.current = undefined;
      }
    } catch (err) {
      if (current()) {
        setUnknown(true);
        setError(`原任务尚未核对，不能换命令重发：${describeError(err)}`);
      }
    }
  }
  async function submit() {
    if (!preview || !input || !scope || !consent || pending || record.current)
      return;
    setPending(true);
    setError(undefined);
    const commandId = crypto.randomUUID();
    let dispatched = false;
    try {
      record.current = { commandId };
      localStorage.setItem(key.current, JSON.stringify(record.current));
      if (localStorage.getItem(key.current) !== JSON.stringify(record.current))
        throw new Error('无法可靠保存原任务标识，本次未发送。');
      dispatched = true;
      const response = await api(
        '/me/auxiliary-tasks',
        {
          method: 'POST',
          body: {
            ...input,
            commandId,
            dataScope: scope,
            disclosureId: preview.disclosure.id,
            disclosureDigest: preview.disclosure.scopeDigest,
            dataConsent: true,
          },
        },
        auxiliaryTaskReceiptSchema,
      );
      if (!current()) return;
      setTask(response);
      record.current = { commandId, taskId: response.task.id };
      localStorage.setItem(key.current, JSON.stringify(record.current));
      setUnknown(false);
    } catch (err) {
      if (!current()) return;
      if (
        isUncertainMutationError(err) ||
        (dispatched && !(err instanceof ApiError))
      ) {
        setUnknown(true);
      } else {
        try {
          localStorage.removeItem(key.current);
        } catch {}
        record.current = undefined;
      }
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }
  async function cancel() {
    if (!task || pending) return;
    setPending(true);
    try {
      const response = await api(
        `/me/auxiliary-tasks/${task.task.id}/cancel`,
        { method: 'POST', body: { commandId: crypto.randomUUID() } },
        auxiliaryTaskReceiptSchema,
      );
      if (current()) setTask(response);
    } catch (err) {
      if (current()) setError(describeError(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <Button
        icon={<RobotOutlined />}
        disabled={disabled}
        loading={pending && !open}
        onClick={() => void show()}
      >
        {label}
      </Button>
      <Modal
        title={label}
        open={open}
        width={900}
        zIndex={uiLayers.nestedDialog}
        styles={{ body: { maxHeight: '65dvh', overflowY: 'auto' } }}
        onCancel={() => setOpen(false)}
        footer={
          <Space>
            <Button onClick={() => setOpen(false)}>关闭</Button>
            {(record.current || task) && (
              <Button disabled={pending} onClick={() => void recover()}>
                查询原任务
              </Button>
            )}
            {task &&
              ['accepted', 'running', 'cancelling'].includes(
                task.task.state,
              ) && (
                <Button disabled={pending} onClick={() => void cancel()}>
                  停止辅助任务
                </Button>
              )}
            {preview && !task && !unknown && (
              <Button
                type="primary"
                loading={pending}
                disabled={!scope || !consent || Boolean(record.current)}
                onClick={() => void submit()}
              >
                允许本次发送并分析
              </Button>
            )}
          </Space>
        }
      >
        <Alert
          type="info"
          showIcon
          title="辅助结果仅为建议"
          description="不会自动更名、调整严重程度、批准或执行 SQL。失败不影响人工主流程。"
        />
        {error && <Alert type="error" showIcon title={error} />}{' '}
        {unknown && (
          <Alert
            type="warning"
            title="原受理结果未知，只查询原任务，不重新发送。"
          />
        )}
        {preview && !task && (
          <Space direction="vertical" style={{ width: '100%', marginTop: 16 }}>
            <Typography.Text>
              模型：{modelServiceCaption(preview.disclosure.model)} /{' '}
              {modelDisplayLabel(preview.disclosure.model)} · 修订{' '}
              {'schemaVersion' in preview.disclosure.model
                ? preview.disclosure.model.serviceRevision
                : preview.disclosure.model.configRevision}
            </Typography.Text>
            <Typography.Paragraph>
              {preview.disclosure.payloadSummary}
            </Typography.Paragraph>
            {preview.disclosure.source.unreadMaterials?.map((item, i) => (
              <Typography.Text type="warning" key={i}>
                {item}
              </Typography.Text>
            ))}
            <Collapse
              items={[
                {
                  key: 'payload',
                  label: '核对本次实际发送资料',
                  children: (
                    <Input.TextArea
                      readOnly
                      value={preview.disclosure.payloadPreview}
                      rows={12}
                    />
                  ),
                },
              ]}
            />
            <Select
              style={{ width: '100%' }}
              placeholder="明确选择本次资料范围"
              value={scope}
              onChange={(value) => {
                setScope(value);
                setConsent(false);
              }}
              options={preview.disclosure.allowedDataScopes.map((value) => ({
                value,
                label: scopeLabels[value],
              }))}
            />
            <Checkbox
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            >
              我已核对资料与接收模型，并有权允许本次发送
            </Checkbox>
          </Space>
        )}
        {task && (
          <Space direction="vertical" style={{ width: '100%', marginTop: 16 }}>
            <Tag>{stateLabels[task.task.state]}</Tag>
            {recovered && (
              <Alert
                type="info"
                title="这是原任务的资料与结果；不代表当前新草稿或新修改已完成分析。"
              />
            )}
            <Typography.Text type="secondary">
              来源：{task.task.executionOrigin}；任务 {task.task.id}
            </Typography.Text>
            {task.task.errorCode && (
              <Alert type="warning" title={task.task.errorCode} />
            )}{' '}
            {task.task.result && (
              <>
                <Input.TextArea
                  readOnly
                  rows={12}
                  value={JSON.stringify(task.task.result, null, 2)}
                />
                {onUse && (
                  <Button
                    onClick={() => {
                      if (current() && task.task.result)
                        onUse(task.task.result);
                      setOpen(false);
                    }}
                  >
                    将建议填入个人名称草稿
                  </Button>
                )}
              </>
            )}
            <Typography.Text type="secondary">
              请求次数：{task.task.call?.requestCount ?? '未知'}；Token：
              {task.task.call?.totalTokens ?? '未知'}
              。供应商与合成验证分别记录。
            </Typography.Text>
          </Space>
        )}
      </Modal>
    </>
  );
}
