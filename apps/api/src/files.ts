import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { ZodError } from 'zod';
import { idSchema } from '../../../packages/contracts/src/base.js';
import { FilesService } from '../../../packages/application/src/files/service.js';
import { IdentityService } from '../../../packages/application/src/identity/service.js';
import { DomainError } from '../../../packages/application/src/errors.js';
import type { Database } from '../../../packages/persistence/src/database.js';
import type { StoragePort } from '../../../packages/storage/src/port.js';
import { createStorageFromEnvironment } from '../../../packages/storage/src/s3.js';

function session(req: Request): string | undefined {
  return req.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('ath_session='))
    ?.slice('ath_session='.length);
}
function bearer(req: Request): string | undefined {
  const header = req.header('authorization');
  if (header === undefined) return undefined;
  if (!header.startsWith('Bearer ') || header.length > 512)
    throw new DomainError('UNAUTHENTICATED', '认证格式无效。', 401);
  return header.slice(7);
}
async function json(req: Request): Promise<unknown> {
  if (!req.is('application/json'))
    throw new DomainError('VALIDATION_ERROR', '文件登记须使用JSON。', 400);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
    size += chunk.length;
    if (size > 64 * 1024)
      throw new DomainError('VALIDATION_ERROR', '文件登记内容过大。', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new DomainError('VALIDATION_ERROR', '文件登记JSON格式无效。', 400);
  }
}

/** Must mount after request-origin/CSRF checks and before the general JSON parser. */
export async function mountFiles(
  app: NestExpressApplication,
  db: Database,
  identity: IdentityService,
  storage?: StoragePort,
  providedService?: FilesService,
): Promise<FilesService> {
  const port =
    storage ??
    providedService?.storage ??
    (await createStorageFromEnvironment());
  const files = providedService ?? new FilesService(db, port);
  if (
    providedService &&
    (providedService.db !== db || providedService.storage !== port)
  )
    throw new DomainError(
      'DEPENDENCY_UNAVAILABLE',
      '文件服务与应用数据/存储绑定不一致。',
      503,
    );
  if (storage === undefined && providedService === undefined)
    app.getHttpServer().once('close', () => port.close());
  app.use(
    '/api/v1/files',
    (req: Request, res: Response, next: NextFunction) => {
      const path = req.path.replace(/\/$/, '');
      const filePath = /^\/([^/]+)(\/content)?$/.exec(path);
      if (
        !(path === '/register' && req.method === 'POST') &&
        !(filePath && ['GET', 'PUT'].includes(req.method))
      ) {
        next();
        return;
      }
      const requestId =
        typeof res.locals.requestId === 'string'
          ? res.locals.requestId
          : randomUUID();
      const handle = async () => {
        const actor = await identity.authenticate(
          session(req),
          bearer(req),
          requestId,
        );
        if (path === '/capabilities' && req.method === 'GET') {
          res.json(await files.capabilities(actor, req.query));
          return;
        }
        if (path === '/register') {
          res.status(201).json(await files.register(actor, await json(req)));
          return;
        }
        const id = idSchema.parse(filePath?.[1]);
        if (!filePath?.[2]) {
          if (req.method !== 'GET')
            throw new DomainError('NOT_FOUND', '没有此文件操作。', 404);
          res.json(await files.metadata(actor, id));
          return;
        }
        if (req.method === 'PUT') {
          req.setTimeout(10 * 60_000, () => req.destroy());
          res.json(await files.upload(actor, id, req));
          return;
        }
        const result = await files.download(actor, id);
        const encoded = encodeURIComponent(result.file.originalName).replace(
          /[!'()*]/g,
          (character) =>
            `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
        );
        res.setHeader('Content-Type', result.file.mediaType);
        res.setHeader('Content-Length', result.file.bytes);
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="download"; filename*=UTF-8''${encoded}`,
        );
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        await pipeline(result.body, res);
      };
      void handle().catch((error: unknown) => {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        const failure =
          error instanceof DomainError
            ? error
            : error instanceof ZodError
              ? new DomainError('VALIDATION_ERROR', '文件参数不符合契约。', 400)
              : new DomainError(
                  'INTERNAL_ERROR',
                  '文件操作失败，请查询原状态后处理。',
                  500,
                );
        res.status(failure.status).json({
          error: { code: failure.code, message: failure.message },
          meta: { requestId },
        });
      });
    },
  );
  return files;
}
