import type { AiTaskStatus } from '../../../packages/contracts/src/conversations';
import type { ModelAttemptView } from '../../../packages/contracts/src/ai-retry';
import type { AiRetryState } from './ai-retry-state';
import { AiRetryStatus } from './ai-retry-status';

export function interruptedModelAttempts(attempts: ModelAttemptView[]) {
  return attempts.filter(
    (attempt) =>
      ['failed', 'retryWait', 'cancelled'].includes(attempt.state) &&
      attempt.visibleText.length > 0,
  );
}
export function modelMessagePresentation(task: AiTaskStatus['task']) {
  let content = task.content;
  const fragments = interruptedModelAttempts(task.modelAttempts);
  const last = task.modelAttempts.reduce<ModelAttemptView | null>(
    (current, attempt) =>
      !current ||
      attempt.modelOrdinal > current.modelOrdinal ||
      (attempt.modelOrdinal === current.modelOrdinal &&
        attempt.attemptNo > current.attemptNo)
        ? attempt
        : current,
    null,
  );
  let unresolved: ModelAttemptView | null = null;
  if (
    last &&
    ['failed', 'cancelled'].includes(last.state) &&
    last.visibleText
  ) {
    // This is a server-recorded UTF-16 boundary, never a fuzzy text-suffix guess.
    const boundary = last.prefixLength;
    if (
      boundary !== null &&
      boundary <= content.length &&
      content.length - boundary === last.visibleText.length &&
      content.slice(boundary) === last.visibleText
    )
      content = content.slice(0, boundary);
    else if (boundary === null || content.length !== boundary)
      unresolved = last;
  }
  return {
    content,
    fragments: fragments.filter((attempt) => attempt.id !== unresolved?.id),
    unresolved,
  };
}
const reasons = {
  rateLimited: '模型服务暂时限流',
  network: '模型连接暂时中断',
  timeout: '模型响应超时',
  serverUnavailable: '模型服务暂时不可用',
};
export function modelRetryState(
  task: AiTaskStatus['task'],
): AiRetryState | null {
  const retry = task.modelRetry;
  if (!retry || retry.phase === 'recovered') return null;
  const running = ['accepted', 'running'].includes(task.status);
  if (!running && retry.phase !== 'exhausted') return null;
  return {
    layer: 'model',
    phase:
      retry.phase === 'scheduled'
        ? 'waiting'
        : retry.phase === 'started'
          ? 'connecting'
          : 'exhausted',
    attempt: retry.retryNo,
    maxAttempts: retry.maxRetries,
    nextAttemptAt:
      retry.nextAttemptAt === null ? null : Date.parse(retry.nextAttemptAt),
    reason:
      retry.phase === 'exhausted'
        ? retry.stopReason === 'timeBudget'
          ? '已达到本次模型自动恢复时间上限。'
          : '已达到模型自动重试次数上限。'
        : retry.reason
          ? `${reasons[retry.reason]}；仅重试当前模型段，已完成工具回执保留。`
          : null,
  };
}
export function InterruptedModelFragments({
  attempts,
}: {
  attempts: ModelAttemptView[];
}) {
  const fragments = interruptedModelAttempts(attempts);
  if (!fragments.length) return null;
  return (
    <div className="model-interrupted-fragments">
      {fragments.map((attempt) => (
        <section
          className="notice model-interrupted-fragment"
          key={attempt.id}
          aria-label={`中断模型片段 ${attempt.modelOrdinal} 第${attempt.attemptNo}次尝试`}
        >
          <div className="between">
            <b>{attempt.state === 'cancelled' ? '已停止片段' : '中断片段'}</b>
            <span className="caption">
              模型段 {attempt.modelOrdinal} ·{' '}
              {attempt.attemptNo === 0
                ? '首次尝试'
                : `重试 ${attempt.attemptNo}`}
            </span>
          </div>
          <p className="caption">此片段保留供核对，不与后续重试内容拼接。</p>
          <div className="message-prose">{attempt.visibleText}</div>
        </section>
      ))}
    </div>
  );
}
export function ModelAttemptFragments({
  task,
}: {
  task: AiTaskStatus['task'];
}) {
  const { fragments, unresolved } = modelMessagePresentation(task);
  return (
    <>
      <InterruptedModelFragments attempts={fragments} />
      {unresolved && (
        <details className="notice model-interrupted-fragment mt">
          <summary>
            末次中断片段的位置未能核对，保留原正文；可单独查看原片段。
          </summary>
          <div className="message-prose">{unresolved.visibleText}</div>
        </details>
      )}
    </>
  );
}
export function ModelRetryStatus({
  task,
  onCancel,
}: {
  task: AiTaskStatus['task'];
  onCancel?: () => void;
}) {
  const state = modelRetryState(task);
  return state ? (
    <AiRetryStatus state={state} {...(onCancel ? { onCancel } : {})} />
  ) : null;
}
