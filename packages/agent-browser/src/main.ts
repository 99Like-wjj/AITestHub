import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
import { BrowserProxyClient } from '../../agent-browser-proxy/src/proxy.js';
import { readBrowserNetworkPolicy } from '../../agent-browser-proxy/src/environment.js';
import { createBrowserBroker } from './broker.js';
import { PlaywrightBrowserRuntime } from './runtime.js';

export async function startBrowserBroker(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const required = (name: string) => z.string().min(1).parse(environment[name]);
  const token = (
    await readFile(required('AITESTHUB_BROWSER_TOKEN_FILE'), 'utf8')
  ).trim();
  const proxyToken = (
    await readFile(required('AITESTHUB_BROWSER_PROXY_TOKEN_FILE'), 'utf8')
  ).trim();
  const policy = await readBrowserNetworkPolicy(environment);
  const runtime = new PlaywrightBrowserRuntime({
    proxy: new BrowserProxyClient(
      required('AITESTHUB_BROWSER_PROXY_CONTROL_ORIGIN'),
      proxyToken,
    ),
    journalDirectory: required('AITESTHUB_BROWSER_JOURNAL_DIRECTORY'),
    allowedWebSocketOrigins: policy.allowedWebSocketOrigins,
  });
  const server = createBrowserBroker(runtime, token);
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(
      z.coerce
        .number()
        .int()
        .min(1)
        .max(65535)
        .parse(environment.AITESTHUB_BROWSER_PORT ?? 5317),
      environment.AITESTHUB_BROWSER_BIND_HOST ?? '127.0.0.1',
      done,
    );
  });
  const close = async () => {
    await runtime.shutdown();
    await new Promise<void>((done) => server.close(() => done()));
  };
  process.once('SIGINT', () => {
    void close();
  });
  process.once('SIGTERM', () => {
    void close();
  });
  return { server, runtime, close };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  startBrowserBroker().catch(() => {
    process.stderr.write('BROWSER_BROKER_START_FAILED\n');
    process.exitCode = 1;
  });
