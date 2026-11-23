import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Modal, Space } from 'antd';
import { z } from 'zod';
import {
  apiStopInputSchema,
  apiStopReceiptSchema,
  apiStopStatusSchema,
} from '../../../packages/contracts/src/api-execution';
import { api, describeError, isUncertainMutationError } from './api';
import { uiLayers } from './ui-layers';
import { RecoveryBlock } from './recovery-block';

const recordSchema = z.strictObject({ runId: z.uuid(), commandId: z.uuid() });
type StopRecord = z.infer<typeof recordSchema>;
const eventName = 'aitesthub:api-stop-receipts-changed';
const key = (userId: string, projectId: string) =>
  `aitesthub:api-stop:v1:${userId}:${projectId}`;
function read(userId: string, projectId: string) {
  try {
    return z
      .array(recordSchema)
      .max(1000)
      .parse(JSON.parse(localStorage.getItem(key(userId, projectId)) ?? '[]'));
  } catch {
    return [];
  }
}
function remember(
  userId: string,
  projectId: string,
  record: StopRecord,
  remove = false,
) {
  try {
    const records = read(userId, projectId).filter(
      (item) => item.runId !== record.runId,
    );
    if (!remove && records.length >= 1000) return false;
    if (!remove) records.push(record);
    localStorage.setItem(key(userId, projectId), JSON.stringify(records));
    window.dispatchEvent(new Event(eventName));
    return true;
  } catch {
    return false;
  }
}
export function usePendingStops(userId: string, projectId: string) {
  const [records, setRecords] = useState<StopRecord[]>([]);
  useEffect(() => {
    const update = () => setRecords(read(userId, projectId));
    update();
    window.addEventListener(eventName, update);
    return () => window.removeEventListener(eventName, update);
  }, [userId, projectId]);
  return records;
}
export interface StopTarget {
  runId: string;
  name: string;
  currentCase: string | null;
  session: string;
  queryOnly?: boolean;
  commandId?: string;
}
export function ExecutionStopDialog({
  userId,
  projectId,
  target,
  onClose,
  onAcknowledged,
}: {
  userId: string;
  projectId: string;
  target: StopTarget;
  onClose: () => void;
  onAcknowledged: () => void;
}) {
  const saved = useRef(
    read(userId, projectId).find((item) => item.runId === target.runId),
  );
  const command = useRef(
    saved.current?.commandId ?? target.commandId ?? crypto.randomUUID(),
  );
  const [uncertain, setUncertain] = useState(
    Boolean(saved.current) || target.queryOnly === true,
  );
  const [pending, setPending] = useState(false),
    [reading, setReading] = useState(false),
    [failed, setFailed] = useState(false);
  const [error, setError] = useState<string>(),
    [status, setStatus] = useState<string>();
  const alive = useRef(true),
    busy = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  function acknowledged(state: string) {
    remember(
      userId,
      projectId,
      { runId: target.runId, commandId: command.current },
      true,
    );
    setStatus(`原停止回执已确认，轮次状态：${state}。`);
    setUncertain(false);
    onAcknowledged();
    onClose();
  }
  async function stop() {
    if (busy.current || uncertain) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    const record = { runId: target.runId, commandId: command.current };
    const retained = remember(userId, projectId, record);
    try {
      const response = await api(
        `/projects/${projectId}/api-executions/${target.runId}/stop`,
        {
          method: 'POST',
          body: apiStopInputSchema.parse({ commandId: command.current }),
        },
        apiStopReceiptSchema,
      );
      if (alive.current) acknowledged(response.state);
    } catch (failure) {
      if (!isUncertainMutationError(failure))
        remember(userId, projectId, record, true);
      if (alive.current) {
        setUncertain(isUncertainMutationError(failure));
        if (isUncertainMutationError(failure) && !retained)
          setStatus('浏览器无法保留此停止标识，请记录当前commandId后再关闭。');
        setError(describeError(failure));
      }
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
    }
  }
  async function receipt() {
    if (reading) return;
    setReading(true);
    setStatus(undefined);
    try {
      const response = await api(
        `/projects/${projectId}/api-executions/${target.runId}/stop-receipts/${command.current}`,
        {},
        apiStopStatusSchema,
      );
      if (!alive.current) return;
      if (
        response.runId !== target.runId ||
        response.commandId !== command.current
      )
        throw Error('原停止回执范围不符，保持禁重发。');
      if (response.status === 'completed' && response.response)
        acknowledged(response.response.state);
      else {
        setFailed(response.status === 'failed');
        setStatus(
          response.status === 'failed'
            ? '原停止操作已确认失败。'
            : `原操作${response.status === 'pending' ? '仍在处理中' : '仍未知'}，不自动重发。`,
        );
      }
    } catch (failure) {
      if (alive.current)
        setStatus(`${describeError(failure)}；404不代表原操作未发生。`);
    } finally {
      if (alive.current) setReading(false);
    }
  }
  return (
    <Modal
      open
      title={uncertain ? '核对原接口停止回执' : '停止后续接口用例'}
      width={610}
      zIndex={uiLayers.dialog}
      onCancel={() => {
        if (!pending) onClose();
      }}
      closable={!pending}
      maskClosable={!pending}
      footer={
        <Space>
          <Button disabled={pending} onClick={onClose}>
            关闭
          </Button>
          {!uncertain && (
            <Button danger loading={pending} onClick={() => void stop()}>
              正常停止后续用例
            </Button>
          )}
        </Space>
      }
    >
      <h3>{target.name}</h3>
      <p className="caption mt">轮次 {target.runId}</p>
      <p className="mt">
        停止不再启动后续用例。当前用例与清理按原策略收尾，不强制重跑、不重试请求或清理。
      </p>
      {target.currentCase && (
        <p className="caption mt">
          当前显示用例：{target.currentCase}；提交时以服务端实际当前用例为准。
        </p>
      )}
      {error && (
        <Alert className="section-alert" type="error" showIcon title={error} />
      )}
      {uncertain && (
        <RecoveryBlock
          variant="pending"
          title="核对接口执行停止回执"
          reference={command.current}
          description="同一停止请求暂待原回执确认。"
          actions={
            <Space wrap>
              <Button loading={reading} onClick={() => void receipt()}>
                查询原停止回执
              </Button>
              {failed && (
                <Button
                  onClick={() => {
                    remember(
                      userId,
                      projectId,
                      { runId: target.runId, commandId: command.current },
                      true,
                    );
                    command.current = crypto.randomUUID();
                    setUncertain(false);
                    setFailed(false);
                    setError(undefined);
                    setStatus('原失败已确认，需再次明确停止才会提交新操作。');
                  }}
                >
                  已知失败，重新确认
                </Button>
              )}
            </Space>
          }
        />
      )}
      {status && (
        <p className="caption mt" role="status">
          {status}
        </p>
      )}
    </Modal>
  );
}
