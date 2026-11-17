import { lookup } from 'node:dns/promises';
import { request as httpRequest, Agent as HttpAgent } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { safePublicSourceUrl } from '../external-mcp/public-search.js';
import { publicAddress } from '../external-mcp/safety.js';
import { DomainError } from '../errors.js';

export interface PublicHttpResponse {
  url: string;
  status: number;
  mediaType: string;
  body: Buffer;
  redirects: string[];
}
const rejected = () =>
  new DomainError(
    'FORBIDDEN',
    '只可读取无凭据的公开HTTP/HTTPS网页，禁止私网、非常规端口及不安全跳转。',
    403,
  );

/** Resolves every hop once and pins its IP; redirects cannot rebind to a private host. */
export async function readPublicHttp(
  input: string,
  signal?: AbortSignal,
  dependencies: {
    resolve?: typeof lookup;
    maxBytes?: number;
    timeoutMs?: number;
  } = {},
): Promise<PublicHttpResponse> {
  const active = AbortSignal.any([
    AbortSignal.timeout(dependencies.timeoutMs ?? 20_000),
    ...(signal ? [signal] : []),
  ]);
  const redirects: string[] = [];
  let target = input;
  for (let hop = 0; hop <= 5; hop++) {
    const safe = safePublicSourceUrl(target);
    if (!safe) throw rejected();
    const url = new URL(safe);
    if (
      url.port &&
      !(
        (url.protocol === 'https:' && url.port === '443') ||
        (url.protocol === 'http:' && url.port === '80')
      )
    )
      throw rejected();
    url.hash = '';
    const addresses = await (dependencies.resolve ?? lookup)(
      url.hostname.replace(/^\[|\]$/g, ''),
      { all: true, verbatim: true },
    );
    if (
      !addresses.length ||
      addresses.some((address) => !publicAddress(address.address))
    )
      throw rejected();
    const address = addresses[0];
    if (!address) throw rejected();
    active.throwIfAborted();
    const response = await new Promise<{
      status: number;
      location?: string;
      mediaType: string;
      body: Buffer;
    }>((resolve, reject) => {
      const agent =
        url.protocol === 'https:'
          ? new HttpsAgent({ keepAlive: false, proxyEnv: {} })
          : new HttpAgent({ keepAlive: false, proxyEnv: {} });
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        url,
        {
          method: 'GET',
          agent,
          signal: active,
          family: address.family,
          lookup: (_host, _options, done) =>
            done(null, address.address, address.family),
          headers: {
            'user-agent': 'AITestHub/0.1.2 (public source reader)',
            accept:
              'text/html,application/xhtml+xml,text/plain,application/json;q=0.8',
            'accept-encoding': 'identity',
          },
        },
        (incoming) => {
          const status = incoming.statusCode ?? 502;
          if ([301, 302, 303, 307, 308].includes(status)) {
            incoming.resume();
            resolve({
              status,
              ...(incoming.headers.location
                ? { location: incoming.headers.location }
                : {}),
              mediaType: '',
              body: Buffer.alloc(0),
            });
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          incoming.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > (dependencies.maxBytes ?? 2 * 1024 * 1024)) {
              request.destroy(
                new DomainError(
                  'PRECONDITIONS_MISSING',
                  '网页超过读取大小限制，未声称完整读取。',
                  422,
                ),
              );
            } else chunks.push(chunk);
          });
          incoming.once('error', reject);
          incoming.once('end', () =>
            resolve({
              status,
              mediaType: incoming.headers['content-type'] ?? '',
              body: Buffer.concat(chunks),
            }),
          );
        },
      );
      request.once('error', reject);
      request.once('close', () => agent.destroy());
      request.end();
    });
    if (response.location) {
      if (hop === 5)
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '网页跳转次数超过限制。',
          422,
        );
      redirects.push(url.href);
      target = new URL(response.location, url).href;
      continue;
    }
    return {
      url: url.href,
      status: response.status,
      mediaType: response.mediaType,
      body: response.body,
      redirects,
    };
  }
  throw rejected();
}
