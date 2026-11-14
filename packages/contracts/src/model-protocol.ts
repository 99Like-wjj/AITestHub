import { z } from 'zod';

/** Wire format, not a supplier brand or a claim of tested model capability. */
export const modelProtocolSchema = z.enum([
  'chatCompletions',
  'responses',
  'anthropicMessages',
]);
export type ModelProtocol = z.infer<typeof modelProtocolSchema>;
export const modelAuthSchemeSchema = z.enum(['bearer', 'xApiKey']);
export type ModelAuthScheme = z.infer<typeof modelAuthSchemeSchema>;
export function defaultModelAuthScheme(
  protocol: ModelProtocol,
): ModelAuthScheme {
  return protocol === 'anthropicMessages' ? 'xApiKey' : 'bearer';
}

/** A service base or known protocol endpoint; never embedded authentication, query or fragment. */
export const modelBaseUrlSchema = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return (
      (url.protocol === 'https:' || (local && url.protocol === 'http:')) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }, '使用HTTPS服务地址；仅本机loopback允许HTTP，不接受内嵌凭据、查询或片段。');

export const modelProtocolEndpointPaths: Readonly<Record<ModelProtocol, string>> = {
  chatCompletions: '/chat/completions',
  responses: '/responses',
  anthropicMessages: '/messages',
};
export function modelEndpointPathProtocol(pathname: string): ModelProtocol | 'models' | null {
  const path = pathname.replace(/\/+$/, '');
  if (path.endsWith('/models')) return 'models';
  for (const protocol of modelProtocolSchema.options) {
    if (path.endsWith(modelProtocolEndpointPaths[protocol])) return protocol;
  }
  return null;
}
/** Input guidance only. Stored service DTOs and immutable message snapshots retain their original URL. */
export function modelEndpointConfigurationIssue(baseUrl: string, protocol: ModelProtocol): string | null {
  const valid = modelBaseUrlSchema.safeParse(baseUrl);
  if (!valid.success) return null; // The URL schema reports its own structural/security error.
  const supplied = modelEndpointPathProtocol(new URL(valid.data).pathname);
  if (supplied === 'models') return '这是模型列表地址，请填写服务基础地址或所选协议的推理终点；模型发现会单独读取 /models。';
  if (supplied && supplied !== protocol) return `地址结尾 ${modelProtocolEndpointPaths[supplied]} 与所选接口协议不一致；请更正协议，或填写对应服务基础地址/终点。`;
  return null;
}
/** Static relationship only; it is not a count of prompt tokens or a full context-window guarantee. */
export function modelOutputContextIssue(outputBudget: number | null, contextLimit: number | null): string | null {
  return outputBudget !== null && contextLimit !== null && outputBudget >= contextLimit
    ? '输出预算必须小于已配置的上下文上限；仍需为输入资料及工具上下文留出空间，请核对这两个配置。'
    : null;
}
