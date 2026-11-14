import { Controller, Get, Post, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  commandIdSchema,
  idSchema,
} from '../../../packages/contracts/src/base.js';
import {
  uiDeclareEndInputSchema,
  uiDeclareResumeInputSchema,
  uiSealDeliveryInputSchema,
  uiDeliveryStatusQuerySchema,
  receiveUiBatchFileInputSchema,
} from '../../../packages/contracts/src/ui-delivery.js';
import { IdentityService } from '../../../packages/application/src/identity/service.js';
import { UiDeliveryService } from '../../../packages/application/src/results/delivery.js';
import { FilesService } from '../../../packages/application/src/files/service.js';
import { DomainError } from '../../../packages/application/src/errors.js';

@Controller('api/v1/projects/:projectId')
export class UiDeliveryController {
  constructor(
    @Inject(IdentityService) readonly identity: IdentityService,
    @Inject(UiDeliveryService) readonly delivery: UiDeliveryService,
    @Inject(FilesService) readonly files: FilesService,
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
  private project(req: Request) {
    return idSchema.parse(req.params.projectId);
  }
  private scoped<S extends z.ZodType<{ runId: string }>>(
    req: Request,
    schema: S,
  ) {
    const input = schema.parse(req.body);
    if (input.runId !== idSchema.parse(req.params.runId))
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '路径与提交的本地UI执行不一致。',
        409,
      );
    return input;
  }
  @Post('ui-result-batches/prepare')
  async prepare(@Req() req: Request, @Res() res: Response) {
    return res
      .status(200)
      .json(
        await this.delivery.prepareBatch(
          await this.actor(req, res),
          this.project(req),
          req.body,
        ),
      );
  }
  @Post('ui-result-batches')
  async receive(@Req() req: Request, @Res() res: Response) {
    return res
      .status(200)
      .json(
        await this.delivery.receiveBatch(
          await this.actor(req, res),
          this.project(req),
          req.body,
        ),
      );
  }
  @Post('ui-result-batches/from-file')
  async receiveFile(@Req() req: Request, @Res() res: Response) {
    const input = receiveUiBatchFileInputSchema.parse(req.body);
    return res
      .status(200)
      .json(
        await this.delivery.receiveBatchFile(
          await this.actor(req, res),
          this.project(req),
          input.fileId,
          this.files,
        ),
      );
  }
  @Get('ui-result-batches/:batchId')
  async receipt(@Req() req: Request, @Res() res: Response) {
    return res
      .status(200)
      .json(
        await this.delivery.batchReceipt(
          await this.actor(req, res),
          this.project(req),
          commandIdSchema.parse(req.params.batchId),
        ),
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
          this.project(req),
          idSchema.parse(req.params.runId),
          query,
        ),
      );
  }
  @Post('ui-executions/:runId/declare-end')
  async end(@Req() req: Request, @Res() res: Response) {
    return res
      .status(200)
      .json(
        await this.delivery.declareEnd(
          await this.actor(req, res),
          this.project(req),
          this.scoped(req, uiDeclareEndInputSchema),
        ),
      );
  }
  @Post('ui-executions/:runId/declare-resume')
  async resume(@Req() req: Request, @Res() res: Response) {
    return res
      .status(200)
      .json(
        await this.delivery.declareResume(
          await this.actor(req, res),
          this.project(req),
          this.scoped(req, uiDeclareResumeInputSchema),
        ),
      );
  }
  @Post('ui-executions/:runId/seal-delivery')
  async seal(@Req() req: Request, @Res() res: Response) {
    return res
      .status(200)
      .json(
        await this.delivery.seal(
          await this.actor(req, res),
          this.project(req),
          this.scoped(req, uiSealDeliveryInputSchema),
        ),
      );
  }
}
