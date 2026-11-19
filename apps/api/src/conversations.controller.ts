import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { idSchema } from '../../../packages/contracts/src/base.js';
import { ConversationsService } from '../../../packages/application/src/conversations/service.js';
import { AiTasksService } from '../../../packages/application/src/conversations/tasks.js';
import { taskEventStreamFailure } from '../../../packages/application/src/conversations/event-stream.js';
import { IdentityService } from '../../../packages/application/src/identity/service.js';
import { DomainError } from '../../../packages/application/src/errors.js';
import { z } from 'zod';
import { skillGuidanceCatalogSchema } from '../../../packages/contracts/src/skill-guidance.js';
import { getSharedSkillRuleRegistry } from '../../../packages/application/src/shared-skill-rules/registry.js';

@Controller([
  'api/v1/me/conversations',
  'api/v1/me/requirement-groups',
  'api/v1/me/ai-preferences',
  'api/v1/me/ai-tasks',
  'api/v1/me/usage',
  'api/v1/me/resources',
  'api/v1/me/skill-guidance',
  'api/v1/admin/usage',
])
export class ConversationsController {
  constructor(
    @Inject(ConversationsService) readonly conversations: ConversationsService,
    @Inject(AiTasksService) readonly tasks: AiTasksService,
    @Inject(IdentityService) readonly identity: IdentityService,
  ) {}
  @All(['', '{*conversationPath}'])
  async handle(@Req() req: Request, @Res() res: Response) {
    const path = req.path
      .replace(/^\/api\/v1\//, '')
      .replace(/^me\//, '')
      .replace(/\/$/, '');
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
      throw new DomainError(
        'FORBIDDEN',
        '个人会话、历史、任务及用量不向官方MCP开放。',
        403,
      );
    if (path === 'skill-guidance' && req.method === 'GET')
      return res.json(
        skillGuidanceCatalogSchema.parse({
          guidanceOnly: true,
          skills: getSharedSkillRuleRegistry()
            .catalog()
            .filter((entry) => entry.availability !== 'localOnly')
            .map((entry) => ({
              skillId: entry.skillId,
              name: entry.name,
              description: entry.description,
              version: entry.version,
              availability: entry.availability,
              releaseDigest: entry.releaseDigest,
              unavailableCode: entry.unavailableCode,
            })),
        }),
      );
    if (path === 'conversations' && req.method === 'GET')
      return res.json(
        await this.conversations.list(actor, {
          archived: req.query.archived === 'true',
        }),
      );
    if (path === 'conversations' && req.method === 'POST')
      return res
        .status(201)
        .json(await this.conversations.create(actor, req.body));
    const createReceipt = /^conversations\/create-receipts\/([^/]+)$/.exec(
      path,
    );
    if (createReceipt?.[1] && req.method === 'GET')
      return res
        .status(200)
        .json(
          await this.conversations.createReceipt(
            actor,
            decodeURIComponent(createReceipt[1]),
          ),
        );
    if (path === 'conversations/sidebar' && req.method === 'GET')
      return res.json(
        await this.conversations.sidebar(
          actor,
          req.query.projectId ? idSchema.parse(req.query.projectId) : undefined,
        ),
      );
    if (path === 'conversations/history-candidates' && req.method === 'GET')
      return res.json(
        await this.conversations.historyCandidates(
          actor,
          String(req.query.query ?? ''),
        ),
      );
    if (path === 'conversations/history-search' && req.method === 'POST')
      return res.json(await this.conversations.searchHistory(actor, req.body));
    if (path === 'requirement-groups/archived' && req.method === 'GET')
      return res.json(await this.conversations.archivedGroups(actor));
    if (
      (path === 'requirement-groups/candidates' ||
        path === 'requirement-groups') &&
      req.method === 'GET'
    )
      return res.json(
        await this.conversations.groupCandidates(
          actor,
          idSchema.parse(req.query.projectId),
        ),
      );
    if (path === 'resources' && req.method === 'GET')
      return res.json(
        await this.conversations.resources(actor, {
          ...(req.query.projectId
            ? { projectId: idSchema.parse(req.query.projectId) }
            : {}),
          ...(req.query.requirementId
            ? { requirementId: idSchema.parse(req.query.requirementId) }
            : {}),
          ...(req.query.cursor
            ? { cursor: idSchema.parse(req.query.cursor) }
            : {}),
          ...(req.query.limit ? { limit: Number(req.query.limit) } : {}),
          query: String(req.query.query ?? ''),
          unassigned: req.query.scope === 'unassigned',
        }),
      );
    if (path === 'conversations/delete' && req.method === 'POST')
      return res.json(await this.conversations.commitDelete(actor, req.body));
    if (path === 'ai-preferences' && req.method === 'GET')
      return res.json(await this.conversations.preferences(actor));
    if (path === 'ai-preferences' && req.method === 'PUT')
      return res.json(
        await this.conversations.updatePreferences(actor, req.body),
      );
    if (path === 'ai-preferences/workspace-access' && req.method === 'GET')
      return res.json(
        await this.conversations.workspaceAccessPreference(actor),
      );
    if (path === 'ai-preferences/workspace-access' && req.method === 'PUT')
      return res.json(
        await this.conversations.updateWorkspaceAccessPreference(
          actor,
          req.body,
        ),
      );
    if (path === 'usage' && req.method === 'GET')
      return res.json(
        await this.tasks.usage(
          actor,
          z
            .enum(['liveProvider', 'fixture', 'legacyUnknown', 'all'])
            .parse(req.query.origin ?? 'liveProvider'),
        ),
      );
    if (path === 'admin/usage' && req.method === 'GET')
      return res.json(
        await this.tasks.platformUsage(
          actor,
          z
            .enum(['liveProvider', 'fixture', 'legacyUnknown', 'all'])
            .parse(req.query.origin ?? 'liveProvider'),
        ),
      );
    const receipt =
      /^conversations\/([^/]+)\/send-receipts\/([^/]+)(\/close)?$/.exec(path);
    if (receipt?.[1] && receipt[2] && !receipt[3] && req.method === 'GET')
      return res.json(
        await this.conversations.sendReceipt(
          actor,
          idSchema.parse(receipt[1]),
          decodeURIComponent(receipt[2]),
        ),
      );
    if (receipt?.[1] && receipt[2] && receipt[3] && req.method === 'POST')
      return res.json(
        await this.conversations.closeSendReceipt(
          actor,
          idSchema.parse(receipt[1]),
          decodeURIComponent(receipt[2]),
        ),
      );
    const markdown = /^conversations\/([^/]+)\/export\.md$/.exec(path);
    if (markdown?.[1] && req.method === 'GET') {
      const exported = await this.conversations.exportMarkdown(
        actor,
        idSchema.parse(markdown[1]),
      );
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${exported.filename}"`,
      );
      res.setHeader('Cache-Control', 'private, no-store, max-age=0');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Vary', 'Cookie, Authorization');
      return res.send(exported.markdown);
    }
    const reference = /^conversations\/([^/]+)\/reference$/.exec(path);
    if (reference?.[1] && req.method === 'GET') {
      res.setHeader('Cache-Control', 'private, no-store, max-age=0');
      res.setHeader('Vary', 'Cookie, Authorization');
      return res.json(
        await this.conversations.referenceMetadata(
          actor,
          idSchema.parse(reference[1]),
        ),
      );
    }
    const conversation =
      /^conversations\/([^/]+)(?:\/(associate|messages|delete-preview))?$/.exec(
        path,
      );
    if (conversation?.[1]) {
      const id = idSchema.parse(conversation[1]);
      if (!conversation[2] && req.method === 'GET')
        return res.json(
          await this.conversations.get(actor, id, {
            ...(req.query.before
              ? { before: idSchema.parse(req.query.before) }
              : {}),
            ...(req.query.limit ? { limit: Number(req.query.limit) } : {}),
          }),
        );
      if (!conversation[2] && req.method === 'PUT')
        return res.json(await this.conversations.update(actor, id, req.body));
      if (conversation[2] === 'associate' && req.method === 'POST')
        return res.json(
          await this.conversations.associate(actor, id, req.body),
        );
      if (conversation[2] === 'messages' && req.method === 'POST')
        return res
          .status(202)
          .json(await this.conversations.send(actor, id, req.body));
      if (conversation[2] === 'delete-preview' && req.method === 'POST')
        return res.json(
          await this.conversations.previewDelete(actor, 'conversation', id),
        );
    }
    const group = /^requirement-groups\/([^/]+)\/([^/]+)$/.exec(path);
    if (group?.[1] && group[2] && req.method === 'PUT')
      return res.json(
        await this.conversations.updateGroup(
          actor,
          idSchema.parse(group[1]),
          idSchema.parse(group[2]),
          req.body,
        ),
      );
    const resource = /^resources\/([^/]+)\/delete-preview$/.exec(path);
    if (resource?.[1] && req.method === 'POST')
      return res.json(
        await this.conversations.previewDelete(
          actor,
          'resource',
          idSchema.parse(resource[1]),
        ),
      );
    const task = /^ai-tasks\/([^/]+)(?:\/(status|events|cancel))?$/.exec(path);
    if (task?.[1]) {
      const id = idSchema.parse(task[1]);
      if ((!task[2] || task[2] === 'status') && req.method === 'GET')
        return res.json(await this.tasks.status(actor, id));
      if (task[2] === 'cancel' && req.method === 'POST')
        return res.json(await this.tasks.cancel(actor, id, req.body));
      if (task[2] === 'events' && req.method === 'GET') {
        let after =
          req.header('last-event-id') ?? String(req.query.after ?? '0');
        await this.tasks.events(actor, id, after); // Authorize before opening the stream.
        if (req.query.format === 'json')
          return res.json(await this.tasks.events(actor, id, after));
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-store, no-transform');
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        let closed = false;
        let lastHeartbeatAt = 0;
        res.once('close', () => {
          closed = true;
        });
        while (!closed) {
          try {
            const page = await this.tasks.events(actor, id, after);
            if (closed || res.destroyed || res.writableEnded) break;
            for (const event of page.events) {
              const ready = res.write(
                `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify({ ...event, sentAt: new Date().toISOString() })}\n\n`,
              );
              if (!ready && !closed)
                await new Promise<void>((resolve) => {
                  const done = () => {
                    res.off('drain', done);
                    res.off('close', done);
                    resolve();
                  };
                  res.once('drain', done);
                  res.once('close', done);
                });
              if (closed || res.destroyed || res.writableEnded) break;
              after = event.sequence;
            }
            if (page.terminal && page.events.length < 200) {
              res.end();
              break;
            }
            if (page.events.length) continue;
            if (Date.now() - lastHeartbeatAt >= 10000) {
              res.write(': waiting\n\n');
              lastHeartbeatAt = Date.now();
            }
          } catch (error: unknown) {
            if (closed || res.destroyed || res.writableEnded) break;
            const failure = taskEventStreamFailure(error);
            res.write(
              `event: ${failure.event}\ndata: ${JSON.stringify(failure.payload)}\n\n`,
            );
            res.end();
            break;
          }
          // Drain durable pages immediately; a bounded idle poll keeps real text
          // responsive across separate Worker/API processes without a new broker.
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
        return;
      }
    }
    throw new DomainError('NOT_FOUND', '没有此个人会话接口。', 404);
  }
}
