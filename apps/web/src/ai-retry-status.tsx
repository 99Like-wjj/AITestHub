import { useEffect, useState } from 'react';
import { WifiOutlined } from '@ant-design/icons';
import type { AiRetryState } from './ai-retry-state';

export function AiRetryStatus({
  state,
  onCancel,
  onReconnect,
}: {
  state: AiRetryState;
  onCancel?: () => void;
  onReconnect?: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (state.phase !== 'waiting' || state.nextAttemptAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [state.phase, state.nextAttemptAt]);
  const events = state.layer === 'events',
    count = `${state.attempt}/${state.maxAttempts}`;
  const text =
    state.phase === 'paused'
      ? events
        ? '已暂停事件连接'
        : '已停止自动重试'
      : state.phase === 'exhausted'
        ? state.attempt === 0
          ? '自动恢复已停止'
          : events
            ? `自动重连${state.attempt}次后仍未连上`
            : `模型重试${state.attempt}次后仍未成功`
        : state.attempt === 0
          ? events
            ? '正在连接原任务事件'
            : '正在连接模型服务'
          : events
            ? `正在重新连接 ${count}`
            : `正在重试模型 ${count}`;
  const seconds =
    state.nextAttemptAt === null
      ? 0
      : Math.max(0, Math.ceil((state.nextAttemptAt - now) / 1000));
  return (
    <div
      className="ai-retry-status"
      data-layer={state.layer}
      data-phase={state.phase}
    >
      <div className="row wrap">
        <WifiOutlined aria-hidden="true" className="ai-retry-icon" />
        <span role="status" aria-live="polite" aria-atomic="true">
          {text}
        </span>
        {state.phase === 'waiting' && (
          <span className="ai-retry-countdown" aria-hidden="true">
            · {seconds} 秒后尝试
          </span>
        )}
        {(state.phase === 'waiting' || state.phase === 'connecting') &&
          onCancel && (
            <button
              type="button"
              className="link ai-retry-action"
              onClick={onCancel}
            >
              {events ? '取消自动重连' : '停止重试'}
            </button>
          )}
        {(state.phase === 'exhausted' || state.phase === 'paused') &&
          onReconnect && (
            <button
              type="button"
              className="link ai-retry-action"
              onClick={onReconnect}
            >
              {events ? '手工重连原任务' : '重新查看原状态'}
            </button>
          )}
      </div>
      {state.reason && <p className="caption">{state.reason}</p>}
    </div>
  );
}
