import { idSchema } from '../../../packages/contracts/src/base';
import { identityContextEpoch } from './identity-context';
import { ApiError } from './api';

export async function fetchConversationMarkdown(
  conversationId: string,
): Promise<Blob> {
  const id = idSchema.parse(conversationId),
    epoch = identityContextEpoch();
  const current = () => {
    if (identityContextEpoch() !== epoch)
      throw new ApiError(
        '当前身份已变化，旧对话导出未采用。',
        409,
        'IDENTITY_CONTEXT_CHANGED',
      );
  };
  let response: Response;
  try {
    response = await fetch(`/api/v1/me/conversations/${id}/export.md`, {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(120000),
    });
  } catch {
    throw new ApiError(
      '对话导出未完成，请检查本地服务后重试。',
      0,
      'NETWORK_UNCONFIRMED',
    );
  }
  current();
  if (!response.ok) {
    await response.body?.cancel();
    current();
    if (response.status === 401)
      window.dispatchEvent(new Event('aitesthub:session-expired'));
    throw new ApiError(
      response.status === 413
        ? '对话超过当前完整导出大小限制，未生成截断文件。'
        : `对话导出未完成（HTTP ${response.status}）。`,
      response.status,
      'CONVERSATION_EXPORT_FAILED',
    );
  }
  if (
    !response.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('text/markdown')
  ) {
    await response.body?.cancel();
    current();
    throw new ApiError(
      '服务未返回 Markdown 文件，未生成下载。',
      502,
      'INVALID_EXPORT_RESPONSE',
    );
  }
  const blob = await response.blob();
  current();
  return blob;
}

export async function downloadConversationMarkdown(conversationId: string) {
  const id = idSchema.parse(conversationId),
    epoch = identityContextEpoch();
  const blob = await fetchConversationMarkdown(id);
  if (epoch !== identityContextEpoch())
    throw new ApiError(
      '当前身份已变化，未开始旧对话下载。',
      409,
      'IDENTITY_CONTEXT_CHANGED',
    );
  const url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = `aitesthub-conversation-${id}.md`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
