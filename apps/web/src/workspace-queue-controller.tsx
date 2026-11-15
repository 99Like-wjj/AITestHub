import { useEffect, useState } from 'react';
import { Alert, Button } from 'antd';
import { api, describeError, isUncertainMutationError } from './api';
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
} from './workspace-send-queue';

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
      receipt: async (conversationId, commandId) =>
        (await readWorkspaceSendReceipt(ownerId, conversationId, commandId))
          .receipt,
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

export function WorkspacePendingMessages({
  state,
  queue,
  taskId,
}: {
  state: WorkspaceConversationQueue | undefined;
  queue: WorkspaceSendQueue | null;
  taskId: string | null;
}) {
  const [actionError, setActionError] = useState<string>();
  const act = (work: () => void | Promise<void>) => {
    setActionError(undefined);
    void Promise.resolve()
      .then(work)
      .catch(() => {
        setActionError(
          '队列状态未能保存，请保留原消息并核对浏览器存储后再操作。',
        );
      });
  };
  if (!queue || !state?.items.length) return null;
  return (
    <section className="workspace-pending-messages" aria-label="待发送消息队列">
      <div className="workspace-queue-heading">
        待发送 · {state.items.length}/10{' '}
        <small>按入队时的模型、访问模式和项目发送</small>
      </div>
      {actionError && <Alert type="warning" showIcon title={actionError} />}
      {state.paused && (
        <Alert
          type="warning"
          showIcon
          title={state.paused}
          action={
            <Button
              size="small"
              onClick={() => act(() => queue.recover(state.conversationId))}
            >
              核对并继续
            </Button>
          }
        />
      )}
      <ol>
        {state.items.map((item, index) => (
          <li key={item.input.commandId}>
            <span className="workspace-queue-number">{index + 1}</span>
            <div className="workspace-queue-text">
              <span>{item.input.content}</span>
              <small>
                {item.label} ·{' '}
                {item.state === 'queued'
                  ? '等待发送'
                  : item.state === 'dispatching'
                    ? '正在受理'
                    : item.state === 'unknown'
                      ? '受理待核对'
                      : '未受理'}
              </small>
            </div>
            {item.state === 'queued' && (
              <Button
                size="small"
                type="text"
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
                插队
              </Button>
            )}
            {(item.state === 'queued' || item.state === 'failed') && (
              <Button
                size="small"
                type="text"
                aria-label={`移除待发消息 ${index + 1}`}
                onClick={() =>
                  act(() =>
                    queue.remove(state.conversationId, item.input.commandId),
                  )
                }
              >
                ×
              </Button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
