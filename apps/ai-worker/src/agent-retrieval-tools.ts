import { randomUUID } from 'node:crypto';
import { tool } from 'langchain';
import { retrievalSearchInputSchema } from '../../../packages/contracts/src/agent-retrieval.js';
import type { ActorContext } from '../../../packages/contracts/src/identity.js';
import type { AgentRetrievalService } from '../../../packages/application/src/agent-retrieval/service.js';
import type { RetrievalScope } from '../../../packages/application/src/agent-retrieval/sources.js';
import { DomainError } from '../../../packages/application/src/errors.js';
import type { AiHostEvent } from './host.js';

export function createAgentRetrievalTool(
  service: AgentRetrievalService,
  actor: ActorContext,
  scope: RetrievalScope,
  emit: (event: AiHostEvent) => void,
) {
  return tool(
    async (input) => {
      const invocationId = randomUUID();
      emit({
        type: 'tool',
        name: 'ath_semantic_search',
        invocationId,
        state: 'started',
      });
      try {
        const result = await service.search(actor, input, scope);
        emit({
          type: 'tool',
          name: 'ath_semantic_search',
          invocationId,
          state: 'completed',
          sourceRefs: result.sourceRefs,
        });
        return JSON.stringify(result);
      } catch (error: unknown) {
        emit({
          type: 'tool',
          name: 'ath_semantic_search',
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
              : '本地语义检索服务未取得完整可用结果。',
        });
      }
    },
    {
      name: 'ath_semantic_search',
      schema: retrievalSearchInputSchema,
      description:
        '在本条明确允许的附件、项目知识修订或本人选定历史messageIds中做真正的本地多语言语义检索，支持跨文档同义改写；不默认扫描整个项目/账号。返回R1等实际片段、原资源/知识版本/hash和page/line/paragraph/cell/slide/message位置。query是检索问题，sources必须是实际选定标识。source coverage揭示部分读取、512token截断和视觉未索引，扫描页/图片还要用文档/图像工具实际阅读。语义分值不是事实/批准或测试验收结论。',
    },
  );
}
