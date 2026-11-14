import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { IdentityService } from '../../../packages/application/src/identity/service.js';
import { OperationsService } from '../../../packages/application/src/recovery/service.js';
import { DomainError } from '../../../packages/application/src/errors.js';
@Controller('api/v1/operations')
export class OperationsController {
  constructor(
    @Inject(OperationsService) readonly service: OperationsService,
    @Inject(IdentityService) readonly identity: IdentityService,
  ) {}
  @All(['', '{*operationsPath}'])
  async handle(@Req() req: Request, @Res() res: Response) {
    if (req.header('authorization'))
      throw new DomainError('FORBIDDEN', '运维设置仅限管理员Web。', 403);
    const session = req.headers.cookie
        ?.split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith('ath_session='))
        ?.slice('ath_session='.length),
      actor = await this.identity.authenticate(
        session,
        undefined,
        String(res.locals.requestId),
      );
    const path = req.path
      .slice('/api/v1/operations'.length)
      .replace(/^\/|\/$/g, '');
    if ((!path || path === 'status') && req.method === 'GET')
      return res.json(await this.service.status(actor));
    if (path === 'backups' && req.method === 'GET')
      return res.json(await this.service.list(actor));
    if (path === 'backups' && req.method === 'POST')
      return res
        .status(202)
        .json(await this.service.requestBackup(actor, req.body));
    const detail = /^backups\/([^/]+)$/.exec(path);
    if (detail?.[1] && req.method === 'GET')
      return res.json(await this.service.detail(actor, detail[1]));
    throw new DomainError('NOT_FOUND', '没有该运维操作。', 404);
  }
}
