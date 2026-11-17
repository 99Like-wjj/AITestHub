export type IntentStatus =
  | 'waitingConfirmation'
  | 'executing'
  | 'completed'
  | 'declined'
  | 'failed'
  | 'unknown'
  | 'expired';
export const intentStatusLabels: Record<IntentStatus, string> = {
  waitingConfirmation: '待你决定',
  executing: '正在执行',
  completed: '已返回执行结果',
  declined: '已取消',
  failed: '执行未完成',
  unknown: '结果待核对',
  expired: '已失效',
};
export const intentIsTerminal = (status: IntentStatus) =>
  ['completed', 'declined', 'failed', 'expired'].includes(status);
export function canDecideIntent(
  status: IntentStatus,
  expiresAt: string,
  uncertain: boolean,
) {
  return (
    status === 'waitingConfirmation' &&
    !uncertain &&
    Number.isFinite(Date.parse(expiresAt)) &&
    Date.parse(expiresAt) > Date.now()
  );
}
export interface IntentDecisionFence {
  id: string;
  conversationId: string;
  revision: number;
  scopeDigest: string;
  decision: 'execute' | 'cancel';
  createdAt: string;
}
type DecisionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const key = (owner: string, cid: string, id: string) =>
  `aitesthub:action-decision:v1:${owner}:${cid}:${id}`;
export function readIntentDecisionFence(
  storage: DecisionStorage,
  owner: string,
  cid: string,
  id: string,
): IntentDecisionFence | null {
  const value = storage.getItem(key(owner, cid, id));
  if (!value) return null;
  const raw: unknown = JSON.parse(value);
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('id' in raw) ||
    raw.id !== id ||
    !('conversationId' in raw) ||
    raw.conversationId !== cid ||
    !('revision' in raw) ||
    typeof raw.revision !== 'number' ||
    !('scopeDigest' in raw) ||
    typeof raw.scopeDigest !== 'string' ||
    !('decision' in raw) ||
    !['execute', 'cancel'].includes(String(raw.decision)) ||
    !('createdAt' in raw) ||
    typeof raw.createdAt !== 'string'
  )
    throw new Error('原动作决定记录无法核对，请只查询原结果。');
  return {
    id,
    conversationId: cid,
    revision: raw.revision,
    scopeDigest: raw.scopeDigest,
    decision: raw.decision === 'execute' ? 'execute' : 'cancel',
    createdAt: raw.createdAt,
  };
}
export function beginIntentDecision(
  storage: DecisionStorage,
  owner: string,
  fence: IntentDecisionFence,
) {
  if (readIntentDecisionFence(storage, owner, fence.conversationId, fence.id))
    throw new Error('此动作已有已发出的决定，请只查询原结果，不重复提交。');
  storage.setItem(
    key(owner, fence.conversationId, fence.id),
    JSON.stringify(fence),
  );
  if (
    readIntentDecisionFence(storage, owner, fence.conversationId, fence.id)
      ?.createdAt !== fence.createdAt
  )
    throw new Error('无法可靠保存原决定标识，本次尚未发送。');
}
export function clearIntentDecisionFence(
  storage: DecisionStorage,
  owner: string,
  cid: string,
  id: string,
) {
  storage.removeItem(key(owner, cid, id));
}
