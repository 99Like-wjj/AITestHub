import type { z } from 'zod';
import type { Asset } from '../../../packages/contracts/src/assets';
import type { uiPlanEligibilitySchema } from '../../../packages/contracts/src/plans';

export type UiPlanEligibility = z.infer<
  typeof uiPlanEligibilitySchema
>['items'][number];

export function matchingApproval(
  asset: Asset,
  item: UiPlanEligibility | undefined,
) {
  if (
    item?.caseId !== asset.id ||
    !item.eligible ||
    item.approvedRevisionId !== asset.revisionId
  )
    return undefined;
  return item.approvalSnapshotId ?? undefined;
}

export function uiPlanHandoffHash(
  projectId: string,
  versionId: string,
  approvals: { asset: Asset; approvalSnapshotId: string }[],
) {
  const query = new URLSearchParams({ projectId, kind: 'UI', versionId });
  for (const { asset, approvalSnapshotId } of approvals) {
    query.append('caseId', asset.id);
    query.append('approvalSnapshotId', approvalSnapshotId);
  }
  return 'plans?' + query.toString();
}
