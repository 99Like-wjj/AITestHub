import { z } from 'zod';
import { uiReviewMeetingMutationSchema } from '../../../packages/contracts/src/ui-reviews';
import { api } from './api';

export function uiReviewPath(projectId: string) {
  return '/projects/' + projectId + '/assets/ui-review-meetings';
}

export function readUiReviewReceipt(
  path: string,
  targetPath: string,
  commandId: string,
) {
  const operation =
    path === targetPath ? 'reviews.meeting-create' : 'reviews.meeting-update';
  return api(
    path +
      '/receipt/' +
      encodeURIComponent(commandId) +
      '?operation=' +
      operation,
    {},
    z.strictObject({
      status: z.enum(['completed', 'failed', 'pending', 'unknown']),
      response: uiReviewMeetingMutationSchema.nullable(),
    }),
  );
}
