import { z } from 'zod';
import { decimalCountSchema, idSchema, timestampSchema } from './base.js';
import { modelAttemptContextSchema } from './ai-retry.js';
import { modelSamplingMetadataSchema } from './model-sampling.js';

export const aiSegmentPhaseSchema = z.enum([
  'pending',
  'commentary',
  'final',
  'unclassified',
]);
export const aiSegmentStateSchema = z.enum([
  'streaming',
  'completed',
  'interrupted',
  'cancelled',
]);
export const aiMessageSegmentSchema = z.strictObject({
  id: idSchema,
  logicalCallId: idSchema,
  modelOrdinal: z.number().int().min(1),
  attemptNo: z.number().int().min(0).max(5),
  phase: aiSegmentPhaseSchema,
  state: aiSegmentStateSchema,
  text: z.string().max(100_000),
  startedAt: timestampSchema,
  finishedAt: timestampSchema.nullable(),
});
export const aiProgressItemSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  step: z.string().trim().min(1).max(300),
  status: z.enum(['pending', 'in_progress', 'completed']),
});
export const aiProgressItemsSchema = z
  .array(aiProgressItemSchema)
  .min(1)
  .max(20)
  .refine(
    (items) =>
      items.filter((item) => item.status === 'in_progress').length <= 1 &&
      new Set(items.map((item) => item.id)).size === items.length,
    '计划步骤标识须唯一，且同时最多一个正在进行的步骤',
  );
export const aiProgressSchema = z.strictObject({
  items: aiProgressItemsSchema,
  explanation: z.string().max(1000).nullable(),
  updatedAt: timestampSchema,
});
export const aiPublicSummarySchema = z.strictObject({
  id: z.string().min(1).max(160),
  segmentId: idSchema,
  text: z.string().max(100_000),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
const intervalStatsSchema = z.strictObject({
  count: z.number().int().min(0),
  p50Ms: z.number().nonnegative(),
  p95Ms: z.number().nonnegative(),
  maxMs: z.number().nonnegative(),
});
export const aiModelTimingPayloadSchema = z.strictObject({
  type: z.literal('modelTiming'),
  segmentId: idSchema,
  requestStartedAt: timestampSchema.nullable(),
  firstTextAt: timestampSchema.nullable(),
  firstPersistedAt: timestampSchema.nullable(),
  firstTextLatencyMs: z.number().nonnegative().nullable(),
  textChunks: z.number().int().min(0),
  receiveIntervals: intervalStatsSchema,
  persistIntervals: intervalStatsSchema,
  sampling: modelSamplingMetadataSchema.optional(),
});
export const aiModelDispatchedPayloadSchema = z.strictObject({
  type: z.literal('modelDispatched'),
  segmentId: idSchema,
  startedAt: timestampSchema,
  monotonicMs: z.number().nonnegative(),
  sampling: modelSamplingMetadataSchema.optional(),
});
export const aiTaskPresentationSchema = z.strictObject({
  version: z.literal(1),
  snapshotSequence: decimalCountSchema,
  segments: z.array(aiMessageSegmentSchema),
  progress: aiProgressSchema.nullable(),
  summaries: z.array(aiPublicSummarySchema),
  timings: z.array(aiModelTimingPayloadSchema).default([]),
});
export type AiMessageSegment = z.infer<typeof aiMessageSegmentSchema>;
export type AiTaskPresentation = z.infer<typeof aiTaskPresentationSchema>;
export type AiProgress = z.infer<typeof aiProgressSchema>;

export const aiSegmentFinishedPayloadSchema = z.strictObject({
  type: z.literal('segment'),
  segmentId: idSchema,
  phase: z.enum(['pending', 'commentary', 'final']),
  state: z.enum(['completed', 'interrupted', 'cancelled']),
  text: z.string().max(100_000).optional(),
});
export const aiProgressPayloadSchema = z.strictObject({
  type: z.literal('progress'),
  items: aiProgressItemsSchema,
  explanation: z.string().max(1000).nullable(),
});
export const aiSummaryPayloadSchema = z.strictObject({
  type: z.literal('summary'),
  segmentId: idSchema,
  summaryIndex: z.number().int().min(0).max(1000),
  text: z.string().max(100_000),
});
const eventBase = {
  sequence: decimalCountSchema,
  createdAt: timestampSchema,
  sentAt: timestampSchema.optional(),
};
export const aiPresentationEventSchemas = [
  z.strictObject({
    ...eventBase,
    type: z.literal('ai.segment.started'),
    payload: z.strictObject({ context: modelAttemptContextSchema }),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('ai.segment'),
    payload: aiSegmentFinishedPayloadSchema,
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('ai.progress'),
    payload: aiProgressPayloadSchema,
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('ai.summary'),
    payload: aiSummaryPayloadSchema,
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('ai.modelDispatched'),
    payload: aiModelDispatchedPayloadSchema,
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('ai.modelTiming'),
    payload: aiModelTimingPayloadSchema,
  }),
] as const;

export function emptyAiTaskPresentation(): AiTaskPresentation {
  return {
    version: 1,
    snapshotSequence: '0',
    segments: [],
    progress: null,
    summaries: [],
    timings: [],
  };
}

/** Protocol projection only. Used by persisted readback and the read-only Web observer. */
export function applyAiPresentationEvent(
  previous: AiTaskPresentation,
  event: {
    sequence: string;
    type: string;
    payload: unknown;
    createdAt: string;
  },
): AiTaskPresentation {
  if (BigInt(event.sequence) <= BigInt(previous.snapshotSequence))
    return previous;
  let segments = previous.segments;
  let progress = previous.progress;
  let summaries = previous.summaries;
  let timings = previous.timings;
  if (event.type === 'ai.segment.started') {
    const { context } = aiPresentationEventSchemas[0].parse(event).payload;
    if (segments.some((segment) => segment.id === context.attemptId))
      throw new Error('Duplicate model segment identity');
    segments = [
      ...segments,
      {
        id: context.attemptId,
        logicalCallId: context.logicalCallId,
        modelOrdinal: context.modelOrdinal,
        attemptNo: context.attemptNo,
        phase: 'pending',
        state: 'streaming',
        text: '',
        startedAt: event.createdAt,
        finishedAt: null,
      },
    ];
  } else if (event.type === 'ai.text') {
    const payload = z
      .strictObject({
        type: z.literal('text'),
        text: z.string().max(100_000),
        modelAttemptId: idSchema.optional(),
        receivedAt: timestampSchema.optional(),
        receivedMonotonicMs: z.number().nonnegative().optional(),
      })
      .parse(event.payload);
    segments = segments.map((segment) => {
      if (segment.id !== payload.modelAttemptId) return segment;
      if (segment.state !== 'streaming')
        throw new Error('Text arrived after model segment ended');
      const text = segment.text + payload.text;
      if (text.length > 100_000) throw new Error('Model segment exceeds limit');
      return { ...segment, text };
    });
  } else if (event.type === 'ai.segment') {
    const payload = aiSegmentFinishedPayloadSchema.parse(event.payload);
    if (!segments.some((segment) => segment.id === payload.segmentId)) {
      // Legacy/custom runners can complete a response without publishing an
      // attempt start. Their authoritative aggregate stays unclassified.
      // Once a task uses bounded segments, a missing identity is a contract error.
      if (segments.some((segment) => segment.phase !== 'unclassified'))
        throw new Error('Model segment boundary is missing');
      return { ...previous, snapshotSequence: event.sequence };
    }
    segments = segments.map((segment) =>
      segment.id === payload.segmentId
        ? {
            ...segment,
            phase: payload.phase,
            state: payload.state,
            text: payload.text ?? segment.text,
            finishedAt: event.createdAt,
          }
        : segment,
    );
  } else if (event.type === 'ai.progress') {
    const payload = aiProgressPayloadSchema.parse(event.payload);
    progress = {
      items: payload.items,
      explanation: payload.explanation,
      updatedAt: event.createdAt,
    };
  } else if (event.type === 'ai.summary') {
    const payload = aiSummaryPayloadSchema.parse(event.payload);
    if (!segments.some((segment) => segment.id === payload.segmentId)) {
      if (segments.some((segment) => segment.phase !== 'unclassified'))
        throw new Error('Public summary segment boundary is missing');
      return { ...previous, snapshotSequence: event.sequence };
    }
    const id = `${payload.segmentId}:${payload.summaryIndex}`;
    const existing = summaries.find((summary) => summary.id === id);
    const text = (existing?.text ?? '') + payload.text;
    if (text.length > 100_000) throw new Error('Public summary exceeds limit');
    const summary = {
      id,
      segmentId: payload.segmentId,
      text,
      createdAt: existing?.createdAt ?? event.createdAt,
      updatedAt: event.createdAt,
    };
    summaries = existing
      ? summaries.map((value) => (value.id === id ? summary : value))
      : [...summaries, summary];
  } else if (event.type === 'ai.modelTiming') {
    const timing = aiModelTimingPayloadSchema.parse(event.payload);
    timings = [
      ...timings.filter((value) => value.segmentId !== timing.segmentId),
      timing,
    ];
  } else if (event.type === 'task.finished' || event.type === 'task.interrupted') {
    const { status } = z.object({ status: z.string() }).parse(event.payload);
    segments = segments.map((segment) =>
      segment.state === 'streaming'
        ? {
            ...segment,
            state:
              status === 'cancelled'
                ? 'cancelled'
                : status === 'completed'
                  ? 'completed'
                  : 'interrupted',
            finishedAt: event.createdAt,
          }
        : segment,
    );
  }
  return {
    version: 1,
    snapshotSequence: event.sequence,
    segments,
    progress,
    summaries,
    timings,
  };
}
