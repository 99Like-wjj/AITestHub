import { setTimeout as wait } from 'node:timers/promises';
import {
  apiRequestInstanceId,
  maxApiFlowDepth,
  maxApiFlowVisits,
  type ApiFlowVisit,
} from '../../../packages/contracts/src/api-flow-instance.js';
import type { JsonValue } from '../../../packages/contracts/src/api-execution.js';
import type { ApiFlowNode } from '../../../packages/contracts/src/domain.js';
import {
  apiPlaceholderPattern,
  readApiPath,
} from '../../../packages/contracts/src/api-variable-refs.js';
import { canonicalJson } from '../../../packages/application/src/operations/service.js';
import { DomainError } from '../../../packages/application/src/errors.js';

type Branch = Extract<ApiFlowNode, { type: 'if' }>;
type Script = Extract<ApiFlowNode, { type: 'script' }>;
type DatabaseRead = Extract<ApiFlowNode, { type: 'databaseRead' }>;

interface ApiFlowRuntime {
  variables: Record<string, JsonValue>;
  context: () => unknown;
  assertLive: () => void;
  request: (stepId: string, instanceId: string) => Promise<boolean>;
  script: (node: Script, iterations: readonly number[]) => Promise<boolean>;
  databaseRead: (
    node: DatabaseRead,
    iterations: readonly number[],
  ) => Promise<boolean>;
  visit: (entry: ApiFlowVisit) => void;
  signal?: AbortSignal;
}

function fittedValue(context: unknown, expression: string) {
  const match = apiPlaceholderPattern().exec(expression);
  return readApiPath(
    context,
    match?.[0] === expression && match[1] ? match[1] : expression,
  );
}

function conditionMatches(
  condition: Branch['condition'],
  context: unknown,
): boolean {
  const left = fittedValue(context, condition.left);
  if (condition.operator === 'exists')
    return left !== undefined && left !== null;
  if (left === undefined)
    throw new DomainError('PRECONDITIONS_MISSING', '流程条件的输入缺失。', 422);
  const right = condition.right;
  switch (condition.operator) {
    case 'eq':
      return canonicalJson(left) === canonicalJson(right);
    case 'neq':
      return canonicalJson(left) !== canonicalJson(right);
    case 'contains':
      if (typeof left === 'string' && typeof right === 'string')
        return left.includes(right);
      if (Array.isArray(left))
        return left.some(
          (item) => canonicalJson(item) === canonicalJson(right),
        );
      return false;
    default:
      if (typeof left !== 'number' || typeof right !== 'number')
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '流程数值比较需要同类型数字。',
          422,
        );
      if (condition.operator === 'gt') return left > right;
      if (condition.operator === 'gte') return left >= right;
      if (condition.operator === 'lt') return left < right;
      return left <= right;
  }
}

async function withBindings(
  runtime: ApiFlowRuntime,
  bindings: Record<string, JsonValue>,
  work: () => Promise<boolean>,
) {
  const saved = Object.keys(bindings).map(
    (name) => [name, runtime.variables[name]] as const,
  );
  for (const [name, value] of Object.entries(bindings))
    runtime.variables[name] = value;
  try {
    return await work();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete runtime.variables[name];
      else runtime.variables[name] = value;
    }
  }
}

export async function executeApiFlow(
  flow: readonly ApiFlowNode[],
  runtime: ApiFlowRuntime,
) {
  let visits = 0;
  let waitBudgetMs = 60_000;
  const visited = (
    node: ApiFlowNode,
    iterations: readonly number[],
    values: Pick<ApiFlowVisit, 'decision' | 'count'> = {},
  ) => {
    if (++visits > maxApiFlowVisits)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '本轮超过场景节点执行预算。',
        422,
      );
    runtime.assertLive();
    runtime.visit({
      nodeId: node.nodeId,
      iterations: [...iterations],
      ...(node.stageSource ? { stageSource: node.stageSource } : {}),
      ...(node.type === 'script' && node.sharedScriptSource
        ? { sharedScriptSource: node.sharedScriptSource }
        : {}),
      ...values,
    });
  };

  async function walk(
    nodes: readonly ApiFlowNode[],
    iterations: readonly number[],
    depth: number,
  ): Promise<boolean> {
    if (depth > maxApiFlowDepth)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '场景层级超过运行限制。',
        422,
      );
    for (const node of nodes) {
      if (node.type === 'if') {
        const decision = conditionMatches(node.condition, runtime.context());
        visited(node, iterations, { decision: decision ? 'true' : 'false' });
        if (
          !(await walk(
            decision ? node.whenTrue : node.whenFalse,
            iterations,
            depth + 1,
          ))
        )
          return false;
        continue;
      }
      if (node.type !== 'forEach') visited(node, iterations);
      switch (node.type) {
        case 'request':
          if (
            !(await runtime.request(
              node.stepId,
              apiRequestInstanceId(node.stepId, iterations),
            ))
          )
            return false;
          break;
        case 'group': {
          const bindings =
            'variables' in node && node.variables ? node.variables : {};
          if (
            !(await withBindings(runtime, bindings, () =>
              walk(node.children, iterations, depth + 1),
            ))
          )
            return false;
          break;
        }
        case 'repeat':
          for (let index = 0; index < node.count; index++)
            if (
              !(await withBindings(
                runtime,
                { [node.indexVariable]: index },
                () => walk(node.children, [...iterations, index], depth + 1),
              ))
            )
              return false;
          break;
        case 'forEach': {
          const source = fittedValue(runtime.context(), node.source);
          if (!Array.isArray(source) || source.length > node.maxItems)
            throw new DomainError(
              'PRECONDITIONS_MISSING',
              '循环输入必须为有界数组。',
              422,
            );
          visited(node, iterations, { count: source.length });
          for (const [index, item] of source.entries())
            if (
              !(await withBindings(
                runtime,
                { [node.indexVariable]: index, [node.itemVariable]: item },
                () => walk(node.children, [...iterations, index], depth + 1),
              ))
            )
              return false;
          break;
        }
        case 'script':
          if (!(await runtime.script(node, iterations))) return false;
          break;
        case 'databaseRead':
          if (!(await runtime.databaseRead(node, iterations))) return false;
          break;
        case 'wait':
          waitBudgetMs -= node.milliseconds;
          if (waitBudgetMs < 0)
            throw new DomainError(
              'PRECONDITIONS_MISSING',
              '本轮超过等待时间预算。',
              422,
            );
          await wait(node.milliseconds, undefined, { signal: runtime.signal });
          break;
        case 'sharedScript':
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '引用共享脚本未冻结。',
            422,
          );
        case 'case':
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '引用场景未冻结。',
            422,
          );
      }
    }
    return true;
  }

  return walk(flow, [], 1);
}
