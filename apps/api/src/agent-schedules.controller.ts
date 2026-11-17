import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AgentScheduleService } from '../../../packages/application/src/agent-schedules/service.js';
import { IdentityService } from '../../../packages/application/src/identity/service.js';
import { DomainError } from '../../../packages/application/src/errors.js';

@Controller('api/v1/me/agent-schedules')
export class AgentSchedulesController {
  constructor(
    @Inject(AgentScheduleService) readonly schedules: AgentScheduleService,
    @Inject(IdentityService) readonly identity: IdentityService,
  ) {}
  @All(['', '{*agentSchedulePath}'])
  async handle(@Req() req: Request, @Res() res: Response) {
    if (req.header('authorization'))
      throw new DomainError(
        'FORBIDDEN',
        '个人定时任务只开放本人网页及受控对话。',
        403,
      );
    const cookie = req.headers.cookie
      ?.split(';')
      .map((value) => value.trim())
      .find((value) => value.startsWith('ath_session='))
      ?.slice('ath_session='.length);
    const actor = await this.identity.authenticate(
      cookie,
      undefined,
      String(res.locals.requestId),
    );
    if (actor.entrypoint !== 'web')
      throw new DomainError('FORBIDDEN', '个人定时任务只开放本人网页。', 403);
    const path = req.path
      .replace(/^\/api\/v1\/me\/agent-schedules\/?/, '')
      .replace(/\/$/, '');
    if (!path && req.method === 'GET')
      return res.json(await this.schedules.list(actor));
    if (!path && req.method === 'POST')
      return res.status(201).json(await this.schedules.create(actor, req.body));
    if (path === 'preview' && req.method === 'POST')
      return res.json(await this.schedules.preview(actor, req.body));
    if (path === 'receipt' && req.method === 'GET')
      return res.json(
        await this.schedules.commandReceipt(
          actor,
          z
            .enum(['create', 'revise', 'pause', 'resume', 'cancel'])
            .parse(req.query.operation),
          z.string().min(8).max(128).parse(req.query.key),
        ),
      );
    const match = /^([^/]+)(?:\/(pause|resume|cancel))?$/.exec(path);
    if (match?.[1]) {
      const id = z.uuid().parse(match[1]);
      if (!match[2] && req.method === 'GET')
        return res.json(await this.schedules.detail(actor, id));
      if (!match[2] && req.method === 'PUT')
        return res.json(await this.schedules.revise(actor, id, req.body));
      if (match[2] && req.method === 'POST')
        return res.json(
          await this.schedules.changeState(
            actor,
            id,
            z.enum(['pause', 'resume', 'cancel']).parse(match[2]),
            req.body,
          ),
        );
    }
    throw new DomainError('NOT_FOUND', '没有此个人定时操作。', 404);
  }
}
