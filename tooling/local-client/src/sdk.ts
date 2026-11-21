import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  InsufficientScopeError,
} from '@modelcontextprotocol/client';
import type { ToolPort } from './ports.js';
import { LocalClientError, localFailure } from './errors.js';
import { assertSafe, assertMcpArgumentBudget } from './safety.js';
import {
  contractProtocolVersion,
  contractVersion,
  validateToolInput,
} from './contracts.js';
import { platformOrigin } from './workspace.js';

/** Trusted host connects this SDK instance to its configured authenticated transport. */
export function createSafeSdkClient(): Client {
  return new Client(
    { name: 'AITestHub local shared client', version: contractVersion },
    {
      versionNegotiation: {
        mode: { pin: contractProtocolVersion },
        probe: { maxRetries: 0 },
      },
      inputRequired: { autoFulfill: false },
      capabilities: {},
    },
  );
}
/** Fixed-origin SDK transport; no OAuth refresh, auth fallback, redirect or reconnect retry. */
export function createSafeHttpTransport(
  origin: string,
  getBearerToken: () => Promise<string>,
  fetcher?: typeof fetch,
): StreamableHTTPClientTransport {
  const normalized = platformOrigin(origin);
  return new StreamableHTTPClientTransport(new URL('/mcp', normalized), {
    authProvider: {
      token: async () => {
        platformOrigin(normalized);
        let value: string;
        try {
          value = await getBearerToken();
        } catch {
          throw localFailure(
            'CREDENTIALS_UNAVAILABLE',
            '可信host没有可用凭据。',
          );
        }
        if (
          typeof value !== 'string' ||
          !value ||
          value.length > 505 ||
          /[\s\x00-\x1f\x7f]/.test(value)
        )
          throw localFailure(
            'CREDENTIALS_UNAVAILABLE',
            '可信host凭据格式无效。',
          );
        return value;
      },
    },
    requestInit: { redirect: 'error', credentials: 'omit', cache: 'no-store' },
    onInsufficientScope: 'throw',
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
    ...(fetcher ? { fetch: fetcher } : {}),
  });
}
export interface SdkRequestOnce {
  request(
    request: {
      method: 'tools/call';
      params: { name: string; arguments: Record<string, unknown> };
    },
    options?: { timeout?: number },
  ): Promise<unknown>;
}
export function createSdkToolPort(
  client: SdkRequestOnce,
  requestTimeoutMs = 60_000,
): ToolPort {
  if (
    !Number.isInteger(requestTimeoutMs) ||
    requestTimeoutMs < 100 ||
    requestTimeoutMs > 600_000
  )
    throw localFailure(
      'INVALID_HOST_CONFIG',
      '请求超时必须由可信host合理配置。',
    );
  return {
    async callTool(name, args) {
      if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
        throw localFailure('UNSAFE_TLS', 'TLS校验被关闭；客户端拒绝发送。');
      assertSafe(args);
      assertMcpArgumentBudget(args);
      validateToolInput(name, args);
      let result: unknown;
      try {
        // Do not use SDK callTool: its header-mismatch path may evict/refetch/retry a CUD.
        // request emits one tools/call; no generic reconnect/retry or input auto-accept here.
        result = await client.request(
          {
            method: 'tools/call',
            params: { name, arguments: structuredClone(args) },
          },
          { timeout: requestTimeoutMs },
        );
      } catch (error) {
        if (error instanceof UnauthorizedError)
          throw new LocalClientError(
            'UNAUTHENTICATED',
            'knownFailed',
            '当前凭据未通过平台鉴权；不刷新或切换Key重试。',
          );
        if (error instanceof InsufficientScopeError)
          throw new LocalClientError(
            'FORBIDDEN',
            'knownFailed',
            '当前凭据权限不足；不自动扩大范围。',
          );
        throw new LocalClientError(
          'SDK_OUTCOME_UNKNOWN',
          'unknown',
          'SDK请求未取得可靠回执；请查询原操作，不自动重发。',
        );
      }
      try {
        assertSafe(result);
      } catch {
        throw new LocalClientError(
          'UNSAFE_TOOL_RECEIPT',
          'unknown',
          '工具回执含不安全或无法确认内容；请查询原操作。',
        );
      }
      return result;
    },
  };
}
