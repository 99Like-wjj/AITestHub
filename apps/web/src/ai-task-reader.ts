import {
  aiTaskEventSchema,
  aiTaskEventsSchema,
  aiTaskStatusSchema,
} from '../../../packages/contracts/src/conversations';
import type {
  AiTaskEvent,
  AiTaskStatus,
  TaskState,
} from '../../../packages/contracts/src/conversations';
import { api, ApiError, describeError } from './api';
import type { AiRetryState } from './ai-retry-state';
import { applyAiPresentationEvent } from '../../../packages/contracts/src/ai-presentation';

/** Opt-in metadata only; never includes prompts, model text, tool arguments or credentials. */
export interface AiTaskReadMetric {
  taskId: string;
  stage: 'snapshot' | 'event' | 'paint';
  sequence: string | null;
  monotonicMs: number;
  serverCreatedAt?: string;
  eventType?: string;
  serverSentAt?: string;
  providerReceivedAt?: string;
  segmentId?: string;
  isPublicText?: boolean;
}

export type TaskConnection =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'ended'
  | 'unavailable'
  | 'paused';
export interface TaskCursor {
  id: string | null;
  cursor: string;
  seen: Set<string>;
}
export const terminalAiTaskStates = new Set<TaskState>([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'unknown',
]);
export const EVENT_RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000] as const;
export function retryAfterDelay(value: string | null, now = Date.now()) {
  if (value === null) return 0;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : 0;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? Math.max(0, parsed - now) : 0;
}
export function transientTaskReadFailure(error: unknown) {
  return error instanceof ApiError
    ? error.code !== 'RESPONSE_SCHEMA_MISMATCH' &&
        error.code !== 'TASK_EVENT_CONTRACT_ERROR' &&
        (error.status === 0 ||
          [408, 429, 500, 502, 503, 504].includes(error.status))
    : error instanceof TypeError;
}
function wait(delay: number, signal: AbortSignal) {
  return new Promise<boolean>((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const end = (value: boolean) => {
      signal.removeEventListener('abort', cancel);
      clearTimeout(timer);
      resolve(value);
    };
    const cancel = () => end(false),
      timer = setTimeout(() => end(true), delay);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

/** Read-only observer: no message creation, model invocation, or business tool dispatch. */
export async function readAiTaskSession({
  taskId,
  cursor,
  signal,
  current = () => true,
  onTask,
  onEvent,
  onConnection,
  onRetry,
  onError,
  recoveryBudgetMs = 300000,
  initialTask = null,
  onMetric,
}: {
  taskId: string;
  cursor: TaskCursor;
  signal: AbortSignal;
  current?: () => boolean;
  onTask: (task: AiTaskStatus['task']) => void;
  onEvent: (event: AiTaskEvent) => void;
  onConnection: (state: TaskConnection) => void;
  onRetry: (state: AiRetryState | null) => void;
  onError: (message: string | undefined) => void;
  recoveryBudgetMs?: number;
  initialTask?: AiTaskStatus['task'] | null;
  onMetric?: (metric: AiTaskReadMetric) => void;
}) {
  const active = () => !signal.aborted && current();
  let currentTask = initialTask?.id === taskId ? initialTask : null;
  let publishTimer: ReturnType<typeof setTimeout> | undefined;
  function publish(immediate = false) {
    if (!active() || !currentTask) return;
    if (immediate) {
      if (publishTimer !== undefined) clearTimeout(publishTimer);
      publishTimer = undefined;
      onTask(currentTask);
    } else if (publishTimer === undefined) {
      publishTimer = setTimeout(() => {
        publishTimer = undefined;
        if (active() && currentTask) onTask(currentTask);
      }, 32);
    }
  }
  let retries = 0,
    firstFailureAt: number | undefined,
    refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let attemptController: AbortController | undefined, refreshFailure: unknown;
  let refreshRunning = false;
  let refreshSerial = 0,
    lastAppliedRefresh = 0;
  const requestSignal = () =>
    attemptController
      ? AbortSignal.any([signal, attemptController.signal])
      : signal;
  async function refresh() {
    const owner = attemptController;
    const serial = ++refreshSerial;
    const response = await api(
      `/me/ai-tasks/${encodeURIComponent(taskId)}/status`,
      { signal: requestSignal() },
      aiTaskStatusSchema,
    );
    if (response.task.id !== taskId)
      throw new Error('原任务状态回执不匹配，请保留任务ID核对。');
    if (
      active() &&
      owner === attemptController &&
      !owner?.signal.aborted &&
      serial >= lastAppliedRefresh
    ) {
      lastAppliedRefresh = serial;
      const incoming = response.task.presentation?.snapshotSequence;
      const applied = currentTask?.presentation?.snapshotSequence;
      if (
        applied === undefined ||
        (incoming !== undefined && BigInt(incoming) >= BigInt(applied))
      ) {
        currentTask = response.task;
        publish(true);
        onMetric?.({
          taskId,
          stage: 'snapshot',
          sequence: incoming ?? null,
          monotonicMs: performance.now(),
        });
      }
    }
    return currentTask ?? response.task;
  }
  function retain(event: AiTaskEvent) {
    if (
      !active() ||
      cursor.id !== taskId ||
      cursor.seen.has(event.sequence) ||
      BigInt(event.sequence) <= BigInt(cursor.cursor)
    )
      return;
    if (event.type === 'task.accepted' && event.payload.taskId !== taskId)
      throw new Error('任务事件所属对象不符，已停止读取。');
    cursor.seen.add(event.sequence);
    cursor.cursor = event.sequence;
    onMetric?.({
      taskId,
      stage: 'event',
      sequence: event.sequence,
      monotonicMs: performance.now(),
      serverCreatedAt: event.createdAt,
      eventType: event.type,
      ...(event.sentAt ? { serverSentAt: event.sentAt } : {}),
      ...(event.type === 'ai.text' && event.payload.receivedAt
        ? { providerReceivedAt: event.payload.receivedAt }
        : {}),
      ...(event.type === 'ai.text' && event.payload.modelAttemptId
        ? { segmentId: event.payload.modelAttemptId }
        : {}),
      ...(event.type === 'ai.text'
        ? { isPublicText: event.payload.text.length > 0 }
        : {}),
    });
    const presentation = currentTask?.presentation;
    if (
      currentTask &&
      presentation &&
      BigInt(event.sequence) > BigInt(presentation.snapshotSequence)
    ) {
      currentTask = {
        ...currentTask,
        presentation: applyAiPresentationEvent(presentation, event),
      };
      if (event.type === 'task.started') currentTask.status = 'running';
      if (event.type === 'task.cancel-requested')
        currentTask.status = event.payload.status;
      if (event.type === 'task.finished') {
        currentTask.status = event.payload.status;
        currentTask.finishedAt = event.createdAt;
      }
      if (event.type === 'task.interrupted') currentTask.status = 'interrupted';
      if (event.type === 'ai.modelRetry')
        currentTask.modelRetry = event.payload.retry;
      publish();
    }
    if (event.type !== 'ai.text' && event.type !== 'ai.summary') onEvent(event);
    // New segments consume deltas directly. Old workers have no boundaries and
    // continue the previous snapshot fallback, without guessing old phases.
    if (
      (event.type !== 'ai.text' &&
        event.type !== 'ai.summary' &&
        event.type !== 'ai.modelDispatched') ||
      !presentation?.segments.some(
        (segment) => segment.phase !== 'unclassified',
      )
    )
      scheduleRefresh();
  }
  async function persisted() {
    while (active()) {
      const before = cursor.cursor,
        page = await api(
          `/me/ai-tasks/${encodeURIComponent(taskId)}/events?format=json&after=${encodeURIComponent(before)}`,
          { signal: requestSignal() },
          aiTaskEventsSchema,
        );
      for (const event of page.events) retain(event);
      if (page.events.length < 200 || cursor.cursor === before)
        return page.terminal;
    }
    return false;
  }
  function scheduleRefresh() {
    if (refreshTimer !== undefined || refreshRunning || !active()) return;
    const owner = attemptController;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      if (!active() || owner !== attemptController) return;
      refreshRunning = true;
      void refresh()
        .catch((failure) => {
          if (
            active() &&
            owner === attemptController &&
            !owner?.signal.aborted
          ) {
            refreshFailure = failure;
            owner?.abort();
          }
        })
        .finally(() => {
          refreshRunning = false;
        });
    }, 150);
  }
  const stopRefresh = () => {
    if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    refreshTimer = undefined;
  };
  try {
    while (active()) {
      attemptController = new AbortController();
      refreshFailure = undefined;
      const attempt = attemptController;
      let connectTimer: ReturnType<typeof setTimeout> | undefined,
        idleTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        onConnection(retries ? 'reconnecting' : 'connecting');
        onRetry(
          retries
            ? {
                layer: 'events',
                phase: 'connecting',
                attempt: retries,
                maxAttempts: 5,
                nextAttemptAt: null,
                reason: null,
              }
            : null,
        );
        let status = await refresh();
        if (!active()) return;
        const eventsEnded = await persisted();
        if (!active()) return;
        if (eventsEnded && !terminalAiTaskStates.has(status.status))
          status = await refresh();
        if (terminalAiTaskStates.has(status.status)) {
          onConnection('ended');
          onRetry(null);
          onError(undefined);
          return;
        }
        connectTimer = setTimeout(() => attempt.abort(), 30000);
        const response = await fetch(
          `/api/v1/me/ai-tasks/${encodeURIComponent(taskId)}/events?after=${encodeURIComponent(cursor.cursor)}`,
          {
            method: 'GET',
            credentials: 'same-origin',
            signal: AbortSignal.any([signal, attempt.signal]),
            headers: { Accept: 'text/event-stream' },
          },
        );
        clearTimeout(connectTimer);
        connectTimer = undefined;
        if (!active()) return;
        if (!response.ok) {
          if (response.status === 401 && active())
            window.dispatchEvent(new Event('aitesthub:session-expired'));
          throw new ApiError(
            '当前任务事件连接未能继续读取。',
            response.status,
            'TASK_EVENTS_UNAVAILABLE',
            undefined,
            response.headers.get('Retry-After'),
          );
        }
        if (
          !response.headers
            .get('Content-Type')
            ?.toLowerCase()
            .startsWith('text/event-stream')
        )
          throw new ApiError(
            '任务事件响应类型不匹配，请重新载入页面或核对平台版本。',
            502,
            'TASK_EVENT_CONTRACT_ERROR',
          );
        if (!response.body)
          throw new Error('服务未提供可读的任务事件流，请核对平台版本。');
        onConnection('connected');
        onRetry(null);
        onError(undefined);
        const reader = response.body.getReader(),
          decoder = new TextDecoder('utf-8', { fatal: true });
        let buffer = '';
        const watch = () => {
          if (idleTimer !== undefined) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => attempt.abort(), 45000);
        };
        watch();
        try {
          while (active()) {
            const chunk = await reader.read();
            if (!active()) return;
            if (chunk.done) break;
            watch();
            let text: string;
            try {
              text = decoder.decode(chunk.value, { stream: true });
            } catch {
              throw new Error('任务事件编码无效，请核对平台响应。');
            }
            buffer = `${buffer}${text}`.replaceAll('\r\n', '\n');
            if (buffer.length > 2000000)
              throw new Error('任务事件超过读取上限，请保留原任务ID核对。');
            let boundary = buffer.indexOf('\n\n');
            while (boundary !== -1) {
              const record = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const lines = record.split('\n');
              if (
                lines.includes('event: access-unavailable') ||
                lines.includes('event: access-ended')
              )
                throw new ApiError(
                  '当前权限已无法读取任务事件，订阅已停止。',
                  403,
                  'TASK_ACCESS_UNAVAILABLE',
                );
              const data = lines
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trimStart())
                .join('\n');
              if (lines.includes('event: protocol-unavailable'))
                throw new ApiError(
                  '任务事件处理异常，请重新载入页面或查询原任务。',
                  502,
                  'TASK_EVENT_CONTRACT_ERROR',
                );
              if (data) {
                let raw: unknown;
                try {
                  raw = JSON.parse(data);
                } catch {
                  throw new Error('任务事件格式不匹配，请核对平台版本。');
                }
                if (lines.includes('event: transport-unavailable')) {
                  const delay =
                    typeof raw === 'object' &&
                    raw !== null &&
                    'retryAfterMs' in raw &&
                    typeof raw.retryAfterMs === 'number' &&
                    Number.isFinite(raw.retryAfterMs) &&
                    raw.retryAfterMs >= 0
                      ? String(raw.retryAfterMs / 1000)
                      : null;
                  throw new ApiError(
                    '任务事件连接暂时不可达，将查询原状态后恢复。',
                    503,
                    'TASK_EVENT_TEMPORARY',
                    undefined,
                    delay,
                  );
                }
                const event = aiTaskEventSchema.safeParse(raw);
                if (!event.success)
                  throw new ApiError(
                    '任务事件契约不匹配，请核对平台版本。',
                    502,
                    'TASK_EVENT_CONTRACT_ERROR',
                  );
                retain(event.data);
              }
              boundary = buffer.indexOf('\n\n');
            }
          }
        } finally {
          if (idleTimer !== undefined) clearTimeout(idleTimer);
          idleTimer = undefined;
          void reader.cancel().catch(() => undefined);
        }
        if (!active()) return;
        const final = await refresh();
        if (!active()) return;
        if (terminalAiTaskStates.has(final.status)) {
          await persisted();
          if (active()) {
            onConnection('ended');
            onRetry(null);
            onError(undefined);
          }
          return;
        }
        throw new ApiError(
          '事件连接中断，将按原序号补拉读取。',
          0,
          'TASK_EVENT_CONNECTION_ENDED',
        );
      } catch (originalFailure) {
        if (!active()) return;
        const failure =
          refreshFailure ??
          (attempt.signal.aborted
            ? new ApiError(
                '读取任务事件超时，将查询原状态。',
                0,
                'TASK_READ_TIMEOUT',
              )
            : originalFailure);
        const message = describeError(failure);
        onError(message);
        if (!transientTaskReadFailure(failure)) {
          onConnection('unavailable');
          onRetry(null);
          return;
        }
        firstFailureAt ??= Date.now();
        if (retries >= 5) {
          onConnection('unavailable');
          onRetry({
            layer: 'events',
            phase: 'exhausted',
            attempt: retries,
            maxAttempts: 5,
            nextAttemptAt: null,
            reason: message,
          });
          return;
        }
        const delay = Math.max(
          EVENT_RECONNECT_DELAYS[retries] ?? 16000,
          failure instanceof ApiError ? retryAfterDelay(failure.retryAfter) : 0,
        );
        if (Date.now() + delay - firstFailureAt > recoveryBudgetMs) {
          onConnection('unavailable');
          onRetry({
            layer: 'events',
            phase: 'exhausted',
            attempt: retries,
            maxAttempts: 5,
            nextAttemptAt: null,
            reason:
              '服务要求的等待时间超出本轮自动恢复窗口，请稍后手工查询原任务。',
          });
          return;
        }
        retries += 1;
        onConnection('reconnecting');
        onRetry({
          layer: 'events',
          phase: 'waiting',
          attempt: retries,
          maxAttempts: 5,
          nextAttemptAt: Date.now() + delay,
          reason: message,
        });
        attempt.abort();
        stopRefresh();
        if (!(await wait(delay, signal))) return;
      } finally {
        if (connectTimer !== undefined) clearTimeout(connectTimer);
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        stopRefresh();
      }
    }
  } finally {
    attemptController?.abort();
    stopRefresh();
    if (publishTimer !== undefined) clearTimeout(publishTimer);
  }
}
