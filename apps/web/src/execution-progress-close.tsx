import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Modal, Space } from 'antd';
import { z } from 'zod';
import {
  previewCloseUiProgressBatchInputSchema,
  uiProgressClosePreviewSchema,
  closeUiProgressBatchInputSchema,
  closeUiProgressBatchReceiptSchema,
  uiProgressCloseBatchStatusSchema,
} from '../../../packages/contracts/src/ui-results';
import { api, describeError, isUncertainMutationError, ApiError } from './api';
import {
  pendingProgressCloseSchema,
  assertProgressPreview,
  assertProgressReceipt,
  assertProgressStatus,
} from './execution-progress-close-state';
import type {
  PendingProgressClose,
  ProgressTarget,
} from './execution-progress-close-state';
import { uiLayers } from './ui-layers';
import { RecoveryBlock } from './recovery-block';

const changed = 'aitesthub:ui-progress-close-changed';
const key = (userId: string, projectId: string) =>
  `aitesthub:ui-progress-close:v1:${userId}:${projectId}`;
function read(userId: string, projectId: string) {
  try {
    return z
      .array(pendingProgressCloseSchema)
      .max(1000)
      .parse(JSON.parse(localStorage.getItem(key(userId, projectId)) ?? '[]'));
  } catch {
    return [];
  }
}
function remember(
  userId: string,
  projectId: string,
  record: PendingProgressClose,
  remove = false,
) {
  try {
    const records = read(userId, projectId).filter(
      (item) => item.commandId !== record.commandId,
    );
    if (!remove && records.length >= 1000) return false;
    if (!remove) records.push(record);
    localStorage.setItem(key(userId, projectId), JSON.stringify(records));
    window.dispatchEvent(new Event(changed));
    return true;
  } catch {
    return false;
  }
}
export function usePendingProgressCloses(userId: string, projectId: string) {
  const [items, setItems] = useState<PendingProgressClose[]>([]);
  useEffect(() => {
    const update = () => setItems(read(userId, projectId));
    update();
    window.addEventListener(changed, update);
    return () => window.removeEventListener(changed, update);
  }, [userId, projectId]);
  return items;
}
type Preview = z.infer<typeof uiProgressClosePreviewSchema>;
type ItemReceipt = z.infer<
  typeof closeUiProgressBatchReceiptSchema
>['items'][number];
const labels: Record<ItemReceipt['status'], string> = {
  closed: '已关闭平台进度展示',
  alreadyClosed: '此前已关闭',
  conflict: '版本冲突，未关闭',
  skipped: '已跳过',
};
export function ProgressCloseDialog({
  userId,
  projectId,
  targets,
  recovery,
  onClose,
  onChanged,
}: {
  userId: string;
  projectId: string;
  targets: (ProgressTarget & { name?: string })[];
  recovery?: PendingProgressClose;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null),
    [pending, setPending] = useState(false),
    [uncertain, setUncertain] = useState(!!recovery),
    [error, setError] = useState<string>(),
    [status, setStatus] = useState<string>(),
    [receipt, setReceipt] = useState<ItemReceipt[] | null>(null),
    [completed, setCompleted] = useState(false);
  const command = useRef(recovery?.commandId ?? crypto.randomUUID()),
    saved = useRef<PendingProgressClose | null>(recovery ?? null),
    busy = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const base = `/projects/${projectId}/ui-executions`;
  async function loadPreview() {
    if (busy.current || uncertain || completed) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    try {
      const body = previewCloseUiProgressBatchInputSchema.parse({
        items: targets.map(({ runId, rowVersion }) => ({ runId, rowVersion })),
      });
      const value = assertProgressPreview(
        projectId,
        body,
        await api(
          `${base}/close-progress-preview`,
          { method: 'POST', body },
          uiProgressClosePreviewSchema,
        ),
      );
      if (alive.current) setPreview(value);
    } catch (failure) {
      if (alive.current) setError(describeError(failure));
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
    }
  }
  function acknowledged(
    value: z.infer<typeof closeUiProgressBatchReceiptSchema>,
  ) {
    const record = saved.current;
    if (!record) throw new Error('原提交标识缺失，不能确认回执。');
    assertProgressReceipt(projectId, record, value);
    remember(userId, projectId, record, true);
    setReceipt(value.items);
    setUncertain(false);
    setCompleted(true);
    setStatus('已取得此精确范围的逐项回执。');
    onChanged();
  }
  async function commit() {
    if (!preview || busy.current || uncertain || completed) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    const record = pendingProgressCloseSchema.parse({
      commandId: command.current,
      scopeDigest: preview.scopeDigest,
      items: targets.map(({ runId, rowVersion }) => ({ runId, rowVersion })),
    });
    saved.current = record;
    // Retain identifiers and versions only. Never retain results, report content or credentials.
    const retained = remember(userId, projectId, record);
    try {
      const value = await api(
        `${base}/close-progress-batch`,
        { method: 'POST', body: closeUiProgressBatchInputSchema.parse(record) },
        closeUiProgressBatchReceiptSchema,
      );
      // A mismatched successful receipt is also uncertain; never enable a fresh submission.
      assertProgressReceipt(projectId, record, value);
      if (alive.current) acknowledged(value);
    } catch (failure) {
      const unknown =
        isUncertainMutationError(failure) || !(failure instanceof ApiError);
      if (!unknown) remember(userId, projectId, record, true);
      if (alive.current) {
        setUncertain(unknown);
        setError(describeError(failure));
        if (unknown && !retained)
          setStatus('浏览器无法保存原标识，请记录当前提交标识后再关闭。');
      }
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
    }
  }
  async function recover() {
    const record = saved.current;
    if (!record || busy.current) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    try {
      const value = assertProgressStatus(
        projectId,
        record,
        await api(
          `${base}/close-progress-batches/${record.commandId}`,
          {},
          uiProgressCloseBatchStatusSchema,
        ),
      );
      if (!alive.current) return;
      if (value.state === 'completed' && value.receipt)
        acknowledged(value.receipt);
      else {
        setReceipt(
          value.items.flatMap((item) => (item.receipt ? [item.receipt] : [])),
        );
        setStatus(
          '原批次回执尚不完整。缺少回执的轮次结果未知，只读查询不会重发关闭。',
        );
        onChanged();
      }
    } catch (failure) {
      if (alive.current)
        setError(
          `${describeError(failure)}${failure instanceof ApiError && failure.status === 404 ? '；尚未查到不代表原操作未发生。' : ''}`,
        );
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
    }
  }
  const known = new Map(receipt?.map((item) => [item.runId, item]) ?? []);
  return (
    <Modal
      open
      title={recovery ? '核对原批量进度关闭' : '批量关闭平台进度展示'}
      width={820}
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
          {uncertain ? (
            <Button
              type="primary"
              loading={pending}
              onClick={() => void recover()}
            >
              查询原提交回执
            </Button>
          ) : (
            !completed &&
            (preview ? (
              <Button
                danger
                loading={pending}
                disabled={!preview.items.some((item) => item.eligible)}
                onClick={() => void commit()}
              >
                确认关闭此 {targets.length} 项平台进度
              </Button>
            ) : (
              <Button
                type="primary"
                loading={pending}
                onClick={() => void loadPreview()}
              >
                预览所选范围
              </Button>
            ))
          )}
        </Space>
      }
    >
      <p>
        仅关闭所选 UI 轮次的平台进度展示。不会停止本地
        AI、改变执行状态、结果或报告；后续进度上报仍按协议接收。
      </p>
      {error && (
        <Alert className="section-alert" type="error" showIcon title={error} />
      )}
      {uncertain && (
        <RecoveryBlock
          variant="pending"
          title="核对批量进度关闭回执"
          reference={command.current}
          description="查询时沿用原轮次、版本和范围摘要。"
        />
      )}
      {status && (
        <p className="caption mt" role="status">
          {status}
        </p>
      )}
      <div className="tablewrap mt">
        <table>
          <thead>
            <tr>
              <th>确切轮次</th>
              <th>选择版本</th>
              <th>{receipt ? '逐项回执' : preview ? '预览资格' : '待预览'}</th>
            </tr>
          </thead>
          <tbody>
            {targets.map((target) => {
              const pre = preview?.items.find(
                  (item) => item.runId === target.runId,
                ),
                item = known.get(target.runId);
              return (
                <tr key={target.runId}>
                  <td>
                    <b>{target.name ?? '原 UI 轮次'}</b>
                    <p className="caption mono">{target.runId}</p>
                  </td>
                  <td>{target.rowVersion}</td>
                  <td>
                    {item ? (
                      <>
                        <span
                          className={`badge ${item.status === 'closed' || item.status === 'alreadyClosed' ? 'green' : 'amber'}`}
                        >
                          {labels[item.status]}
                        </span>
                        {item.code && <p className="caption">{item.code}</p>}
                      </>
                    ) : receipt ? (
                      <span className="badge amber">回执缺失，结果未知</span>
                    ) : pre ? (
                      <>
                        <span
                          className={`badge ${pre.eligible ? 'green' : 'amber'}`}
                        >
                          {pre.eligible
                            ? '可关闭'
                            : pre.progressClosedAt
                              ? '此前已关闭'
                              : '不可关闭'}
                        </span>
                        {pre.code && <p className="caption">{pre.code}</p>}
                        <p className="caption">
                          当前版本 {pre.actualRowVersion ?? '不可读'} ·{' '}
                          {pre.state ?? '不可读'}
                        </p>
                      </>
                    ) : (
                      '尚未查询资格'
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {completed && (
        <p className="caption mt">
          冲突与跳过项未自动更新版本或补入其他轮次，需要另行明确选择。
        </p>
      )}
    </Modal>
  );
}
