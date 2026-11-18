import { useEffect, useRef, useState } from 'react';
import { Button } from 'antd';
import { receiptCloseResultSchema } from '../../../packages/contracts/src/base';
import { requirementCollaborationStatusSchema } from '../../../packages/contracts/src/requirements';
import { sendReceiptSchema } from '../../../packages/contracts/src/conversations';
import type { TaskState } from '../../../packages/contracts/src/conversations';
import { api, ApiError, describeError, isClosedOperationReceipt } from './api';
import { identityContextEpoch } from './identity-context';
import {
  identityCommandsChanged,
  pendingIdentityCommands,
  settleIdentityCommand,
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
    [expanded, setExpanded] = useState(false),
    [checking, setChecking] = useState<{ commandId: string; close: boolean }>(),
    [notice, setNotice] = useState<string>();
  const alive = useRef(true),
    current = useRef(userId);
  current.current = userId;
  useEffect(() => {
    alive.current = true;
    const update = () => setRecords(pendingIdentityCommands(userId));
    update();
    setExpanded(false);
    setNotice(undefined);
    setChecking(undefined);
    window.addEventListener(identityCommandsChanged, update);
    window.addEventListener('storage', update);
    return () => {
      alive.current = false;
      window.removeEventListener(identityCommandsChanged, update);
      window.removeEventListener('storage', update);
    };
  }, [userId]);
  async function recover(record: IdentityCommand, close: boolean) {
    if (checking || record.userId !== userId) return;
    const owner = userId,
      epoch = identityContextEpoch();
    setChecking({ commandId: record.commandId, close });
    setNotice(undefined);
    const active = () =>
      alive.current &&
      current.current === owner &&
      epoch === identityContextEpoch();
    const path =
      record.operation === 'requirements.collaboration'
        ? `/projects/${record.projectId}/requirements/${record.targetId}/collaboration-receipts/${record.commandId}`
        : `/me/conversations/${record.targetId}/send-receipts/${record.commandId}`;
    const finished = () => {
      settleIdentityCommand({ record, outcome: 'closed' });
      setNotice('本次核对已结束。你可以在原对象继续编辑或发起新的操作。');
    };
    try {
      if (close) {
        const result = await api(
          path + '/close',
          { method: 'POST' },
          receiptCloseResultSchema,
        );
        if (!active()) return;
        if (result.commandId !== record.commandId)
          throw Error('结束核对的回执不匹配，请继续核对原标识。');
        if (result.status === 'closed') {
          finished();
          return;
        }
        if (result.status === 'unknown') {
          setNotice(
            '服务端已有原提交记录，结果暂无法确认。可以收起提示，之后从「待核对操作」继续查询。',
          );
          return;
        }
      }
      if (record.operation === 'requirements.collaboration') {
        const value = await api(path, {}, requirementCollaborationStatusSchema);
        if (!active()) return;
        if (value.commandId !== record.commandId)
          throw Error('原命令回执不匹配，保持未确认。');
        if (
          (value.status === 'completed' && value.response) ||
          value.status === 'failed'
        ) {
          settleIdentityCommand({
            record,
            outcome:
              value.status === 'completed'
                ? 'collaborationCompleted'
                : 'closed',
          });
          setNotice(
            value.status === 'completed'
              ? '原需求协作保存已确认完成。请重新打开该需求查看当前资料，没有重发。'
              : '原需求保存已明确失败，没有重发。',
          );
        } else
          setNotice('原需求保存仍在处理中或结果未知，保留原标识继续只读查询。');
      } else {
        const value = await api(path, {}, sendReceiptSchema);
        if (!active()) return;
        settleIdentityCommand({
          record,
          outcome: 'conversationAccepted',
          receipt: value,
        });
        setNotice(
          `原消息已受理，任务当前状态：${taskLabels[value.currentStatus]}。没有再次发送消息或调用模型。`,
        );
      }
    } catch (error) {
      if (active() && isClosedOperationReceipt(error)) finished();
      else if (active())
        setNotice(
          error instanceof ApiError && error.status === 404
            ? close
              ? '原对象或结束核对入口暂不可用。可以收起提示，原提交标识会保留。'
              : '暂未查到原回执。可尝试结束本次核对，由服务端确认原标识是否还能受理。'
            : describeError(error),
        );
    } finally {
      if (active()) setChecking(undefined);
    }
  }
  const visible = records.filter((record) => record.userId === userId);
  if (!visible.length && (!expanded || !notice)) return null;
  if (!expanded)
    return (
      <div className="identity-recovery-trigger">
        <Button
          type="text"
          size="small"
          aria-expanded={false}
          onClick={() => setExpanded(true)}
        >
          待核对操作（{visible.length}）
        </Button>
      </div>
    );
  return (
    <section
      className="notice amber identity-recovery-banner"
      aria-label="原身份操作回执核对"
    >
      <div className="row wrap">
        <b className="grow">待核对操作</b>
        <Button
          size="small"
          aria-expanded={true}
          onClick={() => {
            setExpanded(false);
            setNotice(undefined);
          }}
        >
          收起
        </Button>
      </div>
      {!!visible.length && (
        <p>可查询原回执。查不到时，可结束本次核对，由服务端关闭原提交标识。</p>
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
            loading={
              checking?.commandId === record.commandId && !checking.close
            }
            onClick={() => void recover(record, false)}
          >
            查询原回执
          </Button>
          <Button
            size="small"
            disabled={!!checking}
            loading={checking?.commandId === record.commandId && checking.close}
            onClick={() => void recover(record, true)}
          >
            结束本次核对
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
    </section>
  );
}
