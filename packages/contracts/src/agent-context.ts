import { z } from 'zod';
import { idSchema, persistedRowVersionSchema, sha256Schema } from './base.js';

export const agentTaskEvidenceSchema = z.strictObject({
  taskId: idSchema,
  invocationId: idSchema,
});
export const agentTaskItemSchema = z.strictObject({
  id: idSchema,
  title: z.string().trim().min(1).max(1000),
  status: z.enum(['pending', 'inProgress', 'blocked', 'unknown', 'completed']),
  evidence: z.array(agentTaskEvidenceSchema).max(20),
  note: z.string().max(2000).default(''),
});
export const agentTaskPlanSchema = z.strictObject({
  goal: z.string().trim().min(1).max(8000),
  decisions: z.array(z.string().trim().min(1).max(2000)).max(32),
  items: z.array(agentTaskItemSchema).max(64),
});
export const agentTaskPlanUpdateSchema = z.strictObject({
  rowVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  plan: agentTaskPlanSchema,
});
export const agentTaskPlanReceiptSchema = z.strictObject({
  plan: agentTaskPlanSchema.nullable(),
  rowVersion: z.number().int().min(0),
  availability: z.enum(['available', 'empty', 'sourceChanged']),
  evidenceMeaning: z.literal(
    'agent-reported-completion-with-tool-transport-receipt',
  ),
  executionQueue: z.literal(false),
});
export const agentContextArchiveReadSchema = z.strictObject({
  recordId: sha256Schema,
  offset: z.number().int().min(0).max(2_000_000).default(0),
  limit: z.number().int().min(1).max(20_000).default(8000),
});
export const agentContextToolInputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('read') }),
  agentTaskPlanUpdateSchema.extend({ action: z.literal('update') }),
  agentContextArchiveReadSchema.extend({ action: z.literal('read_history') }),
]);
export const agentContextArchiveRecordSchema = z.strictObject({
  recordId: sha256Schema,
  messageId: z.string().max(200).nullable(),
  role: z.string().max(40),
  text: z.string().max(2_000_000),
  contentHash: sha256Schema,
  nonTextBlocks: z.array(z.string().max(100)).max(1000),
  toolCalls: z
    .array(
      z.strictObject({ id: z.string().max(200), name: z.string().max(200) }),
    )
    .max(100),
  toolCallId: z.string().max(200).nullable(),
});
export const persistedAgentTaskPlanSchema = z.strictObject({
  plan: agentTaskPlanSchema,
  rowVersion: persistedRowVersionSchema,
});
export type AgentTaskPlan = z.infer<typeof agentTaskPlanSchema>;
export type AgentTaskEvidence = z.infer<typeof agentTaskEvidenceSchema>;
export type AgentTaskPlanReceipt = z.infer<typeof agentTaskPlanReceiptSchema>;
export type AgentContextArchiveRecord = z.infer<
  typeof agentContextArchiveRecordSchema
>;

/** Diagnostics only: estimates never replace provider-reported billing usage. */
export const agentContextBudgetSnapshotSchema = z.strictObject({
  fits: z.boolean(),
  exact: z.literal(false),
  profileVersion: z.string().min(1).max(100),
  contextLimit: z.number().int().positive().nullable(),
  maxOutput: z.number().int().positive(),
  inputTokensEstimate: z.number().int().nonnegative(),
  rawInputTokens: z.number().int().nonnegative(),
  safetyMargin: z.number().int().nonnegative(),
  calibrationFactor: z.number().finite().positive(),
  schemaHash: sha256Schema,
  envelopeHash: sha256Schema,
  components: z.strictObject({
    textTokens: z.number().int().nonnegative(),
    imageTokens: z.number().int().nonnegative(),
    opaqueTokens: z.number().int().nonnegative(),
    imageCount: z.number().int().nonnegative(),
    serializedCharacters: z.number().int().nonnegative(),
    toolsSerializedCharacters: z.number().int().nonnegative(),
    messagesSerializedCharacters: z.number().int().nonnegative(),
    systemSerializedCharacters: z.number().int().nonnegative(),
  }),
});
export type AgentContextBudgetSnapshot = z.infer<
  typeof agentContextBudgetSnapshotSchema
>;
