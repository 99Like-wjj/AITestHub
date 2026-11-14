import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { idSchema } from '../../../packages/contracts/src/base.js';
import { BusinessConfirmations } from '../../../packages/application/src/tool-registry/confirmations.js';
import { IdentityService } from '../../../packages/application/src/identity/service.js';
import { DomainError } from '../../../packages/application/src/errors.js';
import { resolveBusinessConfirmationInputSchema } from '../../../packages/contracts/src/business-tools.js';
import { booleanQueryValue } from './query-values.js';

@Controller('api/v1/me/business-confirmations')
export class BusinessConfirmationsController {
  constructor(
    @Inject(BusinessConfirmations)
    readonly confirmations: BusinessConfirmations,
    @Inject(IdentityService) readonly identity: IdentityService,
  ) {}
  @All(['', '{*confirmationPath}'])
  async handle(@Req() req: Request, @Res() res: Response) {
    if (req.header('authorization'))
      throw new DomainError(
        'FORBIDDEN',
        '此确认通道只接受本人平台Cookie会话。',
        403,
      );
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
    if (actor.entrypoint !== 'web')
      throw new DomainError(
        'FORBIDDEN',
        '确认仅接收本人平台界面的实际用户事件。',
        403,
      );
    const path = req.path
      .replace(/^\/api\/v1\/me\/business-confirmations\/?/, '')
      .replace(/\/$/, '');
    if (
      !path &&
      req.method === 'GET' &&
      req.query.conversationId !== undefined
    ) {
      if (req.query.taskId !== undefined)
        throw new DomainError(
          'VALIDATION_ERROR',
          '请明确按会话或原任务读取提案，不同时指定两个范围。',
          400,
        );
      return res.json(
        await this.confirmations.listConversation(
          actor,
          idSchema.parse(req.query.conversationId),
          booleanQueryValue(true).parse(req.query.pendingOnly),
        ),
      );
    }
    if (!path && req.method === 'GET')
      return res.json(
        await this.confirmations.list(actor, idSchema.parse(req.query.taskId)),
      );
    const matched = /^([0-9a-f-]{36})(?:\/(resolve))?$/.exec(path);
    if (matched?.[1]) {
      const id = idSchema.parse(matched[1]);
      if (!matched[2] && req.method === 'GET')
        return res.json(await this.confirmations.get(actor, id));
      if (matched[2] === 'resolve' && req.method === 'POST') {
        const input = resolveBusinessConfirmationInputSchema.parse(req.body);
        return res.json(
          await this.confirmations.resolve(actor, id, input, 'web-user-event'),
        );
      }
    }
    throw new DomainError('NOT_FOUND', '没有此确认入口。', 404);
  }
}
