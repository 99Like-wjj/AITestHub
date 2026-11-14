import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { idSchema, kindSchema } from '../../../packages/contracts/src/base.js';
import { PlanService } from '../../../packages/application/src/plans/service.js';
import { IdentityService } from '../../../packages/application/src/identity/service.js';
import { DomainError } from '../../../packages/application/src/errors.js';

@Controller('api/v1/projects/:projectId/plans')
export class PlansController {
  constructor(
    @Inject(PlanService) readonly service: PlanService,
    @Inject(IdentityService) readonly identity: IdentityService,
  ) {}
  @All(['', '{*planPath}'])
  async handle(@Req() req: Request, @Res() res: Response) {
    const projectId = idSchema.parse(req.params.projectId);
    const prefix = `/api/v1/projects/${projectId}/plans`;
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
    const actor = await this.identity.authenticate(
      session,
      authorization?.slice(7),
      String(res.locals.requestId),
    );
    if (actor.entrypoint !== 'web')
      throw new DomainError('FORBIDDEN', '个人Key请使用官方MCP。', 403);
    if (path === 'operation-status' && req.method === 'GET')
      return res.json(
        await this.service.operationStatus(actor, projectId, {
          operation: req.query.operation,
          key: req.query.key,
        }),
      );
    if (path === '' && req.method === 'GET')
      return res.json(
        await this.service.list(
          actor,
          projectId,
          req.query.kind === undefined
            ? undefined
            : kindSchema.parse(req.query.kind),
        ),
      );
    if (path === '' && req.method === 'POST')
      return res
        .status(201)
        .json(await this.service.create(actor, projectId, req.body));
    const status = /^api-requests\/([^/]+)$/.exec(path);
    if (status?.[1] && req.method === 'GET')
      return res.json(
        await this.service.requestStatus(
          actor,
          projectId,
          idSchema.parse(status[1]),
        ),
      );
    const plan =
      /^([^/]+)(?:\/(ui-scope|api-start-previews|api-requests))?$/.exec(path);
    if (plan?.[1]) {
      const id = idSchema.parse(plan[1]);
      if (!plan[2]) {
        if (req.method === 'GET')
          return res.json(await this.service.detail(actor, projectId, id));
        if (req.method === 'PUT')
          return res.json(
            await this.service.revise(actor, projectId, id, req.body),
          );
      }
      if (plan[2] === 'ui-scope' && req.method === 'GET')
        return res.json(
          await this.service.uiScope(
            actor,
            projectId,
            id,
            idSchema.parse(req.query.planRevisionId),
          ),
        );
      if (plan[2] === 'api-start-previews' && req.method === 'POST')
        return res.json(
          await this.service.startPreview(actor, projectId, id, req.body),
        );
      if (plan[2] === 'api-requests' && req.method === 'POST')
        return res
          .status(202)
          .json(await this.service.queue(actor, projectId, id, req.body));
    }
    throw new DomainError('NOT_FOUND', '没有此计划接口。', 404);
  }
}
