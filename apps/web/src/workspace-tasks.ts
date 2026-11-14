import { useEffect, useRef, useState } from 'react';
import type {
  AiTaskEvent,
  AiTaskStatus,
  TaskState,
} from '../../../packages/contracts/src/conversations';
import { describeError } from './api';
import { readAiTaskSession, terminalAiTaskStates } from './ai-task-reader';
import type { TaskConnection, TaskCursor } from './ai-task-reader';
import type { AiRetryState } from './ai-retry-state';

export const taskStateLabels: Record<TaskState, string> = {
  accepted: '已受理，等待处理',
  running: '任务处理中',
  cancelling: '停止请求处理中',
  completed: '已完成',
  failed: '未完成',
  cancelled: '已停止生成',
  interrupted: '中断，未自动重放',
  unknown: '结果未知，需查原回执',
};

export function useAiTask(taskId: string | null) {
  const [task, setTask] = useState<AiTaskStatus['task'] | null>(null);
  const [events, setEvents] = useState<AiTaskEvent[]>([]);
  const [connection, setConnection] = useState<TaskConnection>('idle');
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState<AiRetryState | null>(null);
  const [manualEpoch, setManualEpoch] = useState(0);
  const [pausedTask, setPausedTask] = useState<string | null>(null);
  const remembered = useRef<TaskCursor>({
    id: null,
    cursor: '0',
    seen: new Set(),
  });
  const generation = useRef(0),
    controllerRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const epoch = ++generation.current,
      controller = new AbortController();
    controllerRef.current = controller;
    if (remembered.current.id !== taskId) {
      remembered.current = { id: taskId, cursor: '0', seen: new Set() };
      setTask(null);
      setEvents([]);
      setRetry(null);
    }
    setError(undefined);
    const current = () =>
      !controller.signal.aborted && generation.current === epoch;
    if (!taskId) {
      setConnection('idle');
      setRetry(null);
    } else if (pausedTask === taskId) {
      setConnection('paused');
      setRetry((previous) => ({
        layer: 'events',
        phase: 'paused',
        attempt: previous?.attempt ?? 0,
        maxAttempts: 5,
        nextAttemptAt: null,
        reason: '已暂停原任务事件读取，可手工恢复连接。',
      }));
    } else {
      void readAiTaskSession({
        taskId,
        cursor: remembered.current,
        signal: controller.signal,
        current,
        onTask: (value) => {
          if (current()) setTask(value);
        },
        onEvent: (event) => {
          if (current()) setEvents((previous) => [...previous, event]);
        },
        onConnection: (value) => {
          if (current()) setConnection(value);
        },
        onRetry: (value) => {
          if (current()) setRetry(value);
        },
        onError: (value) => {
          if (current()) setError(value);
        },
      }).catch((failure) => {
        if (current()) {
          setConnection('unavailable');
          setRetry(null);
          setError(describeError(failure));
        }
      });
    }
    return () => {
      controller.abort();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [taskId, manualEpoch, pausedTask]);
  function reconnect() {
    controllerRef.current?.abort();
    setPausedTask(null);
    setManualEpoch((value) => value + 1);
  }
  function pause() {
    controllerRef.current?.abort();
    setPausedTask(taskId);
    setConnection('paused');
    setError(undefined);
    setRetry((previous) => ({
      layer: 'events',
      phase: 'paused',
      attempt: previous?.attempt ?? 0,
      maxAttempts: 5,
      nextAttemptAt: null,
      reason: '已暂停原任务事件读取，可手工恢复连接。',
    }));
  }
  return {
    task,
    events,
    connection,
    error,
    retry,
    reconnect,
    pause,
    terminal: task ? terminalAiTaskStates.has(task.status) : false,
  };
}
