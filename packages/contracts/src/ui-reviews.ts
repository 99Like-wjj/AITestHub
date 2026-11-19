import { z } from 'zod';
import { commandIdSchema, idSchema, timestampSchema } from './base.js';
import { assetSchema } from './assets.js';
import { uiCaseContentSchema } from './domain.js';

const caseIds = z.array(idSchema).min(1).max(1000).refine((ids) => new Set(ids).size === ids.length);
const opinionBody = z.string().trim().min(1).max(10_000);
const rowVersion = z.number().int().positive();
const roundNo = z.number().int().positive();

export const uiReviewStartSchema = z.strictObject({
  commandId: commandIdSchema,
  requirementVersionId: idSchema,
  caseIds,
});

const basis = z.strictObject({
  caseId: idSchema,
  revisionId: idSchema,
  revisionNo: rowVersion,
  rowVersion,
  scenarioRevisionId: idSchema,
  setRevisionId: idSchema,
});
export const uiReviewDraftOpinionSchema = z.strictObject({
  id: idSchema.optional(),
  body: opinionBody,
  target: z.enum(['case', 'scenario', 'set']),
  targetId: idSchema,
  caseIds,
});
const opinion = uiReviewDraftOpinionSchema.required({ id: true }).safeExtend({
  authorId: idSchema,
  createdAt: timestampSchema,
});

const workItem = z.strictObject({
  opinionId: idSchema,
  basis,
  round: roundNo,
  state: z.enum(['waiting', 'returned', 'resolved', 'rework']),
  instruction: opinionBody.optional(),
  reply: z.strictObject({
    body: opinionBody,
    outcome: z.enum(['changed', 'retained', 'unaddressed']),
    revisionId: idSchema,
    actorId: idSchema,
    time: timestampSchema,
  }).optional(),
  decision: z.strictObject({
    actorId: idSchema,
    time: timestampSchema,
    acceptedRevisionId: idSchema.optional(),
  }).optional(),
});

export const uiReviewMeetingStateSchema = z.strictObject({
  scope: z.array(basis),
  draftOpinions: z.array(opinion),
  noChange: z.array(basis),
  opinions: z.array(opinion),
  items: z.array(workItem),
  finalized: z.boolean(),
});
export type UiReviewMeetingState = z.infer<typeof uiReviewMeetingStateSchema>;
export type UiReviewWorkItem = z.infer<typeof workItem>;
export type UiReviewBasis = z.infer<typeof basis>;
export type UiReviewOpinion = z.infer<typeof opinion>;

export const uiReviewReplySchema = z.strictObject({
  commandId: commandIdSchema,
  caseId: idSchema,
  opinionId: idSchema,
  round: roundNo,
  baseRevisionId: idSchema,
  revisionId: idSchema,
  outcome: z.enum(['changed', 'retained', 'unaddressed']),
  body: opinionBody,
});

export const uiReviewUpdateSchema = z.discriminatedUnion('action', [
  z.strictObject({
    commandId: commandIdSchema,
    action: z.literal('save-draft'),
    rowVersion,
    opinion: uiReviewDraftOpinionSchema,
  }),
  z.strictObject({
    commandId: commandIdSchema,
    action: z.literal('remove-draft'),
    rowVersion,
    opinionId: idSchema,
  }),
  z.strictObject({
    commandId: commandIdSchema,
    action: z.literal('no-change'),
    rowVersion,
    caseId: idSchema,
  }),
  z.strictObject({
    commandId: commandIdSchema,
    action: z.literal('finalize'),
    rowVersion,
  }),
  z.strictObject({
    commandId: commandIdSchema,
    action: z.literal('supplement'),
    rowVersion,
    opinion: uiReviewDraftOpinionSchema.omit({ id: true }),
  }),
  z.strictObject({
    commandId: commandIdSchema,
    action: z.literal('decide'),
    rowVersion,
    opinionId: idSchema,
    caseId: idSchema,
    revisionId: idSchema,
    decision: z.enum(['resolve', 'return']),
    instruction: opinionBody.optional(),
  }),
]);
export const uiReviewRoomSummarySchema = z.strictObject({
  id: idSchema,
  requirementVersionId: idSchema,
  rowVersion,
  createdAt: timestampSchema,
  createdBy: idSchema,
  caseCount: z.number().int().nonnegative(),
  finalized: z.boolean(),
});
export const uiReviewMeetingListSchema = z.strictObject({ meetings: z.array(uiReviewRoomSummarySchema) });
export const uiReviewMeetingMutationSchema = z.strictObject({ meeting: uiReviewRoomSummarySchema });
export const uiReviewMeetingDetailSchema = uiReviewMeetingMutationSchema.extend({
  state:uiReviewMeetingStateSchema,
  cases:z.array(assetSchema),
  revisions:z.array(z.strictObject({id:idSchema,revisionNo:rowVersion,content:uiCaseContentSchema})),
});
export const uiReviewHandoffSchema = uiReviewMeetingMutationSchema.extend({
  items:z.array(workItem.extend({opinion,baseChanged:z.boolean(),asset:assetSchema})),
});
