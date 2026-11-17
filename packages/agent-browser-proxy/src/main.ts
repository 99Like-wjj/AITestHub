import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
import { createBrowserEgressProxy } from './proxy.js';
import { readBrowserNetworkPolicy } from './environment.js';

export async function startBrowserProxy(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const tokenFile = z
    .string()
    .min(1)
    .parse(environment.AITESTHUB_BROWSER_PROXY_TOKEN_FILE);
  const policy = await readBrowserNetworkPolicy(environment);
  const advertisedOrigin = z
    .url()
    .parse(environment.AITESTHUB_BROWSER_PROXY_ORIGIN);
  const proxy = createBrowserEgressProxy({
    adminToken: (await readFile(tokenFile, 'utf8')).trim(),
    advertisedOrigin,
    allowedPrivateOrigins: policy.allowedPrivateOrigins,
    forbiddenOrigins: policy.forbiddenOrigins,
  });
  await new Promise<void>((done, reject) => {
    proxy.server.once('error', reject);
    proxy.server.listen(
      z.coerce
        .number()
        .int()
        .min(1)
        .max(65535)
        .parse(environment.AITESTHUB_BROWSER_PROXY_PORT ?? 5318),
      environment.AITESTHUB_BROWSER_PROXY_BIND_HOST ?? '127.0.0.1',
      done,
    );
  });
  process.once('SIGINT', () => {
    void proxy.close();
  });
  process.once('SIGTERM', () => {
    void proxy.close();
  });
  return proxy;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  startBrowserProxy().catch(() => {
    process.stderr.write('BROWSER_PROXY_START_FAILED\n');
    process.exitCode = 1;
  });
