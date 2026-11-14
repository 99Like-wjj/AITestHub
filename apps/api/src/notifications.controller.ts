import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { IdentityService } from '../../../packages/application/src/identity/service.js';
import { NotificationService } from '../../../packages/application/src/notifications/service.js';
import { notificationListQuerySchema } from '../../../packages/contracts/src/notifications.js';
import { DomainError } from '../../../packages/application/src/errors.js';
@Controller('api/v1/me/notifications')
export class NotificationsController {
  constructor(
    @Inject(IdentityService) readonly identity: IdentityService,
    @Inject(NotificationService) readonly notifications: NotificationService,
  ) {}
  @All(['', '{*notificationPath}']) async handle(
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (req.header('authorization'))
      throw new DomainError('FORBIDDEN', '站内通知仅接受本人Cookie会话。', 403);
    const cookie = req.headers.cookie
      ?.split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith('ath_session='))
      ?.slice('ath_session='.length);
    const actor = await this.identity.authenticate(
      cookie,
      undefined,
      String(res.locals.requestId),
    );
    const path = req.path
      .replace(/^\/api\/v1\/me\/notifications\/?/, '')
      .replace(/\/$/, '');
    if (!path && req.method === 'GET')
      return res.json(
        await this.notifications.list(
          actor,
          notificationListQuerySchema.parse({
            ...(req.query.cursor ? { cursor: req.query.cursor } : {}),
            ...(req.query.limit ? { limit: Number(req.query.limit) } : {}),
            unreadOnly: req.query.unreadOnly === 'true',
          }),
        ),
      );
    if (path === 'read' && req.method === 'POST')
      return res.json(await this.notifications.markRead(actor, req.body));
    throw new DomainError('NOT_FOUND', '没有此站内通知接口。', 404);
  }
}
