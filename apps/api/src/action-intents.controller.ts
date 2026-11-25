import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { idSchema } from '../../../packages/contracts/src/base.js';
import { actionIntentDecisionSchema } from '../../../packages/contracts/src/action-intents.js';
import { ActionIntents } from '../../../packages/application/src/tool-registry/action-intents.js';
import { IdentityService } from '../../../packages/application/src/identity/service.js';
import { DomainError } from '../../../packages/application/src/errors.js';
import { booleanQueryValue } from './query-values.js';

@Controller('api/v1/me/conversations/:conversationId/action-intents')
export class ActionIntentsController {
  constructor(
    @Inject(ActionIntents) readonly intents: ActionIntents,
    @Inject(IdentityService) readonly identity: IdentityService,
  ) {}
  @All(['', '{*intentPath}'])
  async handle(@Req() req: Request, @Res() res: Response) {
    if (req.header('authorization'))
      throw new DomainError(
        'FORBIDDEN',
        '执行卡只接受本人Cookie会话，不接受模型或Key确认。',
        403,
      );
    if (req.method === 'POST') {
      const fetchSite = req.header('sec-fetch-site');
      const origin = req.header('origin');
      let originUrl: URL | undefined;
      try {
        originUrl = origin ? new URL(origin) : undefined;
      } catch {
        originUrl = undefined;
      }
      if (
        fetchSite === 'cross-site' ||
        !originUrl ||
        !/^https?:$/.test(originUrl.protocol) ||
        originUrl.host !== req.get('host')
      )
        throw new DomainError(
          'FORBIDDEN',
          '执行卡必须由当前平台对话提交。',
          403,
        );
    }
    const session = req.headers.cookie
      ?.split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith('ath_session='))
      ?.slice('ath_session='.length);
    const actor = await this.identity.authenticate(
      session,
      undefined,
      String(res.locals.requestId),
    );
    if (actor.entrypoint !== 'web')
      throw new DomainError('FORBIDDEN', '只接受本人平台网页操作。', 403);
    const conversationId = idSchema.parse(req.params.conversationId);
    const path =
      req.path
        .split('/action-intents')[1]
        ?.replace(/^\//, '')
        .replace(/\/$/, '') ?? '';
    res.setHeader('Cache-Control', 'private, no-store');
    if (path === 'reply' && req.method === 'POST')
      return res.json(
        await this.intents.replyInConversation(actor, conversationId, req.body),
      );
    if (!path && req.method === 'GET') {
      const filter = z
        .strictObject({
          messageId: idSchema.optional(),
          taskId: idSchema.optional(),
        })
        .parse({
          ...(req.query.messageId !== undefined
            ? { messageId: req.query.messageId }
            : {}),
          ...(req.query.taskId !== undefined
            ? { taskId: req.query.taskId }
            : {}),
        });
      return res.json(
        await this.intents.listConversation(
          actor,
          conversationId,
          booleanQueryValue(false).parse(req.query.pendingOnly),
          filter,
        ),
      );
    }
    const matched = /^([^/]+)(?:\/(decision))?$/.exec(path);
    if (matched?.[1]) {
      const id = idSchema.parse(matched[1]);
      if (!matched[2] && req.method === 'GET')
        return res.json(
          await this.intents.getConversation(actor, conversationId, id),
        );
      if (matched[2] === 'decision' && req.method === 'POST')
        return res.json(
          await this.intents.decide(
            actor,
            conversationId,
            id,
            actionIntentDecisionSchema.parse(req.body),
          ),
        );
    }
    throw new DomainError('NOT_FOUND', '没有此对话执行卡操作。', 404);
  }
}
