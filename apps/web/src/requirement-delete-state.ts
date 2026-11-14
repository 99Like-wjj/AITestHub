import { z } from 'zod';
import {
  requirementDeletionInputSchema,
  requirementDeletionPreviewSchema,
  requirementDeletionReceiptSchema,
} from '../../../packages/contracts/src/requirement-deletion';
import { ApiError, describeError, isUncertainMutationError } from './api';

export const pendingRequirementDeletionSchema = z.strictObject({
  userId: z.uuid(),
  projectId: z.uuid(),
  requirementId: z.uuid(),
  commandId: z.uuid(),
});
export type PendingRequirementDeletion = z.infer<
  typeof pendingRequirementDeletionSchema
>;
export type DeletionPreview = z.infer<typeof requirementDeletionPreviewSchema>;
export type DeletionReceipt = z.infer<typeof requirementDeletionReceiptSchema>;
export type DeletionStorage = Pick<Storage, 'getItem' | 'setItem'>;
export const deletionStorageChanged = 'aitesthub:requirement-deletion-changed';
const key = (userId: string, projectId: string) =>
  `aitesthub:requirement-deletion:v1:${userId}:${projectId}`;
export function browserDeletionStorage(): DeletionStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
export function readPendingRequirementDeletions(
  storage: DeletionStorage | null,
  userId: string,
  projectId: string,
) {
  if (!storage)
    throw new Error('浏览器未开放原提交恢复记录，本次不能发出删除。');
  const records = z
    .array(pendingRequirementDeletionSchema)
    .max(1000)
    .parse(JSON.parse(storage.getItem(key(userId, projectId)) ?? '[]'));
  return records.filter(
    (item) => item.userId === userId && item.projectId === projectId,
  );
}
function saveRecords(
  storage: DeletionStorage,
  userId: string,
  projectId: string,
  records: PendingRequirementDeletion[],
) {
  storage.setItem(key(userId, projectId), JSON.stringify(records));
  if (typeof window !== 'undefined')
    window.dispatchEvent(new Event(deletionStorageChanged));
}
export function removePendingRequirementDeletion(
  storage: DeletionStorage | null,
  record: PendingRequirementDeletion,
) {
  if (!storage) return;
  const records = readPendingRequirementDeletions(
    storage,
    record.userId,
    record.projectId,
  ).filter((item) => item.commandId !== record.commandId);
  saveRecords(storage, record.userId, record.projectId, records);
}
export function assertRequirementDeletePreview(
  requirementId: string,
  preview: DeletionPreview,
) {
  if (
    preview.requirementId !== requirementId ||
    new Set(preview.files.map((file) => file.id)).size !== preview.files.length
  )
    throw new Error('删除影响所属对象不匹配，未提交删除，请重新读取原需求。');
  return preview;
}
export function requirementCanBeDeleted(preview: DeletionPreview) {
  return (
    preview.canDelete &&
    !preview.protectedHistory &&
    preview.recommendedAction === 'delete'
  );
}
export function assertRequirementDeleteReceipt(
  record: PendingRequirementDeletion,
  receipt: DeletionReceipt,
) {
  if (
    receipt.requirementId !== record.requirementId ||
    receipt.commandId !== record.commandId
  )
    throw new Error('原删除回执对象或提交标识不匹配，保持原标识只读核对。');
  return receipt;
}
export async function recoverRequirementDeletion({
  record,
  storage,
  read,
}: {
  record: PendingRequirementDeletion;
  storage: DeletionStorage | null;
  read: () => Promise<{ receipt: DeletionReceipt }>;
}) {
  const value = await read();
  const receipt = assertRequirementDeleteReceipt(record, value.receipt);
  try {
    removePendingRequirementDeletion(storage, record);
  } catch {
    /* Keep the known receipt usable if browser storage became unavailable. */
  }
  return receipt;
}
type Input = z.infer<typeof requirementDeletionInputSchema>;
type Outcome =
  | { state: 'completed'; receipt: DeletionReceipt }
  | { state: 'unknown' | 'rejected' | 'blocked'; message: string };
/** A deletion is sent once only after recovery metadata is safely retained. */
export async function submitRequirementDeletion({
  record,
  preview,
  storage,
  send,
}: {
  record: PendingRequirementDeletion;
  preview: DeletionPreview;
  storage: DeletionStorage | null;
  send: (input: Input) => Promise<DeletionReceipt>;
}): Promise<Outcome> {
  let input: Input;
  try {
    pendingRequirementDeletionSchema.parse(record);
    assertRequirementDeletePreview(record.requirementId, preview);
    if (!requirementCanBeDeleted(preview))
      return {
        state: 'blocked',
        message: '此需求有保护历史或不符合删除条件，请保留资料并使用归档。',
      };
    if (Date.parse(preview.expiresAt) <= Date.now())
      return {
        state: 'blocked',
        message: '删除影响预览已过期，请重新读取后再决定。',
      };
    input = requirementDeletionInputSchema.parse({
      commandId: record.commandId,
      previewId: preview.previewId,
      rowVersion: preview.rowVersion,
      scopeDigest: preview.scopeDigest,
      confirmed: true,
    });
    const records = readPendingRequirementDeletions(
      storage,
      record.userId,
      record.projectId,
    );
    if (records.some((item) => item.requirementId === record.requirementId))
      return {
        state: 'blocked',
        message: '此需求已有原删除提交待核对，本次未重发。请从顶部查询原回执。',
      };
    if (records.length >= 1000)
      return {
        state: 'blocked',
        message: '原提交恢复记录已满，本次未发出删除。请先核对既有回执。',
      };
    saveRecords(storage!, record.userId, record.projectId, [
      ...records,
      record,
    ]);
  } catch {
    return {
      state: 'blocked',
      message:
        '原删除恢复标识未能可靠保存，本次未发出删除。请检查浏览器本地存储后再试。',
    };
  }
  try {
    const receipt = assertRequirementDeleteReceipt(record, await send(input));
    // A storage failure after a valid receipt cannot turn the known deletion into an unknown one.
    try {
      removePendingRequirementDeletion(storage, record);
    } catch {
      /* A later original-receipt GET can clear this retained identifier. */
    }
    return { state: 'completed', receipt };
  } catch (failure) {
    const definitive =
      failure instanceof ApiError &&
      failure.status >= 400 &&
      failure.status < 500 &&
      !isUncertainMutationError(failure);
    if (definitive) {
      try {
        removePendingRequirementDeletion(storage, record);
      } catch {
        /* Keep a recoverable record if storage has become unavailable. */
      }
    }
    return {
      state: definitive ? 'rejected' : 'unknown',
      message: describeError(failure),
    };
  }
}
