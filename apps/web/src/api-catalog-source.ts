import type { ApiCatalogGetResult } from '../../../packages/contracts/src/api-catalog';
import { newRequest, type ApiDraft, type DraftRequest } from './api-draft';

export const catalogMergeFields = [
  { key: 'name', label: '步骤名称' },
  { key: 'method', label: '请求方法' },
  { key: 'url', label: '路径与服务引用' },
  { key: 'query', label: '查询参数' },
  { key: 'headers', label: '请求头' },
  { key: 'body', label: '请求体' },
  { key: 'auth', label: '认证引用' },
] as const;

export type CatalogMergeField = (typeof catalogMergeFields)[number]['key'];

export function catalogFieldValue(
  request: DraftRequest,
  field: CatalogMergeField,
): unknown {
  if (field === 'auth')
    return {
      mode: request.authMode ?? null,
      purposeRef: request.purposeRef ?? null,
      authProfileRef: request.authProfileRef ?? null,
    };
  if (field === 'body')
    return { format: request.body, content: request.bodyText };
  return request[field];
}

export function mergeCatalogRequest(
  previous: DraftRequest,
  source: DraftRequest,
  fields: ReadonlySet<CatalogMergeField>,
  advanceRevision: boolean,
): DraftRequest {
  const next: DraftRequest = {
    ...previous,
    ...(fields.has('name') && { name: source.name }),
    ...(fields.has('method') && { method: source.method }),
    ...(fields.has('url') && { url: source.url }),
    ...(fields.has('query') && { query: source.query }),
    ...(fields.has('headers') && { headers: source.headers }),
    ...(fields.has('body') && { body: source.body, bodyText: source.bodyText }),
    ...(advanceRevision && source.source && { source: source.source }),
  };
  if (fields.has('auth')) {
    delete next.authMode;
    delete next.purposeRef;
    delete next.authProfileRef;
    if (source.authMode) next.authMode = source.authMode;
    if (source.purposeRef) next.purposeRef = source.purposeRef;
    if (source.authProfileRef) next.authProfileRef = source.authProfileRef;
  }
  return next;
}

export function makeCatalogRequest(
  asset: ApiCatalogGetResult,
  existingVars: readonly ApiDraft['variableEntries'][number][] = [],
): { request: DraftRequest; variables: ApiDraft['variableEntries'] } {
  const revision = asset.revision;
  if (!revision) throw new Error('请选择固定的接口修订。');
  const definition = revision.definition;
  const used = new Set(existingVars.map((entry) => entry.name));
  const variables: ApiDraft['variableEntries'] = [];
  let path = definition.path;
  for (const parameter of definition.parameters.filter(
    (item) => item.location === 'path',
  )) {
    const stem = (
      'path_' + parameter.name.replace(/[^a-zA-Z0-9_]/g, '_')
    ).slice(0, 60);
    let name = stem,
      suffix = 1;
    while (used.has(name)) name = stem + '_' + suffix++;
    used.add(name);
    variables.push({
      id: crypto.randomUUID(),
      name,
      valueText: parameter.examples[0]
        ? JSON.stringify(parameter.examples[0].value)
        : '',
    });
    path = path.replaceAll('{' + parameter.name + '}', '{{case.' + name + '}}');
  }
  const named = (location: 'query' | 'header') =>
    definition.parameters
      .filter((item) => item.location === location && item.examples.length)
      .map((item) => ({
        name: item.name,
        value:
          typeof item.examples[0]?.value === 'string'
            ? item.examples[0].value
            : JSON.stringify(item.examples[0]?.value),
      }));
  const body = definition.requestBodies.find(
    (item) => item.mediaType === 'application/json',
  );
  return {
    variables,
    request: {
      ...newRequest(),
      name: revision.title,
      method: definition.method,
      url: '{{env.baseUrls.' + definition.serviceKey + '}}' + path,
      query: named('query'),
      headers: named('header'),
      authMode: definition.auth.mode === 'none' ? 'none' : 'inherit',
      ...(body?.examples[0] && {
        body: { format: 'json' as const, value: body.examples[0].value },
        bodyText: JSON.stringify(body.examples[0].value, null, 2),
      }),
      source: {
        projectId: asset.node.projectId,
        interfaceId: asset.node.id,
        revisionId: revision.id,
      },
    },
  };
}
