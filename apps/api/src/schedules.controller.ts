import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { idSchema } from '../../../packages/contracts/src/base.js';
import { IdentityService } from '../../../packages/application/src/identity/service.js';
import { ScheduleService } from '../../../packages/application/src/schedules/service.js';
import { DomainError } from '../../../packages/application/src/errors.js';
@Controller('api/v1/projects/:projectId/schedules')
export class SchedulesController {
  constructor(
    @Inject(ScheduleService) readonly service: ScheduleService,
    @Inject(IdentityService) readonly identity: IdentityService,
  ) {}
  @All(['', '{*schedulePath}'])
  async handle(@Req() req: Request, @Res() res: Response) {
    const projectId = idSchema.parse(req.params.projectId),
      path = req.path
        .slice(`/api/v1/projects/${projectId}/schedules`.length)
        .replace(/^\//, '')
        .replace(/\/$/, '');
    if (req.header('authorization'))
      throw new DomainError('FORBIDDEN', '个人Key请使用官方MCP。', 403);
    const session = req.headers.cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('ath_session='))
      ?.slice('ath_session='.length);
    const actor = await this.identity.authenticate(
      session,
      undefined,
      String(res.locals.requestId),
    );
    if (path === 'operation-status' && req.method === 'GET')
      return res.json(
        await this.service.operationStatus(actor, projectId, {
          operation: req.query.operation,
          key: req.query.key,
        }),
      );
    if (!path && req.method === 'GET')
      return res.json(await this.service.list(actor, projectId));
    if (!path && req.method === 'POST')
      return res
        .status(201)
        .json(await this.service.create(actor, projectId, req.body));
    if (path === 'preview' && req.method === 'POST')
      return res.json(await this.service.preview(actor, projectId, req.body));
    const match = /^([^/]+)(?:\/(pause|resume|copy|timeline))?$/.exec(path);
    if (match?.[1]) {
      const id = idSchema.parse(match[1]);
      if (!match[2] && req.method === 'GET')
        return res.json(await this.service.detail(actor, projectId, id));
      if (!match[2] && req.method === 'PUT')
        return res.json(
          await this.service.revise(actor, projectId, id, req.body),
        );
      if (match[2] === 'pause' && req.method === 'POST')
        return res.json(
          await this.service.pause(actor, projectId, id, req.body),
        );
      if (match[2] === 'resume' && req.method === 'POST')
        return res.json(
          await this.service.resume(actor, projectId, id, req.body),
        );
      if (match[2] === 'copy' && req.method === 'POST')
        return res
          .status(201)
          .json(await this.service.copy(actor, projectId, id, req.body));
      if (match[2] === 'timeline' && req.method === 'GET')
        return res.json(
          await this.service.timeline(
            actor,
            projectId,
            id,
            typeof req.query.before === 'string' ? req.query.before : undefined,
          ),
        );
    }
    throw new DomainError('NOT_FOUND', '没有此定时计划操作。', 404);
  }
}
