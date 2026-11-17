import { z } from 'zod';

export const browserUrlSchema = z
  .url()
  .max(2000)
  .refine((value) => {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  }, 'Use an HTTP(S) URL without credentials');
const target = {
  targetId: z.string().regex(/^e[0-9]{1,3}$/),
  atUrl: browserUrlSchema,
};
export const browserActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('click'), ...target }),
  z.strictObject({
    kind: z.literal('fill'),
    ...target,
    value: z.string().max(4000),
  }),
  z.strictObject({
    kind: z.literal('select'),
    ...target,
    value: z.string().max(500),
  }),
  z.strictObject({
    kind: z.literal('press'),
    ...target,
    key: z.enum(['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'Space']),
  }),
  z.strictObject({ kind: z.literal('navigate'), url: browserUrlSchema }),
]);
export type BrowserAction = z.infer<typeof browserActionSchema>;
export const browserPlanSchema = z.strictObject({
  observationId: z.uuid(),
  observationHash: z.string().regex(/^[a-f0-9]{64}$/),
  actions: z.array(browserActionSchema).min(1).max(10),
  purpose: z.string().trim().min(1).max(1000),
});
export const browserElementSchema = z.strictObject({
  id: z.string().regex(/^e[0-9]{1,3}$/),
  tag: z.string().max(30),
  role: z.string().max(40),
  label: z.string().max(200),
  inputType: z.string().max(40),
  sensitive: z.boolean(),
});
export const browserObservationSchema = z.strictObject({
  id: z.uuid(),
  url: z.string().max(2000),
  documentId: z.uuid(),
  title: z.string().max(500),
  text: z.string().max(30_000),
  truncated: z.boolean(),
  elements: z.array(browserElementSchema).max(120),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  screenshotBase64: z.string().max(5_592_408),
  privateState: z.boolean(),
  capturedAt: z.iso.datetime(),
  untrustedPageData: z.literal(true),
  networkWarnings: z.array(z.string().max(200)).max(20).default([]),
});
export type BrowserObservation = z.infer<typeof browserObservationSchema>;
export const browserRuntimeResultSchema = z.strictObject({
  operationId: z.uuid(),
  state: z.enum(['completed', 'failed', 'unknown', 'cancelled']),
  completedActions: z.number().int().min(0).max(10),
  errorCode: z
    .string()
    .regex(/^[A-Z0-9_]{1,80}$/)
    .nullable(),
  observation: browserObservationSchema.nullable(),
});
export type BrowserRuntimeResult = z.infer<typeof browserRuntimeResultSchema>;
export interface BrowserRuntimePort {
  open(sessionId: string): Promise<void>;
  observe(sessionId: string, human?: boolean): Promise<BrowserObservation>;
  navigate(
    sessionId: string,
    operationId: string,
    url: string,
  ): Promise<BrowserRuntimeResult>;
  control(
    sessionId: string,
    operationId: string,
    mode: 'agent' | 'human',
  ): Promise<void>;
  plan(
    sessionId: string,
    operationId: string,
    plan: z.infer<typeof browserPlanSchema>,
  ): Promise<BrowserRuntimeResult>;
  humanAction(
    sessionId: string,
    operationId: string,
    action: BrowserAction,
    secret: boolean,
  ): Promise<BrowserRuntimeResult>;
  status(
    sessionId: string,
    operationId: string,
  ): Promise<BrowserRuntimeResult | null>;
  close(sessionId: string): Promise<void>;
}
export const browserSessionSchema = z.strictObject({
  id: z.uuid(),
  conversationId: z.uuid(),
  state: z.enum(['open', 'closed', 'unknown']),
  control: z.enum(['agent', 'human']),
  rowVersion: z.number().int().positive(),
});
export const browserSessionReceiptSchema = z.strictObject({
  session: browserSessionSchema.nullable(),
});
export const browserOperationSchema = z.strictObject({
  id: z.uuid(),
  sessionId: z.uuid(),
  kind: z.enum(['navigate', 'plan', 'human', 'control']),
  state: z.enum([
    'waitingConfirmation',
    'dispatching',
    'completed',
    'failed',
    'unknown',
    'rejected',
    'cancelled',
  ]),
  plan: browserPlanSchema.nullable(),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  rowVersion: z.number().int().positive(),
  errorCode: z.string().nullable(),
  completedActions: z.number().int().min(0).max(10),
  createdAt: z.iso.datetime(),
});
export const browserOperationReceiptSchema = z.strictObject({
  operation: browserOperationSchema,
});
export const browserActionReceiptSchema = browserOperationReceiptSchema.extend({
  observation: browserObservationSchema.nullable().optional(),
});
export const browserOperationListSchema = z.strictObject({
  operations: z.array(browserOperationSchema).max(100),
});
export const browserToolInputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('open') }),
  z.strictObject({ action: z.literal('observe') }),
  z.strictObject({
    action: z.literal('navigate'),
    commandId: z.uuid(),
    url: browserUrlSchema,
  }),
  browserPlanSchema.extend({
    action: z.literal('propose'),
    commandId: z.uuid(),
  }),
  z.strictObject({ action: z.literal('status'), id: z.uuid() }),
  z.strictObject({ action: z.literal('cancel'), id: z.uuid() }),
]);
