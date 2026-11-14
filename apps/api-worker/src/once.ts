// Explicit one-job diagnostic entry; stdout contains public status only, never its run grant.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { WorkerClient, WorkerProtocolError } from './client.js';
import { runAssigned } from './runner.js';
const file = process.env.AITESTHUB_API_WORKER_BOOTSTRAP_FILE;
const url = process.env.AITESTHUB_CONTROL_URL;
const desired = process.env.AITESTHUB_DESIRED_RUN_ID;
const desiredRequest = process.env.AITESTHUB_DESIRED_REQUEST_ID;
if (
  !file ||
  !url ||
  (!desired && !desiredRequest) ||
  (desired && desiredRequest)
)
  throw new Error(
    'One-job worker diagnostic requires private bootstrap file, control URL and exactly one fixed run or queued request ID.',
  );
const client = new WorkerClient(url, (await readFile(file, 'utf8')).trim());
try {
  const raw = await client.claim(randomUUID(), desired, desiredRequest);
  const assignment = z
    .discriminatedUnion('assigned', [
      z.object({ assigned: z.literal(false), reason: z.string() }),
      z.object({
        assigned: z.literal(true),
        runGrant: z.string(),
        leaseMs: z.number(),
      }),
    ])
    .parse(raw);
  if (!assignment.assigned) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, code: 'NO_UNCLAIMED_RUN' })}\n`,
    );
    process.exitCode = 2;
  } else {
    const result = await runAssigned(client, assignment.runGrant, {
      leaseMs: assignment.leaseMs,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
  }
} catch (error: unknown) {
  process.stdout.write(
    `${JSON.stringify({ ok: false, code: error instanceof WorkerProtocolError ? error.code : 'WORKER_FAILED' })}\n`,
  );
  process.exitCode = 1;
}
