import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  browserObservationSchema,
  browserRuntimeResultSchema,
  type BrowserRuntimePort,
  type BrowserAction,
  type browserPlanSchema,
} from '../../contracts/src/agent-browser.js';

export class BrowserBrokerClient implements BrowserRuntimePort {
  readonly origin: string;
  constructor(
    origin: string,
    private readonly token: string,
  ) {
    const url = new URL(origin);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.pathname !== '/' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      token.length < 32
    )
      throw new Error('BROWSER_CLIENT_CONFIG_INVALID');
    this.origin = url.origin;
  }
  private async request(sessionId: string, suffix: string, body?: unknown) {
    const response = await fetch(
      `${this.origin}/sessions/${z.uuid().parse(sessionId)}/${suffix}`,
      {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(65_000),
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    const reader = response.body?.getReader(),
      chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader)
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.length;
          if (bytes > 6 * 1024 * 1024)
            throw new Error('BROWSER_RESPONSE_TOO_LARGE');
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!response.ok) {
      const error = z
        .object({ code: z.string().regex(/^BROWSER_[A-Z0-9_]{1,70}$/) })
        .safeParse(raw);
      throw new Error(
        error.success ? error.data.code : 'BROWSER_RUNTIME_UNAVAILABLE',
      );
    }
    return raw;
  }
  async open(id: string) {
    z.object({ ok: z.literal(true) }).parse(await this.request(id, 'open', {}));
  }
  async observe(id: string, human = false) {
    return browserObservationSchema.parse(
      await this.request(id, `observe${human ? '?human=1' : ''}`),
    );
  }
  async navigate(id: string, operationId: string, url: string) {
    return browserRuntimeResultSchema.parse(
      await this.request(id, 'navigate', { operationId, url }),
    );
  }
  async control(id: string, operationId: string, mode: 'agent' | 'human') {
    z.object({ ok: z.literal(true) }).parse(
      await this.request(id, 'control', { operationId, mode }),
    );
  }
  async plan(
    id: string,
    operationId: string,
    plan: z.infer<typeof browserPlanSchema>,
  ) {
    return browserRuntimeResultSchema.parse(
      await this.request(id, 'plan', { ...plan, operationId }),
    );
  }
  async humanAction(
    id: string,
    operationId: string,
    action: BrowserAction,
    secret: boolean,
  ) {
    return browserRuntimeResultSchema.parse(
      await this.request(id, 'human', { operationId, action, secret }),
    );
  }
  async status(id: string, operationId: string) {
    return z
      .object({ result: browserRuntimeResultSchema.nullable() })
      .parse(await this.request(id, `status/${z.uuid().parse(operationId)}`))
      .result;
  }
  async close(id: string) {
    z.object({ ok: z.literal(true) }).parse(
      await this.request(id, 'close', {}),
    );
  }
}
export async function createBrowserClientFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const origin = environment.AITESTHUB_BROWSER_ORIGIN,
    tokenFile = environment.AITESTHUB_BROWSER_TOKEN_FILE;
  if (!origin && !tokenFile) return undefined;
  if (!origin || !tokenFile)
    throw new Error('BROWSER_ORIGIN_AND_TOKEN_FILE_REQUIRED');
  let token: string;
  try {
    token = (await readFile(tokenFile, 'utf8')).trim();
  } catch {
    throw new Error('BROWSER_TOKEN_FILE_UNAVAILABLE');
  }
  return new BrowserBrokerClient(origin, token);
}
