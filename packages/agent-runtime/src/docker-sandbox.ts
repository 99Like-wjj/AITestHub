import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  sandboxFileSchema,
  sandboxLimits,
  sandboxRequestSchema,
  type AgentSandboxPort,
  type SandboxRequest,
  type SandboxResult,
  type SandboxState,
} from '../../contracts/src/agent-sandbox.js';
import { pythonBootstrap } from './python-bootstrap.js';

export class SandboxError extends Error {
  constructor(
    readonly code:
      'SANDBOX_UNAVAILABLE' | 'SANDBOX_INPUT_INVALID' | 'SANDBOX_DUPLICATE',
  ) {
    super(code);
  }
}

const configSchema = z.strictObject({
  // An immutable image ID or registry digest, provisioned outside model control.
  image: z
    .string()
    .regex(/^(?:sha256:[a-f0-9]{64}|[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64})$/u),
  dockerBinary: z.string().min(1).default('docker'),
});

type CommandResult = {
  code: number | null;
  stdout: string;
  overflow: boolean;
  timedOut: boolean;
};

/** Only a trusted broker instantiates this class. Never expose its Docker authority to a model. */
export class DockerSandbox implements AgentSandboxPort {
  private readonly config: z.infer<typeof configSchema>;
  private readonly runs = new Set<string>();

  constructor(config: z.input<typeof configSchema>) {
    this.config = configSchema.parse(config);
  }

  private command(
    args: string[],
    options: {
      input?: string;
      maxBytes?: number;
      timeoutMs?: number;
      onLimit?: () => void;
    } = {},
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      // Docker client uses its trusted operator configuration. No child environment is forwarded
      // into the execution container; all execution data travels over stdin, never a host shell.
      const child = spawn(this.config.dockerBinary, args, {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let bytes = 0;
      let overflow = false;
      let timedOut = false;
      const chunks: Buffer[] = [];
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, options.timeoutMs ?? 15_000);
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > (options.maxBytes ?? sandboxLimits.maxWireBytes)) {
          if (!overflow) options.onLimit?.();
          overflow = true;
          child.kill();
        } else chunks.push(chunk);
      });
      // Docker diagnostics can carry host paths. Bound them without returning or logging them.
      child.stderr.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > (options.maxBytes ?? sandboxLimits.maxWireBytes)) {
          if (!overflow) options.onLimit?.();
          overflow = true;
          child.kill();
        }
      });
      child.stdin.on('error', () => {
        /* Container may close stdin while being stopped. */
      });
      child.once('error', () => {
        clearTimeout(timeout);
        resolve({ code: null, stdout: '', overflow, timedOut });
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        resolve({
          code,
          stdout: Buffer.concat(chunks).toString('utf8'),
          overflow,
          timedOut,
        });
      });
      child.stdin.end(options.input);
    });
  }

  async available(): Promise<boolean> {
    const image = await this.command([
      'image',
      'inspect',
      '--format',
      '{{.Id}}',
      this.config.image,
    ]);
    return (
      image.code === 0 && /^sha256:[a-f0-9]{64}$/u.test(image.stdout.trim())
    );
  }

  /** Exact run only; never a prune or broad container cleanup. */
  async cleanup(runId: string): Promise<boolean> {
    const requestId = z.uuid().toLowerCase().parse(runId);
    const name = `ath-sandbox-${requestId}`;
    const identity = await this.command([
      'container',
      'inspect',
      '--format',
      '{{index .Config.Labels "ath.sandbox.run-id"}}',
      name,
    ]);
    if (identity.code === 0) {
      if (identity.stdout.trim() !== requestId) return false;
      await this.command(['container', 'rm', '--force', name]);
    }
    const remaining = await this.command([
      'container',
      'ls',
      '--all',
      '--filter',
      `name=^/${name}$`,
      '--format',
      '{{.Names}}',
    ]);
    return remaining.code === 0 && remaining.stdout.trim() === '';
  }

  async execute(
    raw: SandboxRequest,
    signal?: AbortSignal,
  ): Promise<SandboxResult> {
    const parsed = sandboxRequestSchema.safeParse(raw);
    if (!parsed.success) throw new SandboxError('SANDBOX_INPUT_INVALID');
    const request = parsed.data;
    if (this.runs.has(request.runId))
      throw new SandboxError('SANDBOX_DUPLICATE');
    let total = 0;
    const names = new Set<string>();
    for (const file of request.files) {
      const bytes = Buffer.from(file.contentBase64, 'base64');
      total += bytes.length;
      if (
        names.has(file.path) ||
        bytes.length > sandboxLimits.maxFileBytes ||
        total > sandboxLimits.maxTotalFileBytes ||
        bytes.toString('base64') !== file.contentBase64
      )
        throw new SandboxError('SANDBOX_INPUT_INVALID');
      names.add(file.path);
    }
    if (Buffer.byteLength(request.code) > sandboxLimits.maxCodeBytes)
      throw new SandboxError('SANDBOX_INPUT_INVALID');
    this.runs.add(request.runId);
    const started = Date.now();
    const name = `ath-sandbox-${request.runId}`;
    let state: SandboxState = 'runtime_error';
    let stdout = '';
    let stderr = '';
    let files: SandboxResult['files'] = [];
    let stopped: 'cancelled' | 'timed_out' | 'output_limit' | undefined;
    let timer: NodeJS.Timeout | undefined;
    let stopPromise: Promise<boolean> | undefined;
    let creationUnknown = false;
    const stop = (reason: typeof stopped) => {
      stopped ??= reason;
      stopPromise ??= this.cleanup(request.runId);
    };
    const onAbort = () => stop('cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (signal?.aborted) stopped = 'cancelled';
      else if (!(await this.available()))
        throw new SandboxError('SANDBOX_UNAVAILABLE');
      if (!stopped) {
        const created = await this.command([
          'container',
          'create',
          '--pull',
          'never',
          '--name',
          name,
          '--label',
          `ath.sandbox.run-id=${request.runId}`,
          '--label',
          'ath.sandbox.managed=true',
          '--network',
          'none',
          '--read-only',
          '--user',
          '65534:65534',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--memory',
          '256m',
          '--memory-swap',
          '256m',
          '--cpus',
          '0.5',
          '--pids-limit',
          '32',
          '--ulimit',
          'nofile=128:128',
          '--tmpfs',
          '/workspace:rw,nosuid,nodev,noexec,size=64m,mode=1777',
          '--tmpfs',
          '/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777',
          '--workdir',
          '/workspace',
          '--log-driver',
          'none',
          '--interactive',
          '--entrypoint',
          'python',
          this.config.image,
          '-I',
          '-B',
          '-c',
          pythonBootstrap,
        ]);
        creationUnknown = created.timedOut || created.code === null;
        if (created.code !== 0) throw new SandboxError('SANDBOX_UNAVAILABLE');
        if (!stopped) {
          timer = setTimeout(() => stop('timed_out'), request.timeoutMs);
          const output = await this.command(
            ['container', 'start', '--attach', '--interactive', name],
            {
              input: JSON.stringify(request),
              maxBytes: sandboxLimits.maxWireBytes,
              timeoutMs: request.timeoutMs + 20_000,
              onLimit: () => stop('output_limit'),
            },
          );
          if (output.timedOut) stop('timed_out');
          if (output.overflow) stop('output_limit');
          const inspected = await this.command([
            'container',
            'inspect',
            '--format',
            '{{.State.OOMKilled}}',
            name,
          ]);
          if (
            !stopped &&
            inspected.code === 0 &&
            inspected.stdout.trim() === 'true'
          )
            state = 'resource_limit';
          else if (!stopped && output.code === 0) {
            try {
              const body = z
                .strictObject({
                  state: z.enum(['completed', 'code_error', 'output_limit']),
                  stdout: z.string().max(sandboxLimits.maxStdoutBytes),
                  stderr: z.string().max(sandboxLimits.maxStdoutBytes),
                  files: z.array(sandboxFileSchema).max(sandboxLimits.maxFiles),
                })
                .parse(JSON.parse(output.stdout));
              let outputBytes = 0;
              const paths = new Set<string>();
              files = body.files.map((file) => {
                const content = Buffer.from(file.contentBase64, 'base64');
                outputBytes += content.length;
                if (
                  paths.has(file.path) ||
                  content.length > sandboxLimits.maxFileBytes ||
                  outputBytes > sandboxLimits.maxTotalFileBytes ||
                  content.toString('base64') !== file.contentBase64
                )
                  throw new Error('Invalid output');
                paths.add(file.path);
                return {
                  ...file,
                  sizeBytes: content.length,
                  sha256: createHash('sha256').update(content).digest('hex'),
                };
              });
              if (
                Buffer.byteLength(body.stdout) > sandboxLimits.maxStdoutBytes ||
                Buffer.byteLength(body.stderr) > sandboxLimits.maxStdoutBytes
              )
                throw new Error('Output limit');
              state = body.state;
              stdout = body.stdout;
              stderr = body.stderr;
            } catch {
              state = 'runtime_error';
              files = [];
            }
          }
        }
      }
    } catch {
      state = 'runtime_error';
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (stopPromise) await stopPromise;
    }
    const cleanupConfirmed =
      (await this.cleanup(request.runId)) && !creationUnknown;
    state = cleanupConfirmed ? (stopped ?? state) : 'cleanup_unknown';
    // Do not expose apparently successful artifacts when cancellation or cleanup is uncertain.
    if (state !== 'completed') files = [];
    return {
      runId: request.runId,
      state,
      cleanupConfirmed,
      stdout,
      stderr,
      files,
      durationMs: Date.now() - started,
    };
  }
}
