import { useEffect, useState } from 'react';
import { Alert, Button, Modal, Skeleton, Space } from 'antd';
import { z } from 'zod';
import {
  assetOperationStatusSchema,
  assetReceiptSchema,
  removeAssetInputSchema,
  removeScopedSceneInputSchema,
  scopedSceneRemovalPreviewSchema,
  type Asset,
} from '../../../packages/contracts/src/assets';
import { idSchema } from '../../../packages/contracts/src/base';
import { api, describeError, isUncertainMutationError } from './api';
import { useBusinessCommand } from './business-command';
import { currentIdentityOwner } from './identity-context';
import { RecoveryBlock } from './recovery-block';
import { uiLayers } from './ui-layers';

export function UiAssetRemoval({
  asset,
  userId,
  onClose,
  onRemoved,
}: {
  asset: Asset;
  userId: string;
  onClose: () => void;
  onRemoved: () => Promise<void>;
}) {
  const isScene = asset.targetType === 'scenario';
  const path = `/projects/${asset.projectId}/assets`;
  const action = isScene
    ? 'assets.remove-scoped-scene'
    : 'assets.explicit-remove';
  const storageKey = `aitesthub:ui-remove:${userId}:${asset.projectId}:${asset.id}`;
  const [recoveryId, setRecoveryId] = useState(() => {
    try {
      return idSchema.safeParse(localStorage.getItem(storageKey)).data;
    } catch {
      return undefined;
    }
  });
  const [attempt, setAttempt] = useState(0);
  const command = useBusinessCommand(asset.id + ':' + attempt);
  const [preview, setPreview] =
    useState<z.output<typeof scopedSceneRemovalPreviewSchema>>();
  const [previewError, setPreviewError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [recovering, setRecovering] = useState(false);
  const loading = isScene && !preview && !previewError && !recoveryId;
  useEffect(() => {
    if (!isScene || recoveryId) return;
    const controller = new AbortController();
    setPreview(undefined);
    setPreviewError(undefined);
    void api(
      `${path}/${asset.id}/scoped-scene`,
      { signal: controller.signal },
      scopedSceneRemovalPreviewSchema,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.sceneId !== asset.id)
          setPreviewError('移除范围与选定场景不一致。');
        else setPreview(result);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setPreviewError(describeError(failure));
      });
    return () => controller.abort();
  }, [asset.id, attempt, isScene, path, recoveryId]);

  async function handled(result: z.output<typeof assetReceiptSchema>) {
    if (
      result.asset.id !== asset.id ||
      result.asset.projectId !== asset.projectId ||
      !result.asset.removedAt
    )
      throw new Error('回执与原移除目标不一致，请保留原命令标识。');
    localStorage.removeItem(storageKey);
    command.confirmRecoveredReceipt();
    await onRemoved();
    onClose();
  }

  async function remove() {
    if (
      recoveryId ||
      (isScene && !preview) ||
      currentIdentityOwner() !== userId
    )
      return;
    const result = await command.run(async (commandId) => {
      const body = preview
        ? removeScopedSceneInputSchema.parse({
            commandId,
            baseRevisionId: preview.baseRevisionId,
            rowVersion: preview.rowVersion,
            caseIds: preview.caseIds,
          })
        : removeAssetInputSchema.parse({
            commandId,
            baseRevisionId: asset.revisionId,
            rowVersion: asset.rowVersion,
          });
      localStorage.setItem(storageKey, commandId);
      try {
        return await api(
          `${path}/${asset.id}${preview ? '/scoped-scene' : ''}`,
          {
            method: 'DELETE',
            body,
          },
          assetReceiptSchema,
        );
      } catch (failure) {
        if (isUncertainMutationError(failure)) setRecoveryId(commandId);
        else localStorage.removeItem(storageKey);
        throw failure;
      }
    });
    if (!result) return;
    try {
      await handled(result);
    } catch (failure) {
      setRecoveryId(command.commandId);
      setNotice(describeError(failure));
    }
  }

  async function recover() {
    if (!recoveryId || recovering || currentIdentityOwner() !== userId) return;
    setRecovering(true);
    setNotice(undefined);
    try {
      const receipt = await api(
        `${path}/receipts/${recoveryId}?operation=${action}`,
        {},
        assetOperationStatusSchema,
      );
      if (receipt.commandId !== recoveryId || receipt.operation !== action)
        throw new Error('回执与原移除命令不一致。');
      if (receipt.status === 'completed' && receipt.response)
        await handled(receipt.response);
      else if (receipt.status === 'failed') {
        localStorage.removeItem(storageKey);
        setRecoveryId(undefined);
        setAttempt((value) => value + 1);
        setNotice('原移除已明确失败。请重新核对目标。');
      } else setNotice('原移除尚未确认，请稍后核对。');
    } catch (failure) {
      setNotice(describeError(failure));
    } finally {
      setRecovering(false);
    }
  }

  return (
    <Modal
      open
      title={isScene ? '删除场景' : '删除用例'}
      zIndex={uiLayers.confirmation}
      onCancel={onClose}
      closable={!command.pending && !recovering}
      keyboard={!command.pending && !recovering}
      maskClosable={false}
      footer={
        <Space>
          <Button disabled={command.pending || recovering} onClick={onClose}>
            取消
          </Button>
          {(previewError || (isScene && command.error && !recoveryId)) && (
            <Button onClick={() => setAttempt((value) => value + 1)}>
              重新核对范围
            </Button>
          )}
          {!recoveryId && (
            <Button
              type="primary"
              danger
              loading={command.pending}
              disabled={
                loading || Boolean(previewError) || Boolean(command.error)
              }
              onClick={() => void remove()}
            >
              {isScene ? '删除场景与用例' : '删除用例'}
            </Button>
          )}
        </Space>
      }
    >
      <p>
        <b>{asset.title}</b>
      </p>
      {preview && (
        <p>
          此操作移除该场景与当前 {preview.caseCount} 条用例，涉及{' '}
          {preview.activePlanCount} 个计划。
        </p>
      )}
      <p>已保存的历史修订、批准、报告和缺陷可按原来源读取。</p>
      {loading && <Skeleton active />}
      {(previewError || command.error) && (
        <Alert type="error" showIcon title={previewError ?? command.error} />
      )}
      {notice && <Alert type="info" showIcon title={notice} />}
      {recoveryId && (
        <RecoveryBlock
          variant="pending"
          title="核对原移除回执"
          reference={recoveryId}
          actions={
            <Button loading={recovering} onClick={() => void recover()}>
              查询原回执
            </Button>
          }
        />
      )}
    </Modal>
  );
}
