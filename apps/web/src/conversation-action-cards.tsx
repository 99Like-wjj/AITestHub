import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Collapse,
  Descriptions,
  Space,
  Tag,
  Typography,
} from 'antd';
import {
  actionIntentListSchema,
  actionIntentResponseSchema,
  type ActionIntent,
} from '../../../packages/contracts/src/action-intents';
import { api, ApiError, describeError } from './api';
import {
  currentIdentityOwner,
  identityContextEpoch,
  subscribeIdentityChanges,
} from './identity-context';
import {
  canDecideIntent,
  clearIntentDecisionFence,
  intentIsTerminal,
  intentStatusLabels,
  readIntentDecisionFence,
} from './action-intent-state';
import './conversation-action-cards.css';

export function ActionIntentCardView({
  intent,
  pending = false,
  uncertain = false,
  onRead,
}: {
  intent: ActionIntent;
  pending?: boolean;
  uncertain?: boolean;
  onRead: () => void;
}) {
  const allowed = canDecideIntent(intent.status, intent.expiresAt, uncertain),
    displayStatus =
      intent.status === 'waitingConfirmation' && !allowed && !uncertain
        ? 'expired'
        : intent.status;
  return (
    <article
      className="conversation-action-card"
      aria-label={`操作确认：${intent.title}`}
      data-action-intent={intent.id}
    >
      <header>
        <div>
          <Typography.Text strong>{intent.title}</Typography.Text>
          {intent.projectName ? (
            <Typography.Text type="secondary">
              {' '}
              · {intent.projectName}
            </Typography.Text>
          ) : null}
        </div>
        <Tag
          color={
            displayStatus === 'waitingConfirmation'
              ? 'gold'
              : displayStatus === 'completed'
                ? 'green'
                : displayStatus === 'unknown'
                  ? 'orange'
                  : 'default'
          }
        >
          {intentStatusLabels[displayStatus]}
        </Tag>
      </header>
      <Typography.Paragraph className="conversation-action-summary">
        {intent.summary}
      </Typography.Paragraph>
      {intent.changes.length ? (
        <dl className="conversation-action-changes">
          {intent.changes.slice(0, 4).map((change, index) => (
            <div key={index}>
              <dt>{change.label}</dt>
              <dd>
                {change.before !== null ? (
                  <>
                    <span>{change.before}</span>
                    <span aria-label="变更为"> → </span>
                  </>
                ) : null}
                <strong>{change.after ?? '移除'}</strong>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {intent.details.length ? (
        <div className="conversation-action-scope">
          {intent.details.slice(0, 3).map((detail, index) => (
            <span key={index}>
              {detail.label}：{detail.value}
            </span>
          ))}
        </div>
      ) : null}
      <Collapse
        ghost
        size="small"
        items={[
          {
            key: 'details',
            label: '查看完整变更与参数',
            children: (
              <>
                <Descriptions
                  size="small"
                  column={1}
                  items={intent.details.map((detail, index) => ({
                    key: index,
                    label: detail.label,
                    children: detail.value,
                  }))}
                />
                {intent.changes.length > 4 ? (
                  <dl className="conversation-action-changes">
                    {intent.changes.slice(4).map((change, index) => (
                      <div key={index}>
                        <dt>{change.label}</dt>
                        <dd>
                          {change.before ?? '无'} → {change.after ?? '移除'}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                <Typography.Text type="secondary">
                  原意图 {intent.id} · 有效期至{' '}
                  {new Date(intent.expiresAt).toLocaleString()}
                </Typography.Text>
                <pre
                  className="conversation-action-json"
                  aria-label="只读精确操作参数"
                >
                  {JSON.stringify(
                    {
                      arguments: intent.arguments,
                      scope: intent.proposal.scope,
                    },
                    null,
                    2,
                  )}
                </pre>
              </>
            ),
          },
          ...(intent.response === null
            ? []
            : [
                {
                  key: 'response',
                  label: '查看执行回执',
                  children: (
                    <pre
                      className="conversation-action-json"
                      aria-label="原执行结果"
                    >
                      {JSON.stringify(intent.response, null, 2)}
                    </pre>
                  ),
                },
              ]),
        ]}
      />
      {uncertain ? (
        <Alert
          type="warning"
          showIcon
          title="已发送决定，原结果尚待核对"
          description="只查询这张卡的原结果，不会重复执行或新建意图。"
        />
      ) : null}
      {displayStatus === 'expired' ? (
        <Typography.Paragraph type="secondary">
          此意图已失效，不能继续执行。需要操作时，请在对话中重新说明变更。
        </Typography.Paragraph>
      ) : null}
      {intent.status === 'unknown' ? (
        <Typography.Paragraph type="secondary">
          {intent.recovery}
        </Typography.Paragraph>
      ) : null}
      <footer>
        <Space>
          {allowed && (
            <Typography.Text>
              在本对话回复「确认 {intent.id.slice(0, 8)}」或「取消{' '}
              {intent.id.slice(0, 8)}」。
            </Typography.Text>
          )}
          <Button type="text" disabled={pending} onClick={onRead}>
            {intent.status === 'executing' ||
            intent.status === 'unknown' ||
            uncertain
              ? '查询原结果'
              : '更新状态'}
          </Button>
        </Space>
        <Typography.Text type="secondary">
          {intent.status === 'completed'
            ? '执行结果以实际回执为准。'
            : intent.status === 'waitingConfirmation'
              ? '等待本人对原提案的对话回复。'
              : ''}
        </Typography.Text>
      </footer>
    </article>
  );
}

/** Bound to one assistant response, rather than a second executable page or conversation footer. */
export function ConversationActionCards({
  conversationId,
  taskId,
  messageId,
  refreshKey = 0,
  onResolved,
}: {
  conversationId: string;
  taskId?: string;
  messageId?: string;
  refreshKey?: string | number;
  onResolved?: () => void;
}) {
  const [rows, setRows] = useState<ActionIntent[]>([]),
    [error, setError] = useState<string>(),
    [uncertain, setUncertain] = useState(new Set<string>()),
    [, setClock] = useState(0);
  const generation = useRef(0),
    activeAbort = useRef<AbortController | undefined>(undefined),
    scopeKey = `${conversationId}:${taskId ?? ''}:${messageId ?? ''}`;
  const base = `/me/conversations/${conversationId}/action-intents`;
  const acceptRows = useCallback(
    (intents: ActionIntent[]) => {
      const owner = currentIdentityOwner(),
        blocked = new Set<string>();
      for (const intent of intents) {
        if (
          intent.conversationId !== conversationId ||
          (taskId && intent.taskId !== taskId) ||
          (messageId && intent.messageId !== messageId)
        )
          throw new Error('动作卡不属于当前AI回复，未采用其他范围的确认内容。');
        if (!owner) {
          blocked.add(intent.id);
          continue;
        }
        try {
          const fence = readIntentDecisionFence(
            window.localStorage,
            owner,
            conversationId,
            intent.id,
          );
          if (intentIsTerminal(intent.status))
            clearIntentDecisionFence(
              window.localStorage,
              owner,
              conversationId,
              intent.id,
            );
          else if (fence) blocked.add(intent.id);
        } catch {
          blocked.add(intent.id);
        }
      }
      setRows(intents);
      setUncertain(blocked);
    },
    [conversationId, taskId, messageId],
  );
  const load = useCallback(
    async (id?: string) => {
      if (!taskId && !messageId) return;
      const epoch = ++generation.current,
        identity = identityContextEpoch();
      activeAbort.current?.abort();
      const controller = new AbortController();
      activeAbort.current = controller;
      try {
        const query = new URLSearchParams({
          pendingOnly: 'false',
          ...(taskId ? { taskId } : {}),
          ...(messageId ? { messageId } : {}),
        });
        const list = id
          ? [
              (
                await api(
                  `${base}/${id}`,
                  { signal: controller.signal },
                  actionIntentResponseSchema,
                )
              ).intent,
            ]
          : (
              await api(
                `${base}?${query}`,
                { signal: controller.signal },
                actionIntentListSchema,
              )
            ).intents;
        if (
          controller.signal.aborted ||
          epoch !== generation.current ||
          identity !== identityContextEpoch()
        )
          return;
        if (id) {
          const previous = rows.filter((row) => row.id !== id);
          acceptRows(
            [...previous, ...list].sort((a, b) =>
              a.createdAt.localeCompare(b.createdAt),
            ),
          );
        } else acceptRows(list);
        setError(undefined);
      } catch (failure) {
        if (!controller.signal.aborted && epoch === generation.current) {
          setError(describeError(failure));
          if (
            !id ||
            (failure instanceof ApiError &&
              [401, 403, 404].includes(failure.status))
          )
            setRows([]);
          else
            setUncertain(
              (current) => new Set([...current, ...rows.map((row) => row.id)]),
            );
        }
      }
    },
    [base, taskId, messageId, acceptRows, rows],
  );
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    setRows([]);
    setUncertain(new Set());
    void loadRef.current();
    return () => activeAbort.current?.abort();
  }, [scopeKey]);
  useEffect(() => {
    void loadRef.current();
  }, [refreshKey]);
  useEffect(
    () =>
      subscribeIdentityChanges(() => {
        generation.current++;
        activeAbort.current?.abort();
        setRows([]);
        setError(undefined);
        setUncertain(new Set());
      }),
    [],
  );
  const executing = rows.some((row) => row.status === 'executing');
  useEffect(() => {
    if (!executing) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadRef.current();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [executing, scopeKey]);
  useEffect(() => {
    if (!rows.some((row) => row.status === 'waitingConfirmation')) return;
    const timer = window.setInterval(
      () => setClock((value) => value + 1),
      30_000,
    );
    return () => window.clearInterval(timer);
  }, [rows]);
  useEffect(() => {
    const focus = () => {
      if (document.visibilityState === 'visible') void loadRef.current();
    };
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => {
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
    };
  }, [scopeKey]);
  useEffect(() => {
    const onReply = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === conversationId) {
        void loadRef.current();
        onResolved?.();
      }
    };
    window.addEventListener('aitesthub:conversation-confirmation', onReply);
    return () =>
      window.removeEventListener(
        'aitesthub:conversation-confirmation',
        onReply,
      );
  }, [conversationId, onResolved]);
  if (!rows.length && !error) return null;
  return (
    <section
      className="conversation-action-cards"
      aria-label="本条回复的操作确认"
    >
      {error ? (
        <Alert
          type="warning"
          showIcon
          title={error}
          action={
            <Button onClick={() => void loadRef.current()}>查询原状态</Button>
          }
        />
      ) : null}
      {rows.map((row) => (
        <ActionIntentCardView
          key={row.id}
          intent={row}
          uncertain={uncertain.has(row.id)}
          onRead={() => void loadRef.current(row.id)}
        />
      ))}
    </section>
  );
}
