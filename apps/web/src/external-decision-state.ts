type DecisionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const key = (owner: string, id: string) =>
  `aitesthub:external-decision:v1:${owner}:${id}`;
export function externalDecisionPending(
  storage: DecisionStorage,
  owner: string,
  id: string,
) {
  return storage.getItem(key(owner, id)) !== null;
}
export function beginExternalDecision(
  storage: DecisionStorage,
  owner: string,
  input: { id: string; scopeDigest: string; decision: 'accept' | 'decline' },
) {
  if (externalDecisionPending(storage, owner, input.id))
    throw new Error('原外发决定已提交，请只查询原结果。');
  const text = JSON.stringify(input);
  storage.setItem(key(owner, input.id), text);
  if (storage.getItem(key(owner, input.id)) !== text)
    throw new Error('无法可靠保存原外发标识，本次尚未发送。');
}
export function clearExternalDecision(
  storage: DecisionStorage,
  owner: string,
  id: string,
) {
  storage.removeItem(key(owner, id));
}
export function canInlineExternalDecision(input: {
  inline: boolean;
  taskId: string | null;
  conversationId: string | null;
  currentTaskId?: string;
  currentConversationId?: string;
}) {
  return input.inline
    ? Boolean(
        input.currentTaskId &&
        input.currentConversationId &&
        input.taskId === input.currentTaskId &&
        input.conversationId === input.currentConversationId,
      )
    : input.taskId === null;
}
