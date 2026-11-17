import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { fileCenterQuerySchema } from '../../../packages/contracts/src/agent-workspace.js';
import {
  idSchema,
  persistedRowVersionSchema,
} from '../../../packages/contracts/src/base.js';
import { FileCenterService } from '../../../packages/application/src/agent-workspace/file-center.js';
import { IdentityService } from '../../../packages/application/src/identity/service.js';
import { DomainError } from '../../../packages/application/src/errors.js';

function query(req: Request) {
  return fileCenterQuerySchema.parse({
    ...Object.fromEntries(
      Object.entries(req.query).filter(([key]) =>
        [
          'query',
          'projectId',
          'requirementId',
          'conversationId',
          'kind',
          'from',
          'to',
          'dateField',
          'cursor',
        ].includes(key),
      ),
    ),
    personal: req.query.personal === 'true',
    includeDeleted: req.query.includeDeleted === 'true',
    ...(req.query.limit !== undefined
      ? { limit: Number(req.query.limit) }
      : {}),
  });
}

export function sendFileCenterBytes(
  res: Response,
  req: Request,
  result: {
    entry: { path: string; originalName?: string | null; mediaType: string };
    bytes: Buffer;
  },
) {
  const name = encodeURIComponent(
    result.entry.originalName ??
      result.entry.path.split('/').at(-1) ??
      'download',
  ).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  res.setHeader('Content-Type', result.entry.mediaType);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="download"; filename*=UTF-8''${name}`,
  );
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.setHeader('Accept-Ranges', 'bytes');
  const range = req.header('range');
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start = 0,
      end = result.bytes.length - 1;
    if (match && (match[1] || match[2])) {
      if (!match[1])
        start = Math.max(0, result.bytes.length - Number(match[2]));
      else {
        start = Number(match[1]);
        if (match[2]) end = Math.min(Number(match[2]), end);
      }
    } else start = -1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start > end ||
      start >= result.bytes.length
    ) {
      res.setHeader('Content-Range', `bytes */${result.bytes.length}`);
      return res.status(416).end();
    }
    res.setHeader(
      'Content-Range',
      `bytes ${start}-${end}/${result.bytes.length}`,
    );
    res.setHeader('Content-Length', end - start + 1);
    return res.status(206).send(result.bytes.subarray(start, end + 1));
  }
  res.setHeader('Content-Length', result.bytes.length);
  return res.send(result.bytes);
}

@Controller('api/v1/me/file-center')
export class FileCenterController {
  constructor(
    @Inject(FileCenterService) readonly center: FileCenterService,
    @Inject(IdentityService) readonly identity: IdentityService,
  ) {}
  @All(['', '{*fileCenterPath}'])
  async handle(@Req() req: Request, @Res() res: Response) {
    const session = req.headers.cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('ath_session='))
      ?.slice(12);
    const authorization = req.header('authorization');
    if (authorization !== undefined && !authorization.startsWith('Bearer '))
      throw new DomainError('UNAUTHENTICATED', '认证格式无效。', 401);
    const actor = await this.identity.authenticate(
      session,
      authorization?.slice(7),
      String(res.locals.requestId),
    );
    if (actor.entrypoint !== 'web')
      throw new DomainError('FORBIDDEN', '文件中心仅开放本人网页。', 403);
    const path =
      req.path
        .split('/file-center')[1]
        ?.replace(/^\//, '')
        .replace(/\/$/, '') ?? '';
    if (req.method !== 'GET')
      throw new DomainError('NOT_FOUND', '没有此文件中心操作。', 404);
    res.setHeader('Cache-Control', 'private, no-store');
    if (!path) return res.json(await this.center.list(actor, query(req)));
    if (path === 'tree')
      return res.json(await this.center.tree(actor, query(req)));
    const match =
      /^entries\/([^/]+)(?:\/(versions|content|preview|associations))?$/.exec(
        path,
      );
    if (!match?.[1])
      throw new DomainError('NOT_FOUND', '没有此文件中心操作。', 404);
    const entryId = idSchema.parse(match[1]);
    const revision =
      req.query.revision === undefined
        ? undefined
        : persistedRowVersionSchema.parse(Number(req.query.revision));
    if (!match[2]) return res.json(await this.center.detail(actor, entryId));
    if (match[2] === 'associations')
      return res.json(
        await this.center.associations(actor, entryId, {
          ...(req.query.cursor !== undefined
            ? { cursor: req.query.cursor }
            : {}),
          ...(req.query.limit !== undefined ? { limit: req.query.limit } : {}),
        }),
      );
    if (match[2] === 'versions')
      return res.json(await this.center.history(actor, entryId));
    if (match[2] === 'content')
      return sendFileCenterBytes(
        res,
        req,
        await this.center.read(actor, entryId, revision),
      );
    const abort = new AbortController();
    const cancel = () => {
      if (!res.writableEnded) abort.abort();
    };
    req.once('aborted', cancel);
    res.once('close', cancel);
    try {
      return res.json(
        await this.center.preview(
          actor,
          entryId,
          revision,
          {
            ...(req.query.sheet !== undefined
              ? { sheet: req.query.sheet }
              : {}),
            ...(req.query.offset !== undefined
              ? { offset: req.query.offset }
              : {}),
            ...(req.query.limit !== undefined
              ? { limit: req.query.limit }
              : {}),
          },
          abort.signal,
        ),
      );
    } finally {
      req.off('aborted', cancel);
      res.off('close', cancel);
    }
  }
}
