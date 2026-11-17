import { randomUUID } from 'node:crypto';
import { tool } from 'langchain';
import { agentRepositoryInputSchema } from '../../../packages/contracts/src/agent-repository.js';
import type { ActorContext } from '../../../packages/contracts/src/identity.js';
import type { AgentRepositoryService } from '../../../packages/application/src/agent-repository/service.js';
import { DomainError } from '../../../packages/application/src/errors.js';
import type { AiHostEvent } from './host.js';
export function createAgentRepositoryTool(
  service: AgentRepositoryService,
  actor: ActorContext,
  scope: {
    authorizeResource: (id: string) => Promise<void>;
    signal?: AbortSignal;
  },
  emit: (event: AiHostEvent) => void,
) {
  return tool(
    async (input) => {
      const invocationId = randomUUID();
      emit({
        type: 'tool',
        name: 'ath_repository',
        invocationId,
        state: 'started',
      });
      try {
        const result = await service.read(actor, input, scope);
        emit({
          type: 'tool',
          name: 'ath_repository',
          invocationId,
          state: 'completed',
          sourceRefs: result.sourceRefs,
        });
        return JSON.stringify(result);
      } catch (error: unknown) {
        emit({
          type: 'tool',
          name: 'ath_repository',
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
              : '仓库快照未取得可用读取结果。',
        });
      }
    },
    {
      name: 'ath_repository',
      schema: agentRepositoryInputSchema,
      description:
        '只读分析明确附件resourceId的完整Git bundle仓库。先inspect实际refs及最多8个ref-tip的commits/parents元数据，使用真实完整SHA定位当前提交及其父提交；比较最近两提交时可用实际parents[0]作为baseCommit，不猜SHA。history按一个明确完整commit SHA读取其直接parents，需要更老提交可沿实际parent再读；根提交parents为空。然后tree/read按路径与行分页，diff比较两个实际固定提交。支持用户git bundle create repository.bundle --all生成并上传；不接宿主路径、远端仓库URL、凭据，不执行代码/hooks/checkout/子模块。二进制、增量bundle、不支持的对象算法或超过64个直接父提交会明确拒绝，未读范围不能假称通读。',
    },
  );
}
