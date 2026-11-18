import { useEffect, useState } from 'react';
import { Alert, Button, Dropdown, Tooltip } from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  EllipsisOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  PaperClipOutlined,
  RollbackOutlined,
} from '@ant-design/icons';
import {
  api,
  describeError,
  isClosedOperationReceipt,
  isUncertainMutationError,
} from './api';
import { WorkspaceReferencePreview } from './workspace-reference-preview';
import { InlineMessageContent } from './inline-composer';
import { inlineReferenceKey } from './workspace-inline-tokens';
import {
  currentIdentityOwner,
  identityContextEpoch,
  subscribeIdentityChanges,
} from './identity-context';
import {
  aiTaskStatusSchema,
  aiTaskEventsSchema,
  taskAcceptedSchema,
} from '../../../packages/contracts/src/conversations';
import { readWorkspaceSendReceipt } from './workspace-send-receipt';
import { workspaceQueueStorageKey } from './workspace-queue-storage';
import { rememberWorkspaceModelSelection } from './workspace-model-preference';
import {
  WorkspaceSendQueue,
  savedWorkspaceQueueSchema,
  type WorkspaceConversationQueue,
  type WorkspaceQueuedMessage,
} from './workspace-send-queue';
import './workspace-queue.css';

const controllers = new Map<
  string,
  { epoch: number; queue: WorkspaceSendQueue }
>();
const storageKey = workspaceQueueStorageKey;
let observing = false;
function controller(ownerId: string) {
  if (!observing) {
    observing = true;
    subscribeIdentityChanges(() => {
      controllers.clear();
    });
  }
  const epoch = identityContextEpoch(),
    prior = controllers.get(ownerId);
  if (prior?.epoch === epoch) return prior.queue;
  const saved = window.sessionStorage.getItem(storageKey(ownerId));
  const queue = new WorkspaceSendQueue(
    {
      active: () =>
        currentIdentityOwner() === ownerId && identityContextEpoch() === epoch,
      persist: (queues) => {
        if (
          currentIdentityOwner() !== ownerId ||
          identityContextEpoch() !== epoch
        )
          return;
        window.sessionStorage.setItem(
          storageKey(ownerId),
          JSON.stringify(savedWorkspaceQueueSchema.parse(queues)),
        );
      },
      changed: () => window.dispatchEvent(new Event('aitesthub:queue-changed')),
      wait: () => new Promise((resolve) => window.setTimeout(resolve, 1000)),
      status: async (taskId) => {
        const { task } = await api(
          `/me/ai-tasks/${taskId}`,
          {},
          aiTaskStatusSchema,
        );
        if (['accepted', 'running', 'cancelling'].includes(task.status))
          return { terminal: false, safeToContinue: false };
        if (
          ['unknown', 'interrupted'].includes(task.status) ||
          task.errorCode === 'OPERATION_RESULT_UNKNOWN'
        )
          return { terminal: true, safeToContinue: false };
        const tools = new Map<string, { state: string; unknown: boolean }>();
        let after = '0';
        for (let page = 0; ; page++) {
          if (page === 64) return { terminal: true, safeToContinue: false };
          const { events } = await api(
            `/me/ai-tasks/${taskId}/events?format=json&after=${after}`,
            {},
            aiTaskEventsSchema,
          );
          for (const event of events)
            if (event.type === 'ai.tool')
              tools.set(event.payload.invocationId, {
                state: event.payload.state,
                unknown: event.payload.unknownEffect === true,
              });
          if (events.length < 200) break;
          const next = events.at(-1)?.sequence;
          if (!next || next === after)
            return { terminal: true, safeToContinue: false };
          after = next;
        }
        return {
          terminal: true,
          safeToContinue: [...tools.values()].every(
            (tool) => !tool.unknown && tool.state !== 'started',
          ),
        };
      },
      cancel: async (taskId, commandId) => {
        await api(`/me/ai-tasks/${taskId}/cancel`, {
          method: 'POST',
          body: { commandId },
        });
      },
      send: (conversationId, input) =>
        api(
          `/me/conversations/${conversationId}/messages`,
          { method: 'POST', body: input },
          taskAcceptedSchema,
        ),
      receipt: async (conversationId, commandId) => {
        try {
          return (
            await readWorkspaceSendReceipt(ownerId, conversationId, commandId)
          ).receipt;
        } catch (error) {
          if (isClosedOperationReceipt(error)) return null;
          throw error;
        }
      },
      accepted: (conversationId, receipt, input) => {
        rememberWorkspaceModelSelection(ownerId, input.modelSelection);
        window.dispatchEvent(
          new CustomEvent('aitesthub:queued-message-accepted', {
            detail: { ownerId, conversationId, receipt },
          }),
        );
      },
      uncertain: isUncertainMutationError,
      errorText: describeError,
    },
    saved ? JSON.parse(saved) : [],
  );
  controllers.set(ownerId, { epoch, queue });
  return queue;
}

export function useWorkspaceSendQueue(
  ownerId: string,
  conversationId: string | null,
) {
  const [, refresh] = useState(0);
  let queue: WorkspaceSendQueue | null = null,
    error: string | null = null;
  try {
    queue = controller(ownerId);
  } catch {
    error = '待发消息草稿暂时无法恢复或保存，请保留当前页面并检查浏览器存储。';
  }
  useEffect(() => {
    const update = () => refresh((value) => value + 1);
    window.addEventListener('aitesthub:queue-changed', update);
    queue?.resume();
    return () => window.removeEventListener('aitesthub:queue-changed', update);
  }, [ownerId, queue]);
  return {
    controller: queue,
    state: conversationId ? queue?.snapshot(conversationId) : undefined,
    error,
  };
}

function QueueAttachment({ item }: { item: WorkspaceQueuedMessage }) {
  const reference = item.display?.references.find(
    (entry) => entry.reference.kind === 'resource',
  );
  const fileCount = item.input.references.filter(
    (entry) => entry.kind === 'resource',
  ).length;
  if (!fileCount) return null;
  const label = reference?.label ?? `${fileCount} 个文件`;
  return (
    <WorkspaceReferencePreview
      fileId={
        reference?.reference.kind === 'resource'
          ? reference.reference.resourceId
          : null
      }
      label={label}
      className="workspace-queue-attachment"
      fallback={<PaperClipOutlined aria-label={label} />}
    />
  );
}

export function WorkspacePendingMessages({
  state,
  queue,
  taskId,
  mode,
  onModeChange,
  onEdit,
}: {
  state: WorkspaceConversationQueue | undefined;
  queue: WorkspaceSendQueue | null;
  taskId: string | null;
  mode: 'queue' | 'steer';
  onModeChange: (mode: 'queue' | 'steer') => void | Promise<void>;
  onEdit: (item: WorkspaceQueuedMessage) => void | Promise<void>;
}) {
  const [actionError, setActionError] = useState<string>();
  useEffect(() => setActionError(undefined), [state?.conversationId]);
  const act = (work: () => void | Promise<void>) => {
    setActionError(undefined);
    void Promise.resolve()
      .then(work)
      .catch((failure: unknown) => setActionError(describeError(failure)));
  };
  if (!queue || !state?.items.length) return null;
  return (
    <section
      className="workspace-pending-messages workspace-queue-drawer"
      aria-label={`待发送消息队列，共 ${state.items.length} 条`}
    >
      {actionError && <Alert type="warning" showIcon title={actionError} />}
      {state.paused && (
        <Alert
          type="warning"
          showIcon
          title={state.paused}
          action={
            state.items[0]?.state !== 'failed' && (
              <Button
                size="small"
                onClick={() => act(() => queue.recover(state.conversationId))}
              >
                核对并继续
              </Button>
            )
          }
        />
      )}
      <ol className="workspace-queue-list">
        {state.items.map((item, index) => {
          const editable = item.state === 'queued' || item.state === 'failed';
          const canSteer =
            !state.paused &&
            state.items.every((entry) => entry.state === 'queued');
          const summary = item.input.content.trim().replace(/\s+/g, ' ');
          const status =
            item.state === 'queued'
              ? '等待发送'
              : item.state === 'dispatching'
                ? '正在受理'
                : item.state === 'unknown'
                  ? '受理待核对'
                  : '未受理';
          return (
            <li className="workspace-queue-row" key={item.input.commandId}>
              <MenuUnfoldOutlined
                className="workspace-queue-symbol"
                aria-label={`待发消息 ${index + 1}，${status}`}
              />
              <QueueAttachment item={item} />
              <span
                className="workspace-queue-summary"
                title={`${item.label}；${status}`}
              >
                <InlineMessageContent
                  text={summary}
                  allowedReferences={
                    new Set(item.input.references.map(inlineReferenceKey))
                  }
                  renderText={(text) => text}
                />
              </span>
              {item.state !== 'queued' && (
                <small className="workspace-queue-status">{status}</small>
              )}
              <Tooltip title="停止当前回复，优先发送此消息；已发生的操作与回执保留">
                <Button
                  className="workspace-queue-steer"
                  size="small"
                  type="text"
                  icon={<RollbackOutlined rotate={180} />}
                  disabled={!canSteer}
                  onClick={() =>
                    act(() =>
                      queue.prioritize(
                        state.conversationId,
                        item.input.commandId,
                        taskId,
                      ),
                    )
                  }
                >
                  引导
                </Button>
              </Tooltip>
              <Tooltip title="删除待发消息">
                <Button
                  className="workspace-queue-icon-button"
                  size="small"
                  type="text"
                  icon={<DeleteOutlined />}
                  disabled={!editable}
                  aria-label={`删除待发消息 ${index + 1}`}
                  onClick={() =>
                    act(() =>
                      queue.remove(state.conversationId, item.input.commandId),
                    )
                  }
                />
              </Tooltip>
              <Dropdown
                trigger={['click']}
                classNames={{ root: 'workspace-queue-more-menu' }}
                menu={{
                  items: [
                    {
                      key: 'edit',
                      label: '编辑消息',
                      icon: <EditOutlined />,
                      disabled: !editable,
                    },
                    {
                      key: 'mode',
                      label: mode === 'queue' ? '关闭排队' : '关闭引导',
                      icon: <MenuFoldOutlined />,
                    },
                  ],
                  onClick: ({ key }) => {
                    if (key === 'edit' && editable) act(() => onEdit(item));
                    if (key === 'mode')
                      act(() =>
                        onModeChange(mode === 'queue' ? 'steer' : 'queue'),
                      );
                  },
                }}
              >
                <Button
                  className="workspace-queue-icon-button"
                  size="small"
                  type="text"
                  icon={<EllipsisOutlined />}
                  aria-label={`待发消息 ${index + 1} 更多操作`}
                />
              </Dropdown>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
