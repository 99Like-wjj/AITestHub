import { Controller, Get, Post, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  idSchema,
  commandIdSchema,
} from '../../../packages/contracts/src/base.js';
import { IdentityService } from '../../../packages/application/src/identity/service.js';
import { UiExecutionService } from '../../../packages/application/src/ui-executions/service.js';
import { ResultService } from '../../../packages/application/src/results/service.js';
import { ReportService } from '../../../packages/application/src/reports/service.js';
import { DomainError } from '../../../packages/application/src/errors.js';

@Controller('api/v1/projects/:projectId')
export class ResultsController {
  constructor(
    @Inject(IdentityService) readonly identity: IdentityService,
    @Inject(UiExecutionService) readonly ui: UiExecutionService,
    @Inject(ResultService) readonly results: ResultService,
    @Inject(ReportService) readonly reports: ReportService,
  ) {}
  private async actor(req: Request, res: Response) {
    if (req.header('authorization'))
      throw new DomainError(
        'FORBIDDEN',
        '个人 Key 请使用官方 MCP 和专用文件通道。',
        403,
      );
    const session = req.headers.cookie
      ?.split(';')
      .map((value) => value.trim())
      .find((value) => value.startsWith('ath_session='))
      ?.slice('ath_session='.length);
    return this.identity.authenticate(
      session,
      undefined,
      String(res.locals.requestId),
    );
  }
  private project(req: Request) {
    return idSchema.parse(req.params.projectId);
  }
  @Post('ui-executions/claim')
  async claim(@Req() req: Request, @Res() res: Response) {
    return res
      .status(201)
      .json(
        await this.ui.claim(
          await this.actor(req, res),
          this.project(req),
          req.body,
        ),
      );
  }
  @Get('ui-executions/:runId')
  async status(@Req() req: Request, @Res() res: Response) {
    return res.json(
      await this.ui.status(
        await this.actor(req, res),
        this.project(req),
        idSchema.parse(req.params.runId),
      ),
    );
  }
  @Get('ui-executions/:runId/scope')
  async scope(@Req() req: Request, @Res() res: Response) {
    return res.json(
      await this.ui.scope(
        await this.actor(req, res),
        this.project(req),
        idSchema.parse(req.params.runId),
      ),
    );
  }
  @Post('ui-executions/:runId/progress')
  async progress(@Req() req: Request, @Res() res: Response) {
    const actor = await this.actor(req, res);
    const body = z.record(z.string(), z.unknown()).parse(req.body);
    const runId = idSchema.parse(req.params.runId);
    if (body.runId !== runId)
      throw new DomainError(
        'VALIDATION_ERROR',
        '路径与进度所属执行不一致。',
        400,
      );
    return res.json(await this.ui.progress(actor, this.project(req), body));
  }
  @Post('ui-executions/:runId/close-progress')
  async close(@Req() req: Request, @Res() res: Response) {
    return res.json(
      await this.ui.closeProgress(
        await this.actor(req, res),
        this.project(req),
        idSchema.parse(req.params.runId),
        req.body,
      ),
    );
  }
  @Post('ui-executions/close-progress-preview')
  async previewCloseBatch(@Req() req: Request, @Res() res: Response) {
    return res
      .status(200)
      .json(
        await this.ui.previewCloseProgressBatch(
          await this.actor(req, res),
          this.project(req),
          req.body,
        ),
      );
  }
  @Post('ui-executions/close-progress-batch')
  async closeBatch(@Req() req: Request, @Res() res: Response) {
    return res
      .status(200)
      .json(
        await this.ui.closeProgressBatch(
          await this.actor(req, res),
          this.project(req),
          req.body,
        ),
      );
  }
  @Get('ui-executions/close-progress-batches/:commandId')
  async closeBatchReceipt(@Req() req: Request, @Res() res: Response) {
    return res.json(
      await this.ui.closeProgressBatchReceipt(
        await this.actor(req, res),
        this.project(req),
        commandIdSchema.parse(req.params.commandId),
      ),
    );
  }
  @Post('ui-archives/preview')
  async previewArchive(@Req() req: Request, @Res() res: Response) {
    return res.json(
      await this.results.archives.preview(
        await this.actor(req, res),
        this.project(req),
        req.body,
      ),
    );
  }
  @Get('ui-archives/receipts/:commandId')
  async archiveReceipt(@Req() req: Request, @Res() res: Response) {
    return res.json(
      await this.results.archives.receipt(
        await this.actor(req, res),
        this.project(req),
        commandIdSchema.parse(req.params.commandId),
      ),
    );
  }
  @Post('ui-archives')
  async commitArchive(@Req() req: Request, @Res() res: Response) {
    return res.json(
      await this.results.archives.commit(
        await this.actor(req, res),
        this.project(req),
        req.body,
      ),
    );
  }
  @Post('result-submissions')
  async submit(@Req() req: Request, @Res() res: Response) {
    return res.json(
      await this.results.submitUi(
        await this.actor(req, res),
        this.project(req),
        req.body,
      ),
    );
  }
  @Post('result-submissions/prepare')
  async prepareSubmission(@Req() req: Request, @Res() res: Response) {
    return res
      .status(200)
      .json(
        await this.results.prepareUi(
          await this.actor(req, res),
          this.project(req),
          req.body,
        ),
      );
  }
  @Get('result-submissions/missing-files/:runId')
  async missingSubmissionFiles(@Req() req: Request, @Res() res: Response) {
    return res.json(
      await this.results.missingUiFiles(
        await this.actor(req, res),
        this.project(req),
        idSchema.parse(req.params.runId),
      ),
    );
  }
  @Get('result-submissions/:submissionId')
  async receipt(@Req() req: Request, @Res() res: Response) {
    return res.json(
      await this.results.receipt(
        await this.actor(req, res),
        this.project(req),
        commandIdSchema.parse(req.params.submissionId),
      ),
    );
  }
  @Post('result-amendments')
  async amend(@Req() req: Request, @Res() res: Response) {
    return res.json(
      await this.results.amend(
        await this.actor(req, res),
        this.project(req),
        req.body,
      ),
    );
  }
  @Get('results/:resultId')
  async result(@Req() req: Request, @Res() res: Response) {
    return res.json(
      await this.results.detail(
        await this.actor(req, res),
        this.project(req),
        idSchema.parse(req.params.resultId),
      ),
    );
  }
  @Post('results/:resultId/assessment')
  async assess(@Req() req: Request, @Res() res: Response) {
    return res.json(
      await this.results.assess(
        await this.actor(req, res),
        this.project(req),
        idSchema.parse(req.params.resultId),
        req.body,
      ),
    );
  }
  @Post('results/:resultId/evidence-additions')
  async evidence(@Req() req: Request, @Res() res: Response) {
    const actor = await this.actor(req, res);
    const body = z.record(z.string(), z.unknown()).parse(req.body);
    const id = idSchema.parse(req.params.resultId);
    if ('resultId' in body && body.resultId !== id)
      throw new DomainError(
        'VALIDATION_ERROR',
        '路径与补证所属结果不一致。',
        400,
      );
    return res.json(
      await this.results.addEvidence(actor, this.project(req), {
        ...body,
        resultId: id,
      }),
    );
  }
  @Get('reports')
  async listReports(@Req() req: Request, @Res() res: Response) {
    return res.json(
      await this.reports.list(await this.actor(req, res), this.project(req)),
    );
  }
  @Get('execution-records')
  async executionRecords(@Req() req: Request, @Res() res: Response) {
    return res.json(
      await this.reports.records(
        await this.actor(req, res),
        this.project(req),
        {
          ...(req.query.page ? { page: Number(req.query.page) } : {}),
          ...(req.query.pageSize
            ? { pageSize: Number(req.query.pageSize) }
            : {}),
          kind: req.query.kind ?? 'all',
          source: req.query.source ?? 'formal',
          search: req.query.search ?? '',
          ...(req.query.state ? { state: req.query.state } : {}),
        },
      ),
    );
  }
  @Get('reports/:reportId')
  async report(@Req() req: Request, @Res() res: Response) {
    return res.json(
      await this.reports.detail(
        await this.actor(req, res),
        this.project(req),
        idSchema.parse(req.params.reportId),
      ),
    );
  }
  @Get('reports/:reportId/revisions/:revisionId')
  async revision(@Req() req: Request, @Res() res: Response) {
    return res.json(
      await this.reports.revision(
        await this.actor(req, res),
        this.project(req),
        idSchema.parse(req.params.reportId),
        idSchema.parse(req.params.revisionId),
      ),
    );
  }
  @Get('reports/:reportId/export')
  async export(@Req() req: Request, @Res() res: Response) {
    const id = idSchema.parse(req.params.reportId);
    const html = await this.reports.exportHtml(
      await this.actor(req, res),
      this.project(req),
      id,
      req.query.revisionId ? idSchema.parse(req.query.revisionId) : undefined,
    );
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="aitesthub-report-${id}.html"`,
    );
    return res.send(html);
  }
}
