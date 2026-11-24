import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  idSchema,
  commandIdSchema,
} from '../../../packages/contracts/src/base.js';
import { IdentityService } from '../../../packages/application/src/identity/service.js';
import { RetestService } from '../../../packages/application/src/retests/service.js';
import { DomainError } from '../../../packages/application/src/errors.js';
@Controller('api/v1/projects/:projectId/retests')
export class RetestsController {
  constructor(
    @Inject(IdentityService) readonly identity: IdentityService,
    @Inject(RetestService) readonly retests: RetestService,
  ) {}
  @All(['', '{*retestPath}']) async handle(
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (req.header('authorization'))
      throw new DomainError('FORBIDDEN', '个人Key请使用官方MCP复测工具。', 403);
    const cookie = req.headers.cookie
      ?.split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith('ath_session='))
      ?.slice(12);
    const actor = await this.identity.authenticate(
      cookie,
      undefined,
      String(res.locals.requestId),
    );
    const projectId = idSchema.parse(req.params.projectId);
    const path = req.path
      .slice(`/api/v1/projects/${projectId}/retests`.length)
      .replace(/^\//, '')
      .replace(/\/$/, '');
    if (!path && req.method === 'GET')
      return res.json(await this.retests.list(actor, projectId));
    if (!path && req.method === 'POST')
      return res
        .status(201)
        .json(await this.retests.prepare(actor, projectId, req.body));
    const receipt = /^api-start-receipts\/([^/]+)$/.exec(path);
    if (receipt?.[1] && req.method === 'GET')
      return res.json(
        await this.retests.startReceipt(
          actor,
          projectId,
          commandIdSchema.parse(decodeURIComponent(receipt[1])),
        ),
      );
    const group = /^groups\/([^/]+)\/(start-api|start-preview)$/.exec(path);
    if (group?.[1]) {
      const id = idSchema.parse(group[1]);
      if (group[2] === 'start-preview' && req.method === 'GET')
        return res.json(await this.retests.startPreview(actor, projectId, id));
      if (group[2] === 'start-api' && req.method === 'POST')
        return res.json(
          await this.retests.startApi(actor, projectId, id, req.body),
        );
    }
    if (/^[0-9a-f-]{36}$/.test(path) && req.method === 'GET')
      return res.json(
        await this.retests.detail(actor, projectId, idSchema.parse(path)),
      );
    throw new DomainError('NOT_FOUND', '没有此复测接口。', 404);
  }
}
