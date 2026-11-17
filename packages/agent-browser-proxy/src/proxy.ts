import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import {
  createServer,
  request as httpRequest,
  Agent,
  type OutgoingHttpHeaders,
} from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { z } from 'zod';
import { browserPublicAddress } from './address.js';

const equal = (a: string, b: string) =>
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const registrationSchema = z.strictObject({ sessionId: z.uuid() });
interface ProxySession {
  password: string;
  expiresAt: number;
}
export interface BrowserProxyControlPort {
  register(
    sessionId: string,
  ): Promise<{ server: string; username: string; password: string }>;
  remove(sessionId: string): Promise<void>;
}
export function createBrowserEgressProxy(options: {
  adminToken: string;
  advertisedOrigin: string;
  allowedPrivateOrigins?: readonly string[];
  forbiddenOrigins?: readonly string[];
  resolve?: typeof lookup;
}) {
  if (options.adminToken.length < 32)
    throw new Error('BROWSER_PROXY_CONFIG_INVALID');
  const privateOrigins = new Set(
    (options.allowedPrivateOrigins ?? []).map((value) => new URL(value).origin),
  );
  const forbiddenOrigins = (options.forbiddenOrigins ?? []).map(
    (value) => new URL(value),
  );
  const sessions = new Map<string, ProxySession>();
  const sockets = new Set<Duplex>();
  const authenticated = (header: string | undefined) => {
    if (!header?.startsWith('Basic ')) return null;
    let decoded: string;
    try {
      decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    } catch {
      return null;
    }
    const colon = decoded.indexOf(':');
    const id = decoded.slice(0, colon),
      password = decoded.slice(colon + 1);
    const session = sessions.get(id);
    return session &&
      session.expiresAt > Date.now() &&
      equal(session.password, password)
      ? id
      : null;
  };
  const resolveTarget = async (raw: string) => {
    const url = new URL(raw);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error('BROWSER_PROXY_TARGET_BLOCKED');
    const privateAllowed = privateOrigins.has(url.origin);
    if (
      !privateAllowed &&
      url.port &&
      !(
        (url.protocol === 'http:' && url.port === '80') ||
        (url.protocol === 'https:' && url.port === '443')
      )
    )
      throw new Error('BROWSER_PROXY_TARGET_BLOCKED');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (
      !privateAllowed &&
      (/^(?:localhost)$/i.test(host) ||
        /(?:^|\.)(?:local|internal|corp|lan|home|invalid|test)$/i.test(host))
    )
      throw new Error('BROWSER_PROXY_TARGET_BLOCKED');
    const addresses = await (options.resolve ?? lookup)(host, {
      all: true,
      verbatim: true,
    });
    if (
      !addresses.length ||
      (!privateAllowed &&
        addresses.some((entry) => !browserPublicAddress(entry.address)))
    )
      throw new Error('BROWSER_PROXY_TARGET_BLOCKED');
    const address = addresses[0];
    if (!address) throw new Error('BROWSER_PROXY_TARGET_BLOCKED');
    if (
      addresses.some(
        (item) =>
          item.address === '0.0.0.0' ||
          item.address === '::' ||
          item.address === 'fd00:ec2::254' ||
          /^169\.254\./.test(item.address) ||
          /^fe[89ab][a-f0-9]:/i.test(item.address),
      )
    )
      throw new Error('BROWSER_PROXY_TARGET_BLOCKED');
    const port = Number(url.port || (url.protocol === 'https:' ? '443' : '80'));
    for (const forbidden of forbiddenOrigins) {
      const deniedPort = Number(
        forbidden.port || (forbidden.protocol === 'https:' ? '443' : '80'),
      );
      if (deniedPort !== port) continue;
      const denied = await (options.resolve ?? lookup)(
        forbidden.hostname.replace(/^\[|\]$/g, ''),
        { all: true, verbatim: true },
      );
      if (
        forbidden.origin === url.origin ||
        addresses.some((item) =>
          denied.some((blocked) => blocked.address === item.address),
        )
      )
        throw new Error('BROWSER_PROXY_TARGET_BLOCKED');
    }
    return { url, address };
  };
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith('/sessions/')) {
      if (
        !equal(
          request.headers.authorization ?? '',
          `Bearer ${options.adminToken}`,
        )
      ) {
        response.writeHead(401).end();
        return;
      }
      const id = request.url.slice('/sessions/'.length);
      if (!z.uuid().safeParse(id).success) {
        response.writeHead(400).end();
        return;
      }
      if (request.method === 'DELETE') {
        sessions.delete(id);
        response.writeHead(204).end();
        return;
      }
      if (
        request.method !== 'PUT' ||
        (sessions.size >= 16 && !sessions.has(id))
      ) {
        response.writeHead(409).end();
        return;
      }
      registrationSchema.parse({ sessionId: id });
      const existing = sessions.get(id);
      const session = existing ?? {
        password: randomBytes(32).toString('hex'),
        expiresAt: Date.now() + 30 * 60_000,
      };
      sessions.set(id, session);
      response.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      response.end(
        JSON.stringify({
          server: options.advertisedOrigin,
          username: id,
          password: session.password,
        }),
      );
      return;
    }
    if (!authenticated(request.headers['proxy-authorization'])) {
      response
        .writeHead(407, {
          'proxy-authenticate': 'Basic realm="browser-egress"',
        })
        .end();
      return;
    }
    try {
      const { url, address } = await resolveTarget(request.url ?? '');
      if (url.protocol !== 'http:')
        throw new Error('BROWSER_PROXY_TARGET_BLOCKED');
      const headers: OutgoingHttpHeaders = {
        ...request.headers,
        host: url.host,
      };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];
      const upstream = httpRequest(
        url,
        {
          method: request.method,
          headers,
          agent: new Agent({ keepAlive: false, proxyEnv: {} }),
          family: address.family,
          lookup: (_host, _options, done) =>
            done(null, address.address, address.family),
          timeout: 20_000,
        },
        (incoming) => {
          response.writeHead(incoming.statusCode ?? 502, incoming.headers);
          incoming.pipe(response);
        },
      );
      upstream.once('timeout', () => upstream.destroy());
      upstream.once('error', () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      request.once('aborted', () => upstream.destroy());
      request.pipe(upstream);
    } catch {
      response.writeHead(403).end();
    }
  });
  server.on('connect', async (request, socket, head) => {
    if (!authenticated(request.headers['proxy-authorization'])) {
      socket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="browser-egress"\r\n\r\n',
      );
      return;
    }
    try {
      const { url, address } = await resolveTarget(
        `https://${request.url ?? ''}`,
      );
      const upstream = connect({
        host: address.address,
        port: Number(url.port || '443'),
        family: address.family,
      });
      sockets.add(upstream);
      sockets.add(socket);
      upstream.setTimeout(30_000, () => upstream.destroy());
      upstream.once('connect', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      upstream.once('error', () => socket.destroy());
      socket.once('error', () => upstream.destroy());
      socket.once('close', () => {
        upstream.destroy();
        sockets.delete(socket);
      });
      upstream.once('close', () => {
        socket.destroy();
        sockets.delete(upstream);
      });
    } catch {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    }
  });
  server.on('upgrade', (_request, socket) =>
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'),
  );
  return {
    server,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      sessions.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export class BrowserProxyClient implements BrowserProxyControlPort {
  constructor(
    readonly controlOrigin: string,
    readonly token: string,
  ) {}
  async register(sessionId: string) {
    const response = await fetch(
      `${this.controlOrigin}/sessions/${z.uuid().parse(sessionId)}`,
      {
        method: 'PUT',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${this.token}` },
      },
    );
    if (!response.ok) throw new Error('BROWSER_PROXY_REGISTRATION_FAILED');
    return z
      .strictObject({
        server: z.url(),
        username: z.uuid(),
        password: z.string().length(64),
      })
      .parse(await response.json());
  }
  async remove(sessionId: string) {
    const response = await fetch(
      `${this.controlOrigin}/sessions/${z.uuid().parse(sessionId)}`,
      {
        method: 'DELETE',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${this.token}` },
      },
    );
    if (!response.ok) throw new Error('BROWSER_PROXY_CLEANUP_UNKNOWN');
  }
}
