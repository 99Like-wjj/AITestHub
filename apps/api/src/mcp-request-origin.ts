import { DomainError } from '../../../packages/application/src/errors.js';

type RequestHeaders = {
  get(name: string): string | undefined;
  rawHeaders?: readonly string[];
};
type Authority = { hostname: string; port: number | null };
type ParsedOrigin = {
  origin: string;
  authority: Authority;
  protocol: 'http:' | 'https:';
};
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Parse an authority, never a URL supplied in Host or a forwarded-host hint. */
function authority(value: string): Authority {
  const match = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::([0-9]+))?$/i.exec(value);
  if (!match?.[1]) throw new Error('Invalid authority');
  const rawHostname = match[1].toLowerCase(),
    parsed = new URL(`http://${value}`),
    port = match[2] === undefined ? null : Number(match[2]);
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535))
    throw new Error('Invalid port');
  if (!rawHostname.startsWith('[')) {
    // Reject URL-parser aliases such as 127.1, decimal/hex IPv4 and trailing-dot hosts.
    if (
      rawHostname.length > 253 ||
      parsed.hostname !== rawHostname ||
      !rawHostname
        .split('.')
        .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
    )
      throw new Error('Invalid hostname');
  }
  return { hostname: parsed.hostname, port };
}

function parseOrigin(value: string, configured = false): ParsedOrigin {
  // Only the configuration may spell an otherwise empty root as a final slash.
  const match = (
    configured ? /^(https?):\/\/([^/?#]+)\/?$/i : /^(https?):\/\/([^/?#]+)$/i
  ).exec(value);
  if (!match?.[1] || !match[2]) throw new Error('Invalid origin');
  const protocol = match[1].toLowerCase() === 'https' ? 'https:' : 'http:',
    host = authority(match[2]),
    defaultPort = protocol === 'https:' ? 443 : 80;
  return {
    protocol,
    authority: host,
    origin: `${protocol}//${host.hostname}${host.port === null || host.port === defaultPort ? '' : `:${host.port}`}`,
  };
}

function header(
  req: RequestHeaders,
  name: 'host' | 'origin',
): string | undefined {
  let count = 0;
  for (let i = 0; i < (req.rawHeaders?.length ?? 0); i += 2)
    if (req.rawHeaders?.[i]?.toLowerCase() === name) count++;
  if (count > 1) throw new Error('Multiple header fields');
  const value = req.get(name);
  if (value !== undefined && typeof value !== 'string')
    throw new Error('Invalid header');
  return value;
}

/** A mount-time trusted allowlist. It does not authenticate a Key or change Web CSRF. */
export function createMcpRequestValidator(
  publicOrigin?: string,
): (req: RequestHeaders) => void {
  let configured: ParsedOrigin | undefined;
  if (publicOrigin !== undefined) {
    try {
      configured = parseOrigin(publicOrigin, true);
      if (
        !loopbackHosts.has(configured.authority.hostname) &&
        configured.protocol !== 'https:'
      )
        throw new Error('Public origin requires HTTPS');
    } catch {
      // Do not echo the configuration: malformed input could contain credentials.
      throw new Error(
        'Invalid AITESTHUB_PUBLIC_ORIGIN: expected an HTTP(S) loopback or HTTPS public origin without credentials, path, query or fragment.',
      );
    }
  }
  return (req) => {
    try {
      const hostValue = header(req, 'host');
      if (hostValue === undefined) throw new Error('Host required');
      const host = authority(hostValue);
      if (
        !loopbackHosts.has(host.hostname) &&
        (!configured ||
          host.hostname !== configured.authority.hostname ||
          (host.port ?? (configured.protocol === 'https:' ? 443 : 80)) !==
            (configured.authority.port ??
              (configured.protocol === 'https:' ? 443 : 80)))
      )
        throw new Error('Host not allowed');
    } catch {
      throw new DomainError('FORBIDDEN', 'MCP入口不接受此主机。', 403);
    }
    try {
      const originValue = header(req, 'origin');
      if (originValue === undefined) return; // Non-browser SDK requests do not need Origin.
      const origin = parseOrigin(originValue);
      if (
        !loopbackHosts.has(origin.authority.hostname) &&
        origin.origin !== configured?.origin
      )
        throw new Error('Origin not allowed');
    } catch {
      throw new DomainError('FORBIDDEN', 'MCP入口不接受此来源。', 403);
    }
  };
}
