import { useEffect, useState } from 'react';
import { z } from 'zod';
import { assetNavigationSchema } from '../../../packages/contracts/src/assets';
import { requirementEligibleParticipantsSchema } from '../../../packages/contracts/src/requirements';
import { requirementDetailSchema } from '../../../packages/contracts/src/requirements';
import { api, describeError } from './api';
import { useIssueReadScope } from './issues-counts';

export const issueSourceLabels = {
  manualTester: '测试人员手工发现',
  manualProduct: '产品人员手工发现',
  confirmedProblem: '待确认问题经测试确认',
  uiResult: 'UI结果发现',
  apiResult: '接口结果发现',
  extraFinding: '其他人工发现',
} as const;

export const problemExecutionProvenanceLabels = {
  'local-ai': '本地AI执行来源',
  'protocol-synthetic': '合成协议来源，非真实UI执行',
  unknown: '执行来源未确认',
  'platform-api': '平台接口执行来源',
} as const;
export type IssueNavigation = z.infer<
  typeof assetNavigationSchema
>['requirements'];
export type IssueMember = z.infer<
  typeof requirementEligibleParticipantsSchema
>['users'][number];
type RequirementMetadata = {
  id: string;
  title: string;
  versions: { id: string; versionNo: number }[];
};
/** Resolve only the opened historical object; never add it to a filtered browse tree. */
export function useRequirementMetadata(
  projectId: string,
  requirementId: string | null,
  visibleRequirements: IssueNavigation,
) {
  const listed = visibleRequirements.find((row) => row.id === requirementId);
  const [reload, setReload] = useState(0);
  const [lookup, setLookup] = useState<{
    key: object;
    metadata: RequirementMetadata | null;
    error?: string;
  } | null>(null);
  const scope = useIssueReadScope(
    JSON.stringify([
      'issue-requirement-metadata',
      projectId,
      requirementId,
      Boolean(listed),
      reload,
    ]),
  );
  const hasListed = Boolean(listed);
  useEffect(() => {
    const controller = new AbortController();
    if (!requirementId || hasListed || !scope.ownerReady)
      return () => controller.abort();
    const current = () => scope.isCurrent() && !controller.signal.aborted;
    setLookup((previous) =>
      current() ? { key: scope.key, metadata: null } : previous,
    );
    void api(
      `/projects/${projectId}/requirements/${requirementId}`,
      { signal: controller.signal },
      requirementDetailSchema,
    )
      .then((response) => {
        if (!current()) return;
        setLookup((previous) =>
          current()
            ? {
                key: scope.key,
                metadata: {
                  id: response.requirement.id,
                  title: response.requirement.title,
                  versions: response.versions.map((version) => ({
                    id: version.id,
                    versionNo: version.versionNo,
                  })),
                },
              }
            : previous,
        );
      })
      .catch((error) => {
        if (current())
          setLookup((previous) =>
            current()
              ? { key: scope.key, metadata: null, error: describeError(error) }
              : previous,
          );
      });
    return () => controller.abort();
  }, [scope.key]);
  const current =
    lookup?.key === scope.key && scope.isCurrent() ? lookup : null;
  return {
    requirement: scope.ownerReady
      ? (listed ?? current?.metadata ?? null)
      : null,
    loading: Boolean(
      requirementId && !listed && !current?.metadata && !current?.error,
    ),
    error: listed ? undefined : current?.error,
    refresh: () => setReload((value) => value + 1),
  };
}
export function useIssueContext(
  projectId: string | null,
  includeArchivedRequirements = true,
  expectedOwner?: string,
) {
  const scope = useIssueReadScope(
    JSON.stringify(['issue-context', projectId, includeArchivedRequirements]),
    expectedOwner,
  );
  const [record, setRecord] = useState<{
    key: object;
    requirements: IssueNavigation;
    members: IssueMember[];
    error: string | undefined;
  }>();
  useEffect(() => {
    const controller = new AbortController();
    if (!projectId || !scope.ownerReady) return () => controller.abort();
    const current = () => scope.isCurrent() && !controller.signal.aborted;
    void Promise.allSettled([
      api(
        `/projects/${projectId}/assets/navigation?kind=UI&includeArchivedRequirements=${includeArchivedRequirements}`,
        { signal: controller.signal },
        assetNavigationSchema,
      ),
      api(
        `/projects/${projectId}/requirements/eligible-participants`,
        { signal: controller.signal },
        requirementEligibleParticipantsSchema,
      ),
    ]).then((results) => {
      if (!current()) return;
      const [navigation, people] = results;
      const errors = results
        .filter((result) => result.status === 'rejected')
        .map((result) => describeError(result.reason));
      setRecord((previous) =>
        current()
          ? {
              key: scope.key,
              requirements:
                navigation.status === 'fulfilled'
                  ? navigation.value.requirements
                  : [],
              members: people.status === 'fulfilled' ? people.value.users : [],
              error: errors.length ? errors.join('；') : undefined,
            }
          : previous,
      );
    });
    return () => controller.abort();
  }, [scope.key]);
  return record?.key === scope.key && scope.isCurrent()
    ? record
    : { requirements: [], members: [], error: undefined };
}
export const issueStateLabels = {
  pending: '待处理',
  inProgress: '处理中',
  awaitingRetest: '待复测',
  closed: '已关闭',
};
export const severityLabels = { severe: '严重', normal: '一般', minor: '轻微' };
export const problemStateLabels = {
  pendingConfirmation: '待测试确认',
  confirmed: '已确认正式缺陷',
  dismissed: '已判定非缺陷',
};
