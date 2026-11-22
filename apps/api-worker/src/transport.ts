import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { z } from 'zod';
import type {
  JsonValue,
  WorkerTransport,
} from '../../../packages/contracts/src/api-execution.js';
import { encodeMultipart, type MultipartFileLoader } from './multipart-body.js';

export interface RawTransportResponse {
  status: number | null;
  headers: Record<string, string>;
  body: JsonValue;
  elapsedMs: number;
  receivedBytes?: number;
  errorCode: string | null;
  sideEffectCertainty: 'known' | 'unknown';
}
function captureBody(bytes: Buffer): JsonValue {
  const text = bytes.toString('utf8');
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return text;
  }
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop();
    if (!item) break;
    if (++nodes > 50000 || item.depth > 40)
      throw new Error('RESPONSE_COMPLEXITY_LIMIT');
    if (item.value && typeof item.value === 'object')
      for (const child of Object.values(item.value))
        pending.push({ value: child, depth: item.depth + 1 });
  }
  return z.json().parse(value);
}
/** Exactly one ClientRequest, fresh connection, no redirect following or implicit retry. */
async function requestHttp(
  transport: Extract<WorkerTransport, { type: 'http' }>,
  signal?: AbortSignal,
  loadMultipartFile?: MultipartFileLoader,
): Promise<RawTransportResponse> {
  const started = performance.now();
  const notSent = (errorCode: string): RawTransportResponse => ({
    status: null,
    headers: {},
    body: { dispatchCertainty: 'notDispatched' },
    elapsedMs: Math.max(0, Math.round(performance.now() - started)),
    errorCode,
    sideEffectCertainty: 'known',
  });
  let body =
    transport.body === null ? null : Buffer.from(transport.body, 'utf8');
  let multipartContentType: string | undefined;
  if (transport.multipart) {
    if (
      body !== null ||
      ['GET', 'HEAD'].includes(transport.method.toUpperCase()) ||
      Object.keys(transport.headers).some(
        (name) => name.toLowerCase() === 'content-type',
      )
    )
      return notSent('REQUEST_NOT_DISPATCHED_HEADER_CONFLICT');
    try {
      const encoded = await encodeMultipart(
        transport.multipart,
        loadMultipartFile,
        signal,
      );
      body = encoded.body;
      multipartContentType = encoded.contentType;
    } catch {
      return notSent(
        signal?.aborted
          ? 'REQUEST_NOT_DISPATCHED_INTERRUPTED'
          : 'REQUEST_NOT_DISPATCHED_FILE_UNAVAILABLE',
      );
    }
  }
  const length = body?.length ?? 0;
  const suppliedLengths = Object.entries(transport.headers).filter(
    ([name]) => name.toLowerCase() === 'content-length',
  );
  if (
    suppliedLengths.length > 1 ||
    suppliedLengths.some(([, value]) => value !== String(length)) ||
    Object.keys(transport.headers).some(
      (name) => name.toLowerCase() === 'transfer-encoding',
    )
  ) {
    // The control plane already rejects these DSL headers. Refuse an inconsistent
    // transport envelope before creating a ClientRequest; no permit is replayed.
    return notSent('REQUEST_NOT_DISPATCHED_HEADER_CONFLICT');
  }
  const headers = Object.fromEntries(
    Object.entries(transport.headers).filter(
      ([name]) => name.toLowerCase() !== 'content-length',
    ),
  );
  // Node does not enable chunked bodies automatically for DELETE. Frame the
  // actual encoded bytes for every non-null body, including an empty string.
  if (body !== null) headers['content-length'] = String(length);
  if (multipartContentType) headers['content-type'] = multipartContentType;
  return new Promise((resolve) => {
    let finished = false;
    const settle = (response: Omit<RawTransportResponse, 'elapsedMs'>) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      resolve({
        ...response,
        elapsedMs: Math.max(0, Math.round(performance.now() - started)),
      });
    };
    const failure = (code: string) =>
      settle({
        status: null,
        headers: {},
        body: '[response unavailable]',
        errorCode: code,
        sideEffectCertainty: 'unknown',
      });
    const url = new URL(transport.url);
    const requester = url.protocol === 'https:' ? https : http;
    const request = requester.request(
      url,
      { method: transport.method, headers, agent: false },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(response.headers))
          if (value !== undefined)
            headers[name] = Array.isArray(value) ? value.join(', ') : value;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 512 * 1024) {
            request.destroy();
            failure('RESPONSE_TOO_LARGE');
          } else chunks.push(chunk);
        });
        response.on('error', () => failure('RESPONSE_INTERRUPTED'));
        response.on('end', () => {
          try {
            settle({
              status: response.statusCode ?? null,
              headers,
              body: captureBody(Buffer.concat(chunks)),
              receivedBytes: size,
              errorCode: null,
              sideEffectCertainty: 'known',
            });
          } catch {
            failure('RESPONSE_COMPLEXITY_LIMIT');
          }
        });
      },
    );
    const cancel = () => {
      request.destroy();
      failure('REQUEST_INTERRUPTED');
    };
    const timer = setTimeout(() => {
      request.destroy();
      failure('REQUEST_TIMEOUT');
    }, transport.timeoutMs);
    request.once('error', () => failure('REQUEST_TRANSPORT_ERROR'));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) {
      cancel();
      return;
    }
    if (body !== null) request.end(body);
    else request.end();
  });
}
async function requestSql(
  transport: Extract<WorkerTransport, { type: 'sql' }>,
): Promise<RawTransportResponse> {
  const started = performance.now();
  try {
    if (transport.driver === 'postgresql') {
      const client = new pg.Client({
        host: transport.host,
        port: transport.port,
        database: transport.database,
        user: transport.username,
        password: transport.password,
        ssl: transport.tls ? { rejectUnauthorized: true } : false,
        connectionTimeoutMillis: 5000,
        query_timeout: transport.timeoutMs,
        statement_timeout: transport.timeoutMs,
      });
      try {
        await client.connect();
        const result = await client.query(
          transport.statement,
          transport.values,
        );
        return {
          status: null,
          headers: {},
          body: { affectedRows: result.rowCount ?? 0 },
          elapsedMs: Math.round(performance.now() - started),
          errorCode: null,
          sideEffectCertainty: 'known',
        };
      } finally {
        await client.end().catch(() => {});
      }
    }
    const connection = await mysql.createConnection({
      host: transport.host,
      port: transport.port,
      database: transport.database,
      user: transport.username,
      password: transport.password,
      ...(transport.tls ? { ssl: { rejectUnauthorized: true } } : {}),
      connectTimeout: 5000,
      multipleStatements: false,
      enableKeepAlive: false,
    });
    let completed = false;
    try {
      const [result] = await connection.execute<mysql.ResultSetHeader>(
        { sql: transport.statement, timeout: transport.timeoutMs },
        transport.values,
      );
      completed = true;
      return {
        status: null,
        headers: {},
        body: { affectedRows: result.affectedRows },
        elapsedMs: Math.round(performance.now() - started),
        errorCode: null,
        sideEffectCertainty: 'known',
      };
    } finally {
      // A client timeout does not prove that the server stopped the DELETE. Do not wait for a queued QUIT
      // behind the still-running statement, and never reconnect/replay it.
      if (completed) await connection.end().catch(() => {});
      else connection.destroy();
    }
  } catch (error: unknown) {
    const code =
      error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : '';
    const postgresServerError =
      transport.driver === 'postgresql' &&
      Boolean(
        error &&
        typeof error === 'object' &&
        'severity' in error &&
        typeof error.severity === 'string',
      ) &&
      /^[0-9A-Z]{5}$/.test(code) &&
      code !== '57014';
    const serverError =
      postgresServerError ||
      (transport.driver === 'mysql' && /^ER_[A-Z_]+$/.test(code));
    return {
      status: null,
      headers: {},
      body: serverError
        ? { databaseErrorCode: code }
        : '[SQL outcome unavailable]',
      elapsedMs: Math.round(performance.now() - started),
      errorCode: serverError ? 'SQL_SERVER_ERROR' : 'SQL_TRANSPORT_ERROR',
      sideEffectCertainty: serverError ? 'known' : 'unknown',
    };
  }
}
export async function performTransport(
  transport: WorkerTransport,
  signal?: AbortSignal,
  loadMultipartFile?: MultipartFileLoader,
): Promise<RawTransportResponse> {
  return transport.type === 'http'
    ? requestHttp(transport, signal, loadMultipartFile)
    : requestSql(transport);
}
