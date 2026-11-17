import { randomUUID } from 'node:crypto';
import { tool } from 'langchain';
import { agentContextToolInputSchema } from '../../../packages/contracts/src/agent-context.js';
import type { ActorContext } from '../../../packages/contracts/src/identity.js';
import type { AgentContextService } from '../../../packages/application/src/agent-context/service.js';
import type { AiHostEvent } from './host.js';
import { DomainError } from '../../../packages/application/src/errors.js';

export function createAgentContextTool(
  context: AgentContextService,
  actor: ActorContext,
  emit: (event: AiHostEvent) => void,
) {
  return tool(
    async (input) => {
      const invocationId = randomUUID();
      emit({
        type: 'tool',
        name: 'ath_task_context',
        invocationId,
        state: 'started',
      });
      try {
        const result =
          input.action === 'read'
            ? await context.readPlan(actor)
            : input.action === 'update'
              ? await context.updatePlan(actor, {
                  rowVersion: input.rowVersion,
                  plan: input.plan,
                })
              : await context.readHistory(actor, {
                  recordId: input.recordId,
                  offset: input.offset,
                  limit: input.limit,
                });
        emit({
          type: 'tool',
          name: 'ath_task_context',
          invocationId,
          state: 'completed',
          sourceRefs: [],
        });
        return JSON.stringify(result);
      } catch (error: unknown) {
        emit({
          type: 'tool',
          name: 'ath_task_context',
          invocationId,
          state: 'failed',
        });
        return JSON.stringify({
          ok: false,
          code:
            error instanceof DomainError
              ? error.code
              : 'DEPENDENCY_UNAVAILABLE',
          message:
            error instanceof DomainError
              ? error.message
              : '任务上下文暂不可读。',
        });
      }
    },
    {
      name: 'ath_task_context',
      schema: agentContextToolInputSchema,
      description:
        '保存和读取本会话复杂任务的明确目标、决定及工作项；完成项须引用真实工具回执（仅传输完成，不等同业务验收或批准）。read_history按摘要给出的recordId分页读回授权原文；摘要为摘录，绝不把unknown/失败任务重放。计划不是自动执行队列。',
    },
  );
}
