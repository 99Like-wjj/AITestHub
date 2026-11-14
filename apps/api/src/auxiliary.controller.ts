import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { IdentityService } from '../../../packages/application/src/identity/service.js';
import { AuxiliaryService } from '../../../packages/application/src/auxiliary/service.js';
import {
  idSchema,
  commandIdSchema,
} from '../../../packages/contracts/src/base.js';
import { DomainError } from '../../../packages/application/src/errors.js';
@Controller('api/v1/me/auxiliary-tasks')
export class AuxiliaryController {
  constructor(
    @Inject(IdentityService) readonly identity: IdentityService,
    @Inject(AuxiliaryService) readonly auxiliary: AuxiliaryService,
  ) {}
  @All(['', '{*auxiliaryPath}']) async handle(
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (req.header('authorization'))
      throw new DomainError(
        'FORBIDDEN',
        '系统辅助任务使用本人平台Cookie会话。',
        403,
      );
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
    const path = req.path
      .replace(/^\/api\/v1\/me\/auxiliary-tasks\/?/, '')
      .replace(/\/$/, '');
    if (path === 'preflight' && req.method === 'POST')
      return res.json(await this.auxiliary.preflight(actor, req.body));
    if (!path && req.method === 'POST')
      return res
        .status(202)
        .json(await this.auxiliary.request(actor, req.body));
    const command = /^by-command\/([^/]+)$/.exec(path);
    if (command?.[1] && req.method === 'GET')
      return res.json(
        await this.auxiliary.byCommand(
          actor,
          commandIdSchema.parse(decodeURIComponent(command[1])),
        ),
      );
    const task = /^([^/]+)(?:\/(cancel))?$/.exec(path);
    if (task?.[1]) {
      const id = idSchema.parse(task[1]);
      if (!task[2] && req.method === 'GET')
        return res.json(await this.auxiliary.get(actor, id));
      if (task[2] && req.method === 'POST')
        return res.json(await this.auxiliary.cancel(actor, id, req.body));
    }
    throw new DomainError('NOT_FOUND', '没有此辅助任务接口。', 404);
  }
}
