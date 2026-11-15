import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  modelConnectionProbeReceiptSchema,
  type ModelConnectionObservation,
  type ModelConnectionProbeReceipt,
} from '../../../packages/contracts/src/model-connections';
import { api, ApiError, describeError, isUncertainMutationError } from './api';
import { currentIdentityOwner, identityContextEpoch } from './identity-context';

const pendingSchema = z.strictObject({ commandId: z.uuid() });
const labels = {
  connected: '已连通',
  failed: '最近调用未成功',
  pending: '调用中 / 待核对',
};

export function ModelConnectionControl({
  serviceId,
  entryId,
  revision,
  enabled,
  observation,
  onTested,
}: {
  serviceId: string;
  entryId: string;
  revision: number;
  enabled: boolean;
  observation: ModelConnectionObservation | undefined;
  onTested: () => void;
}) {
  const ownerId = currentIdentityOwner();
  const scope = `${ownerId}:${serviceId}:${entryId}:${revision}`;
  const storageKey = `aitesthub:model-connection-test:${scope}`;
  const current = useRef(scope);
  const alive = useRef(true);
  current.current = scope;
  const [pending, setPending] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [storageError, setStorageError] = useState(false),
    [error, setError] = useState<string>(),
    [result, setResult] = useState<ModelConnectionProbeReceipt['probe'] | null>(
      null,
    );
  const dispatching = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    setPending(null);
    setResult(null);
    setError(undefined);
    setBusy(false);
    setStorageError(false);
    try {
      const saved = window.sessionStorage.getItem(storageKey);
      if (saved) setPending(pendingSchema.parse(JSON.parse(saved)).commandId);
    } catch {
      setStorageError(true);
    }
  }, [storageKey]);
  async function test() {
    if (
      !ownerId ||
      currentIdentityOwner() !== ownerId ||
      dispatching.current ||
      storageError
    )
      return;
    const epoch = identityContextEpoch(),
      expectedScope = scope;
    let commandId = pending;
    const isRead = commandId !== null;
    if (!commandId) {
      commandId = crypto.randomUUID();
      try {
        window.sessionStorage.setItem(
          storageKey,
          JSON.stringify({ commandId }),
        );
      } catch {
        setStorageError(true);
        return;
      }
      setPending(commandId);
    }
    dispatching.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const response = await api(
        `/admin/model-services/${serviceId}/connection-tests${isRead ? '/' + commandId : ''}`,
        isRead
          ? {}
          : {
              method: 'POST',
              body: {
                commandId,
                modelEntryId: entryId,
                serviceRevision: revision,
              },
              timeoutMs: 90_000,
            },
        modelConnectionProbeReceiptSchema,
      );
      if (
        !alive.current ||
        epoch !== identityContextEpoch() ||
        currentIdentityOwner() !== ownerId ||
        current.current !== expectedScope
      )
        return;
      const probe = response.probe;
      if (
        probe.commandId !== commandId ||
        probe.modelServiceId !== serviceId ||
        probe.modelEntryId !== entryId ||
        probe.serviceRevision !== revision
      )
        throw new ApiError(
          '连接测试回执不属于本次模型与配置修订，请查询原测试。',
          502,
          'RESPONSE_SCHEMA_MISMATCH',
        );
      setResult(probe);
      if (probe.state === 'connected' || probe.state === 'failed') {
        try {
          window.sessionStorage.removeItem(storageKey);
        } catch {
          /* The original terminal receipt remains safe to read again. */
        }
        setPending(null);
        onTested();
      }
    } catch (failure) {
      if (
        alive.current &&
        epoch === identityContextEpoch() &&
        currentIdentityOwner() === ownerId &&
        current.current === expectedScope
      ) {
        if (isRead || isUncertainMutationError(failure)) {
          setError(
            describeError(failure) +
              ' 原测试标识已保留，可查询结果；不会自动重新调用模型。',
          );
        } else {
          try {
            window.sessionStorage.removeItem(storageKey);
          } catch {
            /* A retained identifier can only recover the same request. */
          }
          setPending(null);
          setError(describeError(failure));
        }
      }
    } finally {
      dispatching.current = false;
      if (alive.current && current.current === expectedScope) setBusy(false);
    }
  }
  const state =
    result?.state === 'connected' || result?.state === 'failed'
      ? result.state
      : pending
        ? 'pending'
        : observation?.state;
  return (
    <div className="model-connection-control">
      <span
        className={`badge ${state === 'connected' ? 'green' : state === 'failed' ? 'red' : ''}`}
      >
        {state ? labels[state] : '未测试连接'}
      </span>
      {observation && (
        <div className="caption mt">
          最近调用记录：
          {new Date(observation.checkedAt).toLocaleString('zh-CN')}
        </div>
      )}
      <button
        className="btn mt"
        type="button"
        disabled={busy || storageError || (!pending && !enabled)}
        title="仅发送固定测试提示，不读取项目资料；会产生一次模型调用"
        onClick={() => void test()}
      >
        {busy ? '正在核对…' : pending ? '查询测试结果' : '测试连接'}
      </button>
      {storageError && (
        <p className="caption">
          浏览器测试记录不可用，本次未发送；请恢复浏览器存储后再试。
        </p>
      )}
      {pending && !busy && (
        <p className="caption">
          原测试仍在执行或受理待核对；查询不会重新调用模型。
        </p>
      )}
      {result?.state === 'connected' && (
        <p className="caption">
          基础连接已通过；工具、图片等能力仍按下方独立记录。
        </p>
      )}
      {result?.state === 'failed' && (
        <p className="caption">
          未得到完整文字回复
          {result.upstreamHttpStatus
            ? `（上游 HTTP ${result.upstreamHttpStatus}）`
            : ''}
          ，请核对地址、模型 ID、Key 或输出配置。
        </p>
      )}
      {error && (
        <p role="alert" className="caption">
          {error}
        </p>
      )}
    </div>
  );
}
