import { ApiError, describeError } from './api';

export function describeModelDiscoveryError(error: unknown): string {
  if (!(error instanceof ApiError) || error.code !== 'DEPENDENCY_UNAVAILABLE')
    return describeError(error);
  const status = error.details?.upstreamHttpStatus;
  const request = error.requestId ? `（请求 ${error.requestId}）` : '';
  if (status === 404)
    return `模型列表端点返回 404，请检查服务地址及列表端点，或手工添加模型。${request}`;
  if (status === 401 || status === 403)
    return `模型列表服务拒绝认证或访问（HTTP ${status}），请检查此服务的 Key 和权限；平台登录仍有效。${request}`;
  if (typeof status === 'number' && (status >= 500 || status === 429))
    return `模型列表服务暂时不可用（HTTP ${status}），可稍后重试或手工添加模型。${request}`;
  return describeError(error);
}
