import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  idSchema,
  commandIdSchema,
} from '../../../packages/contracts/src/base.js';
import { ConfigurationService } from '../../../packages/application/src/configuration/service.js';
import { IdentityService } from '../../../packages/application/src/identity/service.js';
import { DomainError } from '../../../packages/application/src/errors.js';

@Controller([
  'api/v1/admin/model-services',
  'api/v1/admin/auxiliary-model',
  'api/v1/model-services',
])
export class ConfigurationController {
  constructor(
    @Inject(ConfigurationService) readonly service: ConfigurationService,
    @Inject(IdentityService) readonly identity: IdentityService,
  ) {}
  @All(['', '{*configurationPath}'])
  async handle(@Req() req: Request, @Res() res: Response) {
    const path = req.path.replace(/^\/api\/v1\/?/, '').replace(/\/$/, '');
    const session = req.headers.cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('ath_session='))
      ?.slice('ath_session='.length);
    const authorization = req.header('authorization');
    if (authorization !== undefined && !authorization.startsWith('Bearer '))
      throw new DomainError('UNAUTHENTICATED', '认证格式无效。', 401);
    const actor = await this.identity.authenticate(
      session,
      authorization?.slice(7),
      String(res.locals.requestId),
    );
    if (actor.entrypoint !== 'web')
      throw new DomainError('FORBIDDEN', '此配置仅供本人通过网页维护。', 403);
    if (path === 'model-services' && req.method === 'GET')
      return res.json(await this.service.v2.available(actor));
    if (path === 'admin/model-services') {
      if (req.method === 'GET')
        return res.json(await this.service.v2.adminList(actor));
      if (req.method === 'POST')
        return res
          .status(201)
          .json(await this.service.v2.create(actor, req.body));
    }
    if (path === 'admin/auxiliary-model') {
      if (req.method === 'GET')
        return res.json(await this.service.v2.getAuxiliary(actor));
      if (req.method === 'PUT')
        return res.json(await this.service.v2.setAuxiliary(actor, req.body));
    }
    const command = /^admin\/model-services\/commands\/([^/]+)$/.exec(path);
    if (command?.[1] && req.method === 'GET')
      return res.json(
        await this.service.v2.commandReceipt(
          actor,
          commandIdSchema.parse(command[1]),
        ),
      );
    const discovery = /^admin\/model-services\/([^/]+)\/discover-models$/.exec(
      path,
    );
    if (discovery?.[1] && req.method === 'POST')
      return res.json(
        await this.service.v2.discover(
          actor,
          idSchema.parse(discovery[1]),
          req.body,
        ),
      );
    const connection =
      /^admin\/model-services\/([^/]+)\/connection-tests(?:\/([^/]+))?$/.exec(
        path,
      );
    if (connection?.[1]) {
      const serviceId = idSchema.parse(connection[1]);
      if (!connection[2] && req.method === 'POST')
        return res.json(
          await this.service.connections.test(actor, serviceId, req.body),
        );
      if (connection[2] && req.method === 'GET')
        return res.json(
          await this.service.connections.get(
            actor,
            serviceId,
            idSchema.parse(connection[2]),
          ),
        );
    }
    const model = /^admin\/model-services\/([^/]+)(\/credential)?$/.exec(path);
    if (model?.[1]) {
      const id = idSchema.parse(model[1]);
      if (!model[2] && req.method === 'PUT')
        return res.json(await this.service.v2.update(actor, id, req.body));
      if (!model[2] && req.method === 'DELETE')
        return res.json(await this.service.v2.remove(actor, id, req.body));
      if (model[2] && req.method === 'PUT')
        return res.json(
          await this.service.v2.setCredential(actor, id, req.body),
        );
      if (model[2] && req.method === 'DELETE')
        return res.json(
          await this.service.v2.revokeCredential(actor, id, req.body),
        );
    }
    throw new DomainError('NOT_FOUND', '没有此配置接口。', 404);
  }
}
