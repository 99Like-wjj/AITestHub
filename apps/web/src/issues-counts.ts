import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  issueCountsQuerySchema,
  issueCountsResponseSchema,
  type IssueCounts,
  type IssueCountsQuery,
} from '../../../packages/contracts/src/issues';
import { api, ApiError, describeError } from './api';
import {
  identityContextEpoch,
  currentIdentityOwner,
  subscribeIdentityChanges,
} from './identity-context';

/** Identity/project/query generation; a return to the same project gets a new token. */
export function useIssueReadScope(signature: string, expectedOwner?: string) {
  const identity = useSyncExternalStore(
      subscribeIdentityChanges,
      identityContextEpoch,
      identityContextEpoch,
    ),
    owner = currentIdentityOwner();
  const key = useMemo(
      () => ({ signature, identity, owner, expectedOwner, alive: false }),
      [signature, identity, owner, expectedOwner],
    ),
    live = useRef(key);
  live.current = key;
  useLayoutEffect(() => {
    key.alive = true;
    return () => {
      key.alive = false;
    };
  }, [key]);
  const isCurrent = () =>
    live.current === key &&
    key.alive &&
    key.identity === identityContextEpoch() &&
    key.owner !== null &&
    key.owner === currentIdentityOwner() &&
    (!key.expectedOwner || key.owner === key.expectedOwner);
  return {
    key,
    isCurrent,
    ownerReady: owner !== null && (!expectedOwner || owner === expectedOwner),
  };
}
export async function readIssueCounts(
  projectId: string,
  raw: IssueCountsQuery,
  context: { signal?: AbortSignal; isCurrent?: () => boolean } = {},
) {
  const identity = identityContextEpoch(),
    owner = currentIdentityOwner(),
    query = issueCountsQuerySchema.parse(raw);
  const current = () =>
    !context.signal?.aborted &&
    context.isCurrent?.() !== false &&
    identity === identityContextEpoch() &&
    owner !== null &&
    owner === currentIdentityOwner();
  if (!current())
    throw new ApiError(
      '当前身份、项目或筛选已变化，旧统计未采用。',
      409,
      'ISSUE_COUNT_CONTEXT_CHANGED',
    );
  const response = await api(
    `/projects/${projectId}/issues/counts?${new URLSearchParams(
      Object.entries(query)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)]),
    )}`,
    context.signal ? { signal: context.signal } : {},
    issueCountsResponseSchema,
  );
  if (!current())
    throw new ApiError(
      '当前身份、项目或筛选已变化，旧统计未采用。',
      409,
      'ISSUE_COUNT_CONTEXT_CHANGED',
    );
  if (
    response.projectId !== projectId ||
    JSON.stringify(response.filters) !== JSON.stringify(query)
  )
    throw new ApiError(
      '缺陷统计不属于当前项目与筛选，未采用。',
      409,
      'ISSUE_COUNT_SCOPE_MISMATCH',
    );
  return response;
}
export function useIssueCounts(
  projectId: string | null,
  raw: IssueCountsQuery,
  expectedOwner: string,
  enabled = true,
) {
  const [revision, setRevision] = useState(0),
    filterKey = JSON.stringify(issueCountsQuerySchema.parse(raw)),
    query = useMemo(
      () => issueCountsQuerySchema.parse(JSON.parse(filterKey) as unknown),
      [filterKey],
    );
  const scope = useIssueReadScope(
    JSON.stringify(['issue-counts', projectId, filterKey, revision, enabled]),
    expectedOwner,
  );
  const [record, setRecord] = useState<{
    key: object | null;
    status: 'loading' | 'ready' | 'error';
    data?: IssueCounts;
    error?: string;
  }>({ key: null, status: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    if (!projectId || !enabled || !scope.ownerReady)
      return () => controller.abort();
    const current = () => scope.isCurrent() && !controller.signal.aborted;
    setRecord((previous) =>
      current() ? { key: scope.key, status: 'loading' } : previous,
    );
    void readIssueCounts(projectId, query, {
      signal: controller.signal,
      isCurrent: current,
    })
      .then((data) =>
        setRecord((previous) =>
          current() ? { key: scope.key, status: 'ready', data } : previous,
        ),
      )
      .catch((error) =>
        setRecord((previous) =>
          current()
            ? { key: scope.key, status: 'error', error: describeError(error) }
            : previous,
        ),
      );
    return () => controller.abort();
  }, [scope.key, projectId, enabled]);
  const current =
    record.key === scope.key && scope.isCurrent()
      ? record
      : { key: scope.key, status: 'loading' as const };
  return { ...current, refresh: () => setRevision((value) => value + 1) };
}
