import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { idSchema } from '../../../packages/contracts/src/base.js';
import { AgentMemoryService } from '../../../packages/application/src/agent-memory/service.js';
import { IdentityService } from '../../../packages/application/src/identity/service.js';
import { DomainError } from '../../../packages/application/src/errors.js';
@Controller('api/v1/me/agent-memory')
export class AgentMemoryController {
  constructor(
    @Inject(AgentMemoryService) readonly memory: AgentMemoryService,
    @Inject(IdentityService) readonly identity: IdentityService,
  ) {}
  @All(['', '{*memoryPath}'])
  async handle(@Req() req: Request, @Res() res: Response) {
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
    if (actor.entrypoint !== 'web')
      throw new DomainError('FORBIDDEN', '个人记忆只开放本人网页管理。', 403);
    const path =
      req.path
        .split('/agent-memory')[1]
        ?.replace(/^\//, '')
        .replace(/\/$/, '') ?? '';
    if (path === '' && req.method === 'GET')
      return res.json(await this.memory.list(actor));
    if (path === '' && req.method === 'POST')
      return res.status(201).json(await this.memory.save(actor, req.body));
    if (path === 'preference' && req.method === 'PUT')
      return res.json(await this.memory.preference(actor, req.body));
    if (req.method === 'DELETE')
      return res.json(
        await this.memory.remove(actor, idSchema.parse(path), req.body),
      );
    throw new DomainError('NOT_FOUND', '个人记忆接口不存在。', 404);
  }
}
