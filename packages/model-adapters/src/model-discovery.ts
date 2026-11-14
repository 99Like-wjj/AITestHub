import {
  modelBaseUrlSchema,
  modelAuthSchemeSchema,
  modelProtocolSchema,
  type ModelProtocol,
  type ModelAuthScheme,
} from '../../contracts/src/model-protocol.js';
import { modelDiscoveryV2ReceiptSchema } from '../../contracts/src/model-configuration-v2.js';
import { parseStrictJsonText } from '../../contracts/src/safe-json.js';
import { resolveModelEndpoint } from './model-endpoint.js';

export type ModelDiscoveryErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'CREDENTIAL_UNAVAILABLE'
  | 'CREDENTIAL_CHANGED'
  | 'HTTP_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE'
  | 'RESPONSE_LIMIT'
  | 'PAGINATION_LIMIT'
  | 'UNSUPPORTED_PAGINATION'
  | 'PROTECTED_RESPONSE';
/** No provider text, URL, headers, credential, or error cause crosses this boundary. */
export class ModelDiscoveryError extends Error {
  readonly terminal = true;
  constructor(
    readonly code: ModelDiscoveryErrorCode,
    readonly httpStatus: number | null = null,
    readonly requestsSent = 0,
  ) {
    super(
      `模型列表读取失败（${code}${httpStatus === null ? '' : `，HTTP ${httpStatus}`}）。未自动重试或切换连接，可检查配置后手工添加模型。`,
    );
    this.name = 'ModelDiscoveryError';
  }
}
export interface ModelDiscoveryInput {
  protocol: ModelProtocol;
  authScheme: ModelAuthScheme;
  baseUrl: string;
  credential: () => Promise<string>;
}
export interface NativeModelDiscoveryOptions {
  fetch?: typeof globalThis.fetch;
  /** Trusted isolated fixtures only. It never enables arbitrary HTTP or redirects. */
  allowLocalHttp?: boolean;
  /** Overall deadline, including credential checks, all pages, body reads and parsing. */
  timeoutMs?: number;
  maxPageBytes?: number;
  maxTotalBytes?: number;
  maxPages?: number;
}
const maximumModels = 5000,
  pageSize = 1000;
const resultModelSchema = modelDiscoveryV2ReceiptSchema.shape.models.element;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const status = (failure: unknown): number | null => {
  const code = object(failure)?.status;
  return typeof code === 'number' &&
    Number.isInteger(code) &&
    code >= 100 &&
    code <= 599
    ? code
    : null;
};
const deadlineExceeded = Symbol('model-discovery-deadline');
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(deadlineExceeded);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(deadlineExceeded);
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

/** Explicit read-only GET /models. No endpoint guessing, retries, inference, or installation. */
export class NativeModelDiscovery {
  readonly #options: Required<Omit<NativeModelDiscoveryOptions, 'fetch'>>;
  readonly #fetch: typeof globalThis.fetch;
  constructor(options: NativeModelDiscoveryOptions = {}) {
    this.#options = Object.freeze({
      allowLocalHttp: options.allowLocalHttp ?? false,
      timeoutMs: options.timeoutMs ?? 30_000,
      maxPageBytes: options.maxPageBytes ?? 2 * 1024 * 1024,
      maxTotalBytes: options.maxTotalBytes ?? 8 * 1024 * 1024,
      maxPages: options.maxPages ?? 20,
    });
    const limits = this.#options;
    if (
      !Number.isSafeInteger(limits.timeoutMs) ||
      limits.timeoutMs < 1 ||
      limits.timeoutMs > 120_000 ||
      !Number.isSafeInteger(limits.maxPageBytes) ||
      limits.maxPageBytes < 1 ||
      limits.maxPageBytes > 4 * 1024 * 1024 ||
      !Number.isSafeInteger(limits.maxTotalBytes) ||
      limits.maxTotalBytes < limits.maxPageBytes ||
      limits.maxTotalBytes > 16 * 1024 * 1024 ||
      !Number.isSafeInteger(limits.maxPages) ||
      limits.maxPages < 1 ||
      limits.maxPages > 50
    )
      throw new ModelDiscoveryError('INVALID_CONFIGURATION');
    this.#fetch = options.fetch ?? globalThis.fetch;
  }
  async discover(
    input: ModelDiscoveryInput,
  ): Promise<{ models: { modelId: string; displayName: string | null }[] }> {
    const protocol = modelProtocolSchema.safeParse(input.protocol),
      auth = modelAuthSchemeSchema.safeParse(input.authScheme),
      base = modelBaseUrlSchema.safeParse(input.baseUrl);
    if (
      !protocol.success ||
      !auth.success ||
      !base.success ||
      typeof input.credential !== 'function'
    )
      throw new ModelDiscoveryError('INVALID_CONFIGURATION');
    let endpoint: URL;
    try {
      endpoint = resolveModelEndpoint(base.data, protocol.data, 'models');
    } catch {
      throw new ModelDiscoveryError('INVALID_CONFIGURATION');
    }
    if (
      endpoint.protocol !== 'https:' &&
      !(
        this.#options.allowLocalHttp &&
        endpoint.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
      )
    )
      throw new ModelDiscoveryError('INVALID_CONFIGURATION');
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), this.#options.timeoutMs);
    const expiresAt = performance.now() + this.#options.timeoutMs;
    const checkDeadline = () => {
      if (controller.signal.aborted || performance.now() >= expiresAt)
        throw deadlineExceeded;
    };
    let requestsSent = 0,
      totalBytes = 0,
      firstCredential: string | undefined,
      cursor: string | null = null;
    const models: { modelId: string; displayName: string | null }[] = [],
      ids = new Set<string>(),
      cursors = new Set<string>();
    function failure(
      code: ModelDiscoveryErrorCode,
      httpStatus: number | null = null,
    ): never {
      throw new ModelDiscoveryError(code, httpStatus, requestsSent);
    }
    const cancel = (response: Response) => {
      if (response.body) void response.body.cancel().catch(() => {});
    };
    async function readJson(
      response: Response,
      pageLimit: number,
      totalLimit: number,
    ) {
      const length = response.headers.get('content-length');
      if (
        length &&
        /^\d+$/.test(length) &&
        (BigInt(length) > BigInt(pageLimit) ||
          BigInt(length) > BigInt(totalLimit - totalBytes))
      ) {
        cancel(response);
        return failure('RESPONSE_LIMIT');
      }
      if (
        !response.body ||
        !/^application\/(?:[a-z0-9_.-]+\+)?json(?:\s*;|\s*$)/i.test(
          response.headers.get('content-type') ?? '',
        )
      ) {
        cancel(response);
        return failure('INVALID_RESPONSE');
      }
      const reader = response.body.getReader(),
        decoder = new TextDecoder('utf-8', { fatal: true });
      let pageBytes = 0,
        text = '';
      try {
        while (true) {
          const part = await bounded(reader.read(), controller.signal);
          if (part.done) break;
          pageBytes += part.value.byteLength;
          totalBytes += part.value.byteLength;
          if (pageBytes > pageLimit || totalBytes > totalLimit)
            failure('RESPONSE_LIMIT');
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
        const decoded = parseStrictJsonText(text);
        checkDeadline();
        return decoded;
      } catch (error) {
        if (error === deadlineExceeded) throw error;
        if (error instanceof ModelDiscoveryError) throw error;
        return failure('INVALID_RESPONSE');
      } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
    try {
      for (let page = 0; page < this.#options.maxPages; page++) {
        let credential: string;
        try {
          credential = await bounded(
            Promise.resolve().then(() => input.credential()),
            controller.signal,
          );
        } catch (error) {
          if (error === deadlineExceeded) throw error;
          return failure('CREDENTIAL_UNAVAILABLE', status(error));
        }
        if (
          typeof credential !== 'string' ||
          credential.length < 8 ||
          credential.length > 16384 ||
          !/^[\x21-\x7e]+$/.test(credential)
        )
          failure('CREDENTIAL_UNAVAILABLE');
        if (firstCredential === undefined) firstCredential = credential;
        else if (firstCredential !== credential) failure('CREDENTIAL_CHANGED');
        const url = new URL(endpoint);
        if (protocol.data === 'anthropicMessages') {
          url.searchParams.set('limit', String(pageSize));
          if (cursor !== null) url.searchParams.set('after_id', cursor);
        }
        if (
          url.origin !== endpoint.origin ||
          url.pathname !== endpoint.pathname
        )
          failure('INVALID_CONFIGURATION');
        const headers = new Headers({
          Accept: 'application/json',
          ...(auth.data === 'bearer'
            ? { Authorization: `Bearer ${credential}` }
            : { 'x-api-key': credential }),
        });
        if (protocol.data === 'anthropicMessages')
          headers.set('anthropic-version', '2023-06-01');
        checkDeadline();
        requestsSent++;
        let response: Response;
        try {
          response = await bounded(
            this.#fetch(url, {
              method: 'GET',
              headers,
              redirect: 'error',
              signal: controller.signal,
            }),
            controller.signal,
          );
        } catch (error) {
          if (error === deadlineExceeded || controller.signal.aborted)
            throw deadlineExceeded;
          return failure('NETWORK_ERROR');
        }
        if (!response.ok) {
          cancel(response);
          return failure('HTTP_ERROR', response.status);
        }
        const raw = object(
          await readJson(
            response,
            this.#options.maxPageBytes,
            this.#options.maxTotalBytes,
          ),
        );
        if (!raw || !Array.isArray(raw.data)) failure('INVALID_RESPONSE');
        const data = raw.data as unknown[];
        if (
          data.length >
          (protocol.data === 'anthropicMessages' ? pageSize : maximumModels)
        )
          failure('RESPONSE_LIMIT');
        for (const item of data) {
          const row = object(item);
          if (!row) failure('INVALID_RESPONSE');
          const projected = resultModelSchema.safeParse({
            modelId: row.id,
            displayName:
              protocol.data === 'anthropicMessages' ? row.display_name : null,
          });
          if (!projected.success || projected.data.modelId !== row.id)
            failure('INVALID_RESPONSE');
          const model = projected.data;
          if (
            model.modelId.includes(firstCredential) ||
            model.displayName?.includes(firstCredential)
          )
            failure('PROTECTED_RESPONSE');
          if (ids.has(model.modelId)) failure('INVALID_RESPONSE');
          ids.add(model.modelId);
          models.push(model);
          if (models.length > maximumModels) failure('RESPONSE_LIMIT');
        }
        if (protocol.data !== 'anthropicMessages') {
          if (raw.object !== 'list') failure('INVALID_RESPONSE');
          // OpenAI's official list has no cursor. Never silently ignore a nonstandard continuation.
          if (
            ('has_more' in raw && raw.has_more !== false) ||
            raw.next_page != null ||
            raw.next_cursor != null ||
            raw.next != null
          )
            failure('UNSUPPORTED_PAGINATION');
          checkDeadline();
          return { models };
        }
        if (
          typeof raw.has_more !== 'boolean' ||
          !('first_id' in raw) ||
          !('last_id' in raw)
        )
          failure('INVALID_RESPONSE');
        const first = data.length ? object(data[0])?.id : null,
          last = data.length ? object(data[data.length - 1])?.id : null;
        if (raw.first_id !== first || raw.last_id !== last)
          failure('INVALID_RESPONSE');
        if (!raw.has_more) {
          checkDeadline();
          return { models };
        }
        if (!data.length || typeof last !== 'string' || cursors.has(last))
          failure('INVALID_RESPONSE');
        if (models.length >= maximumModels) failure('PAGINATION_LIMIT');
        cursors.add(last);
        cursor = last;
      }
      return failure('PAGINATION_LIMIT');
    } catch (error) {
      if (error === deadlineExceeded || controller.signal.aborted)
        throw new ModelDiscoveryError('TIMEOUT', null, requestsSent);
      if (error instanceof ModelDiscoveryError) throw error;
      throw new ModelDiscoveryError('INVALID_RESPONSE', null, requestsSent);
    } finally {
      clearTimeout(timer);
      firstCredential = undefined;
    }
  }
}
