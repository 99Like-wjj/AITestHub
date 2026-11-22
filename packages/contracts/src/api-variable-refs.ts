import type { ApiCaseContent } from './domain.js';

type VariableContent = Pick<ApiCaseContent, 'steps' | 'variables' | 'cleanup'>;
type Request = VariableContent['steps'][number];
type Path = (string | number)[];
export interface ApiVariableIssue {
  path: Path;
  message: string;
  unresolvedPreparationVariable?: true;
}

// The environment configuration allows hyphens in public keys and base URL names.
export const apiPlaceholderPattern = () =>
  /\{\{([A-Za-z_][A-Za-z0-9_.-]*(?:\[\d+\][A-Za-z0-9_.-]*)*)\}\}/g;

export function readApiPath(value: unknown, path: string): unknown {
  const segments = path
    .replace(/^\$\.?/, '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let current = value;
  for (const segment of segments) {
    if (
      ['__proto__', 'prototype', 'constructor'].includes(segment) ||
      current === null ||
      typeof current !== 'object' ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    )
      return undefined;
    current = Reflect.get(current, segment);
  }
  return current;
}

export function apiTemplateReferences(value: unknown): string[] {
  if (typeof value === 'string')
    return [...value.matchAll(apiPlaceholderPattern())].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    );
  if (Array.isArray(value)) return value.flatMap(apiTemplateReferences);
  if (value && typeof value === 'object')
    return Object.values(value).flatMap(apiTemplateReferences);
  return [];
}

function requestTemplateFields(request: Request) {
  const fields: { value: unknown; path: Path }[] = [
    { value: request.url, path: ['url'] },
  ];
  for (const key of ['query', 'headers'] as const)
    request[key].forEach((entry, index) =>
      fields.push({ value: entry.value, path: [key, index, 'value'] }),
    );
  if (request.body.format === 'json' || request.body.format === 'text')
    fields.push({ value: request.body.value, path: ['body', 'value'] });
  else if (request.body.format === 'form')
    request.body.fields.forEach((entry, index) =>
      fields.push({
        value: entry.value,
        path: ['body', 'fields', index, 'value'],
      }),
    );
  else if (request.body.format === 'multipart')
    request.body.parts.forEach((entry, index) => {
      if (entry.kind === 'text')
        fields.push({ value: entry.value, path: ['body', 'parts', index, 'value'] });
    });
  request.assertions.forEach((entry, index) =>
    fields.push({
      value: entry.expected,
      path: ['assertions', index, 'expected'],
    }),
  );
  return fields;
}

export function apiRequestVariableReferences(
  request: Request | undefined,
): string[] {
  return request
    ? requestTemplateFields(request).flatMap((field) =>
        apiTemplateReferences(field.value),
      )
    : [];
}

export function apiVariableIssues(
  content: VariableContent,
  environment?: Record<string, unknown>,
): ApiVariableIssue[] {
  const requests: { request: Request; position: number; path: Path }[] =
    content.steps.map((request, position) => ({
      request,
      position,
      path: ['steps', position],
    }));
  const cleanup = content.cleanup.mode === 'none' ? [] : content.cleanup.steps;
  cleanup.forEach((step, index) => {
    if (step.type === 'http')
      requests.push({
        request: step.request,
        position: content.steps.length + index,
        path: ['cleanup', 'steps', index, 'request'],
      });
  });
  const issues: ApiVariableIssue[] = [];
  const producers = new Map<string, number>();
  for (const { request, position, path } of requests)
    request.extractors.forEach((extractor, index) => {
      if (extractor.sensitive && extractor.source === 'status')
        issues.push({
          path: [...path, 'extractors', index, 'source'],
          message: 'HTTP 状态为数字，敏感提取须选择返回文本的来源。',
        });
      if (producers.has(extractor.name)) {
        issues.push({
          path: [...path, 'extractors', index, 'name'],
          message: `提取变量 ${extractor.name} 已在本用例声明，须使用唯一名称。`,
        });
      } else producers.set(extractor.name, position);
    });
  function check(
    reference: string,
    position: number,
    path: Path,
    allowAuth: boolean,
  ) {
    const [scope, key] = reference.split(/[.\[]/, 2);
    const rest = scope ? reference.slice(scope.length + 1) : '';
    let message: string | undefined;
    let unresolvedPreparationVariable = false;
    if (!key) message = `变量 ${reference} 缺少字段路径。`;
    else if (scope === 'env') {
      if (environment && readApiPath(environment, rest) === undefined)
        message = `所选环境没有定义 ${reference}。`;
    } else if (scope === 'case') {
      // Scripts can change values in a run, but the use case declares their names.
      if (!Object.prototype.hasOwnProperty.call(content.variables, key)) {
        message = `用例没有定义 ${reference}，请先声明变量。`;
        unresolvedPreparationVariable = true;
      }
    } else if (scope === 'extract') {
      const producer = producers.get(key);
      if (producer === undefined) {
        message = `没有步骤提取 ${reference}。`;
        unresolvedPreparationVariable = true;
      } else if (producer >= position)
        message = `${reference} 尚未产生，请将提取放到前置步骤。`;
    } else if (!(scope === 'auth' && allowAuth))
      message = `此处不支持引用 ${reference}。`;
    if (message)
      issues.push({
        path,
        message,
        ...(unresolvedPreparationVariable
          ? { unresolvedPreparationVariable: true as const }
          : {}),
      });
  }
  const inspect = (value: unknown, position: number, path: Path) => {
    for (const reference of new Set(apiTemplateReferences(value)))
      check(reference, position, path, true);
  };
  for (const { request, position, path } of requests) {
    for (const field of requestTemplateFields(request))
      inspect(field.value, position, [...path, ...field.path]);
    request.assertions.forEach((assertion, index) => {
      if (assertion.source !== 'variable' || !assertion.path) return;
      const location = [...path, 'assertions', index, 'path'];
      if (!/^(case|extract)\./.test(assertion.path))
        issues.push({
          path: location,
          message: '变量断言路径须以 case 或 extract 开头。',
        });
      else check(assertion.path, position, location, false);
    });
  }
  cleanup.forEach((step, index) => {
    const path = ['cleanup', 'steps', index];
    const position = content.steps.length + index;
    step.requiredTargets.forEach((reference, target) =>
      check(reference, position, [...path, 'requiredTargets', target], false),
    );
    if (step.type === 'sql')
      step.parameters.forEach((parameter, at) =>
        check(
          parameter.valueRef,
          position,
          [...path, 'parameters', at, 'valueRef'],
          false,
        ),
      );
  });
  return issues;
}

/** The editor has declared snapshots, but the platform resolves their steps at execution preflight. */
export function apiAuthoringVariableIssues(
  content: ApiCaseContent,
  environment?: Record<string, unknown>,
  preparations?: Pick<ApiCaseContent, 'steps' | 'variables'>,
): ApiVariableIssue[] {
  const variables = { ...preparations?.variables, ...content.variables };
  const steps = preparations
    ? [...preparations.steps, ...content.steps]
    : content.steps;
  const variants = content.dataRows?.length
    ? content.dataRows.map((row, index) => ({
        variables: { ...variables, ...row.values },
        row: { index, name: row.name },
      }))
    : [{ variables, row: undefined }];
  const unique = new Map<string, ApiVariableIssue>();
  const deferred = !preparations && Boolean(content.preparations?.length);
  for (const variant of variants)
    for (const issue of apiVariableIssues(
      { ...content, steps, variables: variant.variables },
      environment,
    )) {
      if (deferred && issue.unresolvedPreparationVariable) continue;
      const candidate = variant.row
        ? {
            ...issue,
            path: ['dataRows', variant.row.index, ...issue.path],
            message: `数据行 ${variant.row.name}：${issue.message}`,
          }
        : issue;
      unique.set(
        JSON.stringify([candidate.path, candidate.message]),
        candidate,
      );
    }
  return [...unique.values()];
}
