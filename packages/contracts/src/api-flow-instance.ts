import { z } from 'zod';
import { apiStageSourceSchema } from './api-stage-actions.js';
import { apiSharedScriptSourceSchema } from './api-shared-scripts.js';
import type { ApiFlowNode } from './domain.js';

export const maxApiFlowVisits = 1_000;
export const maxApiFlowDepth = 8;
export const apiDatabaseReadPrefix = 'db:';

export const apiFlowVisitSchema = z.strictObject({
  nodeId: z.string().min(1).max(200),
  iterations: z.array(z.number().int().min(0).max(99)).max(maxApiFlowDepth),
  decision: z.enum(['true', 'false']).optional(),
  count: z.number().int().min(0).max(100).optional(),
  stageSource: apiStageSourceSchema.optional(),
  sharedScriptSource: apiSharedScriptSourceSchema.optional(),
});
export const apiFlowTraceSchema = z.array(apiFlowVisitSchema).max(maxApiFlowVisits);
export type ApiFlowVisit = z.infer<typeof apiFlowVisitSchema>;

export function apiRequestInstanceId(stepId: string, iterations: readonly number[]) {
  return iterations.length ? `${stepId}~${iterations.join('.')}` : stepId;
}

type RequestNode = Extract<ApiFlowNode, { type: 'request' }>;

export function resolveApiRequestInstance(
  flow: readonly ApiFlowNode[],
  instanceId: string,
): { node: RequestNode; iterations: number[] } | undefined {
  const [stepId, stack, extra] = instanceId.split('~');
  if (!stepId || extra !== undefined || (stack !== undefined && !/^(0|[1-9][0-9]?)(\.(0|[1-9][0-9]?))*$/.test(stack)))
    return undefined;
  const iterations = stack === undefined ? [] : stack.split('.').map(Number);

  function locate(nodes: readonly ApiFlowNode[], depth: number): RequestNode | undefined {
    for (const node of nodes) {
      if (node.type === 'request') {
        if (node.stepId === stepId && depth === iterations.length) return node;
      } else if (node.type === 'group') {
        const found = locate(node.children, depth);
        if (found) return found;
      } else if (node.type === 'if') {
        const found = locate(node.whenTrue, depth) ?? locate(node.whenFalse, depth);
        if (found) return found;
      } else if (node.type === 'repeat' || node.type === 'forEach') {
        const index = iterations[depth];
        const limit = node.type === 'repeat' ? node.count : node.maxItems;
        if (index === undefined || index >= limit) continue;
        const found = locate(node.children, depth + 1);
        if (found) return found;
      }
    }
    return undefined;
  }

  const node = locate(flow, 0);
  return node ? { node, iterations } : undefined;
}

/** Matches a bounded traversal prefix against the frozen graph, including its loop instances. */
export function inspectApiFlowTrace(
  flow: readonly ApiFlowNode[],
  trace: readonly ApiFlowVisit[],
): { requests: string[]; complete: boolean } | undefined {
  let next = 0;
  const requests: string[] = [];
  type State = 'complete' | 'prefix' | 'invalid';
  function match(nodes: readonly ApiFlowNode[], iterations: readonly number[]): State {
    for (const node of nodes) {
      const entry = trace[next];
      if (!entry) return 'prefix';
      next++;
      if (entry.nodeId !== node.nodeId || entry.iterations.join('.') !== iterations.join('.'))
        return 'invalid';
      const stage = node.stageSource;
      const observed = entry.stageSource;
      if (Boolean(stage) !== Boolean(observed) || (stage && observed && (
        stage.phase !== observed.phase ||
        stage.kind !== observed.kind ||
        stage.projectId !== observed.projectId ||
        stage.providerId !== observed.providerId ||
        stage.title !== observed.title ||
        stage.revisionId !== observed.revisionId ||
        stage.rowVersion !== observed.rowVersion ||
        stage.actionId !== observed.actionId ||
        stage.requestStepId !== observed.requestStepId
      ))) return 'invalid';
      const script = node.type === 'script' ? node.sharedScriptSource : undefined;
      const observedScript = entry.sharedScriptSource;
      if (Boolean(script) !== Boolean(observedScript) || (script && observedScript && (
        script.projectId !== observedScript.projectId ||
        script.scriptId !== observedScript.scriptId ||
        script.scriptRevisionId !== observedScript.scriptRevisionId ||
        script.title !== observedScript.title
      ))) return 'invalid';
      if ((node.type === 'if') !== (entry.decision !== undefined) ||
          (node.type === 'forEach') !== (entry.count !== undefined))
        return 'invalid';
      let state: State = 'complete';
      switch (node.type) {
        case 'request':
          requests.push(apiRequestInstanceId(node.stepId, iterations));
          break;
        case 'databaseRead':
          requests.push(apiRequestInstanceId(apiDatabaseReadPrefix + node.nodeId, iterations));
          break;
        case 'group':
          state = match(node.children, iterations);
          break;
        case 'if':
          state = match(entry.decision === 'true' ? node.whenTrue : node.whenFalse, iterations);
          break;
        case 'repeat':
        case 'forEach': {
          const count = node.type === 'repeat' ? node.count : entry.count;
          const limit = node.type === 'repeat' ? node.count : node.maxItems;
          if (count === undefined || count < 0 || count > limit) return 'invalid';
          for (let index = 0; index < count; index++) {
            state = match(node.children, [...iterations, index]);
            if (state !== 'complete') break;
          }
          break;
        }
        case 'case':
        case 'sharedScript':
          return 'invalid';
      }
      if (state !== 'complete') return state;
    }
    return 'complete';
  }
  const state = match(flow, []);
  if (state === 'invalid' || next !== trace.length) return undefined;
  return { requests, complete: state === 'complete' };
}
