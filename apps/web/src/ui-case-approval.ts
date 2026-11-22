import { z } from 'zod';
import { approvalCommitReceiptSchema } from '../../../packages/contracts/src/assets';
import { currentIdentityOwner } from './identity-context';

const recordSchema = z.strictObject({
  commandId: z.uuid(),
  scopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  objectIds: z.array(z.uuid()).min(1).max(10000),
});
export type ApprovalRecovery = z.infer<typeof recordSchema>;
type ApprovalReceipt = z.infer<typeof approvalCommitReceiptSchema>;

export const recoveredApprovalSchema = z.strictObject({
  status: z.enum(['pending', 'completed', 'failed', 'unknown']),
  response: approvalCommitReceiptSchema.nullable(),
});

export function readApprovalRecovery(key: string) {
  const raw = localStorage.getItem(key);
  return raw ? recordSchema.parse(JSON.parse(raw)) : undefined;
}

export function rememberApproval(
  key: string,
  userId: string,
  record: ApprovalRecovery,
) {
  if (currentIdentityOwner() !== userId) throw new Error('请先核对当前账号。');
  if (readApprovalRecovery(key)) throw new Error('有原批准操作待核对。');
  const frozen = JSON.stringify(record);
  localStorage.setItem(key, frozen);
  if (localStorage.getItem(key) !== frozen)
    throw new Error('无法保留批准操作标识，本次未发送。');
}

export function forgetApproval(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // If retained, the original identifier is only used for receipt lookup.
  }
}

export function assertApprovalReceipt(
  record: ApprovalRecovery,
  result: ApprovalReceipt,
) {
  if (
    result.scopeDigest !== record.scopeDigest ||
    result.results.length !== record.objectIds.length ||
    new Set(result.results.map((item) => item.id)).size !==
      record.objectIds.length ||
    !record.objectIds.every((id) =>
      result.results.some((item) => item.id === id),
    )
  )
    throw new Error('批准回执与原确认范围不一致，请保留原标识核对。');
}
