import { Controller, Get, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { idSchema } from '../../../packages/contracts/src/base.js';
import { IdentityService } from '../../../packages/application/src/identity/service.js';
import { DomainError } from '../../../packages/application/src/errors.js';
import { BusinessToolRegistry } from '../../../packages/application/src/tool-registry/registry.js';

const commandEnvelope = z.looseObject({ op: z.string() });

@Controller('api/v1/projects/:projectId')
export class ApiAssetsController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(BusinessToolRegistry) private readonly tools: BusinessToolRegistry,
  ) {}

  @Get('api-catalog/nodes')
  async list(@Req() req: Request, @Res() res: Response) {
    const { includeArchived, ...query } = req.query;
    return this.dispatch(req, res, 'ath_api_catalog', {
      op: 'list',
      input: {
        ...query,
        ...(includeArchived === undefined
          ? {}
          : {
              includeArchived:
                z.enum(['true', 'false']).parse(includeArchived) === 'true',
            }),
      },
    });
  }

  @Get('api-catalog/nodes/:id')
  async get(@Req() req: Request, @Res() res: Response) {
    return this.dispatch(req, res, 'ath_api_catalog', {
      op: 'get',
      id: idSchema.parse(req.params.id),
      input: req.query,
    });
  }

  @Post('api-catalog')
  async catalogue(@Req() req: Request, @Res() res: Response) {
    return this.dispatch(
      req,
      res,
      'ath_api_catalog',
      commandEnvelope.parse(req.body),
    );
  }

  @Post('api-automation')
  async automation(@Req() req: Request, @Res() res: Response) {
    return this.dispatch(
      req,
      res,
      'ath_api_automation',
      commandEnvelope.parse(req.body),
    );
  }

  private async dispatch(
    req: Request,
    res: Response,
    tool: 'ath_api_catalog' | 'ath_api_automation',
    body: Record<string, unknown>,
  ) {
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
    const projectId = idSchema.parse(req.params.projectId);
    if (
      actor.entrypoint !== 'web' ||
      (body.projectId !== undefined && body.projectId !== projectId)
    )
      throw new DomainError('FORBIDDEN', '请使用当前项目的网页会话。', 403);
    const call = await this.tools.prepare(actor, tool, { ...body, projectId });
    if (call.confirmation)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '请先确认本次操作范围。',
        412,
      );
    return res.status(200).json(await call.execute());
  }
}
