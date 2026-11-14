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

/** The saved base URL has no embedded authentication or endpoint override. */
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
  }, '使用HTTPS服务根地址；仅本机loopback允许HTTP，不接受内嵌凭据、查询或片段。');
