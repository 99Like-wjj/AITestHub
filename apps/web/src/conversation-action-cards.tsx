import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Space, Tag, Typography } from 'antd';
import {
  actionIntentDecisionSchema,
  actionIntentListSchema,
  actionIntentResponseSchema,
  type ActionIntent,
} from '../../../packages/contracts/src/action-intents';
import { api, ApiError, describeError, isUncertainMutationError } from './api';
import {
  currentIdentityOwner,
  identityContextEpoch,
  subscribeIdentityChanges,
} from './identity-context';
import {
  beginIntentDecision,
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
  onDecision,
  onRead,
}: {
  intent: ActionIntent;
  pending?: boolean;
  uncertain?: boolean;
  onDecision: (decision: 'execute' | 'cancel') => void;
  onRead: () => void;
}) {
  const allowed = canDecideIntent(intent.status, intent.expiresAt, uncertain);
  const displayStatus =
    intent.status === 'waitingConfirmation' && !allowed && !uncertain
      ? 'expired'
      : intent.status;
  const result = intent.resultPresentation;
  const targets = intent.targets ?? [];
  const showingResult =
    result && ['completed', 'declined', 'failed'].includes(displayStatus);
  const needsRead =
    uncertain || displayStatus === 'unknown' || displayStatus === 'executing';
  return (
    <article
      className="conversation-action-card"
      aria-label={(showingResult ? '变更结果：' : '操作确认：') + intent.title}
      data-action-intent={intent.id}
    >
      <header>
        <div className="conversation-action-title">
          <Typography.Text strong>{intent.title}</Typography.Text>
          {intent.projectName && (
            <Typography.Text type="secondary">
              {intent.projectName}
            </Typography.Text>
          )}
        </div>
        <Tag
          color={
            displayStatus === 'waitingConfirmation'
              ? 'gold'
              : displayStatus === 'completed'
                ? 'green'
                : displayStatus === 'failed'
                  ? 'error'
                  : 'default'
          }
        >
          {intentStatusLabels[displayStatus]}
        </Tag>
      </header>
      <Typography.Paragraph className="conversation-action-summary">
        {showingResult ? result.summary : intent.summary}
      </Typography.Paragraph>
      {showingResult && result.items.length > 0 && (
        <ul className="conversation-action-items" aria-label="逐项变更结果">
          {result.items.map((item, index) => (
            <li key={index}>
              <span>{item.subject}</span>
              <strong>{item.outcome}</strong>
              {item.detail && (
                <span className="conversation-action-item-detail">
                  {item.detail}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {(!showingResult || !result.items.length) && targets.length > 0 && (
        <ul className="conversation-action-items" aria-label="本次变更对象">
          {targets.map((label, index) => (
            <li key={index}>
              <span>{label}</span>
            </li>
          ))}
        </ul>
      )}
      {intent.changes.length > 0 &&
        (!showingResult ||
          (displayStatus === 'completed' && !result.items.length)) && (
          <dl className="conversation-action-changes">
            {intent.changes.map((change, index) => (
              <div key={index}>
                <dt>{change.label}</dt>
                <dd>
                  {change.before && (
                    <>
                      <span>{change.before}</span>
                      <span aria-label="变更为"> → </span>
                    </>
                  )}
                  <strong>{change.after ?? '移除'}</strong>
                </dd>
              </div>
            ))}
          </dl>
        )}
      {!showingResult && intent.details.length > 0 && (
        <div className="conversation-action-scope">
          {intent.details.map((item, index) => (
            <span key={index}>
              {item.label} · {item.value}
            </span>
          ))}
        </div>
      )}
      {uncertain && (
        <Alert
          type="warning"
          showIcon
          title="原结果尚待核对"
          description="请查询同一份提案的原结果。"
        />
      )}
      {displayStatus === 'expired' && (
        <Typography.Paragraph type="secondary">
          确认已过期，请重新说明需要执行的变更。
        </Typography.Paragraph>
      )}
      {displayStatus === 'unknown' && (
        <Typography.Paragraph type="secondary">
          结果暂未确认，请查询原结果。
        </Typography.Paragraph>
      )}
      {(allowed || needsRead) && (
        <footer>
          <Space size={8}>
            {allowed && (
              <>
                <Button
                  type="primary"
                  loading={pending}
                  disabled={pending}
                  onClick={() => onDecision('execute')}
                >
                  确认
                </Button>
                <Button disabled={pending} onClick={() => onDecision('cancel')}>
                  取消
                </Button>
              </>
            )}
            {needsRead && (
              <Button disabled={pending} onClick={onRead}>
                查询原结果
              </Button>
            )}
          </Space>
          {allowed && (
            <Typography.Text
              className="conversation-action-chat-hint"
              type="secondary"
            >
              也可回复「确认 {intent.id.slice(0, 8)}」
            </Typography.Text>
          )}
        </footer>
      )}
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
    [pendingId, setPendingId] = useState<string>(),
    [uncertain, setUncertain] = useState(new Set<string>()),
    [, setClock] = useState(0);
  const generation = useRef(0),
    activeAbort = useRef<AbortController | undefined>(undefined),
    deciding = useRef(false),
    scopeKey = `${conversationId}:${taskId ?? ''}:${messageId ?? ''}`;
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
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
    setPendingId(undefined);
    deciding.current = false;
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
  async function decide(row: ActionIntent, decision: 'execute' | 'cancel') {
    if (
      deciding.current ||
      !canDecideIntent(row.status, row.expiresAt, uncertain.has(row.id))
    )
      return;
    const originalScope = scopeKey,
      identity = identityContextEpoch(),
      owner = currentIdentityOwner();
    if (!owner) {
      setError('当前账号尚未核对，未发送执行决定。');
      return;
    }
    deciding.current = true;
    generation.current++;
    activeAbort.current?.abort();
    setPendingId(row.id);
    setError(undefined);
    try {
      const input = actionIntentDecisionSchema.parse({
        revision: row.revision,
        scopeDigest: row.scopeDigest,
        decision,
      });
      beginIntentDecision(window.localStorage, owner, {
        id: row.id,
        conversationId,
        revision: row.revision,
        scopeDigest: row.scopeDigest,
        decision,
        createdAt: new Date().toISOString(),
      });
      setUncertain((current) => new Set([...current, row.id]));
      const result = (
        await api(
          `${base}/${row.id}/decision`,
          { method: 'POST', body: input },
          actionIntentResponseSchema,
        )
      ).intent;
      if (
        originalScope !== currentScope.current ||
        identity !== identityContextEpoch()
      )
        return;
      if (
        result.id !== row.id ||
        result.scopeDigest !== row.scopeDigest ||
        result.revision < row.revision
      )
        throw new Error('原执行回执的精确意图不一致，请只查询原结果。');
      generation.current++;
      activeAbort.current?.abort();
      acceptRows(
        rows.map((intent) => (intent.id === row.id ? result : intent)),
      );
      onResolved?.();
    } catch (failure) {
      if (
        originalScope === currentScope.current &&
        identity === identityContextEpoch()
      ) {
        if (!isUncertainMutationError(failure)) {
          clearIntentDecisionFence(
            window.localStorage,
            owner,
            conversationId,
            row.id,
          );
          setUncertain((prior) => {
            const next = new Set(prior);
            next.delete(row.id);
            return next;
          });
          void loadRef.current(row.id);
        }
        setError(describeError(failure));
      }
    } finally {
      if (
        originalScope === currentScope.current &&
        identity === identityContextEpoch()
      ) {
        deciding.current = false;
        setPendingId(undefined);
      }
    }
  }
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
          pending={pendingId === row.id}
          onDecision={(choice) => void decide(row, choice)}
          uncertain={uncertain.has(row.id)}
          onRead={() => void loadRef.current(row.id)}
        />
      ))}
    </section>
  );
}
