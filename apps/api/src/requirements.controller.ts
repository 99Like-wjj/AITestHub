import { requirementPageQuerySchema } from '../../../packages/contracts/src/requirements.js';
import { booleanQueryValue } from './query-values.js';
import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  idSchema,
  commandIdSchema,
} from '../../../packages/contracts/src/base.js';
import { RequirementService } from '../../../packages/application/src/requirements/service.js';
import { IdentityService } from '../../../packages/application/src/identity/service.js';
import { DomainError } from '../../../packages/application/src/errors.js';

@Controller('api/v1/projects/:projectId/requirements')
export class RequirementsController {
  constructor(
    @Inject(RequirementService) readonly service: RequirementService,
    @Inject(IdentityService) readonly identity: IdentityService,
  ) {}

  @All(['', '{*path}'])
  async handle(@Req() req: Request, @Res() res: Response) {
    const projectId = idSchema.parse(req.params.projectId);
    const prefix = `/api/v1/projects/${projectId}/requirements`;
    const path = req.path
      .slice(prefix.length)
      .replace(/^\//, '')
      .replace(/\/$/, '');
    const bearer = req.header('authorization');
    const session = req.headers.cookie
      ?.split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith('ath_session='))
      ?.slice('ath_session='.length);
    const actor = await this.identity.authenticate(
      session,
      bearer?.startsWith('Bearer ') ? bearer.slice(7) : undefined,
      res.locals.requestId as string,
    );
    if (actor.entrypoint !== 'web')
      throw new DomainError('FORBIDDEN', '个人 Key 请使用官方 MCP。', 403);
    if (path === '' && req.method === 'GET') {
      return res.json(
        await this.service.list(
          actor,
          projectId,
          booleanQueryValue(false).parse(req.query.archived),
        ),
      );
    }
    if (path === 'prepare-version' && req.method === 'POST') {
      const body = z.record(z.string(), z.unknown()).parse(req.body),
        nested = z.record(z.string(), z.unknown()).parse(body.input);
      if (
        (body.target === 'existing' && body.projectId !== projectId) ||
        (body.target === 'new' && nested.projectId !== projectId)
      )
        throw new DomainError(
          'VALIDATION_ERROR',
          '准备范围与路径项目不一致。',
          400,
        );
      return res.json(await this.service.prepareVersion(actor, body));
    }
    if (path === '' && req.method === 'POST') {
      const body = z.record(z.string(), z.unknown()).parse(req.body);
      if ('projectId' in body && body.projectId !== projectId)
        throw new DomainError(
          'VALIDATION_ERROR',
          '项目路径与提交目标不一致。',
          400,
        );
      return res
        .status(201)
        .json(await this.service.create(actor, { ...body, projectId }));
    }
    if (path === 'page' && req.method === 'GET')
      return res.json(
        await this.service.listPage(
          actor,
          projectId,
          requirementPageQuerySchema
            .extend({
              page: z.coerce.number().int().min(1).max(1000000).default(1),
              pageSize: z.coerce.number().int().min(1).max(200).default(20),
              archived: booleanQueryValue(false),
            })
            .parse(req.query),
        ),
      );
    if (path === 'eligible-participants' && req.method === 'GET')
      return res.json(
        await this.service.eligibleParticipants(actor, projectId),
      );
    if (path === 'candidates' && req.method === 'POST') {
      const body = z.record(z.string(), z.unknown()).parse(req.body);
      return res.json(
        await this.service.candidates(actor, { ...body, projectId }),
      );
    }
    const deletionReceipt = /^([^/]+)\/deletion-receipts\/([^/]+)$/.exec(path);
    if (deletionReceipt?.[1] && deletionReceipt[2] && req.method === 'GET')
      return res.json(
        await this.service.deletionReceipt(
          actor,
          projectId,
          idSchema.parse(deletionReceipt[1]),
          commandIdSchema.parse(decodeURIComponent(deletionReceipt[2])),
        ),
      );
    const deletion = /^([^/]+)\/(delete-preview|delete)$/.exec(path);
    if (deletion?.[1]) {
      const id = idSchema.parse(deletion[1]);
      if (deletion[2] === 'delete-preview' && req.method === 'GET')
        return res.json(
          await this.service.previewDeletion(actor, projectId, id),
        );
      if (deletion[2] === 'delete' && req.method === 'POST')
        return res.json(
          await this.service.deleteUnused(actor, projectId, id, req.body),
        );
    }
    const receipt = /^([^/]+)\/collaboration-receipts\/([^/]+)$/.exec(path);
    if (receipt?.[1] && receipt[2] && req.method === 'GET')
      return res.json(
        await this.service.collaborationReceipt(
          actor,
          projectId,
          idSchema.parse(receipt[1]),
          commandIdSchema.parse(decodeURIComponent(receipt[2])),
        ),
      );
    const match =
      /^([^/]+)(?:\/(versions|participants|state|archive|collaboration))?$/.exec(
        path,
      );
    if (match?.[1]) {
      const id = idSchema.parse(match[1]);
      if (!match[2] && req.method === 'GET')
        return res.json(await this.service.detail(actor, projectId, id));
      if (match[2] === 'versions' && req.method === 'POST')
        return res
          .status(201)
          .json(await this.service.addVersion(actor, projectId, id, req.body));
      if (match[2] === 'participants' && req.method === 'PUT')
        return res.json(
          await this.service.participants(actor, projectId, id, req.body),
        );
      if (match[2] === 'state' && req.method === 'PUT')
        return res.json(
          await this.service.setState(actor, projectId, id, req.body),
        );
      if (match[2] === 'collaboration' && req.method === 'PUT')
        return res.json(
          await this.service.collaboration(actor, projectId, id, req.body),
        );
      if (match[2] === 'archive' && req.method === 'PUT')
        return res.json(
          await this.service.archive(actor, projectId, id, req.body),
        );
    }
    throw new DomainError('NOT_FOUND', '没有此需求接口。', 404);
  }
}
