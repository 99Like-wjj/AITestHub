import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  sandboxLimits,
  sandboxAdmissionRejectedSchema,
  sandboxPendingSchema,
  sandboxRequestSchema,
  sandboxResultSchema,
  type AgentSandboxPort,
  type SandboxRequest,
  type SandboxResult,
  type SandboxPending,
} from '../../contracts/src/agent-sandbox.js';

export class SandboxBrokerClient implements AgentSandboxPort {
  private readonly origin: string;
  constructor(
    origin: string,
    private readonly token: string,
  ) {
    const url = new URL(origin);
    if (
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      !['http:', 'https:'].includes(url.protocol) ||
      token.length < 32
    )
      throw new Error('SANDBOX_BROKER_CONFIG_INVALID');
    this.origin = url.origin;
  }

  private async request(path: string, method = 'GET', body?: SandboxRequest) {
    const response = await fetch(this.origin + path, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader) {
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.length;
          if (bytes > sandboxLimits.maxWireBytes)
            throw new Error('SANDBOX_BROKER_RESPONSE_INVALID');
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    }
    return {
      status: response.status,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
    };
  }

  async status(
    runId: string,
  ): Promise<
    | SandboxResult
    | SandboxPending
    | { runId: string; state: 'result_unavailable'; cleanupConfirmed: boolean }
  > {
    const id = z.uuid().toLowerCase().parse(runId);
    const read = await this.request(`/v1/runs/${id}`);
    if (read.status !== 200)
      throw new Error('SANDBOX_BROKER_STATUS_UNAVAILABLE');
    const result = sandboxResultSchema.safeParse(read.body);
    if (result.success && result.data.runId === id) return result.data;
    return z
      .union([
        sandboxPendingSchema.extend({ runId: z.literal(id) }),
        z.strictObject({
          runId: z.literal(id),
          state: z.literal('result_unavailable'),
          cleanupConfirmed: z.boolean(),
        }),
      ])
      .parse(read.body);
  }

  async cancel(runId: string): Promise<void> {
    const id = z.uuid().toLowerCase().parse(runId);
    const reply = await this.request(`/v1/runs/${id}`, 'DELETE');
    if (reply.status !== 202) throw new Error('SANDBOX_BROKER_CANCEL_UNKNOWN');
  }

  async execute(
    raw: SandboxRequest,
    signal?: AbortSignal,
  ): Promise<SandboxResult> {
    const request = sandboxRequestSchema.parse(raw);
    if (signal?.aborted)
      return {
        runId: request.runId,
        state: 'cancelled',
        cleanupConfirmed: true,
        stdout: '',
        stderr: '',
        files: [],
        durationMs: 0,
      };
    const start = Date.now();
    const path = `/v1/runs/${request.runId}`;
    let accepted = false;
    try {
      const sent = await this.request('/v1/runs', 'POST', request);
      const rejected = sandboxAdmissionRejectedSchema.safeParse(sent.body);
      if (
        sent.status === 503 &&
        rejected.success &&
        rejected.data.runId === request.runId
      )
        return {
          runId: request.runId,
          state: 'resource_limit',
          cleanupConfirmed: true,
          stdout: '',
          stderr: rejected.data.code,
          files: [],
          durationMs: Date.now() - start,
        };
      if (![202, 409].includes(sent.status))
        throw new Error('SANDBOX_BROKER_UNAVAILABLE');
      accepted = true;
      // Each HTTP request keeps its own 15s limit. Waiting for an execution
      // slot does not spend the program's runtime/cleanup allowance.
      const deadline =
        start + sandboxLimits.maxQueueWaitMs + request.timeoutMs + 60_000;
      let runningDeadline: number | undefined;
      let cancellationSent = false;
      while (Date.now() < Math.min(deadline, runningDeadline ?? deadline)) {
        if (signal?.aborted && !cancellationSent) {
          await this.request(path, 'DELETE');
          cancellationSent = true;
        }
        const read = await this.request(path);
        if (read.status !== 200) throw new Error('SANDBOX_BROKER_UNAVAILABLE');
        const result = sandboxResultSchema.safeParse(read.body);
        if (result.success && result.data.runId === request.runId)
          return result.data;
        const pending = sandboxPendingSchema
          .extend({ runId: z.literal(request.runId) })
          .safeParse(read.body);
        if (pending.success && pending.data.state === 'running')
          runningDeadline ??= Date.now() + request.timeoutMs + 60_000;
        if (!pending.success) {
          const lost = z
            .strictObject({
              runId: z.literal(request.runId),
              state: z.literal('result_unavailable'),
              cleanupConfirmed: z.boolean(),
            })
            .parse(read.body);
          return {
            runId: request.runId,
            state: lost.cleanupConfirmed ? 'runtime_error' : 'cleanup_unknown',
            cleanupConfirmed: lost.cleanupConfirmed,
            stdout: '',
            stderr: '',
            files: [],
            durationMs: Date.now() - start,
          };
        }
        await delay(250);
      }
    } catch {
      // An interrupted POST may already have accepted the code. Never POST a replacement/retry.
      accepted = true;
    }
    if (accepted) {
      try {
        await this.request(path, 'DELETE');
      } catch {
        /* Cleanup is explicitly unknown until a later status reconciliation. */
      }
    }
    return {
      runId: request.runId,
      state: 'cleanup_unknown',
      cleanupConfirmed: false,
      stdout: '',
      stderr: '',
      files: [],
      durationMs: Date.now() - start,
    };
  }
}
