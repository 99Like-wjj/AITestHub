import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  idSchema,
  persistedRowVersionSchema,
} from '../../../packages/contracts/src/base.js';
import { AgentWorkspaceService } from '../../../packages/application/src/agent-workspace/service.js';
import { IdentityService } from '../../../packages/application/src/identity/service.js';
import { DomainError } from '../../../packages/application/src/errors.js';

@Controller('api/v1/me/conversations/:conversationId/workspace')
export class AgentWorkspaceController {
  constructor(
    @Inject(AgentWorkspaceService) readonly workspace: AgentWorkspaceService,
    @Inject(IdentityService) readonly identity: IdentityService,
  ) {}

  @All(['', '{*workspacePath}'])
  async handle(@Req() req: Request, @Res() res: Response) {
    const conversationId = idSchema.parse(req.params.conversationId);
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
      throw new DomainError('FORBIDDEN', '个人会话工作区只开放本人网页。', 403);
    const path =
      req.path.split('/workspace')[1]?.replace(/^\//, '').replace(/\/$/, '') ??
      '';
    if (path === '' && req.method === 'GET')
      return res.json(
        await this.workspace.listManifest(
          actor,
          conversationId,
          req.query.includeDeleted === 'true',
        ),
      );
    if (path === 'import' && req.method === 'POST')
      return res
        .status(201)
        .json(
          await this.workspace.importResource(actor, conversationId, req.body),
        );
    if (path === 'text' && req.method === 'POST')
      return res
        .status(201)
        .json(await this.workspace.putText(actor, conversationId, req.body));
    const command = /^commands\/([^/]+)$/.exec(path);
    if (command?.[1] && req.method === 'GET')
      return res.json(
        await this.workspace.commandReceipt(
          actor,
          conversationId,
          decodeURIComponent(command[1]),
        ),
      );
    const entry = /^entries\/([^/]+)(?:\/(versions|content))?$/.exec(path);
    if (entry?.[1]) {
      const entryId = idSchema.parse(entry[1]);
      if (entry[2] === 'versions' && req.method === 'GET')
        return res.json(
          await this.workspace.history(actor, conversationId, entryId),
        );
      if (!entry[2] && req.method === 'POST')
        return res.json(
          await this.workspace.mutate(actor, conversationId, entryId, req.body),
        );
      if (entry[2] === 'content' && req.method === 'GET') {
        const revision =
          req.query.revision === undefined
            ? undefined
            : persistedRowVersionSchema.parse(Number(req.query.revision));
        const result = await this.workspace.readBytes(
          actor,
          conversationId,
          entryId,
          revision,
        );
        const filename = encodeURIComponent(
          result.entry.path.split('/').at(-1) ?? 'download',
        ).replace(
          /[!'()*]/g,
          (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
        );
        res.setHeader('Content-Type', result.entry.mediaType);
        res.setHeader('Content-Length', result.bytes.length);
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="download"; filename*=UTF-8''${filename}`,
        );
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return res.send(result.bytes);
      }
    }
    throw new DomainError('NOT_FOUND', '没有此工作区操作。', 404);
  }
}
