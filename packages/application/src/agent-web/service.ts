import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { Database } from '../../../persistence/src/database.js';
import { conversationRow } from '../conversations/common.js';
import { assertTaskCapability } from '../conversations/task-capabilities.js';
import { DomainError } from '../errors.js';
import { assertSafeModelInput } from '../security/model-input.js';
import {
  assertPublicSearchInput,
  safePublicSourceUrl,
} from '../external-mcp/public-search.js';
import { readPublicHttp } from './public-http.js';
import { extractPublicPage } from './extract.js';

const searchResponseSchema = z.object({
  results: z
    .array(
      z.object({
        title: z.string().max(10000),
        url: z.string().max(10000),
        content: z.string().max(100000).optional(),
        publishedDate: z.string().max(200).nullable().optional(),
      }),
    )
    .max(1000),
  unresponsive_engines: z.array(z.unknown()).optional(),
});
const searchToolDefinition = {
  metadata: {},
  name: 'platform_public_search',
  description: 'Public search',
  effect: 'read' as const,
  projectAction: 'project.read' as const,
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  },
  publicSearch: {
    queryArgument: 'query',
    resultsPath: ['results'],
    titleField: 'title',
    urlField: 'url',
    snippetField: 'content',
  },
};
export interface AgentWebScope {
  conversationId: string;
  taskId: string;
  authorize: () => Promise<void>;
  signal?: AbortSignal;
}

/** The fixed search endpoint is trusted deployment configuration, not a tool argument. */
export class AgentWebService {
  constructor(
    readonly db: Database,
    readonly searchEndpoint: string | null,
  ) {
    if (searchEndpoint) {
      const url = new URL(searchEndpoint);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error('AITESTHUB_SEARCH_ENDPOINT_INVALID');
    }
  }
  async #run(
    actor: ActorContext,
    scope: AgentWebScope,
    kind: 'search' | 'read',
    request: { query: string } | { url: string },
    execute: () => Promise<unknown>,
  ) {
    await scope.authorize();
    const digest = createHash('sha256')
      .update(JSON.stringify(request))
      .digest('hex');
    const { row, fresh } = await this.db.transaction(async (tx) => {
      await assertTaskCapability(tx, actor, scope, 'office', { active: true });
      const inserted = await tx.query<{
        id: string;
        state: string;
        result: unknown;
        error_code: string | null;
      }>(
        "INSERT INTO app.agent_web_receipts(id,owner_id,conversation_id,task_id,request_digest,kind,state,request) VALUES($1,$2,$3,$4,$5,$6,'dispatching',$7) ON CONFLICT(owner_id,task_id,kind,request_digest) DO NOTHING RETURNING id,state,result,error_code",
        [
          randomUUID(),
          actor.userId,
          scope.conversationId,
          scope.taskId,
          digest,
          kind,
          JSON.stringify(request),
        ],
      );
      const row =
        inserted.rows[0] ??
        (
          await tx.query<{
            id: string;
            state: string;
            result: unknown;
            error_code: string | null;
          }>(
            'SELECT id,state,result,error_code FROM app.agent_web_receipts WHERE owner_id=$1 AND task_id=$2 AND kind=$3 AND request_digest=$4',
            [actor.userId, scope.taskId, kind, digest],
          )
        ).rows[0];
      if (!row)
        throw new DomainError('BUSINESS_CONFLICT', '联网回执不存在。', 409);
      return { row, fresh: Boolean(inserted.rowCount) };
    });
    if (!fresh)
      return {
        invocationId: row.id,
        state: row.state,
        result: row.result,
        errorCode: row.error_code,
        replayed: false,
      };
    try {
      await scope.authorize();
      scope.signal?.throwIfAborted();
      await this.db.transaction((tx) =>
        assertTaskCapability(tx, actor, scope, 'office', { active: true }),
      );
      const result = await execute();
      await scope.authorize();
      assertSafeModelInput(result);
      await this.db.query(
        "UPDATE app.agent_web_receipts SET state='completed',result=$2,finished_at=now() WHERE id=$1 AND state='dispatching'",
        [row.id, JSON.stringify(result)],
      );
      return {
        invocationId: row.id,
        state: 'completed',
        result,
        errorCode: null,
      };
    } catch (error: unknown) {
      const code =
        error instanceof DomainError
          ? error.code
          : scope.signal?.aborted
            ? 'CANCELLED'
            : 'DEPENDENCY_UNAVAILABLE';
      await this.db.query(
        "UPDATE app.agent_web_receipts SET state='failed',error_code=$2,finished_at=now() WHERE id=$1 AND state='dispatching'",
        [row.id, code],
      );
      throw new DomainError(
        error instanceof DomainError ? error.code : 'DEPENDENCY_UNAVAILABLE',
        '联网请求未取得可用回执，请查原记录；未伪造来源、未自动重试。',
        422,
      );
    }
  }
  async search(actor: ActorContext, scope: AgentWebScope, rawQuery: string) {
    const query = z.string().trim().min(1).max(500).parse(rawQuery);
    const endpoint = this.searchEndpoint;
    if (!endpoint)
      throw new DomainError(
        'DEPENDENCY_UNAVAILABLE',
        '平台默认搜索服务未配置，请管理员配置搜索服务。',
        503,
      );
    await this.db.transaction(async (tx) => {
      await conversationRow(tx, actor, scope.conversationId, false, true);
      const task = (
        await tx.query<{
          prompt: string;
          project_id: string | null;
          refs: unknown;
        }>(
          'SELECT m.content prompt,c.project_id,a.explicit_refs refs FROM app.ai_tasks t JOIN app.ai_messages m ON m.id=t.user_message_id JOIN app.ai_messages a ON a.id=t.assistant_message_id JOIN app.ai_conversations c ON c.id=t.conversation_id WHERE t.id=$1 AND t.owner_id=$2 AND t.conversation_id=$3 AND m.deleted_at IS NULL',
          [scope.taskId, actor.userId, scope.conversationId],
        )
      ).rows[0];
      if (!task || !task.prompt.includes(query))
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '默认公开检索只发送当前用户明确提供的公开搜索词，请直接使用本条用户消息中的原词；不从附件或私有上下文构造查询。',
          422,
        );
      await assertPublicSearchInput(
        tx,
        actor,
        searchToolDefinition,
        { query },
        { projectId: task.project_id, sourceRefs: task.refs },
      );
    });
    return this.#run(actor, scope, 'search', { query }, async () => {
      const url = new URL(endpoint);
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');
      const response = await fetch(url, {
        redirect: 'error',
        signal: AbortSignal.any([
          AbortSignal.timeout(20_000),
          ...(scope.signal ? [scope.signal] : []),
        ]),
        headers: { accept: 'application/json' },
      });
      if (!response.ok || !response.body)
        throw new DomainError(
          'DEPENDENCY_UNAVAILABLE',
          '搜索服务当前不可用。',
          503,
        );
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          await response.body.cancel().catch(() => undefined);
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '搜索返回超过限额。',
            422,
          );
        }
        chunks.push(chunk);
      }
      const parsed = searchResponseSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
      );
      const sources = parsed.results
        .flatMap((item) => {
          const url = safePublicSourceUrl(item.url);
          return url
            ? [
                {
                  title: item.title.slice(0, 300),
                  url,
                  snippet: item.content?.slice(0, 1600) ?? '',
                  publishedAt: item.publishedDate ?? null,
                },
              ]
            : [];
        })
        .slice(0, 10);
      return {
        query,
        retrievedAt: new Date().toISOString(),
        sources,
        linksFetched: false,
        partial: Boolean(parsed.unresponsive_engines?.length),
        notice:
          '只含实际搜索条目与摘要，网页正文尚未读取。没有来源不代表不存在。',
      };
    });
  }
  async read(actor: ActorContext, scope: AgentWebScope, input: string) {
    const url = z.url().max(2000).parse(input);
    return this.#run(actor, scope, 'read', { url }, async () =>
      extractPublicPage(await readPublicHttp(url, scope.signal)),
    );
  }
}
