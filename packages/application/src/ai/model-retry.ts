import { randomUUID } from 'node:crypto';
import { ModelAdapterError } from '../../../model-adapters/src/index.js';
import type {
  ModelAttemptContext,
  ModelRetryEvent,
} from '../../../contracts/src/ai-retry.js';

export interface AiModelRetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  maxElapsedMs: number;
}
export const defaultAiModelRetryPolicy: Readonly<AiModelRetryPolicy> = {
  maxRetries: 5,
  initialDelayMs: 2000,
  maxDelayMs: 32000,
  maxElapsedMs: 300000,
};
export function modelRetryReason(error: unknown): ModelRetryEvent['reason'] {
  if (!(error instanceof ModelAdapterError)) return null;
  if (error.code === 'HTTP_ERROR') {
    // SenseNova's generic quota_exceeded_error is not proof of permanent exhaustion.
    // Explicit hard-quota codes and authentication/validation failures are terminal.
    if (
      /^(?:insufficient_quota|FREE_QUOTA_EXHAUSTED)$/i.test(
        error.providerCode ?? '',
      )
    )
      return null;
    if (error.httpStatus === 429) return 'rateLimited';
    if (error.httpStatus === 408) return 'timeout';
    if ([500, 502, 503, 504].includes(error.httpStatus ?? 0))
      return 'serverUnavailable';
    return null;
  }
  if (error.code === 'NETWORK_ERROR') return 'network';
  if (error.code === 'TIMEOUT') return 'timeout';
  if (error.code === 'STREAM_INTERRUPTED') return 'network';
  return null;
}
export function abortableRetryDelay(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(new DOMException('Cancelled', 'AbortError'));
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Only wraps one model inference. It never invokes tools, requeues tasks or changes a model/key. */
export class AiModelRetryCoordinator {
  constructor(
    readonly runtime: {
      now?: () => number;
      random?: () => number;
      wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
    } = {},
  ) {}
  async run<T>(options: {
    modelOrdinal: number;
    policy?: Partial<AiModelRetryPolicy>;
    signal?: AbortSignal;
    attempt: (context: ModelAttemptContext) => Promise<T>;
    event?: (event: ModelRetryEvent) => void | Promise<void>;
  }): Promise<T> {
    const policy = { ...defaultAiModelRetryPolicy, ...options.policy };
    if (
      !Number.isInteger(policy.maxRetries) ||
      policy.maxRetries < 0 ||
      policy.maxRetries > 5 ||
      ![policy.initialDelayMs, policy.maxDelayMs, policy.maxElapsedMs].every(
        (v) => Number.isFinite(v) && v > 0,
      )
    )
      throw new RangeError('Invalid bounded model retry policy');
    const now = this.runtime.now ?? Date.now,
      random = this.runtime.random ?? Math.random;
    const wait = this.runtime.wait ?? abortableRetryDelay;
    const startedAt = now(),
      logicalCallId = randomUUID();
    for (let attemptNo = 0; ; attemptNo++) {
      if (options.signal?.aborted)
        throw new DOMException('Cancelled', 'AbortError');
      const context: ModelAttemptContext = {
        logicalCallId,
        attemptId: randomUUID(),
        modelOrdinal: options.modelOrdinal,
        attemptNo,
        maxRetries: policy.maxRetries,
      };
      if (attemptNo > 0)
        await options.event?.({
          ...context,
          phase: 'started',
          retryNo: attemptNo,
          reason: null,
          nextAttemptAt: null,
          delayMs: null,
          stopReason: null,
        });
      try {
        const result = await options.attempt(context);
        if (attemptNo > 0)
          await options.event?.({
            ...context,
            phase: 'recovered',
            retryNo: attemptNo,
            reason: null,
            nextAttemptAt: null,
            delayMs: null,
            stopReason: null,
          });
        return result;
      } catch (error: unknown) {
        if (options.signal?.aborted)
          throw new DOMException('Cancelled', 'AbortError');
        const reason = modelRetryReason(error);
        if (!reason) throw error;
        if (attemptNo >= policy.maxRetries) {
          await options.event?.({
            ...context,
            phase: 'exhausted',
            retryNo: attemptNo,
            reason,
            nextAttemptAt: null,
            delayMs: null,
            stopReason: 'maxRetries',
          });
          throw error;
        }
        const jitter = 0.8 + Math.max(0, Math.min(1, random())) * 0.4;
        const backoff = Math.round(
          Math.min(policy.initialDelayMs * 2 ** attemptNo, policy.maxDelayMs) *
            jitter,
        );
        const advice =
          error instanceof ModelAdapterError ? error.retryAfterMs : null;
        const delayMs = Math.max(
          backoff,
          advice !== null && Number.isFinite(advice) && advice >= 0
            ? Math.ceil(advice)
            : 0,
        );
        if (Math.max(0, now() - startedAt) + delayMs >= policy.maxElapsedMs) {
          await options.event?.({
            ...context,
            phase: 'exhausted',
            retryNo: attemptNo,
            reason,
            nextAttemptAt: null,
            delayMs,
            stopReason: 'timeBudget',
          });
          throw error;
        }
        await options.event?.({
          ...context,
          phase: 'scheduled',
          retryNo: attemptNo + 1,
          reason,
          nextAttemptAt: new Date(now() + delayMs).toISOString(),
          delayMs,
          stopReason: null,
        });
        await wait(delayMs, options.signal);
        if (now() - startedAt >= policy.maxElapsedMs) {
          await options.event?.({
            ...context,
            phase: 'exhausted',
            retryNo: attemptNo,
            reason,
            nextAttemptAt: null,
            delayMs,
            stopReason: 'timeBudget',
          });
          throw error;
        }
      }
    }
  }
}
