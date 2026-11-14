import { useEffect, useRef, useState } from 'react';
import { Button } from 'antd';
import { requirementCollaborationStatusSchema } from '../../../packages/contracts/src/requirements';
import { sendReceiptSchema } from '../../../packages/contracts/src/conversations';
import type { TaskState } from '../../../packages/contracts/src/conversations';
import { api, ApiError, describeError } from './api';
import { identityContextEpoch } from './identity-context';
import {
  identityCommandsChanged,
  pendingIdentityCommands,
  resolveIdentityCommand,
  identityCommandStorageReliable,
} from './identity-commands';
import type { IdentityCommand } from './identity-commands';
const taskLabels: Record<TaskState, string> = {
  accepted: '已受理',
  running: '处理中',
  cancelling: '停止处理中',
  completed: '已完成',
  failed: '未完成',
  cancelled: '已停止',
  interrupted: '已中断',
  unknown: '结果未知',
};
export function IdentityCommandRecovery({ userId }: { userId: string }) {
  const [records, setRecords] = useState<IdentityCommand[]>([]),
    [checking, setChecking] = useState<string>(),
    [notice, setNotice] = useState<string>();
  const alive = useRef(true),
    current = useRef(userId);
  current.current = userId;
  useEffect(() => {
    alive.current = true;
    const update = () => setRecords(pendingIdentityCommands(userId));
    update();
    window.addEventListener(identityCommandsChanged, update);
    window.addEventListener('storage', update);
    return () => {
      alive.current = false;
      window.removeEventListener(identityCommandsChanged, update);
      window.removeEventListener('storage', update);
    };
  }, [userId]);
  async function read(record: IdentityCommand) {
    if (checking || record.userId !== userId) return;
    const owner = userId,
      epoch = identityContextEpoch();
    setChecking(record.commandId);
    setNotice(undefined);
    const active = () =>
      alive.current &&
      current.current === owner &&
      epoch === identityContextEpoch();
    try {
      if (record.operation === 'requirements.collaboration') {
        const value = await api(
          `/projects/${record.projectId}/requirements/${record.targetId}/collaboration-receipts/${record.commandId}`,
          {},
          requirementCollaborationStatusSchema,
        );
        if (!active()) return;
        if (value.commandId !== record.commandId)
          throw Error('原命令回执不匹配，保持未确认。');
        if (
          (value.status === 'completed' && value.response) ||
          value.status === 'failed'
        ) {
          resolveIdentityCommand(record);
          setNotice(
            value.status === 'completed'
              ? '原需求协作保存已确认完成。请重新打开该需求查看当前资料，没有重发。'
              : '原需求保存已明确失败，没有重发。',
          );
        } else
          setNotice('原需求保存仍在处理中或结果未知，保留原标识继续只读查询。');
      } else {
        const value = await api(
          `/me/conversations/${record.targetId}/send-receipts/${record.commandId}`,
          {},
          sendReceiptSchema,
        );
        if (!active()) return;
        resolveIdentityCommand(record);
        setNotice(
          `原消息已受理，任务当前状态：${taskLabels[value.currentStatus]}。没有再次发送消息或调用模型。`,
        );
      }
    } catch (error) {
      if (active())
        setNotice(
          error instanceof ApiError && error.status === 404
            ? '暂未查到原回执，不代表原操作未发生；保留原标识，不重新提交。'
            : describeError(error),
        );
    } finally {
      if (active()) setChecking(undefined);
    }
  }
  const visible = records.filter((record) => record.userId === userId);
  if (!visible.length && !notice) return null;
  return (
    <section
      className="notice amber identity-recovery-banner"
      aria-label="原身份操作回执核对"
    >
      {!!visible.length && (
        <p>
          以下原操作回执待核对。只保存本人、项目、对象和命令标识；此处只读查询，不重发业务请求。
        </p>
      )}
      {!!visible.length && !identityCommandStorageReliable() && (
        <p>浏览器当前无法持久保存恢复标识，请记录下面的原命令后再关闭本页。</p>
      )}
      {visible.map((record) => (
        <div
          className="row wrap mt"
          key={`${record.operation}:${record.commandId}`}
        >
          <span className="grow caption">
            {record.operation === 'requirements.collaboration'
              ? '需求协作保存'
              : '对话发送'}{' '}
            · <span className="mono">{record.commandId}</span>
          </span>
          <Button
            size="small"
            disabled={!!checking}
            loading={checking === record.commandId}
            onClick={() => void read(record)}
          >
            查询原回执
          </Button>
          <Button
            size="small"
            onClick={() => {
              window.location.hash =
                record.operation === 'requirements.collaboration'
                  ? `requirements?projectId=${record.projectId}&requirementId=${record.targetId}`
                  : `workspace?conversationId=${record.targetId}`;
            }}
          >
            打开原对象
          </Button>
        </div>
      ))}
      {notice && (
        <p className="caption mt" role="status">
          {notice}
        </p>
      )}
      {!visible.length && notice && (
        <Button size="small" onClick={() => setNotice(undefined)}>
          关闭已核对提示
        </Button>
      )}
    </section>
  );
}
