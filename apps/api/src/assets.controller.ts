import {
  assetListQuerySchema,
  assetNavigationQuerySchema,
} from '../../../packages/contracts/src/assets.js';
import { booleanQueryValue } from './query-values.js';
import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  idSchema,
  kindSchema,
  commandIdSchema,
} from '../../../packages/contracts/src/base.js';
import { AssetService } from '../../../packages/application/src/assets/service.js';
import { CoverageCheckpointService } from '../../../packages/application/src/assets/coverage-checkpoints.js';
import { readCaseSupplementOrigin } from '../../../packages/application/src/assets/supplement-origin.js';
import { ReviewService } from '../../../packages/application/src/assets/reviews.js';
import { UiReviewService } from '../../../packages/application/src/assets/ui-review.js';
import { IdentityService } from '../../../packages/application/src/identity/service.js';
import { DomainError } from '../../../packages/application/src/errors.js';

@Controller('api/v1/projects/:projectId/assets')
export class AssetsController {
  constructor(
    @Inject(AssetService) readonly assets: AssetService,
    @Inject(ReviewService) readonly reviews: ReviewService,
    @Inject(IdentityService) readonly identity: IdentityService,
  ) {}
  @All(['', '{*assetPath}'])
  async handle(@Req() req: Request, @Res() res: Response) {
    const projectId = idSchema.parse(req.params.projectId);
    const prefix = `/api/v1/projects/${projectId}/assets`;
    const path = req.path
      .slice(prefix.length)
      .replace(/^\//, '')
      .replace(/\/$/, '');
    const session = req.headers.cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('ath_session='))
      ?.slice('ath_session='.length);
    const authorization = req.header('authorization');
    if (
      authorization !== undefined &&
      (!authorization.startsWith('Bearer ') || authorization.length > 512)
    )
      throw new DomainError('UNAUTHENTICATED', '认证格式无效。', 401);
    const actor = await this.identity.authenticate(
      session,
      authorization?.slice(7),
      String(res.locals.requestId),
    );
    if (actor.entrypoint !== 'web')
      throw new DomainError('FORBIDDEN', '个人Key请使用官方MCP。', 403);
    if (path === 'coverage-checkpoints' && req.method === 'GET')
      return res.json(
        await new CoverageCheckpointService(this.assets.db).list(
          actor,
          projectId,
          req.query,
        ),
      );
    if (path === 'coverage-checkpoints' && req.method === 'POST')
      return res.json(
        await new CoverageCheckpointService(this.assets.db).save(
          actor,
          projectId,
          req.body,
        ),
      );
    const coverageReceipt = /^coverage-checkpoints\/receipts\/([^/]+)$/.exec(
      path,
    );
    if (coverageReceipt?.[1] && req.method === 'GET')
      return res.json(
        await new CoverageCheckpointService(this.assets.db).receipt(
          actor,
          projectId,
          commandIdSchema.parse(decodeURIComponent(coverageReceipt[1])),
        ),
      );
    if (path === '' && req.method === 'GET')
      return res.json(
        await this.assets.list(
          actor,
          projectId,
          assetListQuerySchema
            .extend({
              includeRemoved: booleanQueryValue(false),
              includeArchivedRequirements: booleanQueryValue(true),
            })
            .parse(req.query),
        ),
      );
    if (path === 'navigation' && req.method === 'GET') {
      const query = assetNavigationQuerySchema
        .extend({ includeArchivedRequirements: booleanQueryValue(true) })
        .parse(req.query);
      return res.json(
        await this.assets.navigation(
          actor,
          projectId,
          query.kind,
          query.includeArchivedRequirements,
        ),
      );
    }
    const receipt = /^receipts\/([^/]+)$/.exec(path);
    if (receipt?.[1] && req.method === 'GET')
      return res.json(
        await this.assets.operationStatus(
          actor,
          projectId,
          commandIdSchema.parse(decodeURIComponent(receipt[1])),
          req.query.operation,
        ),
      );
    if (path === 'scenarios' && req.method === 'POST')
      return res
        .status(201)
        .json(await this.assets.createScenario(actor, projectId, req.body));
    if (path === 'scoped-cases' && req.method === 'POST')
      return res
        .status(201)
        .json(await this.assets.createScopedCase(actor, projectId, req.body));
    if (path === 'submissions' && req.method === 'POST')
      return res.json(await this.assets.submit(actor, projectId, req.body));
    if (path === 'approval-previews' && req.method === 'POST')
      return res.json(await this.reviews.preview(actor, projectId, req.body));
    const approvalReceipt = /^approval-receipts\/([^/]+)$/.exec(path);
    if (approvalReceipt?.[1] && req.method === 'GET') {
      const result = await this.reviews.operations.get(actor, {
        operation: 'reviews.approve',
        key: commandIdSchema.parse(decodeURIComponent(approvalReceipt[1])),
      });
      if (result.command.projectId !== projectId)
        throw new DomainError('NOT_FOUND', '此范围内没有该批准回执。', 404);
      return res.json({
        status: result.command.status,
        response: result.command.response ?? null,
      });
    }
    if (path === 'approve' && req.method === 'POST')
      return res.json(await this.reviews.commit(actor, projectId, req.body));
    if (path === 'ui-case-review-stages' && req.method === 'GET')
      return res.json(
        await new UiReviewService(this.assets.db).stages(
          actor,
          projectId,
          idSchema.parse(req.query.requirementVersionId),
        ),
      );
    if (path === 'ui-review-meetings' && req.method === 'GET')
      return res.json(
        await new UiReviewService(this.assets.db).list(
          actor,
          projectId,
          idSchema.parse(req.query.requirementVersionId),
          idSchema.optional().parse(req.query.caseId),
          booleanQueryValue(false).parse(req.query.archived),
        ),
      );
    if (path === 'ui-review-meetings' && req.method === 'POST')
      return res
        .status(201)
        .json(
          await new UiReviewService(this.assets.db).create(
            actor,
            projectId,
            req.body,
          ),
        );
    const meetingReceipt = /^ui-review-meetings\/receipt\/([^/]+)$/.exec(path);
    if (meetingReceipt?.[1] && req.method === 'GET') {
      const operation = req.query.operation;
      if (
        operation !== 'reviews.meeting-create' &&
        operation !== 'reviews.meeting-update'
      )
        throw new DomainError('NOT_FOUND', '此评审操作不可查询。', 404);
      const result = await new UiReviewService(this.assets.db).operations.get(
        actor,
        {
          operation,
          key: commandIdSchema.parse(decodeURIComponent(meetingReceipt[1])),
        },
      );
      if (result.command.projectId !== projectId)
        throw new DomainError('NOT_FOUND', '此范围内没有该评审回执。', 404);
      return res.json({
        status: result.command.status,
        response: result.command.response ?? null,
      });
    }
    const meeting = /^ui-review-meetings\/([^/]+)$/.exec(path);
    if (meeting?.[1]) {
      const review = new UiReviewService(this.assets.db);
      const id = idSchema.parse(meeting[1]);
      if (req.method === 'GET')
        return res.json(
          await review.get(
            actor,
            projectId,
            id,
            idSchema.optional().parse(req.query.caseId),
            booleanQueryValue(false).parse(req.query.archived),
          ),
        );
      if (req.method === 'POST')
        return res.json(await review.update(actor, projectId, id, req.body));
    }
    const origin = /^([^/]+)\/supplement-origin$/.exec(path);
    if (origin?.[1] && req.method === 'GET')
      return res.json(
        await readCaseSupplementOrigin(
          this.assets.db,
          actor,
          projectId,
          idSchema.parse(origin[1]),
        ),
      );
    const target =
      /^([^/]+)(?:\/(opinions|optimization-notes|latest-approved)(?:\/([^/]+))?)?$/.exec(
        path,
      );
    const targetId = idSchema.safeParse(target?.[1]);
    if (target && targetId.success) {
      const id = targetId.data;
      if (!target[2]) {
        if (req.method === 'GET')
          return res.json(await this.assets.detail(actor, projectId, id));
        if (req.method === 'PUT')
          return res.json(
            await this.assets.revise(actor, projectId, id, req.body),
          );
        if (req.method === 'DELETE')
          return res.json(
            await this.assets.explicitRemove(actor, projectId, id, req.body),
          );
      }
      if (target[2] === 'opinions') {
        if (target[3] && req.method === 'DELETE')
          return res.json(
            await this.reviews.removeOpinion(
              actor,
              projectId,
              id,
              idSchema.parse(target[3]),
              req.body,
            ),
          );
        if (!target[3] && req.method === 'GET')
          return res.json(
            await this.reviews.opinions(
              actor,
              projectId,
              id,
              req.query.revisionId === undefined
                ? undefined
                : idSchema.parse(req.query.revisionId),
            ),
          );
        if (!target[3] && req.method === 'POST')
          return res
            .status(201)
            .json(
              await this.reviews.addOpinion(actor, projectId, id, req.body),
            );
      }
      if (target[2] === 'optimization-notes' && req.method === 'POST')
        return res.json(
          await this.reviews.optimizationNotes(actor, projectId, id, req.body),
        );
      if (target[2] === 'latest-approved' && req.method === 'GET')
        return res.json(
          await this.reviews.latestApproved(
            actor,
            projectId,
            id,
            kindSchema.parse(req.query.kind),
          ),
        );
    }
    throw new DomainError('NOT_FOUND', '没有此资产接口。', 404);
  }
}
