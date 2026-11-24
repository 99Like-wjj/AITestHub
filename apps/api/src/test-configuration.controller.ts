import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { idSchema } from '../../../packages/contracts/src/base.js';
import { configurationKindSchema } from '../../../packages/contracts/src/test-configuration.js';
import { TestConfigurationService } from '../../../packages/application/src/test-configuration/service.js';
import { IdentityService } from '../../../packages/application/src/identity/service.js';
import { DomainError } from '../../../packages/application/src/errors.js';

@Controller('api/v1/projects/:projectId/test-configuration')
export class TestConfigurationController {
  constructor(
    @Inject(TestConfigurationService)
    readonly service: TestConfigurationService,
    @Inject(IdentityService) readonly identity: IdentityService,
  ) {}
  @All(['', '{*path}'])
  async handle(@Req() req: Request, @Res() res: Response) {
    const projectId = idSchema.parse(req.params.projectId);
    const path = req.path
      .slice(`/api/v1/projects/${projectId}/test-configuration`.length)
      .replace(/^\//, '')
      .replace(/\/$/, '');
    const session = req.headers.cookie
      ?.split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith('ath_session='))
      ?.slice('ath_session='.length);
    const actor = await this.identity.authenticate(
      session,
      undefined,
      String(res.locals.requestId),
    );
    if (req.header('authorization'))
      throw new DomainError(
        'FORBIDDEN',
        '个人 Key 请使用官方 MCP 和专用文件通道。',
        403,
      );
    if (!path && req.method === 'GET')
      return res.json(
        await this.service.list(
          actor,
          projectId,
          req.query.kind === undefined
            ? undefined
            : configurationKindSchema.parse(req.query.kind),
        ),
      );
    if (!path && req.method === 'POST')
      return res
        .status(201)
        .json(await this.service.save(actor, projectId, undefined, req.body));
    const match = /^([^/]+)(\/credential)?$/.exec(path);
    if (match?.[1]) {
      const id = idSchema.parse(match[1]);
      if (match[2] && req.method === 'PUT')
        return res.json(
          await this.service.setCredential(actor, projectId, id, req.body),
        );
      if (!match[2] && req.method === 'PUT')
        return res.json(
          await this.service.save(actor, projectId, id, req.body),
        );
    }
    throw new DomainError('NOT_FOUND', '没有此项目测试配置接口。', 404);
  }
}
