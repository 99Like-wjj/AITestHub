import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { idSchema } from '../../../packages/contracts/src/base.js';
import { AgentBrowserService } from '../../../packages/application/src/agent-browser/service.js';
import { IdentityService } from '../../../packages/application/src/identity/service.js';
import { DomainError } from '../../../packages/application/src/errors.js';
@Controller('api/v1/me/conversations/:conversationId/browser')
export class AgentBrowserController {
  constructor(
    @Inject(AgentBrowserService) readonly browser: AgentBrowserService,
    @Inject(IdentityService) readonly identity: IdentityService,
  ) {}
  @All(['', '{*browserPath}'])
  async handle(@Req() req: Request, @Res() res: Response) {
    const conversationId = idSchema.parse(req.params.conversationId);
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
    if (actor.entrypoint !== 'web' || actor.keyId)
      throw new DomainError(
        'FORBIDDEN',
        '办公浏览器控制面只开放本人网页。',
        403,
      );
    const scope = { conversationId };
    const path =
      req.path.split('/browser')[1]?.replace(/^\//, '').replace(/\/$/, '') ??
      '';
    if (path === '' && req.method === 'GET')
      return res.json(await this.browser.current(actor, scope));
    if (path === 'open' && req.method === 'POST')
      return res.json(await this.browser.open(actor, scope));
    if (path === 'observe' && req.method === 'GET')
      return res.json(
        await this.browser.observe(actor, scope, req.query.human === '1'),
      );
    if (path === 'navigate' && req.method === 'POST')
      return res.json(await this.browser.navigate(actor, scope, req.body));
    if (path === 'control' && req.method === 'POST')
      return res.json(await this.browser.control(actor, scope, req.body));
    if (path === 'human' && req.method === 'POST')
      return res.json(await this.browser.humanAction(actor, scope, req.body));
    if (path === 'close' && req.method === 'POST')
      return res.json(await this.browser.close(actor, scope));
    if (path === 'operations' && req.method === 'GET')
      return res.json(await this.browser.operations(actor, scope));
    const command = /^commands\/([^/]+)$/.exec(path);
    if (command?.[1] && req.method === 'GET')
      return res.json(
        await this.browser.commandReceipt(
          actor,
          scope,
          idSchema.parse(command[1]),
        ),
      );
    const operation = /^operations\/([^/]+)(?:\/(decision|cancel))?$/.exec(
      path,
    );
    if (operation?.[1]) {
      const id = idSchema.parse(operation[1]);
      if (!operation[2] && req.method === 'GET')
        return res.json(await this.browser.status(actor, scope, id));
      if (operation[2] === 'decision' && req.method === 'POST')
        return res.json(await this.browser.decide(actor, scope, id, req.body));
      if (operation[2] === 'cancel' && req.method === 'POST')
        return res.json(await this.browser.cancel(actor, scope, id));
    }
    throw new DomainError('NOT_FOUND', '没有此办公浏览器操作。', 404);
  }
}
