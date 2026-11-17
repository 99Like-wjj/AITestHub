import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  browserActionSchema,
  browserPlanSchema,
  browserUrlSchema,
  type BrowserRuntimePort,
} from '../../contracts/src/agent-browser.js';

export function createBrowserBroker(
  runtime: BrowserRuntimePort,
  token: string,
) {
  if (token.length < 32) throw new Error('BROWSER_BROKER_TOKEN_INVALID');
  const expected = Buffer.from(`Bearer ${token}`);
  return createServer(async (request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? '');
    response.setHeader('cache-control', 'no-store');
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      response.writeHead(401).end();
      return;
    }
    try {
      const url = new URL(request.url ?? '/', 'http://broker.invalid');
      const match =
        /^\/sessions\/([^/]+)(?:\/(open|observe|navigate|control|plan|human|close|status)(?:\/([^/]+))?)?$/.exec(
          url.pathname,
        );
      const id = z.uuid().parse(match?.[1]);
      const path = match?.[2] ?? '';
      let raw: unknown = undefined;
      if (request.method === 'POST') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const value of request) {
          const chunk = Buffer.from(value);
          size += chunk.byteLength;
          if (size > 64 * 1024) throw new Error('BROWSER_REQUEST_TOO_LARGE');
          chunks.push(chunk);
        }
        raw = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      }
      let result: unknown;
      if (path === 'open' && request.method === 'POST') {
        z.strictObject({}).parse(raw);
        await runtime.open(id);
        result = { ok: true };
      } else if (path === 'observe' && request.method === 'GET')
        result = await runtime.observe(
          id,
          url.searchParams.get('human') === '1',
        );
      else if (path === 'status' && request.method === 'GET')
        result = {
          result: await runtime.status(id, z.uuid().parse(match?.[3])),
        };
      else if (path === 'navigate' && request.method === 'POST') {
        const input = z
          .strictObject({ operationId: z.uuid(), url: browserUrlSchema })
          .parse(raw);
        result = await runtime.navigate(id, input.operationId, input.url);
      } else if (path === 'control' && request.method === 'POST') {
        const input = z
          .strictObject({
            operationId: z.uuid(),
            mode: z.enum(['human', 'agent']),
          })
          .parse(raw);
        await runtime.control(id, input.operationId, input.mode);
        result = { ok: true };
      } else if (path === 'plan' && request.method === 'POST') {
        const input = browserPlanSchema
          .extend({ operationId: z.uuid() })
          .parse(raw);
        const { operationId, ...plan } = input;
        result = await runtime.plan(id, operationId, plan);
      } else if (path === 'human' && request.method === 'POST') {
        const input = z
          .strictObject({
            operationId: z.uuid(),
            action: browserActionSchema,
            secret: z.boolean(),
          })
          .parse(raw);
        result = await runtime.humanAction(
          id,
          input.operationId,
          input.action,
          input.secret,
        );
      } else if (path === 'close' && request.method === 'POST') {
        z.strictObject({}).parse(raw);
        await runtime.close(id);
        result = { ok: true };
      } else {
        response.writeHead(404).end();
        return;
      }
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(result));
    } catch (error: unknown) {
      const code =
        error instanceof Error &&
        /^BROWSER_[A-Z0-9_]{1,70}$/.test(error.message)
          ? error.message
          : error instanceof z.ZodError
            ? 'BROWSER_REQUEST_INVALID'
            : 'BROWSER_RUNTIME_UNAVAILABLE';
      response
        .writeHead(422, { 'content-type': 'application/json' })
        .end(JSON.stringify({ code }));
    }
  });
}
