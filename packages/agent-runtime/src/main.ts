import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
import { createSandboxBroker } from './broker.js';
import { DockerSandbox } from './docker-sandbox.js';

export async function startSandboxBroker(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const config = z
    .strictObject({
      image: z.string().min(1),
      tokenFile: z.string().min(1),
      journal: z.string().min(1),
      host: z.string().min(1),
      port: z.coerce.number().int().min(1).max(65535),
    })
    .parse({
      image: environment.AITESTHUB_SANDBOX_IMAGE,
      tokenFile: environment.AITESTHUB_SANDBOX_TOKEN_FILE,
      journal: environment.AITESTHUB_SANDBOX_JOURNAL_DIRECTORY,
      host: environment.AITESTHUB_SANDBOX_BIND_HOST ?? '127.0.0.1',
      port: environment.AITESTHUB_SANDBOX_PORT ?? '5312',
    });
  const runner = new DockerSandbox({ image: config.image });
  const broker = await createSandboxBroker({
    runner,
    token: (await readFile(config.tokenFile, 'utf8')).trim(),
    journalDirectory: config.journal,
  });
  await new Promise<void>((done, reject) => {
    broker.server.once('error', reject);
    broker.server.listen(config.port, config.host, done);
  });
  const stop = () => {
    void broker.shutdown().then((clean) => {
      process.exitCode = clean ? 0 : 1;
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return broker;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  startSandboxBroker().catch(() => {
    process.stderr.write('SANDBOX_BROKER_START_FAILED\n');
    process.exitCode = 1;
  });
