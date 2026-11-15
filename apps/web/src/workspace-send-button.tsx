import { Button } from 'antd';
import { AppIcon } from './app-icon';

export function WorkspaceSendButton({
  generating,
  hasContent,
  stopping,
  sendDisabled,
  stopDisabled,
  loading,
  mode,
  onSend,
  onStop,
}: {
  generating: boolean;
  hasContent: boolean;
  stopping: boolean;
  sendDisabled: boolean;
  stopDisabled: boolean;
  loading: boolean;
  mode: 'queue' | 'steer';
  onSend: () => void;
  onStop: () => void;
}) {
  const stop = generating && !hasContent;
  const label = stop
    ? stopping
      ? '正在停止回复'
      : '停止回复'
    : generating
      ? mode === 'queue'
        ? '排队发送消息'
        : '引导发送消息'
      : '发送消息';
  return (
    <Button
      className={`send-message-button${stop ? ' stop-message-button' : ''}`}
      shape="circle"
      type="primary"
      aria-label={label}
      title={
        stop || !generating
          ? label
          : mode === 'queue'
            ? 'Enter 排队发送；Ctrl/Cmd+Enter 停止当前回复后优先发送'
            : 'Enter 引导发送：停止当前回复后优先发送'
      }
      disabled={stop ? stopDisabled : sendDisabled}
      loading={loading && !stop}
      aria-busy={loading || (stop && stopping)}
      icon={
        stop ? (
          <span className="composer-stop-square" aria-hidden="true" />
        ) : (
          <AppIcon name="send" />
        )
      }
      onClick={stop ? onStop : onSend}
    />
  );
}
