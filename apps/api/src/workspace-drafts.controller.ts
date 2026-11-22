import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Inject,
  Param,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { WorkspaceDraftService } from '../../../packages/application/src/conversations/drafts.js';
import { DomainError } from '../../../packages/application/src/errors.js';
import { IdentityService } from '../../../packages/application/src/identity/service.js';

const privateCache = 'private, no-store, max-age=0';

@Controller('api/v1/me/workspace-drafts')
export class WorkspaceDraftsController {
  constructor(
    @Inject(WorkspaceDraftService) readonly drafts: WorkspaceDraftService,
    @Inject(IdentityService) readonly identity: IdentityService,
  ) {}

  private async actor(req: Request, res: Response) {
    if (req.header('authorization') !== undefined)
      throw new DomainError('FORBIDDEN', '个人草稿只开放本人网页。', 403);
    const prefix = 'ath_session=';
    const cookie = req.headers.cookie
      ?.split(';')
      .map((value) => value.trim())
      .find((value) => value.startsWith(prefix))
      ?.slice(prefix.length);
    const actor = await this.identity.authenticate(
      cookie,
      undefined,
      String(res.locals.requestId),
    );
    if (req.header('x-ath-draft-owner') !== actor.userId)
      throw new DomainError('FORBIDDEN', '当前身份与草稿编辑身份不一致。', 403);
    return actor;
  }

  @Get()
  @Header('Cache-Control', privateCache)
  @Header('Vary', 'Cookie')
  async list(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.drafts.listUnsaved(await this.actor(req, res));
  }

  @Get(':key')
  @Header('Cache-Control', privateCache)
  @Header('Vary', 'Cookie')
  async read(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('key') key: string,
  ) {
    return this.drafts.read(await this.actor(req, res), key);
  }

  @Put(':key')
  @Header('Cache-Control', privateCache)
  @Header('Vary', 'Cookie')
  async save(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('key') key: string,
    @Body() body: unknown,
  ) {
    return this.drafts.save(await this.actor(req, res), key, body);
  }

  @Delete(':key')
  @Header('Cache-Control', privateCache)
  @Header('Vary', 'Cookie')
  async remove(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('key') key: string,
    @Body() body: unknown,
  ) {
    return this.drafts.delete(await this.actor(req, res), key, body);
  }
}
