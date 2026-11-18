import { z } from 'zod';
import { Controller, Get, Inject, Param, Req, Res } from '@nestjs/common';
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
  @Get(':id') async readReceipt(
    @Param('id') id: string,
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
      );
    z.strictObject({}).parse(req.query);
    return res.json(await this.automatic.receipt(actor, idSchema.parse(id)));
  }
}
