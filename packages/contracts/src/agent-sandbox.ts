import { z } from 'zod';

export const sandboxLimits = Object.freeze({
  maxFiles: 32,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalFileBytes: 16 * 1024 * 1024,
  maxCodeBytes: 128 * 1024,
  maxStdoutBytes: 256 * 1024,
  maxWireBytes: 24 * 1024 * 1024,
  maxRuntimeMs: 120_000,
  maxConcurrentRuns: 2,
  maxQueuedRuns: 8,
  maxQueuedInputBytes: 32 * 1024 * 1024,
  maxQueueWaitMs: 120_000,
  maxRetainedResultBytes: 64 * 1024 * 1024,
});

export const sandboxPathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((path) => {
    if (/[\\\u0000-\u001f\u007f:]/u.test(path)) return false;
    return path
      .split('/')
      .every(
        (part) =>
          part.length > 0 &&
          part.length <= 128 &&
          !['.', '..'].includes(part) &&
          !/[. ]$/u.test(part) &&
          !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part),
      );
  }, 'A relative workspace file path is required');

const base64Schema = z
  .string()
  .max(Math.ceil(sandboxLimits.maxFileBytes / 3) * 4)
  // Avoid repeated groups: V8 can exhaust its regexp stack on valid MiB files.
  .regex(/^[A-Za-z0-9+/]*={0,2}$/u)
  .refine(
    (value) => value.length % 4 === 0,
    'Base64 length must be a multiple of four',
  );

export const sandboxFileSchema = z.strictObject({
  path: sandboxPathSchema,
  contentBase64: base64Schema,
});
export type SandboxFile = z.infer<typeof sandboxFileSchema>;

export const sandboxRequestSchema = z.strictObject({
  runId: z.uuid().toLowerCase(),
  language: z.literal('python'),
  code: z.string().max(sandboxLimits.maxCodeBytes),
  files: z.array(sandboxFileSchema).max(sandboxLimits.maxFiles).default([]),
  timeoutMs: z
    .number()
    .int()
    .min(100)
    .max(sandboxLimits.maxRuntimeMs)
    .default(30_000),
});
export type SandboxRequest = z.infer<typeof sandboxRequestSchema>;

export const sandboxStateSchema = z.enum([
  'running',
  'completed',
  'code_error',
  'cancelled',
  'timed_out',
  'output_limit',
  'resource_limit',
  'runtime_error',
  'cleanup_unknown',
]);
export type SandboxState = z.infer<typeof sandboxStateSchema>;
export const sandboxResultSchema = z.strictObject({
  runId: z.uuid().toLowerCase(),
  state: sandboxStateSchema,
  cleanupConfirmed: z.boolean(),
  stdout: z.string().max(sandboxLimits.maxStdoutBytes),
  stderr: z.string().max(sandboxLimits.maxStdoutBytes),
  files: z
    .array(
      sandboxFileSchema.extend({
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        sizeBytes: z.number().int().min(0).max(sandboxLimits.maxFileBytes),
      }),
    )
    .max(sandboxLimits.maxFiles),
  durationMs: z.number().int().min(0),
});
export type SandboxResult = z.infer<typeof sandboxResultSchema>;

export const sandboxPendingSchema = z.strictObject({
  runId: z.uuid().toLowerCase(),
  state: z.enum(['queued', 'running']),
});
export type SandboxPending = z.infer<typeof sandboxPendingSchema>;

// Only this exact response proves that this UUID was not accepted. Other HTTP
// failures may have interrupted an accepted request and require reconciliation.
export const sandboxAdmissionRejectedSchema = z.strictObject({
  runId: z.uuid().toLowerCase(),
  accepted: z.literal(false),
  code: z.enum(['SANDBOX_QUEUE_FULL', 'SANDBOX_SHUTTING_DOWN']),
});

export interface AgentSandboxPort {
  execute(
    request: SandboxRequest,
    signal?: AbortSignal,
  ): Promise<SandboxResult>;
}
