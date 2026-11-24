import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { idSchema } from '../../../packages/contracts/src/base.js';
import { uiDeliveryStatusQuerySchema } from '../../../packages/contracts/src/ui-delivery.js';
import { IdentityService } from '../../../packages/application/src/identity/service.js';
import { UiDeliveryService } from '../../../packages/application/src/results/delivery.js';
import { DomainError } from '../../../packages/application/src/errors.js';

@Controller('api/v1/projects/:projectId')
export class UiDeliveryController {
  constructor(
    @Inject(IdentityService) readonly identity: IdentityService,
    @Inject(UiDeliveryService) readonly delivery: UiDeliveryService,
  ) {}
  private async actor(req: Request, res: Response) {
    if (req.header('authorization'))
      throw new DomainError(
        'FORBIDDEN',
        '个人Key请使用官方MCP与专用文件通道。',
        403,
      );
    const session = req.headers.cookie
      ?.split(';')
      .map((value) => value.trim())
      .find((value) => value.startsWith('ath_session='))
      ?.slice('ath_session='.length);
    return this.identity.authenticate(
      session,
      undefined,
      String(res.locals.requestId),
    );
  }
  @Get('ui-executions/:runId/delivery')
  async status(@Req() req: Request, @Res() res: Response) {
    const query = uiDeliveryStatusQuerySchema
      .extend({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(req.query);
    return res
      .status(200)
      .json(
        await this.delivery.status(
          await this.actor(req, res),
          idSchema.parse(req.params.projectId),
          idSchema.parse(req.params.runId),
          query,
        ),
      );
  }
}
