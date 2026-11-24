import type { Asset } from '../../../packages/contracts/src/assets';
import { currentIdentityOwner } from './identity-context';
import { requestNavigation } from './navigation-guard';
import type { CaseScope } from './requirements';
import { workspaceDrafts } from './workspace-drafts';

export type UiSupplementSource = {
  caseId: string;
  revisionId: string;
  meetingId?: string;
  opinionId?: string;
  round?: number;
};

export function openUiScenarioDraft({
  scope,
  scene,
  userId,
  source,
}: {
  scope: CaseScope;
  scene: Asset;
  userId: string;
  source?: UiSupplementSource | undefined;
}) {
  if (
    currentIdentityOwner() !== userId ||
    scene.projectId !== scope.projectId ||
    scene.targetType !== 'scenario' ||
    scene.kind !== 'UI' ||
    scene.removedAt
  )
    return;
  requestNavigation(() => {
    if (currentIdentityOwner() !== userId) return;
    const draft = 'new:detached:' + crypto.randomUUID();
    const note =
      '先读取关联用例、当前评审轮次和原意见。保存时记录实际依据的用例修订和意见。';
    workspaceDrafts(userId).set(draft, {
      content: [
        `请为「${scope.title}」的「${scene.title}」场景设计 UI 用例。`,
        source
          ? note
          : '结合当前需求资料、场景目标和场景意见，补充现有用例的覆盖缺口。',
        '先展示用例候选、依据和待确认项。经我确认后，仅在该场景保存待评审用例。',
      ].join('\n\n'),
      references: [
        {
          id: crypto.randomUUID(),
          label: scope.title,
          note: '记录设计时采用的需求资料。',
          reference: {
            kind: 'requirementVersion',
            requirementVersionId: scope.requirementVersionId,
            dataScope: 'authorizedRelevantTestData',
          },
        },
      ],
      operationTarget: {
        projectId: scope.projectId,
        requirementId: scope.requirementId,
        objectIds: [scene.id, ...(source ? [source.caseId] : [])],
      },
      skillIds: ['ath-case-design'],
    });
    window.location.hash =
      'workspace?' +
      new URLSearchParams({ projectId: scope.projectId, draft }).toString();
  });
}
