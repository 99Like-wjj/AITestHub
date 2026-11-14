import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { WorkerClient, WorkerProtocolError } from './client.js';
import { runAssigned } from './runner.js';

const secretFile = process.env.AITESTHUB_API_WORKER_BOOTSTRAP_FILE;
if (!secretFile)
  throw new Error('AITESTHUB_API_WORKER_BOOTSTRAP_FILE is required.');
const bootstrap = (await readFile(secretFile, 'utf8')).trim();
if (bootstrap.length < 32)
  throw new Error('Worker bootstrap credential is invalid.');
const endpoint = process.env.AITESTHUB_CONTROL_URL ?? 'http://api:5300';
const client = new WorkerClient(endpoint, bootstrap);
const instance = randomUUID();
let stopped = false;
let current: AbortController | undefined;
const stop = () => {
  stopped = true;
  current?.abort();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
const assignmentSchema = z.discriminatedUnion('assigned', [
  z.object({ assigned: z.literal(false), reason: z.string() }),
  z.object({
    assigned: z.literal(true),
    runId: z.uuid(),
    runGrant: z.string(),
    leaseMs: z.number().int(),
    snapshotDigest: z.string(),
  }),
]);
while (!stopped) {
  try {
    const assignment = assignmentSchema.parse(await client.claim(instance));
    if (assignment.assigned) {
      current = new AbortController();
      await runAssigned(client, assignment.runGrant, {
        leaseMs: assignment.leaseMs,
        signal: current.signal,
      });
      current = undefined;
    } else await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  } catch (error: unknown) {
    // Protocol/technical code only. Never print request, target response, script, token or connection data.
    const code =
      error instanceof WorkerProtocolError ? error.code : 'WORKER_TASK_FAILED';
    process.stderr.write(`${code}\n`);
    if (!stopped)
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  }
}
