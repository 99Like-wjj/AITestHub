import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  sandboxLimits,
  sandboxRequestSchema,
  type SandboxRequest,
  type SandboxResult,
} from '../../contracts/src/agent-sandbox.js';
import { DockerSandbox } from './docker-sandbox.js';

const journalRecordSchema = z.strictObject({
  runId: z.uuid().toLowerCase(),
  createdAt: z.iso.datetime(),
  state: z.enum(['queued', 'running', 'finished', 'cleanup_unknown']),
});
type JournalRecord = z.infer<typeof journalRecordSchema>;
type LiveRun = {
  record: JournalRecord;
  abort: AbortController;
  phase: 'accepting' | 'queued' | 'running' | 'finishing' | 'finished';
  input?: SandboxRequest;
  inputBytes: number;
  result?: SandboxResult;
  resultBytes: number;
  queueTimer?: NodeJS.Timeout;
  expired: boolean;
};

export type SandboxBrokerOptions = {
  runner: DockerSandbox;
  token: string;
  journalDirectory: string;
};

/** Trusted network boundary; intentionally has no arbitrary container, command or host-file API. */
export async function createSandboxBroker(options: SandboxBrokerOptions) {
  if (options.token.length < 32)
    throw new Error('SANDBOX_BROKER_TOKEN_INVALID');
  const authHash = createHash('sha256')
    .update(`Bearer ${options.token}`)
    .digest();
  const directory = resolve(options.journalDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(directory)) !== directory
  )
    throw new Error('SANDBOX_BROKER_JOURNAL_INVALID');
  const live = new Map<string, LiveRun>();
  const uncertain = new Set<string>();
  const queue: LiveRun[] = [];
  let queuedBytes = 0;
  let retainedBytes = 0;
  let active = 0;
  let dispatching: LiveRun | undefined;
  let bodyReaders = 0;
  let inboundBytes = 0;
  let shuttingDown = false;

  const journalPath = (id: string) =>
    join(directory, `${z.uuid().parse(id)}.json`);
  const save = async (record: JournalRecord) => {
    const temp = join(directory, `${record.runId}.${randomUUID()}.tmp`);
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(record));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, journalPath(record.runId));
  };
  // Queued bytes are never persisted. Recovery only cleans exact recorded runs;
  // old and queued journals both consume their UUID forever without replay.
  for (const name of await readdir(directory)) {
    if (!/^[0-9a-f-]{36}\.json$/u.test(name)) continue;
    const record = journalRecordSchema.parse(
      JSON.parse(await readFile(join(directory, name), 'utf8')),
    );
    if (name !== `${record.runId}.json`)
      throw new Error('SANDBOX_BROKER_JOURNAL_INVALID');
    if (record.state === 'finished') continue;
    const cleanupConfirmed = await options.runner.cleanup(record.runId);
    if (!cleanupConfirmed) uncertain.add(record.runId);
    await save({
      ...record,
      state: cleanupConfirmed ? 'finished' : 'cleanup_unknown',
    });
  }

  const forget = (run: LiveRun) => {
    if (live.get(run.record.runId) !== run) return;
    retainedBytes -= run.resultBytes;
    live.delete(run.record.runId);
  };
  const pendingState = (run: LiveRun) =>
    run.phase === 'running' ? 'running' : 'queued';
  const emptyResult = (
    run: LiveRun,
    state: SandboxResult['state'],
    stderr = '',
  ): SandboxResult => ({
    runId: run.record.runId,
    state,
    cleanupConfirmed: true,
    stdout: '',
    stderr,
    files: [],
    durationMs: 0,
  });
  const finish = async (run: LiveRun, result: SandboxResult) => {
    await save({
      ...run.record,
      state: result.cleanupConfirmed ? 'finished' : 'cleanup_unknown',
    });
    run.result = result;
    run.phase = 'finished';
    run.resultBytes = Buffer.byteLength(JSON.stringify(result));
    retainedBytes += run.resultBytes;
    // Bound confidential output by aggregate bytes as well as item count.
    for (const candidate of live.values()) {
      if (
        retainedBytes <= sandboxLimits.maxRetainedResultBytes &&
        [...live.values()].filter((item) => item.result).length <= 16
      )
        break;
      if (candidate.result) forget(candidate);
    }
    const ttl = setTimeout(() => forget(run), 5 * 60_000);
    ttl.unref();
  };
  const removeQueued = (run: LiveRun) => {
    const index = queue.indexOf(run);
    if (index >= 0) queue.splice(index, 1);
    queuedBytes -= run.inputBytes;
    run.inputBytes = 0;
    delete run.input;
    if (run.queueTimer) clearTimeout(run.queueTimer);
  };
  const finishQueued = async (run: LiveRun) => {
    // An accepting request must finish its durable intent before cancellation can
    // publish a terminal result. Its abort flag is observed immediately afterward.
    if (run.phase !== 'queued') return;
    run.phase = 'finishing';
    removeQueued(run);
    try {
      await finish(
        run,
        emptyResult(
          run,
          run.expired ? 'timed_out' : 'cancelled',
          run.expired ? 'SANDBOX_QUEUE_WAIT_EXPIRED' : '',
        ),
      );
    } catch {
      // No code starts on a journal failure. Keep the durable UUID for reconciliation.
      forget(run);
    } finally {
      pump();
    }
  };
  const pump = () => {
    while (
      !shuttingDown &&
      !dispatching &&
      active + uncertain.size < sandboxLimits.maxConcurrentRuns
    ) {
      const run = queue[0];
      // Do not overtake a FIFO head whose acceptance journal is still syncing.
      if (!run || run.phase !== 'queued') return;
      if (run.abort.signal.aborted || run.expired) {
        void finishQueued(run);
        continue;
      }
      const input = run.input;
      if (!input) throw new Error('SANDBOX_QUEUE_INPUT_MISSING');
      removeQueued(run);
      run.phase = 'running';
      active++;
      dispatching = run;
      void (async () => {
        try {
          // Reserve the active slot before awaiting persistence. Execution only
          // begins after the running transition is synced, including for queued jobs.
          await save({ ...run.record, state: 'running' });
          if (run.abort.signal.aborted) {
            await finish(run, emptyResult(run, 'cancelled'));
            return;
          }
          let result: SandboxResult;
          try {
            const execution = options.runner.execute(input, run.abort.signal);
            // Serialize only journal-to-executor dispatch, so a faster fsync
            // cannot let the next FIFO entry start first. Programs still overlap.
            dispatching = undefined;
            pump();
            result = await execution;
          } catch {
            uncertain.add(input.runId);
            const cleanupConfirmed = await options.runner.cleanup(input.runId);
            if (cleanupConfirmed) uncertain.delete(input.runId);
            result = {
              ...emptyResult(
                run,
                cleanupConfirmed ? 'runtime_error' : 'cleanup_unknown',
              ),
              cleanupConfirmed,
            };
          }
          if (!result.cleanupConfirmed) uncertain.add(input.runId);
          await finish(run, result);
        } catch {
          // A synced intent remains even if final persistence/cleanup fails.
          forget(run);
        } finally {
          if (dispatching === run) dispatching = undefined;
          active--;
          pump();
        }
      })();
    }
  };

  const respond = (response: ServerResponse, code: number, body: unknown) => {
    response.writeHead(code, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    response.end(JSON.stringify(body));
  };
  const readBody = async (request: IncomingMessage) => {
    // Incoming bodies share another byte budget; unauthenticated/oversize uploads
    // cannot grow memory independently of the bounded accepted queue.
    if (bodyReaders >= sandboxLimits.maxQueuedRuns)
      throw new Error('SANDBOX_ADMISSION_BUSY');
    bodyReaders++;
    let bytes = 0;
    let transferred = false;
    const chunks: Buffer[] = [];
    try {
      for await (const raw of request) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
        if (
          bytes + chunk.length > sandboxLimits.maxWireBytes ||
          inboundBytes + chunk.length > sandboxLimits.maxQueuedInputBytes
        )
          throw new Error('SANDBOX_REQUEST_TOO_LARGE');
        bytes += chunk.length;
        inboundBytes += chunk.length;
        chunks.push(chunk);
      }
      const input = sandboxRequestSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
      );
      transferred = true;
      return {
        input,
        bytes,
        release: () => {
          inboundBytes -= bytes;
          bodyReaders--;
        },
      };
    } finally {
      if (!transferred) {
        inboundBytes -= bytes;
        bodyReaders--;
      }
    }
  };
  const server = createServer((request, response) => {
    void (async () => {
      const sent = createHash('sha256')
        .update(request.headers.authorization ?? '')
        .digest();
      if (!timingSafeEqual(authHash, sent))
        return respond(response, 401, { code: 'UNAUTHORIZED' });
      if (request.url === '/v1/health' && request.method === 'GET')
        return respond(response, 200, {
          available: !shuttingDown && (await options.runner.available()),
          active,
          queued: queue.length,
          queuedInputBytes: queuedBytes,
          cleanupUncertain: uncertain.size,
        });
      if (request.url === '/v1/runs' && request.method === 'POST') {
        const { input, bytes, release } = await readBody(request);
        try {
          // Existing UUIDs take precedence over capacity rejection. In particular,
          // a full queue must never report an already running UUID as unaccepted.
          if (live.has(input.runId))
            return respond(response, 409, { code: 'SANDBOX_ALREADY_ACCEPTED' });
          try {
            await lstat(journalPath(input.runId));
            return respond(response, 409, { code: 'SANDBOX_ALREADY_ACCEPTED' });
          } catch (error) {
            if (!(
              error instanceof Error &&
              'code' in error &&
              error.code === 'ENOENT'
            ))
              throw error;
          }
          // Recheck after disk await; reservation and capacity checks are synchronous.
          if (live.has(input.runId))
            return respond(response, 409, { code: 'SANDBOX_ALREADY_ACCEPTED' });
          if (
            shuttingDown ||
            queue.length >= sandboxLimits.maxQueuedRuns ||
            queuedBytes + bytes > sandboxLimits.maxQueuedInputBytes
          )
            return respond(response, 503, {
              runId: input.runId,
              accepted: false,
              code: shuttingDown
                ? 'SANDBOX_SHUTTING_DOWN'
                : 'SANDBOX_QUEUE_FULL',
            });
          const record: JournalRecord = {
            runId: input.runId,
            createdAt: new Date().toISOString(),
            state: 'queued',
          };
          const run: LiveRun = {
            record,
            abort: new AbortController(),
            phase: 'accepting',
            input,
            inputBytes: bytes,
            resultBytes: 0,
            expired: false,
          };
          live.set(input.runId, run);
          queue.push(run);
          queuedBytes += bytes;
          run.queueTimer = setTimeout(() => {
            run.expired = true;
            run.abort.abort();
            void finishQueued(run);
          }, sandboxLimits.maxQueueWaitMs);
          run.queueTimer.unref();
          try {
            const intent = await open(journalPath(input.runId), 'wx', 0o600);
            try {
              await intent.writeFile(JSON.stringify(record));
              await intent.sync();
            } finally {
              await intent.close();
            }
          } catch (error) {
            removeQueued(run);
            forget(run);
            pump();
            if (
              error instanceof Error &&
              'code' in error &&
              error.code === 'EEXIST'
            )
              return respond(response, 409, {
                code: 'SANDBOX_ALREADY_ACCEPTED',
              });
            throw error;
          }
          run.phase = 'queued';
          if (shuttingDown || run.abort.signal.aborted) {
            run.abort.abort();
            await finishQueued(run);
          } else pump();
          return respond(response, 202, {
            runId: input.runId,
            state: pendingState(run),
          });
        } finally {
          release();
        }
      }
      const match = /^\/v1\/runs\/([0-9a-f-]{36})$/u.exec(request.url ?? '');
      const id = z.uuid().safeParse(match?.[1]);
      if (!id.success) return respond(response, 404, { code: 'NOT_FOUND' });
      const run = live.get(id.data);
      if (request.method === 'DELETE') {
        if (run && !run.result) {
          run.abort.abort();
          await finishQueued(run);
        }
        if (!run || run.result?.cleanupConfirmed === false) {
          try {
            const record = journalRecordSchema.parse(
              JSON.parse(await readFile(journalPath(id.data), 'utf8')),
            );
            const cleanupConfirmed = await options.runner.cleanup(id.data);
            await save({
              ...record,
              state: cleanupConfirmed ? 'finished' : 'cleanup_unknown',
            });
            if (cleanupConfirmed) {
              uncertain.delete(id.data);
              pump();
            } else uncertain.add(id.data);
            if (run?.result && cleanupConfirmed)
              run.result = {
                ...run.result,
                cleanupConfirmed: true,
                state: 'runtime_error',
                files: [],
              };
          } catch (error) {
            if (!(
              error instanceof Error &&
              'code' in error &&
              error.code === 'ENOENT'
            ))
              throw error;
          }
        }
        // Acknowledgement alone does not prove a running container was removed.
        return respond(response, 202, {
          runId: id.data,
          cancellationRequested: true,
        });
      }
      if (request.method !== 'GET')
        return respond(response, 405, { code: 'METHOD_NOT_ALLOWED' });
      if (run)
        return respond(
          response,
          200,
          run.result ?? {
            runId: id.data,
            state: pendingState(run),
          },
        );
      try {
        const record = journalRecordSchema.parse(
          JSON.parse(await readFile(journalPath(id.data), 'utf8')),
        );
        return respond(response, 200, {
          runId: record.runId,
          state: 'result_unavailable',
          cleanupConfirmed: record.state === 'finished',
        });
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return respond(response, 404, { code: 'NOT_FOUND' });
        throw error;
      }
    })().catch(() => {
      if (!response.headersSent)
        respond(response, 400, { code: 'SANDBOX_REQUEST_REJECTED' });
      else response.destroy();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return {
    server,
    async shutdown() {
      shuttingDown = true;
      for (const run of live.values()) if (!run.result) run.abort.abort();
      server.close();
      await Promise.all([...queue].map((run) => finishQueued(run)));
      // In-flight body readers/acceptance journals observe shuttingDown before
      // execution; include them in drain rather than returning early at active=0.
      const deadline = Date.now() + 45_000;
      while (
        (active > 0 ||
          queue.length > 0 ||
          bodyReaders > 0 ||
          [...live.values()].some((run) => run.phase === 'finishing')) &&
        Date.now() < deadline
      )
        await new Promise<void>((done) => setTimeout(done, 100));
      return (
        active === 0 &&
        uncertain.size === 0 &&
        queue.length === 0 &&
        bodyReaders === 0 &&
        ![...live.values()].some((run) => run.phase === 'finishing')
      );
    },
  };
}
