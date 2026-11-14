import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { idSchema } from '../../../packages/contracts/src/base.js';
import { knowledgeExportSelectionSchema } from '../../../packages/contracts/src/knowledge.js';
import type { Database } from '../../../packages/persistence/src/database.js';
import type { IdentityService } from '../../../packages/application/src/identity/service.js';
import { KnowledgeService } from '../../../packages/application/src/knowledge/service.js';
import { ReportService } from '../../../packages/application/src/reports/service.js';
import { DomainError } from '../../../packages/application/src/errors.js';

/** Fixed authenticated export byte channel; never an arbitrary URL/file path or a private-chat endpoint. */
export function mountMcpKnowledgeExports(
  app: NestExpressApplication,
  db: Database,
  identity: IdentityService,
  validateLocal: (req: Request) => void,
): void {
  const knowledge = new KnowledgeService(db);
  app.use(
    '/api/v1/mcp/knowledge-exports',
    async (req: Request, res: Response) => {
      const requestId = randomUUID();
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      try {
        validateLocal(req);
        if (req.method !== 'GET')
          throw new DomainError(
            'UNSUPPORTED_OPERATION',
            '知识导出字节通道只接受GET。',
            405,
          );
        const authorization = req.header('authorization');
        if (
          !authorization?.startsWith('Bearer ') ||
          authorization.length > 512 ||
          /\s/.test(authorization.slice(7))
        )
          throw new DomainError(
            'UNAUTHENTICATED',
            '此通道需要有效个人Key Bearer认证。',
            401,
          );
        const actor = await identity.authenticate(
          undefined,
          authorization.slice(7),
          requestId,
        );
        if (actor.entrypoint !== 'official-mcp' || !actor.keyId)
          throw new DomainError(
            'UNAUTHENTICATED',
            '此通道需要有效个人Key。',
            401,
          );
        const projectId = idSchema.parse(
          req.path.replace(/^\//, '').replace(/\/$/, ''),
        );
        let raw: unknown;
        try {
          raw = JSON.parse(String(req.query.selection ?? 'null'));
        } catch {
          throw new DomainError(
            'VALIDATION_ERROR',
            '导出选择不是有效JSON。',
            400,
          );
        }
        const data = await knowledge.export(
          actor,
          projectId,
          knowledgeExportSelectionSchema.parse(raw),
        );
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          'attachment; filename="aitesthub-knowledge.json"',
        );
        return res.status(200).send(JSON.stringify(data, null, 2));
      } catch (error: unknown) {
        const failure =
          error instanceof DomainError
            ? error
            : error instanceof ZodError
              ? new DomainError(
                  'VALIDATION_ERROR',
                  '知识导出参数不符合契约。',
                  400,
                )
              : new DomainError(
                  'INTERNAL_ERROR',
                  '知识导出失败，请查询来源状态。',
                  500,
                );
        if (failure.status === 401)
          res.setHeader(
            'WWW-Authenticate',
            'Bearer realm="AITestHub MCP exports"',
          );
        return res.status(failure.status).json({
          error: { code: failure.code, message: failure.message },
          meta: { requestId },
        });
      }
    },
  );
}

/** A captured report revision is mandatory; downloading never captures a newer snapshot. */
export function mountMcpReportExports(
  app: NestExpressApplication,
  db: Database,
  identity: IdentityService,
  validateLocal: (req: Request) => void,
): void {
  const reports = new ReportService(db);
  app.use('/api/v1/mcp/report-exports', async (req: Request, res: Response) => {
    const requestId = randomUUID();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      validateLocal(req);
      if (req.method !== 'GET')
        throw new DomainError(
          'UNSUPPORTED_OPERATION',
          '固定报告导出字节通道只接受GET。',
          405,
        );
      const authorization = req.header('authorization');
      if (
        !authorization?.startsWith('Bearer ') ||
        authorization.length > 512 ||
        /\s/.test(authorization.slice(7))
      )
        throw new DomainError(
          'UNAUTHENTICATED',
          '此通道需要有效个人Key Bearer认证。',
          401,
        );
      const actor = await identity.authenticate(
        undefined,
        authorization.slice(7),
        requestId,
      );
      if (actor.entrypoint !== 'official-mcp' || !actor.keyId)
        throw new DomainError(
          'UNAUTHENTICATED',
          '此通道需要有效个人Key。',
          401,
        );
      const segments = req.path
        .replace(/^\//, '')
        .replace(/\/$/, '')
        .split('/');
      if (segments.length !== 3)
        throw new DomainError('NOT_FOUND', '固定报告导出路径不存在。', 404);
      const projectId = idSchema.parse(segments[0]);
      const reportId = idSchema.parse(segments[1]);
      const revisionId = idSchema.parse(segments[2]);
      const html = await reports.exportHtml(
        actor,
        projectId,
        reportId,
        revisionId,
      );
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="aitesthub-report-${reportId}-${revisionId}.html"`,
      );
      return res.status(200).send(html);
    } catch (error: unknown) {
      const failure =
        error instanceof DomainError
          ? error
          : error instanceof ZodError
            ? new DomainError(
                'VALIDATION_ERROR',
                '固定报告导出路径不符合契约。',
                400,
              )
            : new DomainError(
                'INTERNAL_ERROR',
                '固定报告导出失败，请查询原修订。',
                500,
              );
      if (failure.status === 401)
        res.setHeader(
          'WWW-Authenticate',
          'Bearer realm="AITestHub MCP exports"',
        );
      return res.status(failure.status).json({
        error: { code: failure.code, message: failure.message },
        meta: { requestId },
      });
    }
  });
}
