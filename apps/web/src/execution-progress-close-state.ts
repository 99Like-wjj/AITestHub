import { z } from 'zod';
import {
  previewCloseUiProgressBatchInputSchema,
  uiProgressCloseBatchStatusSchema,
  uiProgressClosePreviewSchema,
  closeUiProgressBatchReceiptSchema,
} from '../../../packages/contracts/src/ui-results';

export const pendingProgressCloseSchema =
  previewCloseUiProgressBatchInputSchema.safeExtend({
    commandId: z.uuid(),
    scopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  });
export type PendingProgressClose = z.infer<typeof pendingProgressCloseSchema>;
export type ProgressTarget = PendingProgressClose['items'][number];
type Scope = { items: ProgressTarget[] };
function exactTargets(expected: Scope, actual: ProgressTarget[]) {
  if (actual.length !== expected.items.length) return false;
  const byId = new Map(
    expected.items.map((item) => [item.runId, item.rowVersion]),
  );
  return (
    new Set(actual.map((item) => item.runId)).size === actual.length &&
    actual.every((item) => byId.get(item.runId) === item.rowVersion)
  );
}
export function assertProgressPreview(
  projectId: string,
  expected: Scope,
  preview: z.infer<typeof uiProgressClosePreviewSchema>,
) {
  if (preview.projectId !== projectId || !exactTargets(expected, preview.items))
    throw new Error('进度预览范围不匹配，未提交关闭。请重新明确选择。');
  return preview;
}
export function assertProgressReceipt(
  projectId: string,
  expected: PendingProgressClose,
  receipt: z.infer<typeof closeUiProgressBatchReceiptSchema>,
) {
  if (
    receipt.projectId !== projectId ||
    receipt.commandId !== expected.commandId ||
    receipt.scopeDigest !== expected.scopeDigest ||
    !exactTargets(
      expected,
      receipt.items.map((item) => ({
        runId: item.runId,
        rowVersion: item.baseRowVersion,
      })),
    )
  )
    throw new Error('原关闭回执范围不匹配，请保留原提交标识继续核对。');
  return receipt;
}
export function assertProgressStatus(
  projectId: string,
  expected: PendingProgressClose,
  status: z.infer<typeof uiProgressCloseBatchStatusSchema>,
) {
  if (
    status.projectId !== projectId ||
    status.commandId !== expected.commandId ||
    status.scopeDigest !== expected.scopeDigest ||
    !exactTargets(expected, status.items)
  )
    throw new Error('原关闭状态范围不匹配，请保留原提交标识继续核对。');
  for (const item of status.items)
    if (
      item.receipt &&
      (item.receipt.runId !== item.runId ||
        item.receipt.baseRowVersion !== item.rowVersion)
    )
      throw new Error('逐项关闭回执不匹配，请保留原提交标识继续核对。');
  if (status.receipt)
    assertProgressReceipt(projectId, expected, status.receipt);
  if (status.state === 'completed' && !status.receipt)
    throw new Error('关闭回执尚不完整，不能视为全部完成。');
  return status;
}
