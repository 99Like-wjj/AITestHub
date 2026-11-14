import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { planningOperationStatusSchema } from '../../../packages/contracts/src/plans';
import { api, ApiError, describeError } from './api';
import { useBusinessCommand } from './business-command';

const storageKey = 'aitesthub:planning-unconfirmed:v2';
export const PlanningActorContext = createContext<string | null>(null);
const changed = 'aitesthub:planning-command-changed';
const recordSchema = z.strictObject({
  userId: z.uuid(),
  projectId: z.uuid(),
  key: z.uuid(),
  operation: z.string(),
  targetId: z.uuid().nullable(),
  label: z.string(),
});
type Record = z.infer<typeof recordSchema>;
export function uncertainPlanningError(error: unknown) {
  return (
    error instanceof ApiError &&
    (error.status === 0 ||
      error.status >= 500 ||
      error.code === 'OPERATION_RESULT_UNKNOWN')
  );
}
function records(): Record[] {
  try {
    return z
      .array(recordSchema)
      .parse(JSON.parse(sessionStorage.getItem(storageKey) ?? '[]'));
  } catch {
    return [];
  }
}
function remember(record: Record, remove = false) {
  try {
    const next = records().filter(
      (item) =>
        item.key !== record.key ||
        item.userId !== record.userId ||
        item.projectId !== record.projectId,
    );
    if (!remove) next.push(record);
    sessionStorage.setItem(storageKey, JSON.stringify(next));
    window.dispatchEvent(new Event(changed));
  } catch {
    /* Server-side command identities remain authoritative when browser storage is unavailable. */
  }
}
export function usePlanningPending(
  projectId: string | undefined,
  actorId?: string,
) {
  const contextualActor = useContext(PlanningActorContext),
    userId = actorId ?? contextualActor;
  const [items, setItems] = useState<Record[]>([]);
  useEffect(() => {
    const refresh = () =>
      setItems(
        records().filter(
          (item) => item.projectId === projectId && item.userId === userId,
        ),
      );
    refresh();
    window.addEventListener(changed, refresh);
    return () => window.removeEventListener(changed, refresh);
  }, [projectId, userId]);
  return items;
}
export function usePlanningCommand(
  projectId: string,
  session: string | null,
  actorId?: string,
) {
  const contextualActor = useContext(PlanningActorContext),
    userId = actorId ?? contextualActor;
  const scope = userId && session ? `${userId}:${session}` : null;
  const current = useRef(scope);
  current.current = scope;
  const command = useBusinessCommand(scope);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => setBlocked(false), [scope]);
  async function run<T>(
    operation: string,
    targetId: string | null,
    label: string,
    action: (key: string) => Promise<T>,
  ) {
    if (blocked || !userId) return null;
    const originalScope = scope;
    return command.run(async (key) => {
      const record = { userId, projectId, key, operation, targetId, label };
      // Only identifiers are retained, never plan content, credentials or submitted JSON.
      remember(record);
      try {
        const result = await action(key);
        remember(record, true);
        return result;
      } catch (error) {
        if (!uncertainPlanningError(error)) remember(record, true);
        else if (current.current === originalScope) setBlocked(true);
        throw error;
      }
    });
  }
  return {
    ...command,
    run,
    uncertain: command.uncertain || blocked,
    confirmRecoveredReceipt: () => {
      setBlocked(false);
      command.confirmRecoveredReceipt();
    },
  };
}
async function original(record: Record) {
  const family = record.operation.startsWith('schedules.')
    ? 'schedules'
    : 'plans';
  return api(
    `/projects/${record.projectId}/${family}/operation-status?operation=${encodeURIComponent(record.operation)}&key=${encodeURIComponent(record.key)}`,
    {},
    planningOperationStatusSchema,
  );
}
export function PlanningRecovery<T>({
  projectId,
  operation,
  command,
  schema,
  onRecovered,
}: {
  projectId: string;
  operation: string;
  command: ReturnType<typeof usePlanningCommand>;
  schema: z.ZodType<T>;
  onRecovered: (value: T) => void;
}) {
  const [pending, setPending] = useState(false),
    [status, setStatus] = useState('');
  const userId = useContext(PlanningActorContext);
  if (!command.uncertain) return null;
  return (
    <div className="notice amber mt" role="status">
      <p>
        未收到确定回执，已停止重发。原提交标识：
        <span className="mono">{command.commandId}</span>
      </p>
      <button
        className="btn small mt"
        disabled={pending}
        onClick={() => {
          setPending(true);
          const record = {
            userId: userId ?? '',
            projectId,
            key: command.commandId,
            operation,
            targetId: null,
            label: operation,
          };
          void original(record)
            .then((result) => {
              if (result.command.projectId !== projectId)
                throw new Error('原回执项目不符。');
              if (result.command.status === 'completed') {
                const value = schema.parse(result.command.response);
                remember(record, true);
                command.confirmRecoveredReceipt();
                onRecovered(value);
              } else
                setStatus(`原操作状态：${result.command.status}。未重复提交。`);
            })
            .catch((error) =>
              setStatus(
                error instanceof ApiError && error.status === 404
                  ? '暂未检索到已提交回执，不代表原操作未发生，请继续只读核对。'
                  : describeError(error),
              ),
            )
            .finally(() => setPending(false));
        }}
      >
        {pending ? '查询中…' : '查询原操作回执'}
      </button>
      {status && <p className="caption mt">{status}</p>}
    </div>
  );
}
export function PlanningPendingBanner({
  projectId,
  onRecovered,
}: {
  projectId: string;
  onRecovered: () => void;
}) {
  const items = usePlanningPending(projectId),
    [checking, setChecking] = useState<string>(),
    [status, setStatus] = useState('');
  if (!items.length && !status) return null;
  return (
    <div className="notice amber mb" role="status">
      {items.length > 0 && (
        <p>以下操作尚待原回执核对。同一目标的写入已暂停，其他资料仍可浏览。</p>
      )}
      {items.map((item) => (
        <div className="row wrap mt" key={item.key}>
          <span className="grow small">
            {item.label} · <span className="mono">{item.key}</span>
          </span>
          <button
            className="btn small"
            disabled={checking !== undefined}
            onClick={() => {
              setChecking(item.key);
              void original(item)
                .then((result) => {
                  if (result.command.status === 'completed') {
                    remember(item, true);
                    setStatus(
                      `${item.label}的原操作已完成，请以刷新后的实际资料为准。`,
                    );
                    onRecovered();
                  } else
                    setStatus(
                      `${item.label}原操作状态：${result.command.status}，没有重发。`,
                    );
                })
                .catch((error) =>
                  setStatus(
                    error instanceof ApiError && error.status === 404
                      ? '暂未取得原回执，不代表未受理；保留原标识继续只读核对。'
                      : describeError(error),
                  ),
                )
                .finally(() => setChecking(undefined));
            }}
          >
            查询原操作
          </button>
        </div>
      ))}
      {status && <p className="caption mt">{status}</p>}
    </div>
  );
}
