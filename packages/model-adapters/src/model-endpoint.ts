import {
  modelBaseUrlSchema,
  modelProtocolSchema,
  modelProtocolEndpointPaths,
  modelEndpointPathProtocol,
  modelEndpointConfigurationIssue,
  type ModelProtocol,
} from '../../contracts/src/model-protocol.js';

/** Pure path compatibility. The caller retains its trusted-loopback, redirect and dispatch guards. */
export function resolveModelEndpoint(
  baseUrl: string,
  protocol: ModelProtocol,
  purpose: 'inference' | 'models' = 'inference',
): URL {
  const base = modelBaseUrlSchema.safeParse(baseUrl);
  if (!base.success || !modelProtocolSchema.safeParse(protocol).success)
    throw new Error('模型地址或接口协议无效。');
  const endpoint = new URL(base.data),
    origin = endpoint.origin;
  const supplied = modelEndpointPathProtocol(endpoint.pathname);
  const issue = modelEndpointConfigurationIssue(base.data, protocol);
  if (issue && !(purpose === 'models' && supplied === 'models'))
    throw new Error(issue);
  const path = endpoint.pathname.replace(/\/+$/, '');
  if (purpose === 'models') {
    const root =
      supplied && supplied !== 'models'
        ? path.slice(0, -modelProtocolEndpointPaths[supplied].length)
        : path;
    endpoint.pathname = supplied === 'models' ? path : `${root}/models`;
  } else
    endpoint.pathname =
      supplied === protocol
        ? path
        : `${path}${modelProtocolEndpointPaths[protocol]}`;
  if (
    endpoint.origin !== origin ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error('模型地址必须保持原服务来源且不能包含认证、查询或片段。');
  return endpoint;
}
