import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  idSchema,
  commandIdSchema,
} from '../../../packages/contracts/src/base.js';
import { ApiExecutionControlService } from '../../../packages/application/src/api-execution/control.js';
import { IdentityService } from '../../../packages/application/src/identity/service.js';
import { DomainError } from '../../../packages/application/src/errors.js';

function bearer(request: Request): string {
  const header = request.header('authorization');
  if (!header?.startsWith('Bearer ') || header.length > 512)
    throw new DomainError('UNAUTHENTICATED', '执行授权格式无效。', 401);
  return header.slice(7);
}
@Controller('api/internal/api-worker')
export class ApiWorkerController {
  constructor(
    @Inject(ApiExecutionControlService)
    readonly service: ApiExecutionControlService,
  ) {}
  @All(['', '{*workerPath}'])
  async handle(@Req() req: Request, @Res() res: Response) {
    if (req.method !== 'POST')
      throw new DomainError('NOT_FOUND', '没有此执行协议操作。', 404);
    const path = req.path
      .replace(/^\/api\/internal\/api-worker\/?/, '')
      .replace(/\/$/, '');
    const credential = bearer(req);
    if (path === 'claim') {
      this.service.verifyBootstrap(credential);
      return res.json(await this.service.claim(req.body));
    }
    if (path === 'load') return res.json(await this.service.load(credential));
    if (path === 'heartbeat')
      return res.json(await this.service.heartbeat(credential));
    if (path === 'begin')
      return res.json(
        await this.service.beginCase(
          credential,
          z.strictObject({ runItemId: idSchema }).parse(req.body).runItemId,
        ),
      );
    if (path === 'authorize')
      return res.json(await this.service.authorize(credential, req.body));
    if (path === 'response')
      return res.json(await this.service.completeAttempt(credential, req.body));
    if (path === 'local-failure')
      return res.json(await this.service.localFailure(credential, req.body));
    if (path === 'case-complete')
      return res.json(await this.service.completeCase(credential, req.body));
    if (path === 'finish')
      return res.json(await this.service.finish(credential));
    if (path === 'abandon')
      return res.json(await this.service.abandon(credential));
    throw new DomainError('NOT_FOUND', '没有此执行协议操作。', 404);
  }
}
@Controller('api/v1/projects/:projectId/api-executions')
export class ApiExecutionController {
  constructor(
    @Inject(ApiExecutionControlService)
    readonly service: ApiExecutionControlService,
    @Inject(IdentityService) readonly identity: IdentityService,
  ) {}
  @All(['', '{*executionPath}'])
  async handle(@Req() req: Request, @Res() res: Response) {
    const projectId = idSchema.parse(req.params.projectId);
    const prefix = `/api/v1/projects/${projectId}/api-executions`;
    const path = req.path
      .slice(prefix.length)
      .replace(/^\//, '')
      .replace(/\/$/, '');
    const session = req.headers.cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('ath_session='))
      ?.slice('ath_session='.length);
    const authorization = req.header('authorization');
    if (
      authorization !== undefined &&
      (!authorization.startsWith('Bearer ') || authorization.length > 512)
    )
      throw new DomainError('UNAUTHENTICATED', '认证格式无效。', 401);
    const authenticate = () =>
      this.identity.authenticate(
        session,
        authorization?.slice(7),
        String(res.locals.requestId),
      );
    const actor = await authenticate();
    if (actor.entrypoint !== 'web')
      throw new DomainError('FORBIDDEN', '个人Key请使用官方MCP。', 403);
    if (path === 'debug' && req.method === 'POST')
      return res
        .status(202)
        .json(await this.service.debug.start(actor, projectId, req.body));
    const receipt = /^debug-receipts\/([^/]+)$/.exec(path);
    if (receipt?.[1] && req.method === 'GET')
      return res.json(
        await this.service.debug.receipt(
          actor,
          projectId,
          commandIdSchema.parse(decodeURIComponent(receipt[1])),
        ),
      );
    const route =
      /^([^/]+)(?:\/(events|stream|stop|attempts|debug-result)(?:\/([^/]+))?)?$/.exec(
        path,
      );
    const stopReceipt = /^([^/]+)\/stop-receipts\/([^/]+)$/.exec(path);
    if (stopReceipt?.[1] && stopReceipt[2] && req.method === 'GET')
      return res.json(
        await this.service.stopReceipt(
          actor,
          projectId,
          idSchema.parse(stopReceipt[1]),
          commandIdSchema.parse(decodeURIComponent(stopReceipt[2])),
        ),
      );
    if (route?.[1]) {
      const runId = idSchema.parse(route[1]);
      if (!route[2] && req.method === 'GET')
        return res.json(await this.service.status(actor, projectId, runId));
      if (route[2] === 'debug-result' && req.method === 'GET')
        return res.json(
          await this.service.debug.trace(actor, projectId, runId),
        );
      if (route[2] === 'stop' && req.method === 'POST')
        return res.json(
          await this.service.stop(actor, projectId, runId, req.body),
        );
      if (route[2] === 'attempts' && route[3] && req.method === 'GET')
        return res.json(
          await this.service.attemptDetail(
            actor,
            projectId,
            runId,
            idSchema.parse(route[3]),
          ),
        );
      if (route[2] === 'events' && req.method === 'GET')
        return res.json(
          await this.service.events(
            actor,
            projectId,
            runId,
            z.coerce
              .number()
              .int()
              .min(0)
              .max(Number.MAX_SAFE_INTEGER)
              .parse(req.query.after ?? 0),
          ),
        );
      if (route[2] === 'stream' && req.method === 'GET') {
        let after = z.coerce
          .number()
          .int()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER)
          .parse(req.header('last-event-id') ?? req.query.after ?? 0);
        await this.service.events(actor, projectId, runId, after);
        res.status(200).set({
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        res.flushHeaders();
        let busy = false;
        let ticks = 0;
        const poll = async () => {
          if (busy) return;
          busy = true;
          try {
            const current = await authenticate();
            const result = await this.service.events(
              current,
              projectId,
              runId,
              after,
            );
            for (const event of result.events) {
              after = Number(event.sequence);
              res.write(
                `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
              );
            }
            if (++ticks % 15 === 0) res.write(': heartbeat\n\n');
          } catch {
            clearInterval(timer);
            res.write(
              'event: access-ended\ndata: {"code":"ACCESS_CHANGED"}\n\n',
            );
            res.end();
          } finally {
            busy = false;
          }
        };
        const timer = setInterval(() => {
          void poll();
        }, 1000);
        res.once('close', () => clearInterval(timer));
        void poll();
        return;
      }
    }
    throw new DomainError('NOT_FOUND', '没有此接口执行操作。', 404);
  }
}
