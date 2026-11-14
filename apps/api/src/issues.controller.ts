import { booleanQueryValue } from './query-values.js';
import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { idSchema } from '../../../packages/contracts/src/base.js';
import {
  issueListQuerySchema,
  problemListQuerySchema,
  issueCountsQuerySchema,
} from '../../../packages/contracts/src/issues.js';
import { IdentityService } from '../../../packages/application/src/identity/service.js';
import { IssueService } from '../../../packages/application/src/issues/service.js';
import { IssueLifecycleService } from '../../../packages/application/src/issues/lifecycle.js';
import { ProblemService } from '../../../packages/application/src/issues/problems.js';
import { DomainError } from '../../../packages/application/src/errors.js';

@Controller([
  'api/v1/projects/:projectId/problems',
  'api/v1/projects/:projectId/issues',
])
export class IssuesController {
  constructor(
    @Inject(IdentityService) readonly identity: IdentityService,
    @Inject(IssueService) readonly issues: IssueService,
    @Inject(IssueLifecycleService) readonly lifecycle: IssueLifecycleService,
    @Inject(ProblemService) readonly problems: ProblemService,
  ) {}
  @All(['', '{*issuePath}'])
  async handle(@Req() req: Request, @Res() res: Response) {
    if (req.header('authorization'))
      throw new DomainError(
        'FORBIDDEN',
        '个人Key请使用官方MCP问题/缺陷工具。',
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
        '问题/缺陷网页需要本人有效会话。',
        403,
      );
    const projectId = idSchema.parse(req.params.projectId);
    const prefix = `/api/v1/projects/${projectId}/`;
    const family = req.path.slice(prefix.length).startsWith('problems')
      ? 'problems'
      : 'issues';
    const path = req.path
      .slice(`${prefix}${family}`.length)
      .replace(/^\//, '')
      .replace(/\/$/, '');
    if (family === 'problems') {
      if (!path && req.method === 'GET')
        return res.json(
          await this.problems.list(
            actor,
            projectId,
            problemListQuerySchema
              .extend({
                participationOnly: booleanQueryValue(true),
                includeArchivedRequirements: booleanQueryValue(true),
              })
              .parse(req.query),
          ),
        );
      if (!path && req.method === 'POST')
        return res
          .status(201)
          .json(await this.problems.report(actor, projectId, req.body));
      if (path === 'confirmation-previews' && req.method === 'POST')
        return res.json(
          await this.problems.previewBatch(actor, projectId, req.body),
        );
      if (path === 'confirm-batch' && req.method === 'POST')
        return res.json(
          await this.problems.confirmBatch(actor, projectId, req.body),
        );
      const preview = /^confirmation-previews\/([^/]+)$/.exec(path);
      if (preview?.[1] && req.method === 'GET')
        return res.json(
          await this.problems.batchPreview(
            actor,
            projectId,
            idSchema.parse(preview[1]),
          ),
        );
      const match = /^([^/]+)(?:\/(confirm|dismiss))?$/.exec(path);
      if (match?.[1]) {
        const id = idSchema.parse(match[1]);
        if (!match[2] && req.method === 'GET')
          return res.json(await this.problems.detail(actor, projectId, id));
        if (match[2] === 'confirm' && req.method === 'POST')
          return res.json(
            await this.problems.confirm(actor, projectId, id, req.body),
          );
        if (match[2] === 'dismiss' && req.method === 'POST')
          return res.json(
            await this.problems.dismiss(actor, projectId, id, req.body),
          );
      }
    } else {
      if (path === 'counts' && req.method === 'GET')
        return res.json(
          await this.issues.counts(
            actor,
            projectId,
            issueCountsQuerySchema
              .extend({
                participationOnly: booleanQueryValue(true),
                includeMerged: booleanQueryValue(true),
                includeArchivedRequirements: booleanQueryValue(true),
                unassignedOnly: booleanQueryValue(false),
              })
              .parse(req.query),
          ),
        );
      if (!path && req.method === 'GET')
        return res.json(
          await this.issues.list(
            actor,
            projectId,
            issueListQuerySchema
              .extend({
                participationOnly: booleanQueryValue(true),
                includeMerged: booleanQueryValue(true),
                includeArchivedRequirements: booleanQueryValue(true),
              })
              .parse(req.query),
          ),
        );
      if (!path && req.method === 'POST')
        return res
          .status(201)
          .json(await this.issues.create(actor, projectId, req.body));
      if (path === 'lifecycle-previews' && req.method === 'POST')
        return res.json(
          await this.lifecycle.preview(actor, projectId, req.body),
        );
      if (path === 'lifecycle-commit' && req.method === 'POST')
        return res.json(
          await this.lifecycle.commit(actor, projectId, req.body),
        );
      if (path === 'merge' && req.method === 'POST')
        return res.json(await this.lifecycle.merge(actor, projectId, req.body));
      if (path === 'unmerge' && req.method === 'POST')
        return res.json(
          await this.lifecycle.unmerge(actor, projectId, req.body),
        );
      const match =
        /^([^/]+)(?:\/(handling|severity|manual-verification|lifecycle))?$/.exec(
          path,
        );
      if (match?.[1]) {
        const id = idSchema.parse(match[1]);
        if (!match[2] && req.method === 'GET')
          return res.json(await this.issues.detail(actor, projectId, id));
        if (!match[2] && req.method === 'PUT')
          return res.json(
            await this.issues.edit(actor, projectId, id, req.body),
          );
        if (match[2] === 'handling' && req.method === 'POST')
          return res.json(
            await this.issues.handle(actor, projectId, id, req.body),
          );
        if (match[2] === 'severity' && req.method === 'POST')
          return res.json(
            await this.issues.severity(actor, projectId, id, req.body),
          );
        if (match[2] === 'manual-verification' && req.method === 'POST')
          return res.json(
            await this.issues.manualVerification(
              actor,
              projectId,
              id,
              req.body,
            ),
          );
        if (match[2] === 'lifecycle' && req.method === 'POST')
          return res.json(
            await this.lifecycle.single(actor, projectId, id, req.body),
          );
      }
    }
    throw new DomainError('NOT_FOUND', '没有此问题/缺陷操作入口。', 404);
  }
}
