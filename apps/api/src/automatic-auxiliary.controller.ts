import { z } from 'zod';
import { automaticAuxiliaryListQuerySchema } from '../../../packages/contracts/src/automatic-auxiliary.js';
import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { IdentityService } from '../../../packages/application/src/identity/service.js';
import { AutomaticAuxiliaryService } from '../../../packages/application/src/auxiliary/automatic.js';
import { idSchema } from '../../../packages/contracts/src/base.js';
import { DomainError } from '../../../packages/application/src/errors.js';
@Controller('api/v1/me/automatic-auxiliary')
export class AutomaticAuxiliaryController {
  constructor(
    @Inject(IdentityService) readonly identity: IdentityService,
    @Inject(AutomaticAuxiliaryService)
    readonly automatic: AutomaticAuxiliaryService,
  ) {}
  @All(['', '{*automaticPath}']) async handle(
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (req.header('authorization'))
      throw new DomainError(
        'FORBIDDEN',
        '个人自动命名意图只使用本人Cookie，不对MCP开放。',
        403,
      );
    const session = req.headers.cookie
        ?.split(';')
        .map((value) => value.trim())
        .find((value) => value.startsWith('ath_session='))
        ?.slice('ath_session='.length),
      actor = await this.identity.authenticate(
        session,
        undefined,
        String(res.locals.requestId),
      ),
      path = req.path
        .replace(/^\/api\/v1\/me\/automatic-auxiliary\/?/, '')
        .replace(/\/$/, '');
    if (!path && req.method === 'GET') {
      const query = automaticAuxiliaryListQuerySchema.parse(req.query);
      return res.json(
        await this.automatic.list(actor, query.projectId, query.afterId),
      );
    }
    const target = /^([^/]+)(?:\/(preview|accept|retry))?$/.exec(path);
    if (target?.[1]) {
      z.strictObject({}).parse(req.query);
      const id = idSchema.parse(target[1]);
      if (!target[2] && req.method === 'GET')
        return res.json(await this.automatic.receipt(actor, id));
      if (target[2] === 'preview' && req.method === 'POST') {
        z.strictObject({}).parse(req.body);
        return res.json(await this.automatic.previewAlias(actor, id));
      }
      if (target[2] === 'retry' && req.method === 'POST') {
        z.strictObject({}).parse(req.body);
        return res.json(await this.automatic.retryAlias(actor, id));
      }
      if (target[2] === 'accept' && req.method === 'POST')
        return res
          .status(202)
          .json(await this.automatic.acceptAlias(actor, id, req.body));
    }
    throw new DomainError('NOT_FOUND', '没有此自动辅助入口。', 404);
  }
}
