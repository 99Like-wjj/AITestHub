import { z } from 'zod';
import {
  apiDataRowSchema,
  httpMethodSchema,
  variableNameSchema,
} from '../../../packages/contracts/src/domain';
import { sourceLinkUnavailableReason } from '../../../packages/contracts/src/source-links';
import { newRequest, type DraftRequest } from './api-draft';

const secretName =
  /(?:password|passwd|authorization|cookie|secret|token|api[-_]?key|credential|signature|private[-_]?key)/iu;
const secretValue =
  /\b(?:sk-|ath_(?:key|session|reset)_)\w{20,}|\b(?:Bearer|Basic)\s+[\w+/=-]{12,}|\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]+/iu;
const invalidProperty = /^(?:__proto__|prototype|constructor)$/u;
const restrictedField = (key: string) =>
  secretName.test(key.normalize('NFKC')) || invalidProperty.test(key);

function assertSafeJson(value: z.infer<ReturnType<typeof z.json>>) {
  const entries = [value];
  while (entries.length) {
    const current = entries.pop();
    if (typeof current === 'string' && secretValue.test(current))
      throw Error('导入内容含疑似认证信息，请删去后重新预览。');
    if (current && typeof current === 'object') {
      for (const [key, child] of Object.entries(current)) {
        if (restrictedField(key))
          throw Error('导入内容含受限字段，请删去后重新预览。');
        entries.push(child);
      }
    }
  }
}

function curlTokens(text: string) {
  if (!text.trim() || text.length > 12000)
    throw Error('请输入不超过 12000 字符的 cURL 配置。');
  const input = text.replace(/\\\r?\n/g, ' ').trim();
  const tokens: string[] = [];
  let word = '';
  let quote = '';
  let started = false;
  for (let position = 0; position < input.length; position += 1) {
    const character = input.charAt(position);
    if (quote && character === quote) {
      quote = '';
    } else if (
      character === '\\' &&
      quote !== "'" &&
      position + 1 < input.length
    ) {
      word += input.charAt(++position);
      started = true;
    } else if (quote) {
      word += character;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/u.test(character)) {
      if (started) tokens.push(word);
      word = '';
      started = false;
    } else {
      if (/[|;&$<>]/u.test(character) || character.charCodeAt(0) === 96)
        throw Error('仅支持单条 cURL 配置，请为含特殊字符的参数加引号。');
      word += character;
      started = true;
    }
  }
  if (quote) throw Error('cURL 中的引号未闭合。');
  if (started) tokens.push(word);
  return tokens;
}

function queryValues(entries: Iterable<[string, string]>) {
  return Array.from(entries, ([name, value]) => {
    if (restrictedField(name) || secretValue.test(value))
      throw Error('查询或表单含受限字段，请改用项目认证和变量引用。');
    return { name, value };
  });
}

export function parseQueryPaste(text: string) {
  if (!text.trim() || text.length > 12000)
    throw Error('请输入不超过 12000 字符的查询参数。');
  const entries = [
    ...new URLSearchParams(
      text
        .trim()
        .replace(/^\?/u, '')
        .split(/\r?\n/gu)
        .filter(Boolean)
        .join('&'),
    ),
  ];
  if (
    !entries.length ||
    entries.some(([name]) => !name.trim()) ||
    entries.length > 200
  )
    throw Error('请使用 name=value 的查询参数，最多 200 项。');
  return queryValues(entries);
}

export function redactPreview(
  value: z.infer<ReturnType<typeof z.json>>,
): z.infer<ReturnType<typeof z.json>> {
  if (typeof value === 'string')
    return secretValue.test(value) ? '[已脱敏]' : value;
  if (Array.isArray(value)) return value.map(redactPreview);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([name, child]) => [
        name,
        restrictedField(name) ? '[已脱敏]' : redactPreview(child),
      ]),
    );
  return value;
}

export function safeRequestDraftPreview(request: DraftRequest) {
  const safeFields = (values: DraftRequest['query']) =>
    values.map(({ name, value }) => ({
      name,
      value: restrictedField(name) ? '[已脱敏]' : redactPreview(value),
    }));
  const body =
    request.body.format === 'multipart'
      ? {
          format: 'multipart',
          parts: request.body.parts.map((part) =>
            part.kind === 'text'
              ? {
                  ...part,
                  value: restrictedField(part.name)
                    ? '[已脱敏]'
                    : redactPreview(part.value),
                }
              : part,
          ),
        }
      : request.body.format === 'form'
        ? { format: 'form', fields: safeFields(request.body.fields) }
        : request.body.format === 'json'
          ? {
              format: 'json',
              content: redactPreview(
                z.json().parse(JSON.parse(request.bodyText)),
              ),
            }
          : request.body.format === 'text'
            ? {
                format: 'text',
                mediaType: request.body.mediaType,
                content: redactPreview(request.bodyText),
              }
            : { format: 'none' };
  const [path, query] = request.url.split('?', 2);
  let visiblePath = path ?? '';
  if (
    /^https?:\/\//iu.test(request.url) &&
    sourceLinkUnavailableReason(request.url)
  )
    visiblePath = '[已隐藏受限链接]';
  return {
    method: request.method,
    url: redactPreview(visiblePath),
    inlineQuery: query
      ? safeFields(
          [...new URLSearchParams(query)].map(([name, value]) => ({
            name,
            value,
          })),
        )
      : [],
    query: safeFields(request.query),
    headers: safeFields(request.headers),
    body,
  };
}

export function parseCurlDraft(text: string): DraftRequest {
  const tokens = curlTokens(text);
  if (!/^curl(?:\.exe)?$/iu.test(tokens.shift() ?? ''))
    throw Error('请粘贴以 curl 开头的一条请求。');
  let address: string | undefined;
  let method: string | undefined;
  let data: string | undefined;
  const headers: DraftRequest['headers'] = [];
  for (let position = 0; position < tokens.length; position += 1) {
    const token = tokens[position];
    if (token === undefined) break;
    if (!token.startsWith('-')) {
      if (address !== undefined) throw Error('一次只接受一个地址。');
      address = token;
      continue;
    }
    const match = /^(--[^=]+)=(.*)$/su.exec(token);
    const flag = match?.[1] ?? token;
    if (
      ![
        '-X',
        '--request',
        '-H',
        '--header',
        '--url',
        '-d',
        '--data',
        '--data-raw',
      ].includes(flag)
    )
      throw Error(
        '移除认证、文件、代理、重定向及其他不支持的执行参数后再预览。',
      );
    const value = match?.[2] ?? tokens[++position];
    if (value === undefined) throw Error('cURL 的选项缺少参数值。');
    switch (flag) {
      case '-X':
      case '--request':
        method = value.toUpperCase();
        break;
      case '--url':
        if (address !== undefined) throw Error('一次只接受一个地址。');
        address = value;
        break;
      case '-H':
      case '--header': {
        const header = /^([A-Za-z0-9!#$%&'*+.^_|~-]+):[ \t]*([^\r\n]*)$/u.exec(
          value,
        );
        const name = header?.[1];
        const content = header?.[2];
        if (name === undefined || content === undefined)
          throw Error('请求头须采用名称和值的格式。');
        if (
          restrictedField(name) ||
          secretValue.test(content) ||
          /^(?:host|content-length|transfer-encoding)$/iu.test(name)
        )
          throw Error('请求头含敏感或由平台控制的字段。');
        headers.push({ name, value: content });
        break;
      }
      default:
        if (data !== undefined || value.startsWith('@'))
          throw Error('仅支持一份内联请求体，无法读取文件。');
        data = value;
    }
  }
  if (!address || sourceLinkUnavailableReason(address))
    throw Error('请使用不带认证信息的 HTTP(S) 地址。');
  const url = new URL(address);
  if (url.hash || url.pathname.startsWith('//'))
    throw Error('地址须有可安全带入的相对路径，且不能包含片段。');
  const verb = httpMethodSchema.safeParse(
    method ?? (data === undefined ? 'GET' : 'POST'),
  );
  if (
    !verb.success ||
    (data !== undefined && (verb.data === 'GET' || verb.data === 'HEAD'))
  )
    throw Error('当前 HTTP 方法或请求体组合不受支持。');
  const request: DraftRequest = {
    ...newRequest(),
    name: '导入请求',
    method: verb.data,
    url: url.pathname,
    query: queryValues(url.searchParams),
    headers,
  };
  if (data === undefined) return request;
  const media =
    headers
      .find(({ name }) => name.toLowerCase() === 'content-type')
      ?.value.toLowerCase() ?? '';
  if (media.includes('json') || (!media && /^[\[{]/u.test(data.trim()))) {
    let parsed: z.infer<ReturnType<typeof z.json>>;
    try {
      const input: unknown = JSON.parse(data);
      parsed = z.json().parse(input);
    } catch {
      throw Error('内联 JSON 请求体格式无效。');
    }
    assertSafeJson(parsed);
    return {
      ...request,
      body: { format: 'json', value: parsed },
      bodyText: JSON.stringify(parsed, null, 2),
    };
  }
  if ((media.includes('x-www-form-urlencoded') || !media) && data.includes('='))
    return {
      ...request,
      body: { format: 'form', fields: queryValues(new URLSearchParams(data)) },
    };
  throw Error(
    'cURL 导入支持内联 JSON 和 URL 编码表单。其他类型可在工作台配置。',
  );
}

function scanCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let content = '';
  let quoted = false;
  let closed = false;
  for (let position = 0; position < text.length; position += 1) {
    const character = text.charAt(position);
    if (quoted) {
      if (character === '"' && text.charAt(position + 1) === '"') {
        content += '"';
        position += 1;
      } else if (character === '"') {
        quoted = false;
        closed = true;
      } else content += character;
      continue;
    }
    if (character === ',' || character === '\r' || character === '\n') {
      row.push(content);
      content = '';
      closed = false;
      if (character !== ',') {
        if (row.some((field) => field.trim())) rows.push(row);
        row = [];
        if (character === '\r' && text.charAt(position + 1) === '\n')
          position += 1;
      }
    } else if (character === '"' && !content && !closed) quoted = true;
    else if (closed || character === '"') throw Error('CSV 的引号位置无效。');
    else content += character;
  }
  if (quoted) throw Error('CSV 的引号未闭合。');
  row.push(content);
  if (row.some((field) => field.trim())) rows.push(row);
  return rows;
}

const importRowSchema = z.strictObject({
  id: apiDataRowSchema.shape.id.optional(),
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().optional(),
  values: z.record(variableNameSchema, z.json()),
});
type ApiImportRow = z.output<typeof importRowSchema>;
type AuthoredApiRow = z.output<typeof apiDataRowSchema>;
export type ApiImportChoice = {
  action: 'keep' | 'replace' | 'add';
  existingId?: string | undefined;
  name: string;
};
export type ApiImportMapping = Record<string, string>;

export function parseApiDataImport(text: string) {
  const input = text.replace(/^\uFEFF/u, '').trim();
  if (!input || input.length > 30000)
    throw Error('请输入不超过 30000 字符的 CSV 或 JSON。');
  const json = input.startsWith('[') || input.startsWith('{');
  let raw: unknown;
  if (json) {
    try {
      raw = JSON.parse(input) as unknown;
    } catch {
      throw Error('JSON 格式无效。');
    }
  } else {
    const rows = scanCsv(input);
    const columns = rows.shift()?.map((name) => name.trim()) ?? [];
    const enabledAt = columns.indexOf('@enabled');
    const idAt = columns.indexOf('@id');
    const variables = columns.flatMap((name, at) =>
      at !== 0 && at !== enabledAt && at !== idAt ? [{ name, at }] : [],
    );
    if (columns[0] !== 'name' || new Set(columns).size !== columns.length)
      throw Error(
        'CSV 首列须为 name，可选 @id 和 @enabled，其余列填写不同的变量名。',
      );
    raw = rows.map((values, index) => {
      if (values.length !== columns.length)
        throw Error('CSV 第 ' + (index + 2) + ' 行的列数和表头不符。');
      const enabled =
        enabledAt < 0 ? undefined : values[enabledAt]?.trim().toLowerCase();
      const id = idAt < 0 ? undefined : values[idAt]?.trim();
      if (enabled !== undefined && enabled !== 'true' && enabled !== 'false')
        throw Error(
          'CSV 第 ' + (index + 2) + ' 行 @enabled 须为 true 或 false。',
        );
      return {
        name: values[0],
        ...(id && { id }),
        ...(enabled !== undefined && { enabled: enabled === 'true' }),
        values: Object.fromEntries(
          variables.map(({ name, at }) => [name, values[at]]),
        ),
      };
    });
  }
  const parsed = z.array(importRowSchema).min(1).max(100).safeParse(raw);
  if (!parsed.success)
    throw Error(
      '数据需为非空行数组，每行包含 name、values，可选 enabled 布尔值。',
    );
  const seen = new Set<string>();
  for (const row of parsed.data) {
    const key = row.id ? 'id:' + row.id : 'name:' + row.name;
    if (seen.has(key))
      throw Error('导入文件内有重复的行标识，请修改后再预览。');
    seen.add(key);
    if (secretValue.test(row.name)) throw Error('数据行名称含疑似认证信息。');
    assertSafeJson(row.values);
  }
  return {
    format: json ? 'JSON' : 'CSV',
    rows: parsed.data,
    sourceKeys: [
      ...new Set(parsed.data.flatMap((row) => Object.keys(row.values))),
    ],
  };
}

export function apiImportMatches(
  row: ApiImportRow,
  existing: readonly AuthoredApiRow[],
) {
  const byId = row.id && existing.find((item) => item.id === row.id);
  return byId ? [byId] : existing.filter((item) => item.name === row.name);
}

export function defaultApiImportChoices(
  incoming: readonly ApiImportRow[],
  existing: readonly AuthoredApiRow[],
): ApiImportChoice[] {
  const names = new Set(existing.map((row) => row.name));
  return incoming.map((row) => {
    const candidates = apiImportMatches(row, existing);
    let name = row.name;
    if (names.has(name)) {
      const base = name.slice(0, 100);
      name = base + '（导入副本）';
      for (let suffix = 2; names.has(name); suffix++)
        name = base + '（导入副本 ' + suffix + '）';
    }
    names.add(name);
    return {
      action: candidates.length ? 'keep' : 'add',
      ...(candidates.length === 1 && { existingId: candidates[0]?.id }),
      name,
    };
  });
}

export function applyApiDataImport(
  existing: readonly AuthoredApiRow[],
  incoming: readonly ApiImportRow[],
  mapping: ApiImportMapping,
  choices: readonly ApiImportChoice[],
): AuthoredApiRow[] {
  if (incoming.length !== choices.length) throw Error('导入选择与预览不一致。');
  const result = [...existing];
  const names = new Set(existing.map((row) => row.name));
  const overwritten = new Set<string>();
  const fields = new Map<string, string>();
  const targets = new Set<string>();
  for (const [source, field] of Object.entries(mapping)) {
    const target = field.trim();
    if (!target) continue;
    if (
      !variableNameSchema.safeParse(target).success ||
      restrictedField(target)
    )
      throw Error('无效的目标变量名：' + target);
    if (targets.has(target))
      throw Error('多个源变量不能映射到同一目标：' + target);
    targets.add(target);
    fields.set(source, target);
  }
  for (const [index, row] of incoming.entries()) {
    const choice = choices[index];
    if (!choice || choice.action === 'keep') continue;
    const values = Object.fromEntries(
      Object.entries(row.values).flatMap(([field, value]) => {
        const target = fields.get(field);
        return target ? [[target, value]] : [];
      }),
    );
    if (choice.action === 'replace') {
      const prior = apiImportMatches(row, existing).find(
        (candidate) => candidate.id === choice.existingId,
      );
      if (!prior)
        throw Error('第 ' + (index + 1) + ' 行的目标数据行已变化或尚未选择。');
      if (overwritten.has(prior.id))
        throw Error('多个导入项不能替换同一个现有数据行。');
      overwritten.add(prior.id);
      const replacement = apiDataRowSchema.parse({
        ...prior,
        ...(row.enabled !== undefined && { enabled: row.enabled }),
        values: { ...prior.values, ...values },
      });
      const targetIndex = result.findIndex((item) => item.id === prior.id);
      if (targetIndex < 0) throw Error('找不到所选原数据行。');
      result[targetIndex] = replacement;
    } else {
      const name = choice.name.trim();
      if (names.has(name)) throw Error('新增数据行名称重复：' + name);
      names.add(name);
      result.push(
        apiDataRowSchema.parse({
          id: crypto.randomUUID(),
          name,
          ...(row.enabled !== undefined && { enabled: row.enabled }),
          values,
        }),
      );
    }
  }
  if (result.length > 100) throw Error('导入后最多保留 100 个数据行。');
  return result;
}

export function exportApiDataRows(
  rows: readonly z.output<typeof importRowSchema>[],
  format: 'JSON' | 'CSV',
) {
  if (format === 'JSON')
    return JSON.stringify(
      rows.map(({ id, name, enabled, values }) => ({
        ...(id && { id }),
        name,
        enabled: enabled !== false,
        values,
      })),
      null,
      2,
    );
  const names = [...new Set(rows.flatMap((row) => Object.keys(row.values)))];
  const escape = (value: string) => '"' + value.replaceAll('"', '""') + '"';
  return [
    ['name', '@id', '@enabled', ...names],
    ...rows.map((row) => [
      row.name,
      row.id ?? '',
      row.enabled === false ? 'false' : 'true',
      ...names.map((name) => {
        const value = row.values[name];
        return typeof value === 'string'
          ? value
          : value === undefined
            ? ''
            : JSON.stringify(value);
      }),
    ]),
  ]
    .map((cells) => cells.map(escape).join(','))
    .join('\r\n');
}
