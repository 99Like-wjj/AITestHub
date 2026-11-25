import { useEffect, useId, useRef, useState } from 'react';
import { CheckOutlined, CopyOutlined, DownOutlined } from '@ant-design/icons';
import type { ReactNode } from 'react';
import type {
  AiTaskEvent,
  AiTaskStatus,
  ConversationMessage,
} from '../../../packages/contracts/src/conversations';
import type { AiMessageSegment } from '../../../packages/contracts/src/ai-presentation';
import { useAiTask, taskStateLabels } from './workspace-tasks';
import { WorkspaceMarkdown } from './workspace-markdown';
import {
  interruptedModelAttempts,
  ModelAttemptFragments,
  ModelRetryStatus,
  modelMessagePresentation,
} from './workspace-model-retry';
import { AiRetryStatus } from './ai-retry-status';
import { taskGuidanceEntries } from './task-guidance';
import {
  WorkspaceGuidanceRecord,
  WorkspaceToolBadge,
} from './workspace-process-references';
import { WorkspaceReferenceChip } from './workspace-composer-references';
import type { AiContextResetReason } from '../../../packages/contracts/src/ai-context';
import './workspace-stream.css';

type Task = AiTaskStatus['task'];
type TaskStream = ReturnType<typeof useAiTask>;
type ToolEvent = Extract<AiTaskEvent, { type: 'ai.tool' }>['payload'];
type ToolState = ToolEvent['state'];
type ToolFailure = NonNullable<ToolEvent['failure']>;

export interface WorkspaceTurnProps {
  taskId: string;
  current: boolean;
  stream: TaskStream;
  fallbackText: string;
  messageStatus: ConversationMessage['status'];
  taskStatus?: ConversationMessage['taskStatus'];
  taskNotices?: ConversationMessage['taskNotices'];
  caption?: ReactNode;
  onProposals: () => void;
  onStop?: () => void;
  onContinue?: () => void;
  sendTiming?: { submittedAt: number; acceptedAt: number };
}

export interface WorkspaceToolRow {
  id: string;
  name: string;
  state: ToolState;
  failure: ToolFailure | null;
  unknownEffect: boolean;
  confirmationId: string | null;
  startedAt: string;
  updatedAt: string;
  external: boolean;
  knowledgeReferences: number;
}

/** A tool response is a transport fact, not a claim that its business operation succeeded. */
export function aggregateWorkspaceTools(
  events: AiTaskEvent[],
): WorkspaceToolRow[] {
  const rows = new Map<string, WorkspaceToolRow>();
  for (const event of events) {
    if (event.type !== 'ai.tool') continue;
    const payload = event.payload;
    const previous = rows.get(payload.invocationId);
    const knowledgeSources = payload.sourceRefs?.filter(
      (source) => source.kind === 'knowledge',
    );
    rows.set(payload.invocationId, {
      id: payload.invocationId,
      name: payload.name,
      state: payload.state,
      failure: payload.failure ?? null,
      unknownEffect: payload.unknownEffect === true,
      confirmationId:
        payload.confirmationId ?? previous?.confirmationId ?? null,
      startedAt: previous?.startedAt ?? event.createdAt,
      updatedAt: event.createdAt,
      external:
        payload.name.startsWith('ext_') ||
        payload.externalInvocationId !== undefined ||
        payload.sourceRefs?.some(
          (source) => source.kind === 'externalMcpInvocation',
        ) === true ||
        previous?.external === true,
      knowledgeReferences: knowledgeSources
        ? new Set(
            knowledgeSources.map(
              (source) => `${source.entryId}:${source.revisionId}`,
            ),
          ).size
        : (previous?.knowledgeReferences ?? 0),
    });
  }
  return [...rows.values()];
}

const segmentFailed = (segment: AiMessageSegment) =>
  segment.state === 'interrupted' || segment.state === 'cancelled';

/** Keep attempt boundaries explicit; never merge old interrupted text into a retry's answer. */
export function workspaceTurnText(task: Task | null, fallbackText: string) {
  const segments = task?.presentation?.segments ?? [];
  const knownFragments = task
    ? interruptedModelAttempts(task.modelAttempts)
    : [];
  const knownIds = new Set(knownFragments.map((attempt) => attempt.id));
  const body = segments.filter(
    (segment) =>
      segment.phase !== 'commentary' &&
      !segmentFailed(segment) &&
      !knownIds.has(segment.id) &&
      segment.text,
  );
  const commentary = segments.filter(
    (segment) =>
      segment.phase === 'commentary' &&
      !segmentFailed(segment) &&
      !knownIds.has(segment.id) &&
      segment.text,
  );
  const orphanedFragments = segments.filter(
    (segment) =>
      segmentFailed(segment) && segment.text && !knownIds.has(segment.id),
  );
  const legacyText = segments.length
    ? ''
    : task
      ? modelMessagePresentation(task).content
      : fallbackText;
  const answer = body.map((segment) => segment.text).join('\n\n') || legacyText;
  const fragments = [
    ...knownFragments.map((attempt) => ({
      id: attempt.id,
      text: attempt.visibleText,
      cancelled: attempt.state === 'cancelled',
      modelOrdinal: attempt.modelOrdinal,
      attemptNo: attempt.attemptNo,
    })),
    ...orphanedFragments.map((segment) => ({
      id: segment.id,
      text: segment.text,
      cancelled: segment.state === 'cancelled',
      modelOrdinal: segment.modelOrdinal,
      attemptNo: segment.attemptNo,
    })),
  ];
  const markdown = [
    ...fragments.map(
      (fragment) =>
        `### ${fragment.cancelled ? '已停止片段' : '中断片段'} · 模型段 ${fragment.modelOrdinal} / 尝试 ${fragment.attemptNo + 1}\n\n${fragment.text}`,
    ),
    answer,
  ]
    .filter(Boolean)
    .join('\n\n');
  return { body, commentary, legacyText, orphanedFragments, markdown };
}

export function workspaceElapsed(
  start: string,
  end: string | number,
  precision: 'seconds' | 'tenths' = 'seconds',
) {
  const startMs = Date.parse(start);
  const endMs = typeof end === 'string' ? Date.parse(end) : end;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const milliseconds = Math.max(0, endMs - startMs);
  const rounded =
    precision === 'tenths'
      ? Math.max(1, Math.ceil(milliseconds / 100)) * 100
      : Math.floor(milliseconds / 1000) * 1000;
  const seconds = (rounded % 60_000) / 1000;
  if (rounded < 60_000) return `${seconds}秒`;
  return `${Math.floor(rounded / 60_000)}分${seconds}秒`;
}

const toolLabels: Record<ToolState, string> = {
  started: '已开始',
  completed: '已返回',
  failed: '未完成',
  waitingConfirmation: '已提出本人决定事项',
  notDispatched: '未执行',
};
const toolFailureReasons: Record<NonNullable<ToolFailure['reason']>, string> = {
  unsupportedDocumentFormat:
    '文件类型不支持。可读取 Markdown、纯文本、PDF 和 Office 文档。',
  invalidUtf8Text: '文件内容不是有效的 UTF-8 文本。',
  documentSizeLimit: '文件超过读取上限，请拆分后再读。',
  toolNotDispatched: '模型请求的工具没有在本步开放。',
};
const documentReadErrors: Partial<Record<ToolFailure['code'], string>> = {
  FORBIDDEN: '当前任务无权读取此文件。',
  NOT_FOUND: '文件已不可访问。',
  FILE_NOT_READY: '文件尚未通过完整性校验。',
  DEPENDENCY_UNAVAILABLE: '文件或解析服务暂不可用。',
  VALIDATION_ERROR: '读取参数或文档内容无效。',
  PRECONDITIONS_MISSING: '无法解析文档或读取指定范围。',
  OPERATION_RESULT_UNKNOWN: '文档解析的沙箱清理尚待确认。',
};
const progressLabels = {
  pending: '待处理',
  in_progress: '进行中',
  completed: '已完成',
};
const contextNotices = {
  'authorization-changed':
    '历史运行上下文曾按当时范围重新整理；旧记录未区分具体原因。',
  'authorization-scope-changed':
    '来源资料或授权范围已变化，已按当前权限重新整理可用历史。',
  'access-mode-changed': '访问模式已切换，已按当前模式整理可用上下文。',
  'source-context-changed':
    '引用资料状态已变化，已按当前权限重新整理可用上下文。',
  'run-recovery':
    '上一轮未完整结束，已恢复当前授权下可用的历史；原操作以原回执为准。',
  'context-rebuilt':
    '运行上下文已重建，已恢复当前授权下可用的历史；原操作以原回执为准。',
} satisfies Record<AiContextResetReason, string>;

export function WorkspaceTurn({
  taskId,
  current,
  stream,
  fallbackText,
  messageStatus,
  taskStatus,
  taskNotices,
  caption,
  onProposals,
  onStop,
  onContinue,
  sendTiming,
}: WorkspaceTurnProps) {
  const [requestedHistory, setRequestedHistory] = useState<string | null>(null);
  const history = useAiTask(
    !current && requestedHistory === taskId && messageStatus !== 'deleted'
      ? taskId
      : null,
  );
  const active = current ? stream : history;
  const task = active.task?.id === taskId ? active.task : null;
  const events = task ? active.events : [];
  const tools = aggregateWorkspaceTools(events);
  const projection = workspaceTurnText(task, fallbackText);
  const hasFinal =
    task?.presentation?.segments.some(
      (segment) =>
        segment.phase === 'final' && !segmentFailed(segment) && segment.text,
    ) ?? false;
  const finishedNormally = task?.status === 'completed';
  const [expanded, setExpanded] = useState(false);
  const foldedTask = useRef<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );
  const processId = useId();
  const running = Boolean(
    task && ['accepted', 'running', 'cancelling'].includes(task.status),
  );
  const readRequested = current || requestedHistory === taskId;

  useEffect(() => {
    setCopyState('idle');
    foldedTask.current = null;
    setExpanded(false);
  }, [taskId, current]);
  useEffect(() => {
    if (
      current &&
      (hasFinal || finishedNormally) &&
      foldedTask.current !== taskId
    ) {
      foldedTask.current = taskId;
      setExpanded(false);
    }
  }, [current, taskId, hasFinal, finishedNormally]);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, taskId]);

  const sequence = task?.presentation?.snapshotSequence;
  const visibleText =
    projection.body.map((segment) => segment.text).join('') ||
    projection.legacyText;
  const visibleSegmentId = projection.body.at(-1)?.id;
  useEffect(() => {
    if (!sequence || !visibleText || messageStatus === 'deleted') return;
    let paintFrame = 0;
    const commitFrame = window.requestAnimationFrame(() => {
      paintFrame = window.requestAnimationFrame(() =>
        active.markPaint(sequence, visibleSegmentId),
      );
    });
    return () => {
      window.cancelAnimationFrame(commitFrame);
      window.cancelAnimationFrame(paintFrame);
    };
  }, [taskId, sequence, visibleText, visibleSegmentId, current, messageStatus]);

  function toggleProcess() {
    if (!current) setRequestedHistory(taskId);
    setExpanded((value) => !value);
  }
  function showProcess() {
    if (!current) setRequestedHistory(taskId);
    setExpanded(true);
  }
  function copyMarkdown() {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      void navigator.clipboard.writeText(projection.markdown).then(
        () => setCopyState('copied'),
        () => setCopyState('failed'),
      );
    } catch {
      setCopyState('failed');
    }
  }

  const activeTool = tools.findLast((tool) => tool.state === 'started');
  const modelRunning = task?.presentation?.segments.some(
    (segment) => segment.state === 'streaming',
  );
  const label = task ? (
    task.status === 'running' ? (
      activeTool ? (
        <>
          正在调用{' '}
          <WorkspaceToolBadge
            name={activeTool.name}
            external={activeTool.external}
          />
        </>
      ) : modelRunning ? (
        '正在生成回复'
      ) : (
        taskStateLabels.running
      )
    ) : (
      taskStateLabels[task.status]
    )
  ) : current ? (
    messageStatus === 'queued' ? (
      '已受理，等待状态同步'
    ) : messageStatus === 'streaming' ? (
      '正在读取处理状态'
    ) : (
      '处理过程'
    )
  ) : (
    '查看已保存的处理过程'
  );
  const elapsed =
    task && (task.finishedAt || running)
      ? workspaceElapsed(
          task.startedAt ?? task.createdAt,
          task.finishedAt ?? now,
        )
      : null;
  const guidance = events.flatMap((event) =>
    taskGuidanceEntries(event).map((entry) => ({
      key: `${event.sequence}:${entry.skillId}`,
      entry,
    })),
  );
  const decisions = tools.filter((tool) => tool.confirmationId !== null);
  const failedTools = tools.filter(
    (tool) =>
      tool.state === 'failed' ||
      tool.state === 'notDispatched' ||
      tool.unknownEffect,
  );
  const contextReset = events.findLast(
    (event) => event.type === 'ai.contextReset',
  );
  const contextNotice = contextReset
    ? contextNotices[contextReset.payload.reason]
    : taskNotices?.hasContextReset
      ? '此任务的运行上下文已重新整理；展开过程可核对原记录。'
      : null;
  const hasUnknownToolEffects =
    failedTools.some((tool) => tool.unknownEffect) ||
    taskNotices?.hasUnknownToolEffects === true;
  const hasFailedTools =
    failedTools.length > 0 ||
    taskNotices?.hasFailedTools === true ||
    hasUnknownToolEffects;
  const status = task?.status ?? taskStatus ?? messageStatus;
  const stopped = status === 'cancelled';
  const interrupted = status === 'interrupted';
  const failed = status === 'failed';
  const toolSelectionFailed =
    task?.errorCode === 'INVALID_MODEL_OUTPUT' &&
    failedTools.some((tool) => tool.failure?.reason === 'toolNotDispatched');
  const unknown = status === 'unknown';
  const stopping = status === 'cancelling';
  const legacyProjection =
    task &&
    !running &&
    (!task.presentation ||
      task.presentation.segments.some(
        (segment) => segment.phase === 'unclassified',
      ));

  if (messageStatus === 'deleted') {
    return (
      <p className="workspace-turn-notice" role="status">
        此消息已删除，不能继续读取。
      </p>
    );
  }

  return (
    <div className="workspace-turn" data-task-id={taskId}>
      <div className="workspace-process">
        <button
          type="button"
          className="workspace-process-trigger"
          aria-expanded={expanded}
          aria-controls={processId}
          onClick={toggleProcess}
        >
          <span
            className={`workspace-process-dot${running ? ' is-active' : ''}`}
            aria-hidden="true"
          />
          <span>{label}</span>
          {elapsed && (
            <span className="workspace-process-time">· {elapsed}</span>
          )}
          <DownOutlined
            aria-hidden="true"
            className={`workspace-process-chevron${expanded ? ' is-expanded' : ''}`}
          />
        </button>
        {expanded && (
          <div id={processId} className="workspace-process-content">
            {!task && readRequested && !active.error && (
              <p role="status" className="caption">
                正在读取已保存的任务过程…
              </p>
            )}
            {projection.commentary.map((segment) => (
              <div key={segment.id} className="workspace-commentary">
                <WorkspaceMarkdown text={segment.text} />
              </div>
            ))}
            {task?.presentation?.summaries
              .filter((summary) => summary.text)
              .map((summary) => (
                <section
                  className="workspace-public-summary"
                  key={summary.id}
                  aria-label="模型公开摘要"
                >
                  <span className="workspace-process-section-label">
                    模型公开摘要
                  </span>
                  <WorkspaceMarkdown text={summary.text} />
                </section>
              ))}
            {task?.presentation?.progress && (
              <section
                className="workspace-real-progress"
                aria-label="本轮任务计划"
              >
                <span className="workspace-process-section-label">
                  本轮任务计划
                </span>
                <ol>
                  {task.presentation.progress.items.map((item) => (
                    <li key={item.id} data-state={item.status}>
                      <span className="workspace-progress-state">
                        {progressLabels[item.status]}
                      </span>
                      <span>{item.step}</span>
                    </li>
                  ))}
                </ol>
                {task.presentation.progress.explanation && (
                  <p className="caption">
                    {task.presentation.progress.explanation}
                  </p>
                )}
              </section>
            )}
            {!!tools.length && (
              <ol className="workspace-tool-list" aria-label="真实工具过程">
                {tools.map((tool) => {
                  const duration = workspaceElapsed(
                    tool.startedAt,
                    tool.state === 'started' && running ? now : tool.updatedAt,
                    'tenths',
                  );
                  return (
                    <li
                      key={tool.id}
                      data-state={tool.unknownEffect ? 'unknown' : tool.state}
                    >
                      <WorkspaceToolBadge
                        name={tool.name}
                        external={tool.external}
                      />
                      <span>
                        {tool.unknownEffect
                          ? '结果未知，查原回执'
                          : toolLabels[tool.state]}
                      </span>
                      {duration && (
                        <span className="workspace-tool-time">{duration}</span>
                      )}
                      {tool.failure && (
                        <span className="caption">
                          {tool.failure.reason
                            ? toolFailureReasons[tool.failure.reason]
                            : (documentReadErrors[tool.failure.code] ??
                              '工具未返回可用结果。')}
                        </span>
                      )}
                      {tool.knowledgeReferences > 0 && (
                        <span className="workspace-tool-sources">
                          <WorkspaceReferenceChip
                            kind="knowledge"
                            label={`知识来源 · ${tool.knowledgeReferences} 项`}
                            className="workspace-process-reference"
                          />
                        </span>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
            {legacyProjection && (
              <p className="caption">
                此任务没有完整的分段标记，保留原正文，不推测哪些文字属于过程说明。
              </p>
            )}
            {!!guidance.length && (
              <details className="workspace-guidance-detail">
                <summary>Skill 指引记录</summary>
                <ul>
                  {guidance.map((item) => (
                    <li key={item.key}>
                      <WorkspaceGuidanceRecord entry={item.entry} />
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <details className="workspace-technical-detail">
              <summary>模型、任务与读取详情</summary>
              {caption}
              <dl>
                <dt>任务</dt>
                <dd>{taskId}</dd>
                {task && (
                  <>
                    <dt>创建时间</dt>
                    <dd>{new Date(task.createdAt).toLocaleString('zh-CN')}</dd>
                    <dt>当前状态</dt>
                    <dd>{taskStateLabels[task.status]}</dd>
                  </>
                )}
                <dt>事件连接</dt>
                <dd>{active.connection}</dd>
                {sequence && (
                  <>
                    <dt>已展示事件水位</dt>
                    <dd>{sequence}</dd>
                  </>
                )}
              </dl>
              <button
                type="button"
                className="workspace-turn-link"
                onClick={active.reconnect}
              >
                只读刷新原任务
              </button>
              <details>
                <summary>事件索引与本地读取耗时</summary>
                <pre className="message-code">
                  {JSON.stringify(
                    {
                      events: events.map((event) => ({
                        sequence: event.sequence,
                        type: event.type,
                        createdAt: event.createdAt,
                      })),
                      readMetrics: active.getReadMetrics(),
                      sendTiming: sendTiming ?? null,
                      modelTimings: task?.presentation?.timings ?? [],
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </details>
          </div>
        )}
      </div>

      {task && (
        <ModelRetryStatus
          task={task}
          {...(current && running && !stopping && onStop
            ? { onCancel: onStop }
            : {})}
        />
      )}
      {readRequested && active.retry && (
        <AiRetryStatus
          state={active.retry}
          onCancel={active.pause}
          onReconnect={active.reconnect}
        />
      )}
      {readRequested && active.error && !active.retry && (
        <div className="workspace-turn-notice is-warning" role="alert">
          {active.error}
          <button
            type="button"
            className="workspace-turn-link"
            onClick={active.reconnect}
          >
            查询原任务
          </button>
        </div>
      )}
      {stopping && (
        <p className="workspace-turn-notice" role="status">
          停止请求处理中；已收到的文字会保留。
        </p>
      )}
      {(failed || interrupted || unknown || stopped) && (
        <div
          className={`workspace-turn-notice${unknown || failed ? ' is-warning' : ''}`}
          role={unknown || failed ? 'alert' : 'status'}
        >
          <span>
            {stopped
              ? '已停止生成，已收到的内容保留。'
              : interrupted
                ? '任务已中断，未自动重放；请先核对原任务与工具回执。'
                : unknown
                  ? '业务结果未知，请先查询原任务和工具回执。'
                  : toolSelectionFailed
                    ? '模型请求了本步不可用的工具。回复未完成，原有工具结果已保留。'
                    : `本次回复未完成${task?.errorCode ? `：${task.errorCode}` : '。'}`}
          </span>
          {task?.errorDetails && (
            <span className="caption">
              供应商状态：{task.errorDetails.httpStatus ?? '未取得'}
              {task.errorDetails.providerCode
                ? ` · ${task.errorDetails.providerCode}`
                : ''}
            </span>
          )}
          <span className="workspace-turn-actions">
            <button
              type="button"
              className="workspace-turn-link"
              onClick={() => {
                if (!current) setRequestedHistory(taskId);
                active.reconnect();
              }}
            >
              查询原任务
            </button>
            <button
              type="button"
              className="workspace-turn-link"
              onClick={onProposals}
            >
              查看工具回执
            </button>
            {stopped && onContinue && (
              <button
                type="button"
                className="workspace-turn-link"
                onClick={onContinue}
              >
                继续提问
              </button>
            )}
          </span>
        </div>
      )}
      {hasFailedTools && (
        <div className="workspace-turn-notice is-warning" role="alert">
          <span>
            {hasUnknownToolEffects
              ? '有工具的业务结果未知，请查询原回执，不自动重放。'
              : '有工具未完成；回复结束不代表该业务已完成。'}
          </span>
          <button
            type="button"
            className="workspace-turn-link"
            onClick={showProcess}
          >
            查看过程
          </button>
          <button
            type="button"
            className="workspace-turn-link"
            onClick={onProposals}
          >
            查看工具回执
          </button>
        </div>
      )}
      {!!decisions.length && (
        <div className="workspace-turn-notice" role="status">
          <span>工具提案 · {decisions.length} 项（当前决定见原回执）</span>
          <button
            type="button"
            className="workspace-turn-link"
            onClick={onProposals}
          >
            查看本人提案
          </button>
        </div>
      )}
      {contextNotice && (
        <p className="workspace-turn-notice" role="status">
          {contextNotice}
        </p>
      )}

      {task && <ModelAttemptFragments task={task} />}
      {projection.orphanedFragments.map((segment) => (
        <section
          key={segment.id}
          className="workspace-orphan-fragment"
          aria-label={segment.state === 'cancelled' ? '已停止片段' : '中断片段'}
        >
          <strong>
            {segment.state === 'cancelled' ? '已停止片段' : '中断片段'}
          </strong>
          <p className="caption">此片段单独保留，不与重试内容拼接。</p>
          <WorkspaceMarkdown text={segment.text} />
        </section>
      ))}
      {!!projection.body.length &&
        projection.body.map((segment) => (
          <div className="workspace-answer-segment" key={segment.id}>
            <WorkspaceMarkdown text={segment.text} />
          </div>
        ))}
      {projection.legacyText && (
        <WorkspaceMarkdown text={projection.legacyText} />
      )}
      {projection.markdown && (
        <div className="workspace-turn-footer">
          <button
            type="button"
            className="workspace-turn-link workspace-copy-reply"
            onClick={copyMarkdown}
            aria-label="复制 AI 回复内容"
            title="复制 AI 回复内容"
          >
            {copyState === 'copied' ? <CheckOutlined /> : <CopyOutlined />}
          </button>
          <span role="status">
            {copyState === 'copied'
              ? '已复制'
              : copyState === 'failed'
                ? '复制失败，请选择文本复制'
                : ''}
          </span>
        </div>
      )}
    </div>
  );
}
