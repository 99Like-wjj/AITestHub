import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Modal, Space } from 'antd';
import {
  requirementDeletionPreviewSchema,
  requirementDeletionReceiptSchema,
  requirementDeletionReceiptLookupSchema,
} from '../../../packages/contracts/src/requirement-deletion';
import { api, ApiError, describeError } from './api';
import { uiLayers } from './ui-layers';
import {
  assertRequirementDeletePreview,
  browserDeletionStorage,
  deletionStorageChanged,
  readPendingRequirementDeletions,
  removePendingRequirementDeletion,
  requirementCanBeDeleted,
  recoverRequirementDeletion,
  submitRequirementDeletion,
} from './requirement-delete-state';
import type {
  DeletionPreview,
  DeletionReceipt,
  PendingRequirementDeletion,
} from './requirement-delete-state';

export function usePendingRequirementDeletions(
  userId: string,
  projectId: string | undefined,
) {
  const [value, setValue] = useState<{
    records: PendingRequirementDeletion[];
    error: string | undefined;
  }>({ records: [], error: undefined });
  useEffect(() => {
    const update = () => {
      try {
        setValue({
          records: projectId
            ? readPendingRequirementDeletions(
                browserDeletionStorage(),
                userId,
                projectId,
              )
            : [],
          error: undefined,
        });
      } catch {
        setValue({
          records: [],
          error:
            '原删除提交恢复记录暂时无法读取，已停用新的删除操作。请恢复浏览器本地存储后刷新。',
        });
      }
    };
    update();
    window.addEventListener(deletionStorageChanged, update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener(deletionStorageChanged, update);
      window.removeEventListener('storage', update);
    };
  }, [userId, projectId]);
  return {
    ...value,
    records: value.records.filter(
      (record) => record.userId === userId && record.projectId === projectId,
    ),
  };
}
export interface RequirementDeleteTarget {
  requirementId: string;
  name?: string;
  session: string;
  recovery?: PendingRequirementDeletion;
}
const fileActions = {
  deleteExclusiveFile: '删除独有资源；字节清理排队',
  retainReferencedFile: '保留被其他记录引用的资源和原件',
  deleteResourceKeepSharedBytes: '删除本资源记录；保留共享原件字节',
};
export function RequirementDeleteDialog({
  userId,
  projectId,
  tester,
  blocked,
  target,
  onClose,
  onDeleted,
}: {
  userId: string;
  projectId: string;
  tester: boolean;
  blocked: boolean;
  target: RequirementDeleteTarget;
  onClose: () => void;
  onDeleted: (requirementId: string) => void;
}) {
  const [original] = useState(() => {
    try {
      return (
        target.recovery ??
        readPendingRequirementDeletions(
          browserDeletionStorage(),
          userId,
          projectId,
        ).find((item) => item.requirementId === target.requirementId)
      );
    } catch {
      return target.recovery;
    }
  });
  const command = useRef(original?.commandId ?? crypto.randomUUID());
  const [preview, setPreview] = useState<DeletionPreview | null>(null),
    [receipt, setReceipt] = useState<DeletionReceipt | null>(null),
    [uncertain, setUncertain] = useState(!!original),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string>(),
    [notice, setNotice] = useState<string>(),
    [now, setNow] = useState(Date.now);
  const busy = useRef(false),
    alive = useRef(true),
    reader = useRef<AbortController | null>(null),
    acknowledged = useRef(false);
  const rejectedRecord = useRef<PendingRequirementDeletion | null>(null);
  const context = `${userId}:${projectId}:${tester}:${target.session}:${target.requirementId}`,
    current = useRef(context);
  current.current = context;
  const active = (origin: string) =>
    alive.current && current.current === origin;
  const record: PendingRequirementDeletion = {
    userId,
    projectId,
    requirementId: target.requirementId,
    commandId: command.current,
  };
  const base = `/projects/${encodeURIComponent(projectId)}/requirements/${encodeURIComponent(target.requirementId)}`;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      reader.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!preview) return;
    const remaining = Date.parse(preview.expiresAt) - Date.now();
    if (remaining <= 0) {
      setNow(Date.now());
      return;
    }
    const timer = setTimeout(() => setNow(Date.now()), remaining + 10);
    return () => clearTimeout(timer);
  }, [preview]);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!original && tester && !blocked) void loadPreview();
    }, 0);
    return () => clearTimeout(timer);
  }, []);
  async function loadPreview() {
    if (busy.current || uncertain || receipt || !tester || blocked) return;
    const origin = context,
      controller = new AbortController();
    reader.current = controller;
    busy.current = true;
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    setPreview(null);
    try {
      if (rejectedRecord.current) {
        removePendingRequirementDeletion(
          browserDeletionStorage(),
          rejectedRecord.current,
        );
        rejectedRecord.current = null;
      }
      const pendingRecords = readPendingRequirementDeletions(
          browserDeletionStorage(),
          userId,
          projectId,
        ),
        existing = pendingRecords.find(
          (item) => item.requirementId === target.requirementId,
        );
      if (existing) {
        command.current = existing.commandId;
        if (active(origin)) {
          setUncertain(true);
          setNotice('此需求已有原删除提交待核对，未发出新的删除。');
        }
        return;
      }
      const value = assertRequirementDeletePreview(
        target.requirementId,
        await api(
          `${base}/delete-preview`,
          { signal: controller.signal },
          requirementDeletionPreviewSchema,
        ),
      );
      if (active(origin) && !controller.signal.aborted) {
        command.current = crypto.randomUUID();
        setPreview(value);
        setNow(Date.now());
      }
    } catch (failure) {
      if (active(origin) && !controller.signal.aborted)
        setError(describeError(failure));
    } finally {
      busy.current = false;
      if (active(origin)) setPending(false);
    }
  }
  function known(value: DeletionReceipt, origin: string) {
    if (!active(origin)) return;
    setReceipt(value);
    setUncertain(false);
    setPreview(null);
    setError(undefined);
    setNotice(undefined);
    if (!acknowledged.current) {
      acknowledged.current = true;
      onDeleted(value.requirementId);
    }
  }
  async function commit() {
    if (
      !preview ||
      !requirementCanBeDeleted(preview) ||
      Date.parse(preview.expiresAt) <= Date.now() ||
      busy.current ||
      uncertain ||
      receipt ||
      !tester ||
      blocked
    )
      return;
    const origin = context;
    busy.current = true;
    setPending(true);
    setError(undefined);
    const outcome = await submitRequirementDeletion({
      record,
      preview,
      storage: browserDeletionStorage(),
      send: (input) =>
        api(
          `${base}/delete`,
          { method: 'POST', body: input },
          requirementDeletionReceiptSchema,
        ),
    });
    busy.current = false;
    if (!active(origin)) return;
    setPending(false);
    if (outcome.state === 'completed') known(outcome.receipt, origin);
    else {
      setError(outcome.message);
      if (outcome.state === 'unknown') {
        setUncertain(true);
        setPreview(null);
      } else if (outcome.state === 'rejected') {
        rejectedRecord.current = record;
        setPreview(null);
        setNotice(
          '服务已明确拒绝本次删除。请重新读取影响；新版本和权限以服务端为准。',
        );
      }
    }
  }
  async function recover() {
    if (busy.current || !tester) return;
    const origin = context,
      controller = new AbortController();
    reader.current = controller;
    busy.current = true;
    setPending(true);
    setError(undefined);
    try {
      const confirmed = await recoverRequirementDeletion({
        record: { ...record, commandId: command.current },
        storage: browserDeletionStorage(),
        read: () =>
          api(
            `${base}/deletion-receipts/${encodeURIComponent(command.current)}`,
            { signal: controller.signal },
            requirementDeletionReceiptLookupSchema,
          ),
      });
      if (active(origin) && !controller.signal.aborted)
        known(confirmed, origin);
    } catch (failure) {
      if (active(origin) && !controller.signal.aborted)
        setError(
          failure instanceof ApiError && failure.status === 404
            ? '暂未查询到原删除回执，不代表未受理或未删除。保留原标识继续只读核对，不重新提交。'
            : describeError(failure),
        );
    } finally {
      busy.current = false;
      if (active(origin)) setPending(false);
    }
  }
  if (!tester) return null;
  const expired = preview ? Date.parse(preview.expiresAt) <= now : false;
  return (
    <Modal
      open
      centered
      title={
        uncertain
          ? '核对原需求删除回执'
          : receipt
            ? '需求删除回执'
            : '检查需求永久删除影响'
      }
      width={1030}
      zIndex={uiLayers.dialog}
      onCancel={() => {
        if (!pending) onClose();
      }}
      closable={!pending}
      maskClosable={!pending}
      keyboard={!pending}
      footer={
        <Space wrap>
          <Button disabled={pending} onClick={onClose}>
            关闭
          </Button>
          {uncertain ? (
            <Button
              type="primary"
              loading={pending}
              onClick={() => void recover()}
            >
              只读查询原删除回执
            </Button>
          ) : (
            !receipt && (
              <>
                <Button
                  disabled={pending || blocked}
                  onClick={() => void loadPreview()}
                  loading={pending && !preview}
                >
                  重新读取删除影响
                </Button>
                {preview && requirementCanBeDeleted(preview) && (
                  <Button
                    danger
                    type="primary"
                    loading={pending}
                    disabled={blocked || expired}
                    onClick={() => void commit()}
                  >
                    永久删除此需求及 {preview.versionCount} 个资料版本
                  </Button>
                )}
              </>
            )
          )}
        </Space>
      }
    >
      <h2>{target.name ?? '原需求删除操作'}</h2>
      <p className="caption">需求 {target.requirementId}</p>
      {error && (
        <Alert type="error" showIcon className="section-alert" title={error} />
      )}
      {notice && (
        <p className="caption mt" role="status">
          {notice}
        </p>
      )}
      {uncertain && (
        <div className="notice amber mt">
          <p>
            原提交标识：<span className="mono">{command.current}</span>
          </p>
          <p>
            原操作结果尚未确认，已禁止新删除提交。需求行或详情消失、返回404，都不能代替原删除回执。
          </p>
        </div>
      )}
      {receipt && (
        <div className="notice mt" role="status">
          <p>
            原回执已确认：需求已于{' '}
            {new Date(receipt.deletedAt).toLocaleString('zh-CN')} 永久删除。
          </p>
          <p>
            删除资料版本 {receipt.removedVersionCount} 个 · 独有资源{' '}
            {receipt.exclusiveFileCount} 个 · 保留引用资源{' '}
            {receipt.retainedFileCount} 个。
          </p>
          <p className="caption">
            独有原件按清理队列处理或没有可清理字节；此回执不代表物理字节已全部清除。
          </p>
        </div>
      )}
      {preview && (
        <>
          {!requirementCanBeDeleted(preview) ? (
            <div className="notice amber mt">
              <b>此需求不符合永久删除条件，请使用归档。</b>
              <p>
                存在需要保护的历史或引用，原资料、版本和关联继续保留。归档不改变生命周期。
              </p>
            </div>
          ) : (
            <div className="notice amber mt">
              <b>将永久删除此需求及全部 {preview.versionCount} 个资料版本。</b>
              <p>
                当前检查未发现受保护历史。确认后不可在平台内撤销；被其他记录引用的资料与共享原件按下列实际影响保留。
              </p>
            </div>
          )}
          <p className="caption mt">
            实际资料版本 {preview.versionCount} 个 · 相关文件资源{' '}
            {preview.files.length} 个 · 本次影响有效至{' '}
            {new Date(preview.expiresAt).toLocaleString('zh-CN')}
          </p>
          {expired && (
            <p className="notice amber mt">
              本次影响预览已过期，请重新读取后再决定。
            </p>
          )}
          <div className="tablewrap mt">
            <table>
              <thead>
                <tr>
                  <th>文件资源</th>
                  <th>字节</th>
                  <th>实际处理</th>
                </tr>
              </thead>
              <tbody>
                {preview.files.map((file) => (
                  <tr key={file.id}>
                    <td>
                      {file.originalName}
                      <details className="caption">
                        <summary>资源校验信息</summary>
                        <span className="mono">
                          {file.id}
                          <br />
                          {file.sha256}
                        </span>
                      </details>
                    </td>
                    <td>{file.bytes}</td>
                    <td>{fileActions[file.action]}</td>
                  </tr>
                ))}
                {!preview.files.length && (
                  <tr>
                    <td colSpan={3}>
                      本次影响中没有文件资源；来源链接随对应资料版本处理，不代表平台已读取其内容。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}
