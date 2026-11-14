import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const json = z.json();
export type ScriptJsonValue = z.infer<typeof json>;
const variableName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
  .refine((name) => !['__proto__', 'constructor', 'prototype'].includes(name));
export const workerScriptOutputSchema = z.strictObject({
  variables: z.record(variableName, json),
  assertions: z
    .array(
      z.strictObject({ passed: z.boolean(), message: z.string().max(4000) }),
    )
    .max(1000),
});
export type WorkerScriptOutput = z.infer<typeof workerScriptOutputSchema>;
export type ScriptErrorCode =
  | 'SCRIPT_ERROR'
  | 'SCRIPT_TIMEOUT'
  | 'SCRIPT_CANCELLED'
  | 'SCRIPT_RESULT_INVALID'
  | 'SCRIPT_ASYNC_UNSUPPORTED'
  | 'SCRIPT_INPUT_PROTECTED'
  | 'SCRIPT_RUNTIME_ERROR';
export class ScriptExecutionError extends Error {
  constructor(readonly code: ScriptErrorCode) {
    super(`受限脚本未完成：${code}`);
  }
}

/** Trusted orchestration only. Neither script nor input becomes a shell argument or environment value. */
export async function runIsolatedScript(
  script: string,
  input: ScriptJsonValue,
  options: {
    timeoutMs?: number;
    memoryLimitBytes?: number;
    signal?: AbortSignal;
    protectedPaths?: string[];
  } = {},
): Promise<WorkerScriptOutput> {
  const request = z
    .strictObject({
      script: z.string().max(64_000),
      input: json,
      timeoutMs: z.number().int().min(10).max(5000),
      memoryLimitBytes: z
        .number()
        .int()
        .min(4 * 1024 * 1024)
        .max(64 * 1024 * 1024),
      protectedPaths: z
        .array(
          z
            .string()
            .max(2000)
            .regex(/^(?:\/(?:[^~]|~[01])*)*$/),
        )
        .max(2000),
    })
    .parse({
      script,
      input,
      timeoutMs: options.timeoutMs ?? 5000,
      memoryLimitBytes: options.memoryLimitBytes ?? 64 * 1024 * 1024,
      protectedPaths: options.protectedPaths ?? [],
    });
  const payload = JSON.stringify(request);
  if (Buffer.byteLength(payload) > 1_048_576)
    throw new ScriptExecutionError('SCRIPT_RESULT_INVALID');
  if (options.signal?.aborted)
    throw new ScriptExecutionError('SCRIPT_CANCELLED');
  const compiledPath = fileURLToPath(
    new URL('./script-child.js', import.meta.url),
  );
  const childPath = existsSync(compiledPath)
    ? compiledPath
    : fileURLToPath(new URL('./script-child.ts', import.meta.url));
  return new Promise<WorkerScriptOutput>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--max-old-space-size=128', childPath],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        env: {},
      },
    );
    let settled = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const finish = (
      error?: ScriptExecutionError,
      result?: WorkerScriptOutput,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      if (!child.killed) child.kill();
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new ScriptExecutionError('SCRIPT_RUNTIME_ERROR'));
    };
    const cancel = () => finish(new ScriptExecutionError('SCRIPT_CANCELLED'));
    const timer = setTimeout(
      () => finish(new ScriptExecutionError('SCRIPT_TIMEOUT')),
      request.timeoutMs + 1500,
    );
    options.signal?.addEventListener('abort', cancel, { once: true });
    child.on('error', () =>
      finish(new ScriptExecutionError('SCRIPT_RUNTIME_ERROR')),
    );
    child.stdin.on('error', () =>
      finish(new ScriptExecutionError('SCRIPT_RUNTIME_ERROR')),
    );
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1_048_576)
        finish(new ScriptExecutionError('SCRIPT_RESULT_INVALID'));
      else chunks.push(chunk);
    });
    // Child/WASM diagnostics can contain untrusted exception text. Do not forward or persist them.
    child.stderr.resume();
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0)
        return finish(new ScriptExecutionError('SCRIPT_RUNTIME_ERROR'));
      try {
        const rawResponse: unknown = JSON.parse(
          Buffer.concat(chunks).toString('utf8'),
        );
        const isRecord = (value: unknown): value is Record<string, unknown> =>
          typeof value === 'object' && value !== null && !Array.isArray(value);
        if (
          isRecord(rawResponse) &&
          isRecord(rawResponse.output) &&
          isRecord(rawResponse.output.variables)
        ) {
          // Validate before Zod's own prototype-key hardening can discard an attempted key.
          for (const name of Object.keys(rawResponse.output.variables))
            variableName.parse(name);
        }
        const response = z
          .discriminatedUnion('ok', [
            z.strictObject({
              ok: z.literal(true),
              output: workerScriptOutputSchema,
            }),
            z.strictObject({
              ok: z.literal(false),
              code: z.enum([
                'SCRIPT_ERROR',
                'SCRIPT_TIMEOUT',
                'SCRIPT_RESULT_INVALID',
                'SCRIPT_ASYNC_UNSUPPORTED',
                'SCRIPT_INPUT_PROTECTED',
              ]),
            }),
          ])
          .parse(rawResponse);
        if (response.ok) finish(undefined, response.output);
        else finish(new ScriptExecutionError(response.code));
      } catch {
        finish(new ScriptExecutionError('SCRIPT_RESULT_INVALID'));
      }
    });
    child.stdin.end(payload);
  });
}
