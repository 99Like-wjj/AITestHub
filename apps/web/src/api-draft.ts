import { z } from 'zod';
import {
  apiCaseContentSchema,
  variableNameSchema,
} from '../../../packages/contracts/src/domain';
import { apiAuthoringVariableIssues } from '../../../packages/contracts/src/api-variable-refs';

export type ApiCase = z.infer<typeof apiCaseContentSchema>;
export type Request = ApiCase['steps'][number];
export type Assertion = Request['assertions'][number];
type DraftAssertion = Omit<Assertion, 'expected'> & { expectedText: string };
export type DraftRequest = Omit<Request, 'assertions'> & {
  bodyText: string;
  assertions: DraftAssertion[];
};
type CleanupStep = Exclude<
  ApiCase['cleanup'],
  { mode: 'none' }
>['steps'][number];
export type DraftCleanupStep =
  | (Omit<
      Extract<CleanupStep, { type: 'http' }>,
      'requiredTargets' | 'request'
    > & { requiredTargetsText: string; request: DraftRequest })
  | (Omit<Extract<CleanupStep, { type: 'sql' }>, 'requiredTargets'> & {
      requiredTargetsText: string;
    });
export interface ApiDraft {
  base: ApiCase;
  requests: DraftRequest[];
  variableEntries: { id: string; name: string; valueText: string }[];
  cleanupDraft: { mode: ApiCase['cleanup']['mode']; steps: DraftCleanupStep[] };
}
export const newRequest = (): DraftRequest => ({
  stepId: crypto.randomUUID(),
  name: '请求',
  method: 'GET',
  url: '',
  query: [],
  headers: [],
  body: { format: 'none' },
  bodyText: '',
  extractors: [],
  assertions: [],
});
export function draftRequestFromStep(step: Request): DraftRequest {
  return {
    ...step,
    bodyText:
      step.body.format === 'json'
        ? JSON.stringify(step.body.value, null, 2)
        : step.body.format === 'text'
          ? step.body.value
          : '',
    assertions: step.assertions.map(({ expected, ...assertion }) => ({
      ...assertion,
      expectedText: expected === undefined ? '' : JSON.stringify(expected),
    })),
  };
}
export function apiDraftFromContent(content: ApiCase): ApiDraft {
  return {
    base: content,
    requests: content.steps.map(draftRequestFromStep),
    variableEntries: Object.entries(content.variables).map(([name, value]) => ({
      id: crypto.randomUUID(),
      name,
      valueText: JSON.stringify(value),
    })),
    cleanupDraft: {
      mode: content.cleanup.mode,
      steps:
        content.cleanup.mode === 'none'
          ? []
          : content.cleanup.steps.map((step) =>
              step.type === 'http'
                ? {
                    ...step,
                    requiredTargetsText: step.requiredTargets.join('\n'),
                    request: draftRequestFromStep(step.request),
                  }
                : {
                    ...step,
                    requiredTargetsText: step.requiredTargets.join('\n'),
                  },
            ),
    },
  };
}
export function emptyApiDraft(scenarioId: string): ApiDraft {
  return {
    base: {
      kind: 'API',
      scenarioId,
      title: '',
      testPoint: '',
      preconditions: [],
      expected: '',
      basisRefs: [],
      dslVersion: 'ath.api-case.v1',
      variables: {},
      steps: [],
      cleanup: { mode: 'none' },
    },
    requests: [newRequest()],
    variableEntries: [],
    cleanupDraft: { mode: 'none', steps: [] },
  };
}
export function serializeRequest(
  request: DraftRequest,
  label: string,
): Request {
  const { bodyText, assertions, ...step } = request;
  let body = step.body;
  if (body.format === 'json') {
    try {
      body = { format: 'json', value: z.json().parse(JSON.parse(bodyText)) };
    } catch {
      throw new Error(`${label} 的 JSON Body 未填写完整，请修正后保存。`);
    }
  } else if (body.format === 'text') body = { ...body, value: bodyText };
  return {
    ...step,
    body,
    assertions: assertions.map((assertion, index) => {
      const { expectedText, ...rule } = assertion;
      if (rule.operator === 'exists') return rule;
      try {
        return { ...rule, expected: z.json().parse(JSON.parse(expectedText)) };
      } catch {
        throw new Error(
          `${label} 的断言 ${index + 1} 需要合法 JSON 预期值，如 200、"ok"、true。`,
        );
      }
    }),
  };
}
export function apiDraftContent(draft: ApiDraft): ApiCase {
  const names = new Set<string>();
  const entries = draft.variableEntries.map((entry, index) => {
    const parsedName = variableNameSchema.safeParse(entry.name);
    if (!parsedName.success)
      throw new Error(
        `用例变量 ${index + 1} 名称须以字母或下划线开头，只含字母、数字或下划线。`,
      );
    if (names.has(parsedName.data))
      throw new Error(`用例变量 ${entry.name} 重复，不能覆盖同名值。`);
    names.add(parsedName.data);
    try {
      return [
        parsedName.data,
        z.json().parse(JSON.parse(entry.valueText)),
      ] as const;
    } catch {
      throw new Error(
        `用例变量 ${entry.name} 需要合法 JSON 值；字符串须包含双引号。`,
      );
    }
  });
  const cleanup =
    draft.cleanupDraft.mode === 'none'
      ? { mode: 'none' as const }
      : {
          mode: draft.cleanupDraft.mode,
          steps: draft.cleanupDraft.steps.map((step, index) => {
            const { requiredTargetsText, ...base } = step;
            const requiredTargets = requiredTargetsText
              .split('\n')
              .map((value) => value.trim())
              .filter(Boolean);
            return base.type === 'http'
              ? {
                  ...base,
                  requiredTargets,
                  request: serializeRequest(
                    base.request,
                    `HTTP清理 ${index + 1}`,
                  ),
                }
              : { ...base, requiredTargets };
          }),
        };
  return apiCaseContentSchema.parse({
    ...draft.base,
    variables: Object.fromEntries(entries),
    steps: draft.requests.map((request, index) =>
      serializeRequest(request, `请求 ${index + 1}`),
    ),
    cleanup,
  });
}
export function serializeApiDraft(draft: ApiDraft): ApiCase {
  const input = apiDraftContent(draft);
  const invalid = apiAuthoringVariableIssues(input)[0];
  if (invalid) throw new Error(`${invalid.path.join('/')}：${invalid.message}`);
  return input;
}
