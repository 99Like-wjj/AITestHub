import type { Conversation } from '../../../packages/contracts/src/conversations';

/** Resolves only a destination. It never submits a message or selects a model. */
export async function resolveComposerDestination({
  activeId,
  conversation,
  model,
  selectionCurrent,
  create,
}: {
  activeId: string | null;
  conversation: Conversation | null;
  model: { available: boolean } | undefined;
  selectionCurrent: boolean;
  create: () => Promise<Conversation | null>;
}): Promise<
  | { state: 'ready'; conversation: Conversation }
  | { state: 'needsModel' | 'unavailable'; reason: string }
> {
  if (!model || !selectionCurrent || !model.available)
    return {
      state: 'needsModel',
      reason: !model
        ? '请先明确选择一个可用模型，再确认本条消息发送。'
        : !selectionCurrent
          ? '所选模型配置已变化，请重新选择并核对本条消息。'
          : '所选模型尚无可用凭据，请选择其他已开放模型或联系管理员。',
    };
  if (
    (activeId && !conversation) ||
    (conversation && conversation.id !== activeId)
  )
    return {
      state: 'unavailable',
      reason: '当前会话尚未读取或不可用，请核对后再发送。',
    };
  if (conversation?.archivedAt)
    return {
      state: 'unavailable',
      reason: '当前会话已归档，请先恢复后再发送。',
    };
  const destination = conversation ?? (await create());
  return destination
    ? { state: 'ready', conversation: destination }
    : {
        state: 'unavailable',
        reason: '本人对话尚未准备完成；若回执待核对，请只读找回原创建。',
      };
}
