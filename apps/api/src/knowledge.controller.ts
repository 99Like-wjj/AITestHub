import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { idSchema } from '../../../packages/contracts/src/base.js';
import {
  knowledgeIndexQuerySchema,
  knowledgeExportSelectionSchema,
  commitKnowledgeSelectionInputSchema,
} from '../../../packages/contracts/src/knowledge.js';
import { KnowledgeService } from '../../../packages/application/src/knowledge/service.js';
import { KnowledgeComparisons } from '../../../packages/application/src/knowledge/comparisons.js';
import { IdentityService } from '../../../packages/application/src/identity/service.js';
import { DomainError } from '../../../packages/application/src/errors.js';

@Controller('api/v1/projects/:projectId/knowledge')
export class KnowledgeController {
  constructor(
    @Inject(KnowledgeService) readonly knowledge: KnowledgeService,
    @Inject(KnowledgeComparisons) readonly comparisons: KnowledgeComparisons,
    @Inject(IdentityService) readonly identity: IdentityService,
  ) {}
  @All(['', '{*knowledgePath}'])
  async handle(@Req() req: Request, @Res() res: Response) {
    if (req.header('authorization'))
      throw new DomainError('FORBIDDEN', '个人Key请使用官方MCP知识工具。', 403);
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
      throw new DomainError('FORBIDDEN', '网页知识入口需要本人有效会话。', 403);
    const projectId = idSchema.parse(req.params.projectId);
    const path = req.path
      .slice(`/api/v1/projects/${projectId}/knowledge`.length)
      .replace(/^\//, '')
      .replace(/\/$/, '');
    if (path === 'operation-status' && req.method === 'GET')
      return res.json(
        await this.knowledge.operationStatus(actor, projectId, {
          operation: req.query.operation,
          key: req.query.key,
        }),
      );
    if (path === 'spaces' && req.method === 'GET')
      return res.json(await this.knowledge.spaces(actor, projectId));
    if (path === 'spaces' && req.method === 'POST')
      return res
        .status(201)
        .json(
          await this.knowledge.saveSpace(actor, projectId, undefined, req.body),
        );
    const space = /^spaces\/([^/]+)$/.exec(path);
    if (space?.[1] && req.method === 'PUT')
      return res.json(
        await this.knowledge.saveSpace(
          actor,
          projectId,
          idSchema.parse(space[1]),
          req.body,
        ),
      );
    if (path === 'entries' && req.method === 'GET')
      return res.json(
        await this.knowledge.index(
          actor,
          projectId,
          knowledgeIndexQuerySchema.parse({
            ...(req.query.spaceId ? { spaceId: req.query.spaceId } : {}),
            ...(req.query.afterId ? { afterId: req.query.afterId } : {}),
            ...(req.query.tag ? { tag: req.query.tag } : {}),
            ...(req.query.query ? { query: req.query.query } : {}),
            includeDeleted: req.query.includeDeleted === 'true',
            ...(req.query.limit ? { limit: Number(req.query.limit) } : {}),
          }),
        ),
      );
    if (path === 'entries' && req.method === 'POST')
      return res
        .status(201)
        .json(await this.knowledge.create(actor, projectId, req.body));
    const entry =
      /^entries\/([^/]+)(?:\/(history|revisions|restore-preview|restore)(?:\/([^/]+))?)?$/.exec(
        path,
      );
    if (entry?.[1]) {
      const id = idSchema.parse(entry[1]);
      if (!entry[2] && req.method === 'GET')
        return res.json(
          await this.knowledge.get(
            actor,
            projectId,
            id,
            req.query.revisionId
              ? idSchema.parse(req.query.revisionId)
              : undefined,
          ),
        );
      if (!entry[2] && req.method === 'PUT')
        return res.json(
          await this.knowledge.revise(actor, projectId, id, req.body),
        );
      if (!entry[2] && req.method === 'DELETE')
        return res.json(
          await this.knowledge.remove(actor, projectId, id, req.body),
        );
      if (entry[2] === 'history' && req.method === 'GET')
        return res.json(await this.knowledge.history(actor, projectId, id));
      if (entry[2] === 'revisions' && entry[3] && req.method === 'GET')
        return res.json(
          await this.knowledge.historicalRevision(
            actor,
            projectId,
            id,
            idSchema.parse(entry[3]),
          ),
        );
      if (entry[2] === 'restore-preview' && req.method === 'GET')
        return res.json(
          await this.knowledge.restorePreview(
            actor,
            projectId,
            id,
            idSchema.parse(req.query.revisionId),
          ),
        );
      if (entry[2] === 'restore' && req.method === 'POST')
        return res.json(
          await this.knowledge.restore(actor, projectId, id, req.body),
        );
    }
    if (path === 'comparisons' && req.method === 'POST')
      return res.json(
        await this.comparisons.compare(actor, projectId, req.body),
      );
    const comparison = /^comparisons\/([^/]+)(?:\/(commit|selections))?$/.exec(
      path,
    );
    if (comparison?.[1]) {
      const id = idSchema.parse(comparison[1]);
      if (!comparison[2] && req.method === 'GET')
        return res.json(await this.comparisons.get(actor, projectId, id));
      if (comparison[2] === 'selections' && req.method === 'GET')
        return res.json(
          await this.comparisons.selectionHistory(
            actor,
            projectId,
            id,
            req.query,
          ),
        );
      if (comparison[2] === 'commit' && req.method === 'POST') {
        const input = commitKnowledgeSelectionInputSchema.parse(req.body);
        if (input.comparisonId !== id)
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '路径与比较身份不一致。',
            409,
          );
        return res.json(await this.comparisons.commit(actor, projectId, input));
      }
    }
    if (path === 'export' && req.method === 'GET') {
      let rawSelection: unknown;
      try {
        rawSelection = JSON.parse(String(req.query.selection ?? 'null'));
      } catch {
        throw new DomainError(
          'VALIDATION_ERROR',
          '导出选择不是有效JSON。',
          400,
        );
      }
      const selection = knowledgeExportSelectionSchema.parse(rawSelection);
      const exported = await this.knowledge.export(actor, projectId, selection);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="aitesthub-knowledge.json"',
      );
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.send(JSON.stringify(exported, null, 2));
    }
    throw new DomainError('NOT_FOUND', '没有此知识入口。', 404);
  }
}
