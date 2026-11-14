import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { idSchema } from '../../../packages/contracts/src/base.js';
import { IdentityService } from '../../../packages/application/src/identity/service.js';
import { ProjectOverviewService } from '../../../packages/application/src/projects/overview.js';
import { DomainError } from '../../../packages/application/src/errors.js';
@Controller('api/v1/projects/:projectId/overview')
export class OverviewController {
  constructor(
    @Inject(IdentityService) readonly identity: IdentityService,
    @Inject(ProjectOverviewService) readonly overview: ProjectOverviewService,
  ) {}
  @Get() async handle(@Req() req: Request, @Res() res: Response) {
    if (req.header('authorization'))
      throw new DomainError(
        'FORBIDDEN',
        '项目概览网页使用本人Cookie会话。',
        403,
      );
    const cookie = req.headers.cookie
      ?.split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith('ath_session='))
      ?.slice('ath_session='.length);
    const actor = await this.identity.authenticate(
      cookie,
      undefined,
      String(res.locals.requestId),
    );
    return res.json(
      await this.overview.get(actor, idSchema.parse(req.params.projectId)),
    );
  }
}
