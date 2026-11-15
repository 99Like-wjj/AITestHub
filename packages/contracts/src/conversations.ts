import { modelDataScopeSchema } from './configuration.js';
import { z } from 'zod';
import { workspaceAccessModeSchema } from './workspace-access.js';
import {
commandIdSchema,
idSchema,
persistedRowVersionSchema,
rowVersionSchema,
timestampSchema,
sha256Schema,
decimalCountSchema,
} from './base.js';
import { modelSelectionInputSchema } from './configuration.js';
import {
modelSelectionV2Schema,
messageModelSnapshotV2Schema,
} from './model-configuration-v2.js';
import { modelAttemptViewSchema,modelRetryEventSchema } from './ai-retry.js';
import {
  aiTaskPresentationSchema,
  aiPresentationEventSchemas,
} from './ai-presentation.js';
import {
sharedSkillRuleSnapshotSchema,
sharedSkillRuleReadMetadataSchema,
} from './skill-guidance.js';

export const dataScopeSchema = modelDataScopeSchema;
export const executionOriginSchema = z.enum([
  'fixture',
  'liveProvider',
  'legacyUnknown',
]);
export const usageOriginScopeSchema = z.enum([
  'fixture',
  'liveProvider',
  'legacyUnknown',
  'all',
]);
export const conversationReferenceInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('conversation'),
    conversationId: idSchema,
    mode: z.enum(['relevant', 'full']),
    query: z.string().max(500).optional(),
    dataScope: dataScopeSchema,
  }),
  z.strictObject({
    kind: z.literal('resource'),
    resourceId: idSchema,
    dataScope: dataScopeSchema,
  }),
  z.strictObject({
    kind: z.literal('requirementVersion'),
    requirementVersionId: idSchema,
    dataScope: dataScopeSchema,
  }),
  z.strictObject({
    kind: z.literal('knowledge'),
    entryId: idSchema,
    revisionId: idSchema.optional(),
    dataScope: dataScopeSchema,
  }),
  z.strictObject({
    kind: z.literal('externalMcpConnection'),
    connectionId: idSchema,
    configRevision: z.number().int().positive(),
    credentialVersion: z.number().int().positive(),
    catalogDigest: sha256Schema,
    dataScope: dataScopeSchema,
  }),
  z.strictObject({
    kind: z.literal('externalMcpInvocation'),
    invocationId: idSchema,
    dataScope: dataScopeSchema,
  }),
]);
export const operationTargetSchema = z.strictObject({
  projectId: idSchema,
  requirementId: idSchema.optional(),
  objectIds: z.array(idSchema).max(100).optional(),
});
export const conversationCreateInputSchema = z
  .strictObject({
    commandId: commandIdSchema,
    requirementId: idSchema.optional(),
    projectId: idSchema.optional(),
    useDefaultTarget: z.boolean().default(true),
  })
  .superRefine((input, context) => {
    if (Boolean(input.requirementId) !== Boolean(input.projectId))
      context.addIssue({
        code: 'custom',
        path: ['requirementId'],
        message: '会话归属必须同时指定项目及需求，或保持个人无项目',
      });
  });
export const conversationUpdateInputSchema = z.strictObject({
  commandId: commandIdSchema,
  rowVersion: persistedRowVersionSchema,
  alias: z.string().trim().min(1).max(200).nullable().optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
});
export const conversationAssociateInputSchema = z.strictObject({
  commandId: commandIdSchema,
  rowVersion: persistedRowVersionSchema,
  projectId: idSchema,
  requirementId: idSchema,
});
export const conversationSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema.nullable(),
  requirementId: idSchema.nullable(),
  requirementTitle: z.string().max(200).nullable().default(null),
  title: z.string().max(200),
  alias: z.string().max(200).nullable(),
  pinnedAt: timestampSchema.nullable(),
  archivedAt: timestampSchema.nullable(),
  rowVersion: persistedRowVersionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  activeTaskStatus: z
    .enum(['accepted', 'running', 'cancelling'])
    .nullable()
    .default(null),
});
export const requirementGroupUpdateInputSchema = z.strictObject({
  commandId: commandIdSchema,
  rowVersion: rowVersionSchema,
  alias: z.string().trim().min(1).max(200).nullable().optional(),
  pinned: z.boolean().optional(),
  expanded: z.boolean().optional(),
  hidden: z.boolean().optional(),
  archived: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
});
export const aiPreferencesInputSchema = z.strictObject({
  commandId: commandIdSchema,
  rowVersion: rowVersionSchema,
  defaultTarget: z.enum(['personal', 'lastRequirement']),
});
export const legacySendMessageInputSchema = z.strictObject({
  commandId: commandIdSchema,
  content: z
    .string()
    .min(1)
    .max(100_000)
    .refine((value) => value.trim().length > 0),
  modelSelection: modelSelectionInputSchema,
  dataScope: dataScopeSchema,
  references: z.array(conversationReferenceInputSchema).max(30),
  operationTarget: operationTargetSchema.nullable(),
});
export const sendMessageInputSchema = legacySendMessageInputSchema.extend({
  modelSelection: modelSelectionV2Schema,
  accessMode: workspaceAccessModeSchema.optional(),
});
export const taskStateSchema = z.enum([
  'accepted',
  'running',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'unknown',
]);
export const taskAcceptedSchema = z.strictObject({
  taskId: idSchema,
  userMessageId: idSchema,
  assistantMessageId: idSchema,
  status: z.literal('accepted'),
});
export const sendReceiptSchema = z.strictObject({
  receipt: taskAcceptedSchema,
  currentStatus: taskStateSchema,
});
export const historySearchInputSchema = z.strictObject({
  conversationIds: z.array(idSchema).min(1).max(20),
  query: z.string().max(500),
  fullRead: z.boolean().default(false),
});
export const deletionCommitInputSchema = z.strictObject({
  commandId: commandIdSchema,
  previewId: idSchema,
  scopeDigest: sha256Schema,
});
export const deletionPreviewSchema = z.strictObject({
  previewId: idSchema,
  targetType: z.enum(['conversation', 'resource']),
  targetId: idSchema,
  rowVersion: persistedRowVersionSchema,
  scopeDigest: sha256Schema,
  exclusiveResourceIds: z.array(idSchema),
  retainedResourceIds: z.array(idSchema),
  affectedConversationIds: z.array(idSchema),
  activeTaskIds: z.array(idSchema),
  expiresAt: timestampSchema,
});
export type ConversationReferenceInput = z.infer<
  typeof conversationReferenceInputSchema
>;
export type Conversation = z.infer<typeof conversationSchema>;
export type SendMessageInput = z.infer<typeof sendMessageInputSchema>;
export type TaskState = z.infer<typeof taskStateSchema>;
export type OperationTarget = z.infer<typeof operationTargetSchema>;

export const internalProjectAccessReferenceSchema = z.strictObject({
  kind: z.literal('projectAccess'),
  projectId: idSchema,
  dataScope: dataScopeSchema,
});
export const frozenConversationReferenceSchema = z.strictObject({
  reference: z.union([
    conversationReferenceInputSchema,
    internalProjectAccessReferenceSchema,
  ]),
  messageIds: z.array(idSchema).optional(),
  frozenVersionId: idSchema.optional(),
  resourceIds: z.array(idSchema).optional(),
  unavailableResourceIds: z.array(idSchema).optional(),
  hasInFlight: z.boolean().optional(),
});
export const messageStateSchema = z.enum([
  'queued',
  'streaming',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'deleted',
]);
export const legacyMessageModelSnapshotSchema = z.strictObject({
  modelServiceId: idSchema,
  configRevision: persistedRowVersionSchema,
  provider: z.enum(['sensenova', 'ark']),
  modelId: z.string().max(200),
  effort: z.string().nullable(),
});
export const messageModelSnapshotSchema = z.union([
  legacyMessageModelSnapshotSchema,
  messageModelSnapshotV2Schema,
]);
export const conversationTaskNoticesSchema = z.strictObject({
  hasFailedTools: z.boolean(),
  hasUnknownToolEffects: z.boolean(),
  hasContextReset: z.boolean(),
});
export const conversationMessageSchema = z.strictObject({
  id: idSchema,
  taskId: idSchema.nullable(),
  // Read-only task metadata. Legacy servers may omit it; message status keeps its original meaning.
  taskStatus: taskStateSchema.nullable().optional(),
  taskNotices: conversationTaskNoticesSchema.optional(),
  executionOrigin: executionOriginSchema,
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  status: messageStateSchema,
  modelServiceId: idSchema.nullable(),
  configRevision: persistedRowVersionSchema.nullable(),
  modelSnapshot: messageModelSnapshotSchema.nullable(),
  effort: z.string().nullable(),
  references: z.array(frozenConversationReferenceSchema),
  operationTarget: operationTargetSchema.nullable(),
  createdAt: timestampSchema,
});
export const conversationMutationSchema = z.strictObject({
  conversation: conversationSchema,
});
export const conversationCreatedSchema = conversationMutationSchema.extend({
  notice: z.string().nullable(),
});
export const conversationCreateReceiptSchema = z.strictObject({
  commandId: commandIdSchema,
  receipt: conversationCreatedSchema,
});
export const conversationListSchema = z.strictObject({
  conversations: z.array(conversationSchema),
});
export const conversationDetailSchema = z.strictObject({
  conversation: conversationSchema,
  messages: z.array(conversationMessageSchema),
  nextMessageCursor: idSchema.nullable(),
});
const groupFields = {
  projectId: idSchema,
  requirementId: idSchema,
  formalTitle: z.string().min(1).max(200),
  generatedName: z.string().max(80).nullable().default(null),
  alias: z.string().nullable(),
  pinnedAt: timestampSchema.nullable(),
  sortOrder: z.number().int().nonnegative(),
  expanded: z.boolean(),
  hidden: z.boolean(),
  archivedAt: timestampSchema.nullable(),
  rowVersion: rowVersionSchema,
};
export const requirementGroupSchema = z.strictObject({
  ...groupFields,
  conversations: z.array(conversationSchema),
});
export const conversationSidebarSchema = z.strictObject({
  groups: z.array(requirementGroupSchema),
  pinned: z.array(conversationSchema.extend({ parentHidden: z.boolean() })),
  recent: z.array(conversationSchema),
});
export const requirementGroupCandidatesSchema = z.strictObject({
  groups: z.array(z.strictObject({ ...groupFields, groupExists: z.boolean() })),
});
export const requirementGroupMutationSchema = z.strictObject({
  group: z.strictObject({
    requirementId: idSchema,
    rowVersion: persistedRowVersionSchema,
    hidden: z.boolean(),
    expanded: z.boolean(),
  }),
});
export const aiPreferencesSchema = z.strictObject({
  preferences: z.strictObject({
    defaultTarget: z.enum(['personal', 'lastRequirement']),
    rowVersion: rowVersionSchema,
  }),
});
export const historyCandidatesSchema = conversationListSchema;
export const historySearchSchema = z.strictObject({
  results: z.array(
    z.strictObject({
      conversationId: idSchema,
      state: z.enum(['available', 'noMatch', 'inaccessible']),
      messages: z.array(
        z.strictObject({
          id: idSchema,
          role: z.enum(['user', 'assistant']),
          content: z.string(),
        }),
      ),
    }),
  ),
});
export const aiErrorDetailsSchema = z.strictObject({
  httpStatus: z.number().int().min(100).max(599).nullable(),
  providerCode: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{1,80}$/)
    .nullable(),
  providerType: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{1,80}$/)
    .nullable(),
  requestId: z.string().max(200).nullable(),
});
export const aiTaskStatusSchema = z.strictObject({
  task: z.strictObject({
    id: idSchema,
    conversationId: idSchema,
    status: taskStateSchema,
    executionOrigin: executionOriginSchema,
    modelSelection: z.union([
      modelSelectionInputSchema,
      modelSelectionV2Schema,
    ]),
    operationTarget: operationTargetSchema.nullable(),
    errorCode: z.string().max(100).nullable(),
    errorDetails: aiErrorDetailsSchema.nullable(),
    modelAttempts: z.array(modelAttemptViewSchema).default([]),
    modelRetry: modelRetryEventSchema.nullable().default(null),
    presentation: aiTaskPresentationSchema.optional(),
    content: z.string(),
    messageStatus: messageStateSchema,
    createdAt: timestampSchema,
    startedAt: timestampSchema.nullable(),
    finishedAt: timestampSchema.nullable(),
  }),
});
const eventBase = {
  sequence: decimalCountSchema,
  createdAt: timestampSchema,
  sentAt: timestampSchema.optional(),
};
export const aiToolSourceReferenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('projectAccess'), projectId: idSchema }),
  z.strictObject({
    kind: z.literal('knowledge'),
    entryId: idSchema,
    revisionId: idSchema,
  }),
  z.strictObject({
    kind: z.literal('externalMcpInvocation'),
    invocationId: idSchema,
  }),
]);
export type AiToolSourceReference = z.infer<typeof aiToolSourceReferenceSchema>;
const referenceAvailabilitySchema = z.enum([
  'available',
  'partial',
  'noMatch',
  'deleted',
  'inaccessible',
  'notParsed',
  'notIntegrated',
]);
export const aiTaskEventSchema = z.discriminatedUnion('type', [
  ...aiPresentationEventSchemas,
  z.strictObject({
    ...eventBase,
    type: z.literal('task.accepted'),
    payload: z.strictObject({
      taskId: idSchema,
      status: z.literal('accepted'),
      conversationId: idSchema,
    }),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('task.started'),
    payload: z.strictObject({ status: z.literal('running') }),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('task.cancel-requested'),
    payload: z.strictObject({ status: z.enum(['cancelled', 'cancelling']) }),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('task.interrupted'),
    payload: z.strictObject({
      status: z.literal('interrupted'),
      cause: z.literal('worker-state-unknown'),
      automaticReplay: z.literal(false),
    }),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('task.finished'),
    payload: z.strictObject({
      status: taskStateSchema,
      errorCode: z.string().max(100).nullable(),
      errorDetails: aiErrorDetailsSchema.nullable().optional(),
    }),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('references.resolved'),
    payload: z.strictObject({
      references: z.array(
        z.strictObject({
          identity: z.string().max(250),
          state: referenceAvailabilitySchema,
        }),
      ),
      dataScope: dataScopeSchema,
    }),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('ai.text'),
    payload: z.strictObject({
      type: z.literal('text'),
      text: z.string(),
      modelAttemptId: idSchema.optional(),
      receivedAt: timestampSchema.optional(),
      receivedMonotonicMs: z.number().nonnegative().optional(),
    }),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('ai.guidance.bound'),
    payload: z.strictObject({ snapshot: sharedSkillRuleSnapshotSchema }),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('ai.guidance.loaded'),
    payload: z.strictObject({ receipt: sharedSkillRuleReadMetadataSchema }),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('ai.modelRetry'),
    payload: z.strictObject({
      type: z.literal('modelRetry'),
      retry: modelRetryEventSchema,
    }),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('ai.tool'),
    payload: z.strictObject({
      type: z.literal('tool'),
      invocationId: idSchema,
      name: z.string().max(200),
      state: z.enum(['started', 'completed', 'failed', 'waitingConfirmation']),
      confirmationId: idSchema.optional(),
      externalInvocationId: idSchema.optional(),
      sourceRefs: z.array(aiToolSourceReferenceSchema).optional(),
      unknownEffect: z.boolean().optional(),
    }),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('ai.contextReset'),
    payload: z.strictObject({
      type: z.literal('contextReset'),
      reason: z.literal('authorization-changed'),
    }),
  }),
]);
export const aiTaskEventsSchema = z.strictObject({
  events: z.array(aiTaskEventSchema),
  status: taskStateSchema,
  terminal: z.boolean(),
});
export const personalResourceSchema = z.strictObject({
  id: idSchema,
  originalName: z.string().max(512),
  mediaType: z.string().max(256),
  bytes: decimalCountSchema,
  sha256: sha256Schema,
  status: z.enum(['pending', 'uploading', 'verified', 'failed']),
  createdAt: timestampSchema,
  verifiedAt: timestampSchema.nullable(),
  referenceCount: decimalCountSchema,
  conversationIds: z.array(idSchema),
  requirementIds: z.array(idSchema),
  projectIds: z.array(idSchema),
  textExtractionSupported: z.boolean(),
});
export const personalResourceListSchema = z.strictObject({
  resources: z.array(personalResourceSchema),
  nextCursor: idSchema.nullable(),
});
export const conversationDeletedSchema = z.strictObject({
  deleted: z.literal(true),
  deletionEventId: idSchema,
  controlLedger: z.enum(['recorded', 'pending']),
  gcState: z.enum(['pending', 'notNeeded']),
});
const sourceSchema = z.enum(['chat', 'auxiliary', 'background']);
const usageCounters = {
  tokens: decimalCountSchema.nullable(),
  calls: decimalCountSchema,
  unknown_calls: decimalCountSchema,
  component_unknown_calls: decimalCountSchema,
  total_fallback_calls: decimalCountSchema,
  unknown_request_intents: decimalCountSchema,
  not_dispatched_calls: decimalCountSchema,
};
const usageBase = {
  timezone: z.literal('Asia/Shanghai'),
  range: z.literal('365days-including-today'),
  executionOriginScope: usageOriginScopeSchema,
  totalPolicy: z.literal('reported-total-first-else-input-output'),
  requestPolicy: z.literal('native-fetch-invocations'),
  datePolicy: z.literal('call-start-date'),
  activityScope: z.literal('all-platform-user-tasks'),
  originBreakdown: z.array(
    z.strictObject({
      executionOrigin: executionOriginSchema,
      ledgerRows: decimalCountSchema,
      confirmedRequests: decimalCountSchema,
      unknownRequestIntents: decimalCountSchema,
      notDispatchedCalls: decimalCountSchema,
      recordedTokens: decimalCountSchema.nullable(),
    }),
  ),
};
export const personalUsageSchema = z.strictObject({
  ...usageBase,
  longestTaskScope: z
    .literal('ended-platform-ai-and-auxiliary-tasks')
    .nullable()
    .default(null),
  longestTaskPolicy: z
    .literal('worker-start-to-matching-terminal-event')
    .nullable()
    .default(null),
  summary: z
    .strictObject({
      input_tokens: decimalCountSchema.nullable(),
      output_tokens: decimalCountSchema.nullable(),
      total_tokens: decimalCountSchema.nullable(),
      known_calls: decimalCountSchema,
      unknown_calls: decimalCountSchema,
      component_unknown_calls: decimalCountSchema,
      total_fallback_calls: decimalCountSchema,
      confirmed_requests: decimalCountSchema,
      unknown_request_intents: decimalCountSchema,
      not_dispatched_calls: decimalCountSchema,
      active_days: decimalCountSchema,
      longest_task_ms: decimalCountSchema.nullable(),
      known_task_durations: decimalCountSchema.nullable().default(null),
      unknown_task_durations: decimalCountSchema.nullable().default(null),
      not_started_tasks: decimalCountSchema.nullable().default(null),
    })
    .nullable(),
  heatmap: z
    .array(
      z.strictObject({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        tokens: decimalCountSchema.nullable(),
        unknown_calls: decimalCountSchema,
        component_unknown_calls: decimalCountSchema,
        confirmed_requests: decimalCountSchema,
        unknown_request_intents: decimalCountSchema,
      }),
    )
    .length(365),
  models: z.array(
    z.strictObject({
      model_id: z.string(),
      source: sourceSchema,
      ledger_rows: decimalCountSchema,
      ...usageCounters,
    }),
  ),
});
export const platformUsageSchema = z.strictObject({
  ...usageBase,
  heatmap: personalUsageSchema.shape.heatmap,
  byModel: personalUsageSchema.shape.models,
  totals: z.strictObject(usageCounters).nullable(),
  bySource: z.array(z.strictObject({ source: sourceSchema, ...usageCounters })),
  byUser: z.array(
    z.strictObject({
      user_id: idSchema,
      account: z.string(),
      display_name: z.string(),
      ...usageCounters,
    }),
  ),
});

export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
export type ConversationSidebar = z.infer<typeof conversationSidebarSchema>;
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;
export type RequirementGroupCandidates = z.infer<
  typeof requirementGroupCandidatesSchema
>;
export type AiTaskStatus = z.infer<typeof aiTaskStatusSchema>;
export type AiTaskEvent = z.infer<typeof aiTaskEventSchema>;
export type AiTaskEvents = z.infer<typeof aiTaskEventsSchema>;
export type PersonalResource = z.infer<typeof personalResourceSchema>;
export type PersonalUsage = z.infer<typeof personalUsageSchema>;
