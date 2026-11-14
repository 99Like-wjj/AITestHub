import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { idSchema } from '../../../packages/contracts/src/base.js';
import { ExternalMcpService } from '../../../packages/application/src/external-mcp/service.js';
import { ExternalMcpInvocations } from '../../../packages/application/src/external-mcp/invocations.js';
import { booleanQueryValue } from './query-values.js';
import { ExternalMcpTransportError } from '../../../packages/application/src/external-mcp/transport.js';
import { IdentityService } from '../../../packages/application/src/identity/service.js';
import { DomainError } from '../../../packages/application/src/errors.js';

@Controller('api/v1/external-mcp')
export class ExternalMcpController {
  constructor(
    @Inject(ExternalMcpService) readonly services: ExternalMcpService,
    @Inject(ExternalMcpInvocations)
    readonly invocations: ExternalMcpInvocations,
    @Inject(IdentityService) readonly identity: IdentityService,
  ) {}
  @All([
    'operation-status',
    'services',
    'services/{*path}',
    'personal',
    'personal/{*path}',
    'available',
    'invocations',
    'invocations/{*path}',
  ])
  async handle(@Req() req: Request, @Res() res: Response) {
    if (req.header('authorization') !== undefined)
      throw new DomainError(
        'FORBIDDEN',
        '外部MCP配置、个人凭据与本人外发决定须使用本人Web会话。',
        403,
      );
    const session = req.headers.cookie
      ?.split(';')
      .map((value) => value.trim())
      .find((value) => value.startsWith('ath_session='))
      ?.slice('ath_session='.length);
    const actor = await this.identity.authenticate(
      session,
      undefined,
      String(res.locals.requestId),
    );
    const path = req.path
      .slice('/api/v1/external-mcp/'.length)
      .replace(/\/$/, '');
    try {
      if (path === 'operation-status' && req.method === 'GET')
        return res.json(
          await this.services.operationStatus(actor, {
            operation: req.query.operation,
            key: req.query.key,
          }),
        );
      if (path === 'services' && req.method === 'GET')
        return res.json(await this.services.listAdmin(actor));
      if (path === 'services' && req.method === 'POST')
        return res
          .status(201)
          .json(await this.services.save(actor, undefined, req.body));
      const service = /^services\/([^/]+)$/.exec(path);
      if (service?.[1] && req.method === 'PUT')
        return res.json(
          await this.services.save(actor, idSchema.parse(service[1]), req.body),
        );
      if (path === 'personal' && req.method === 'GET')
        return res.json(await this.services.personalServices(actor));
      if (path === 'available' && req.method === 'GET')
        return res.json(await this.services.availableTools(actor));
      const personal =
        /^personal\/(services|connections)\/([^/]+)\/(key|check|catalog)$/.exec(
          path,
        );
      if (personal?.[2]) {
        const id = idSchema.parse(personal[2]);
        if (
          personal[1] === 'services' &&
          personal[3] === 'key' &&
          req.method === 'PUT'
        )
          return res.json(
            await this.services.savePersonalKey(actor, id, req.body),
          );
        if (
          personal[1] === 'connections' &&
          personal[3] === 'key' &&
          req.method === 'DELETE'
        )
          return res.json(
            await this.services.revokePersonalKey(actor, id, req.body),
          );
        if (
          personal[1] === 'connections' &&
          personal[3] === 'check' &&
          req.method === 'POST'
        ) {
          z.strictObject({}).parse(req.body ?? {});
          return res.json(await this.services.probe(actor, id));
        }
        if (
          personal[1] === 'connections' &&
          personal[3] === 'catalog' &&
          req.method === 'GET'
        )
          return res.json(await this.services.catalog(actor, id));
      }
      if (path === 'invocations' && req.method === 'GET')
        return res.json(
          await this.invocations.list(
            actor,
            req.query.taskId === undefined
              ? undefined
              : idSchema.parse(req.query.taskId),
            {
              ...(req.query.conversationId === undefined
                ? {}
                : { conversationId: idSchema.parse(req.query.conversationId) }),
              pendingOnly: booleanQueryValue(false).parse(
                req.query.pendingOnly,
              ),
            },
          ),
        );
      if (path === 'invocations' && req.method === 'POST')
        return res
          .status(202)
          .json(await this.invocations.manual(actor, req.body));
      const command = /^invocations\/by-command\/([^/]+)$/.exec(path);
      if (command?.[1] && req.method === 'GET')
        return res.json(
          await this.invocations.byCommand(actor, idSchema.parse(command[1])),
        );
      const invocation = /^invocations\/([^/]+)(?:\/(resolve|cancel))?$/.exec(
        path,
      );
      if (invocation?.[1]) {
        const id = idSchema.parse(invocation[1]);
        if (!invocation[2] && req.method === 'GET')
          return res.json(await this.invocations.get(actor, id));
        if (invocation[2] === 'resolve' && req.method === 'POST')
          return res
            .status(202)
            .json(await this.invocations.resolve(actor, id, req.body));
        if (invocation[2] === 'cancel' && req.method === 'POST') {
          z.strictObject({}).parse(req.body ?? {});
          return res.json(await this.invocations.cancel(actor, id));
        }
      }
    } catch (error) {
      if (error instanceof ExternalMcpTransportError)
        throw new DomainError(
          error.code === 'EXTERNAL_UNAUTHORIZED'
            ? 'PRECONDITIONS_MISSING'
            : 'DEPENDENCY_UNAVAILABLE',
          error.code === 'EXTERNAL_UNAUTHORIZED'
            ? '对方拒绝本人凭据或权限，请本人核对个人Key；没有借用其他人凭据。'
            : '外部连接没有取得可用回执，未自动重试；请检查原连接状态。',
          error.code === 'EXTERNAL_UNAUTHORIZED' ? 422 : 503,
        );
      throw error;
    }
    throw new DomainError('NOT_FOUND', '没有此外部MCP操作。', 404);
  }
}
