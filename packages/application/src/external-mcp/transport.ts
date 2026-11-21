import { lookup } from 'node:dns/promises';
import {
  request as httpRequest,
  STATUS_CODES,
  Agent as HttpAgent,
} from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { ExternalToolDefinition } from '../../../contracts/src/external-mcp.js';
import { DomainError } from '../errors.js';
import {
  boundedExternalJson,
  credentialAbsent,
  decodeExternalJson,
  externalDefinition,
  normalizedExternalEndpoint,
  publicAddress,
  SafeExternalSchemaValidator,
} from './safety.js';

export class ExternalMcpTransportError extends Error {
  constructor(
    readonly code:
      | 'EXTERNAL_UNAVAILABLE'
      | 'EXTERNAL_UNAUTHORIZED'
      | 'EXTERNAL_LIMIT'
      | 'EXTERNAL_PROTOCOL'
      | 'EXTERNAL_CANCELLED'
      | 'EXTERNAL_CREDENTIAL_BLOCKED',
    readonly dispatched: boolean,
  ) {
    super('外部MCP请求未取得可用的确定回执；请查询原调用，未自动重发。');
  }
}
export interface ExternalSessionOptions {
  endpoint: string;
  credential: string;
  protocolMode: 'auto' | 'modern' | 'legacy';
  principal: string;
  signal?: AbortSignal;
  allowedTestEndpoints?: readonly string[];
  beforeRequest: () => Promise<void>;
  beforeToolDispatch?: () => Promise<void>;
}
export interface ExternalMcpSession {
  tools: ExternalToolDefinition[];
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}
/** A new SDK session per user operation. No cookies, redirects, OAuth, retries or arbitrary egress. */
export async function withExternalMcpSession<T>(
  options: ExternalSessionOptions,
  work: (session: ExternalMcpSession) => Promise<T>,
): Promise<T> {
  if (options.protocolMode !== 'modern')
    throw new DomainError(
      'UNSUPPORTED_OPERATION',
      '请更新外部 MCP 服务到当前协议后再连接。',
      422,
    );
  const endpoint = normalizedExternalEndpoint(
      options.endpoint,
      options.allowedTestEndpoints,
    ),
    url = new URL(endpoint);
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)])
    : AbortSignal.timeout(30000);
  let dispatched = false,
    requests = 0;
  let fetchFailure: ExternalMcpTransportError | DomainError | undefined;
  const fail = (
    code: ConstructorParameters<typeof ExternalMcpTransportError>[0],
  ) => new ExternalMcpTransportError(code, dispatched);
  const fetcher: typeof fetch = async (input, init = {}) => {
    try {
      const target = new URL(
        input instanceof Request ? input.url : String(input),
      );
      if (target.href !== endpoint) throw fail('EXTERNAL_PROTOCOL');
      // Standalone server-push is deliberately unsupported; per-POST SSE is handled below.
      if (init.method === 'GET') return new Response(null, { status: 405 });
      if (
        init.method !== 'POST' ||
        typeof init.body !== 'string' ||
        ++requests > 16
      )
        throw fail('EXTERNAL_LIMIT');
      signal.throwIfAborted();
      await options.beforeRequest();
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        throw fail('EXTERNAL_PROTOCOL');
      }
      if (!message || typeof message !== 'object' || Array.isArray(message))
        throw fail('EXTERNAL_PROTOCOL');
      const allowedMethods = new Set([
        'server/discover',
        'initialize',
        'notifications/initialized',
        'tools/list',
        'tools/call',
        'notifications/cancelled',
      ]);
      if (
        typeof message.method === 'string' &&
        !allowedMethods.has(message.method)
      )
        throw fail('EXTERNAL_PROTOCOL');
      credentialAbsent(init.body, options.credential);
      const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), {
        all: true,
        verbatim: true,
      });
      const testEndpoint =
        options.allowedTestEndpoints?.includes(endpoint) ?? false;
      if (
        !addresses.length ||
        (!testEndpoint &&
          addresses.some((item) => !publicAddress(item.address)))
      )
        throw fail('EXTERNAL_PROTOCOL');
      const address = addresses[0]!;
      if (message.method === 'tools/call') {
        if (dispatched) throw fail('EXTERNAL_PROTOCOL');
        await options.beforeToolDispatch?.();
        // This is the durable send intent, immediately before the sole network attempt.
        dispatched = true;
      }
      const sourceHeaders = new Headers(init.headers),
        headers: Record<string, string> = {};
      for (const name of [
        'accept',
        'content-type',
        'mcp-session-id',
        'mcp-protocol-version',
        'mcp-client-info',
        'mcp-client-capabilities',
        'mcp-method',
        'mcp-name',
      ]) {
        const value = sourceHeaders.get(name);
        if (value !== null) headers[name] = value;
      }
      headers.authorization = `Bearer ${options.credential}`;
      headers['content-length'] = String(Buffer.byteLength(init.body));
      const requestSignal = init.signal
        ? AbortSignal.any([signal, init.signal])
        : signal;
      const agent =
        url.protocol === 'https:'
          ? new HttpsAgent({ keepAlive: false, proxyEnv: {} })
          : new HttpAgent({ keepAlive: false, proxyEnv: {} });
      return await new Promise<Response>((resolve, reject) => {
        let settled = false,
          total = 0,
          chunksSeen = 0;
        const chunks: Buffer[] = [];
        const stop = (error: unknown) => {
          if (settled) return;
          settled = true;
          request.destroy();
          reject(
            error instanceof ExternalMcpTransportError
              ? error
              : fail(
                  requestSignal.aborted
                    ? 'EXTERNAL_CANCELLED'
                    : 'EXTERNAL_UNAVAILABLE',
                ),
          );
        };
        const request = (
          url.protocol === 'https:' ? httpsRequest : httpRequest
        )(
          url,
          {
            method: 'POST',
            headers,
            agent,
            family: address.family,
            lookup: (_host, _lookupOptions, done) =>
              done(null, address.address, address.family),
            signal: requestSignal,
          },
          (response) => {
            const responseHeaders = new Headers();
            for (const name of [
              'content-type',
              'mcp-session-id',
              'mcp-protocol-version',
              'cache-control',
              'etag',
              'vary',
            ]) {
              const value = response.headers[name];
              if (typeof value === 'string') {
                try {
                  credentialAbsent(value, options.credential);
                } catch {
                  stop(fail('EXTERNAL_CREDENTIAL_BLOCKED'));
                  return;
                }
                responseHeaders.set(name, value);
              }
            }
            const status = response.statusCode ?? 502,
              media = (response.headers['content-type'] ?? '')
                .split(';')[0]
                ?.trim();
            const finish = (value: unknown | null) => {
              if (settled) return;
              try {
                credentialAbsent(
                  Buffer.concat(chunks).toString('utf8'),
                  options.credential,
                );
                const result =
                  value === null
                    ? null
                    : JSON.stringify(boundedExternalJson(value));
                if (result !== null)
                  responseHeaders.set('content-type', 'application/json');
                settled = true;
                resolve(
                  new Response(result, {
                    status,
                    statusText: STATUS_CODES[status] ?? '',
                    headers: responseHeaders,
                  }),
                );
                response.destroy();
              } catch {
                stop(fail('EXTERNAL_CREDENTIAL_BLOCKED'));
              }
            };
            const decoder = new TextDecoder('utf-8', { fatal: true });
            let lineParts: string[] = [],
              dataLines: string[] = [],
              wasCr = false;
            const line = (text: string) => {
              if (text === '') {
                if (!dataLines.length) return;
                const value = decodeExternalJson(
                  Buffer.from(dataLines.join('\n')),
                  options.credential,
                );
                dataLines = [];
                if (
                  value &&
                  typeof value === 'object' &&
                  !Array.isArray(value) &&
                  'id' in value &&
                  value.id === message.id &&
                  ('result' in value || 'error' in value)
                )
                  finish(value);
              } else if (text.startsWith('data:'))
                dataLines.push(text.slice(5).replace(/^ /, ''));
            };
            response.on('data', (chunk: Buffer) => {
              if (settled) return;
              total += chunk.length;
              if (total > 1024 * 1024 || ++chunksSeen > 4096) {
                stop(fail('EXTERNAL_LIMIT'));
                return;
              }
              chunks.push(chunk);
              if (
                media !== 'text/event-stream' ||
                status < 200 ||
                status >= 300
              )
                return;
              try {
                const text = decoder.decode(chunk, { stream: true });
                let start = 0;
                for (let index = 0; index < text.length && !settled; index++) {
                  const char = text[index];
                  if (wasCr) {
                    wasCr = false;
                    if (char === '\n') {
                      start = index + 1;
                      continue;
                    }
                  }
                  if (char === '\r' || char === '\n') {
                    lineParts.push(text.slice(start, index));
                    line(lineParts.join(''));
                    lineParts = [];
                    start = index + 1;
                    wasCr = char === '\r';
                  }
                }
                if (start < text.length && !settled)
                  lineParts.push(text.slice(start));
              } catch {
                stop(fail('EXTERNAL_CREDENTIAL_BLOCKED'));
              }
            });
            response.on('end', () => {
              if (settled) return;
              try {
                if (status === 401 || status === 403) {
                  stop(fail('EXTERNAL_UNAUTHORIZED'));
                  return;
                }
                if (status === 202 || status === 204) {
                  finish(null);
                  return;
                }
                if (status >= 300 && status !== 400) {
                  finish(null);
                  return;
                }
                if (media === 'application/json') {
                  finish(
                    decodeExternalJson(
                      Buffer.concat(chunks),
                      options.credential,
                    ),
                  );
                  return;
                }
                if (media === 'text/event-stream') {
                  decoder.decode();
                  if (lineParts.length) line(lineParts.join(''));
                  line('');
                  if (settled) return;
                }
                stop(fail('EXTERNAL_PROTOCOL'));
              } catch {
                stop(fail('EXTERNAL_CREDENTIAL_BLOCKED'));
              }
            });
            response.on('error', () =>
              stop(
                fail(
                  requestSignal.aborted
                    ? 'EXTERNAL_CANCELLED'
                    : 'EXTERNAL_UNAVAILABLE',
                ),
              ),
            );
            response.on('aborted', () => stop(fail('EXTERNAL_UNAVAILABLE')));
          },
        );
        request.setTimeout(15000, () => stop(fail('EXTERNAL_UNAVAILABLE')));
        request.once('close', () => agent.destroy());
        request.on('error', () =>
          stop(
            fail(
              requestSignal.aborted
                ? 'EXTERNAL_CANCELLED'
                : 'EXTERNAL_UNAVAILABLE',
            ),
          ),
        );
        request.end(init.body);
      });
    } catch (error) {
      if (
        error instanceof ExternalMcpTransportError ||
        error instanceof DomainError
      )
        fetchFailure = error;
      throw error;
    }
  };
  const client = new Client(
    { name: 'aitesthub-restricted-external-client', version: '0.1.0' },
    {
      capabilities: {},
      cachePartition: options.principal,
      listMaxPages: 4,
      jsonSchemaValidator: new SafeExternalSchemaValidator(),
      versionNegotiation: {
        mode: { pin: '2026-07-28' },
        probe: { maxRetries: 0, timeoutMs: 10000 },
      },
      inputRequired: { autoFulfill: false, maxRounds: 0 },
    },
  );
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: fetcher,
    requestInit: { redirect: 'error' },
    authProvider: { token: async () => options.credential },
    onInsufficientScope: 'throw',
    maxStepUpRetries: 0,
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
  });
  try {
    await client.connect(transport, { signal, timeout: 10000 });
    const listed = await client.listTools(undefined, {
      signal,
      timeout: 10000,
    });
    if (listed.tools.length > 128) throw fail('EXTERNAL_LIMIT');
    const tools = listed.tools
      .map(externalDefinition)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (new Set(tools.map((tool) => tool.name)).size !== tools.length)
      throw fail('EXTERNAL_PROTOCOL');
    return await work({
      tools,
      call: async (name, args) => {
        const tool = listed.tools.find((item) => item.name === name);
        if (!tool) throw fail('EXTERNAL_PROTOCOL');
        const result = await client.callTool(
          { name, arguments: args },
          { signal, timeout: 30000, toolDefinition: tool },
        );
        boundedExternalJson(result);
        credentialAbsent(result, options.credential);
        return result;
      },
    });
  } catch (error) {
    if (error instanceof ExternalMcpTransportError) throw error;
    if (error instanceof DomainError) throw error;
    if (fetchFailure) throw fetchFailure;
    if (signal.aborted) throw fail('EXTERNAL_CANCELLED');
    throw fail('EXTERNAL_UNAVAILABLE');
  } finally {
    await client.close().catch(() => {});
  }
}
