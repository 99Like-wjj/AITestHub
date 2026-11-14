import { isIP } from 'node:net';
import { z } from 'zod';
import {
  publicSearchResultSchema,
  type PublicSearchBinding,
  type PublicSearchResult,
} from '../../../contracts/src/public-search.js';
import type { ExternalApprovedTool } from '../../../contracts/src/external-mcp.js';
import { frozenConversationReferenceSchema } from '../../../contracts/src/conversations.js';
import { parseStrictJsonText } from '../../../contracts/src/safe-json.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { currentUser, requireProject } from '../access/policy.js';
import { DomainError } from '../errors.js';
import { assertSafeModelInput } from '../security/model-input.js';
import { assertSafeResultContent } from '../results/safety.js';
import { publicAddress, boundedExternalJson } from './safety.js';

const blocked = () =>
  new DomainError(
    'VALIDATION_ERROR',
    '公开搜索词或参数无法确认只含通用公开信息，未发送。请移除内部地址、账号凭据、代码长段和项目/需求完整标题后重新提炼。',
    400,
  );
function variants(input: string) {
  const values = new Set([input]);
  let text = input;
  for (let count = 0; count < 8; count++) {
    let decoded = text
      .replace(/\\(["'\\])/g, '$1')
      .replace(/\\u([a-f\d]{4})/gi, (_match: string, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
      .replace(/\\x([a-f\d]{2})/gi, (_match: string, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      decoded = decoded.replace(
        /%([a-f\d]{2})/gi,
        (_match: string, hex: string) =>
          String.fromCharCode(Number.parseInt(hex, 16)),
      );
    }
    decoded = decoded.normalize('NFKC');
    values.add(decoded);
    if (decoded === text) return [...values];
    text = decoded;
  }
  throw blocked();
}
const compact = (value: string) =>
  value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, '');
/** Literal URL safety only. No DNS lookup, URL retrieval or claim that a page is publicly readable. */
export function safePublicSourceUrl(value: string): string | null {
  if (value.length > 2000 || /[\x00-\x20\x7f]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    return null;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    host === 'localhost' ||
    (!host.includes('.') && !host.includes(':')) ||
    /(?:^|\.)(?:localhost|local|internal|corp|lan|home|invalid|test)$/.test(
      host,
    )
  )
    return null;
  if (isIP(host) && !publicAddress(host)) return null;
  try {
    for (const [name, content] of url.searchParams)
      if (
        content &&
        variants(name).some((decoded) =>
          /(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|session|secret|signature|^token$|^sig$)/i.test(
            decoded,
          ),
        )
      )
        return null;
    if (
      variants(url.hash).some((decoded) =>
        /(?:password|passwd|api[_-]?key|token|authorization|cookie|secret)\s*[:=]/i.test(
          decoded,
        ),
      )
    )
      return null;
  } catch {
    return null;
  }
  return url.href;
}
export function validatePublicSearchBinding(tool: ExternalApprovedTool) {
  const binding = tool.publicSearch;
  if (!binding) return;
  if (tool.effect !== 'read' || tool.projectAction !== 'project.read')
    throw blocked();
  if (
    /^(?:url|uri|href|endpoint|path|file|command|sql|password|token|authorization|cookie|api_key|apiKey|__proto__|constructor|prototype)$/i.test(
      binding.queryArgument,
    )
  )
    throw blocked();
  const properties = tool.inputSchema.properties;
  if (
    !properties ||
    typeof properties !== 'object' ||
    Array.isArray(properties) ||
    !Object.hasOwn(properties, binding.queryArgument)
  )
    throw new DomainError(
      'VALIDATION_ERROR',
      '公开搜索绑定的query字段不在实际输入Schema中。',
      400,
    );
  const required = tool.inputSchema.required;
  if (
    Array.isArray(required) &&
    required.some((field) => field !== binding.queryArgument)
  )
    throw new DomainError(
      'VALIDATION_ERROR',
      '公开搜索只支持仅一个query字段即可调用的工具，不自动注入其他参数。',
      400,
    );
}
export function publicQueryArguments(
  binding: PublicSearchBinding,
  args: Record<string, unknown>,
): string {
  const keys = Object.keys(args);
  if (keys.length !== 1 || keys[0] !== binding.queryArgument) throw blocked();
  const query = args[binding.queryArgument];
  if (typeof query !== 'string' || !query.trim() || query.length > 500)
    throw blocked();
  try {
    parseStrictJsonText(JSON.stringify(query));
  } catch {
    throw blocked();
  }
  return query;
}
async function contextProjects(
  tx: SqlExecutor,
  actor: ActorContext,
  projectId: string | null,
  sources: unknown,
) {
  const projects = new Set(projectId ? [projectId] : []),
    references = z
      .array(frozenConversationReferenceSchema)
      .parse(sources ?? [])
      .map((source) => source.reference);
  for (const ref of references)
    if (ref.kind === 'projectAccess') projects.add(ref.projectId);
  const versions = references
      .filter((ref) => ref.kind === 'requirementVersion')
      .map((ref) => ref.requirementVersionId),
    knowledge = references
      .filter((ref) => ref.kind === 'knowledge')
      .map((ref) => ref.entryId),
    resources = references
      .filter((ref) => ref.kind === 'resource')
      .map((ref) => ref.resourceId),
    conversations = references
      .filter((ref) => ref.kind === 'conversation')
      .map((ref) => ref.conversationId),
    invocations = references
      .filter((ref) => ref.kind === 'externalMcpInvocation')
      .map((ref) => ref.invocationId);
  if (
    versions.length ||
    knowledge.length ||
    resources.length ||
    conversations.length ||
    invocations.length
  ) {
    const rows = await tx.query<{ project_id: string | null }>(
      `SELECT project_id FROM app.requirement_versions WHERE id=ANY($1::uuid[]) UNION SELECT project_id FROM app.knowledge_entries WHERE id=ANY($2::uuid[]) UNION SELECT project_id FROM app.file_resources WHERE id=ANY($3::uuid[]) UNION SELECT project_id FROM app.ai_conversations WHERE id=ANY($4::uuid[]) AND owner_id=$6 UNION SELECT project_id FROM app.external_mcp_invocations WHERE id=ANY($5::uuid[]) AND actor_id=$6`,
      [
        versions,
        knowledge,
        resources,
        conversations,
        invocations,
        actor.userId,
      ],
    );
    for (const row of rows.rows)
      if (row.project_id) projects.add(row.project_id);
  }
  for (const p of projects) await requireProject(tx, actor, p, 'project.read');
  return [...projects];
}
/** Secondary checks plus real human query review; these patterns are not a complete private-data classifier. */
export async function assertPublicSearchInput(
  tx: SqlExecutor,
  actor: ActorContext,
  tool: ExternalApprovedTool,
  args: Record<string, unknown>,
  context: { projectId: string | null; sourceRefs?: unknown },
) {
  if (!tool.publicSearch) return undefined;
  validatePublicSearchBinding(tool);
  await currentUser(tx, actor);
  const query = publicQueryArguments(tool.publicSearch, args),
    decoded = variants(query);
  for (const value of decoded) {
    try {
      assertSafeModelInput(value);
      assertSafeResultContent(value);
    } catch {
      throw blocked();
    }
    if (
      /```|[A-Z]:\\|\\\\[\w.-]+\\|\b(?:file|ssh|sftp):\/\/|\b[\w.-]+\.(?:corp|internal|local|lan)(?:\b|[:/])|\blocalhost\b|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:username|account)\s*[:=]/i.test(
        value,
      )
    )
      throw blocked();
    if (
      value.length > 180 &&
      ((value.match(/[{};]/g)?.length ?? 0) > 3 ||
        (value.match(/\n/g)?.length ?? 0) > 2 ||
        /(?:^|\n)\s*(?:import|export|class|function|def|SELECT|INSERT INTO|UPDATE|DELETE FROM)\b/i.test(
          value,
        ))
    )
      throw blocked();
    for (const match of value.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi))
      if (!safePublicSourceUrl(match[0])) throw blocked();
    for (const match of value.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g))
      if (isIP(match[0]) && !publicAddress(match[0])) throw blocked();
    for (const match of value.matchAll(/(?:[a-f\d]{0,4}:){2,}[a-f\d:.%]+/gi))
      if (isIP(match[0]) && !publicAddress(match[0])) throw blocked();
  }
  const projects = await contextProjects(
    tx,
    actor,
    context.projectId,
    context.sourceRefs,
  );
  if (projects.length) {
    const names = await tx.query<{ label: string }>(
      `SELECT name label FROM app.projects WHERE id=ANY($1::uuid[]) UNION ALL SELECT title label FROM app.requirements WHERE project_id=ANY($1::uuid[]) LIMIT 10001`,
      [projects],
    );
    if (names.rows.length > 10000)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '公开检索上下文范围过大，未发送；请缩小明确项目范围。',
        422,
      );
    for (const row of names.rows) {
      const title = compact(row.label);
      if (
        title &&
        decoded.some((value) =>
          title.length >= 4
            ? compact(value).includes(title)
            : compact(value) === title,
        )
      )
        throw blocked();
    }
  }
  return query;
}
function atPath(value: unknown, path: readonly string[]) {
  let current = value;
  for (const key of path) {
    if (current && typeof current === 'object' && Object.hasOwn(current, key))
      current = (current as Record<string, unknown>)[key];
    else return undefined;
  }
  return current;
}
function cut(value: string, limit: number) {
  const text = value.slice(0, limit);
  return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text;
}
export function publicSearchSources(
  invocationId: string,
  query: string,
  binding: PublicSearchBinding,
  result: unknown,
): PublicSearchResult {
  boundedExternalJson(result);
  if (
    result &&
    typeof result === 'object' &&
    'isError' in result &&
    result.isError === true
  )
    throw new DomainError(
      'DEPENDENCY_UNAVAILABLE',
      '搜索工具实际返回错误，未取得可用来源；没有重试。',
      503,
    );
  let rows = atPath(result, binding.resultsPath);
  if (typeof rows === 'string') {
    try {
      rows = parseStrictJsonText(rows);
    } catch {
      throw new DomainError(
        'INVALID_MODEL_OUTPUT',
        '搜索结果不是所配置的结构化JSON来源，未伪造来源。',
        422,
      );
    }
  }
  if (!Array.isArray(rows))
    throw new DomainError(
      'INVALID_MODEL_OUTPUT',
      '搜索结果与已批准的来源路径不符，未伪造来源。',
      422,
    );
  const sources: PublicSearchResult['sources'] = [],
    seen = new Set<string>();
  let rejectedCount = 0,
    truncated = false;
  for (const item of rows) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      rejectedCount++;
      continue;
    }
    const object = item as Record<string, unknown>,
      rawUrl = object[binding.urlField],
      url = typeof rawUrl === 'string' ? safePublicSourceUrl(rawUrl) : null;
    if (!url || seen.has(url)) {
      rejectedCount++;
      continue;
    }
    seen.add(url);
    const title =
        typeof object[binding.titleField] === 'string'
          ? (object[binding.titleField] as string)
          : '',
      snippet =
        binding.snippetField && typeof object[binding.snippetField] === 'string'
          ? (object[binding.snippetField] as string)
          : '';
    if (sources.length >= 20) {
      truncated = true;
      continue;
    }
    if (title.length > 300 || snippet.length > 1600) truncated = true;
    sources.push({ title: cut(title, 300), url, snippet: cut(snippet, 1600) });
  }
  return publicSearchResultSchema.parse({
    schemaVersion: 'ath.public-search-result.v1',
    invocationId,
    query,
    sources,
    returnedCount: rows.length,
    rejectedCount,
    truncated,
    linksFetched: false,
  });
}
