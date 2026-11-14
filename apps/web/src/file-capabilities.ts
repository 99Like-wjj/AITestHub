import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { z } from 'zod';
import {
  fileResourceCapabilitiesSchema,
  resourceCapabilityQuerySchema,
} from '../../../packages/contracts/src/file-resources';
import { uiDeliverySupportedLimits } from '../../../packages/contracts/src/ui-delivery';
import { api, describeError, ApiError } from './api';
import {
  currentIdentityOwner,
  identityContextEpoch,
  subscribeIdentityChanges,
} from './identity-context';

export type FileCapabilities = z.infer<typeof fileResourceCapabilitiesSchema>;
export type CapabilityQuery = z.infer<typeof resourceCapabilityQuerySchema>;
export const webFileBinaryMaximumBytes = Number(
  uiDeliverySupportedLimits.fileBytes,
);
export function resourceByteLabel(value: string): string {
  const bytes = BigInt(value);
  if (bytes > 0n && bytes % 1024n ** 3n === 0n)
    return `${bytes / 1024n ** 3n} GiB`;
  if (bytes > 0n && bytes % 1024n ** 2n === 0n)
    return `${bytes / 1024n ** 2n} MiB`;
  return `${bytes} B`;
}
export async function readWebFileCapabilities(
  query: CapabilityQuery,
  signal?: AbortSignal,
) {
  const input = resourceCapabilityQuerySchema.parse(query),
    epoch = identityContextEpoch(),
    owner = currentIdentityOwner();
  const search = new URLSearchParams(Object.entries(input));
  const response = await api(
    `/files/capabilities?${search}`,
    signal ? { signal } : {},
    fileResourceCapabilitiesSchema,
  );
  if (
    BigInt(response.limits.maxFileBytes) >
      uiDeliverySupportedLimits.fileBytes ||
    BigInt(response.limits.maxSubmissionBytes) >
      uiDeliverySupportedLimits.batchFileBytes ||
    response.limits.maxFilesPerBatch >
      uiDeliverySupportedLimits.manifestItemsPerBatch
  )
    throw new ApiError(
      '服务端资源策略超出本浏览器版本的结构能力，请先升级客户端；未采用静态默认。',
      409,
      'RESOURCE_BINARY_UNSUPPORTED',
    );
  if (epoch !== identityContextEpoch() || owner !== currentIdentityOwner())
    throw new ApiError(
      '当前身份已变化，旧限额读取未采用。',
      409,
      'IDENTITY_CONTEXT_CHANGED',
    );
  const keys = Object.keys(input) as (keyof typeof input)[];
  if (
    Object.keys(response.subject).length !== keys.length ||
    keys.some(
      (key) =>
        (response.subject as Record<string, unknown>)[key] !== input[key],
    )
  )
    throw new ApiError(
      '限额响应不属于本次明确文件/项目身份。',
      409,
      'RESOURCE_SCOPE_MISMATCH',
    );
  return response;
}
type State = {
  key: object;
  status: 'loading' | 'ready' | 'error';
  data?: FileCapabilities;
  error?: string;
};
/** Read-only scope token, independent of mutation command identity. No fallback on404/403. */
export function useProjectFileCapabilities(
  projectId: string,
  enabled: boolean,
) {
  const identity = useSyncExternalStore(
      subscribeIdentityChanges,
      identityContextEpoch,
      identityContextEpoch,
    ),
    owner = currentIdentityOwner();
  const [retry, setRetry] = useState(0),
    key = useMemo(
      () => ({ projectId, identity, owner, enabled, retry, alive: false }),
      [projectId, identity, owner, enabled, retry],
    );
  const live = useRef(key);
  live.current = key;
  useLayoutEffect(() => {
    key.alive = true;
    return () => {
      key.alive = false;
    };
  }, [key]);
  const [state, setState] = useState<State>({ key, status: 'loading' });
  useEffect(() => {
    const abort = new AbortController();
    const current = () =>
      live.current === key &&
      key.alive &&
      key.identity === identityContextEpoch() &&
      key.owner === currentIdentityOwner() &&
      !abort.signal.aborted;
    if (!enabled || !projectId || key.owner === null)
      return () => abort.abort();
    setState({ key, status: 'loading' });
    void readWebFileCapabilities({ target: 'active', projectId }, abort.signal)
      .then((data) => {
        if (current())
          setState((previous) =>
            current() ? { key, status: 'ready', data } : previous,
          );
      })
      .catch((error) => {
        if (current())
          setState((previous) =>
            current()
              ? { key, status: 'error', error: describeError(error) }
              : previous,
          );
      });
    return () => abort.abort();
  }, [key, projectId, enabled]);
  const current =
    state.key === key ? state : { key, status: 'loading' as const };
  return { ...current, refresh: () => setRetry((value) => value + 1) };
}
