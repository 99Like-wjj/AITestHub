import { randomUUID } from 'node:crypto';
import { tool } from 'langchain';
import { z } from 'zod';
import {
  agentCalculationToolInputSchema,
  calculationReceiptSchema,
} from '../../../packages/contracts/src/agent-calculation.js';
import type { ActorContext } from '../../../packages/contracts/src/identity.js';
import type {
  AgentCalculationService,
  AgentCalculationScope,
} from '../../../packages/application/src/agent-calculation/service.js';
import { DomainError } from '../../../packages/application/src/errors.js';
import { assertSafeModelInput } from '../../../packages/application/src/security/model-input.js';
import type { AiHostEvent } from './host.js';

export function createAgentCalculationTool(
  service: AgentCalculationService,
  actor: ActorContext,
  scope: AgentCalculationScope,
  emit: (event: AiHostEvent) => void,
) {
  let importResultUnknown = false;
  return tool(
    async (input) => {
      const invocationId = randomUUID();
      emit({
        type: 'tool',
        invocationId,
        name: 'ath_compute',
        state: 'started',
      });
      try {
        await scope.authorize();
        let result: unknown;
        switch (input.action) {
          case 'files':
            result = await service.files(
              actor,
              scope,
              input.offset,
              input.limit,
            );
            break;
          case 'import_resource': {
            if (importResultUnknown)
              throw new DomainError(
                'OPERATION_RESULT_UNKNOWN',
                '本任务原导入结果尚待核对，未发起新导入；只能用原taskId和commandId查询，不能换命令重做。',
                409,
              );
            const { action, ...request } = input;
            void action;
            result = await service.importResource(actor, scope, request);
            break;
          }
          case 'import_status':
            result = await service.importStatus(
              actor,
              scope,
              input.commandId,
              input.originTaskId,
            );
            break;
          case 'run': {
            const { action, ...request } = input;
            void action;
            result = await service.run(actor, scope, request);
            break;
          }
          case 'status':
            result = await service.status(actor, scope, input.runId);
            break;
          case 'cancel':
            result = await service.cancel(actor, scope, input.runId);
            break;
          case 'read_output':
            result = await service.readOutput(
              actor,
              scope,
              input.runId,
              input.channel,
              input.offset,
              input.limit,
            );
            break;
        }
        const receipt = calculationReceiptSchema.safeParse(result);
        const output = z
          .object({ sourceResourceIds: z.array(z.uuid()) })
          .safeParse(result);
        const unknown = receipt.success && receipt.data.state === 'unknown';
        if (unknown) importResultUnknown = true;
        const failed =
          receipt.success &&
          [
            'execution_failed',
            'artifact_conflict',
            'cancelled',
            'unknown',
          ].includes(receipt.data.state);
        assertSafeModelInput(result);
        emit({
          type: 'tool',
          invocationId,
          name: 'ath_compute',
          state: failed ? 'failed' : 'completed',
          ...(unknown ? { unknownEffect: true } : {}),
          sourceRefs: receipt.success
            ? [
                ...new Set([
                  ...receipt.data.sources.map((source) => source.resourceId),
                  ...receipt.data.artifacts.map(
                    (artifact) => artifact.entry.resourceId,
                  ),
                ]),
              ].map((resourceId) => ({ kind: 'resource' as const, resourceId }))
            : output.success
              ? output.data.sourceResourceIds.map((resourceId) => ({
                  kind: 'resource' as const,
                  resourceId,
                }))
              : [],
        });
        return JSON.stringify(result);
      } catch (error: unknown) {
        if (
          (input.action === 'import_resource' || input.action === 'run') &&
          (!(error instanceof DomainError) ||
            error.code === 'OPERATION_RESULT_UNKNOWN')
        )
          importResultUnknown = true;
        emit({
          type: 'tool',
          invocationId,
          name: 'ath_compute',
          state: 'failed',
          ...((input.action === 'run' || input.action === 'import_resource') &&
          (!(error instanceof DomainError) ||
            error.code === 'OPERATION_RESULT_UNKNOWN')
            ? { unknownEffect: true }
            : {}),
        });
        return JSON.stringify({
          ok: false,
          errorCode:
            error instanceof DomainError
              ? error.code
              : input.action === 'import_resource'
                ? 'WORKSPACE_IMPORT_RESULT_UNKNOWN'
                : 'CALCULATION_RESULT_UNKNOWN',
          message:
            error instanceof DomainError
              ? error.message
              : input.action === 'import_resource'
                ? '导入结果不确定，请用import_status查询原commandId，不得换命令重新导入。'
                : '计算结果不确定，请查询原运行，不能自动重跑代码。',
          ...(input.action === 'import_resource' ||
          input.action === 'import_status'
            ? {
                commandId: input.commandId,
                taskId:
                  input.action === 'import_status'
                    ? (input.originTaskId ?? scope.taskId)
                    : scope.taskId,
              }
            : {}),
          automaticReplay: false,
        });
      }
    },
    {
      name: 'ath_compute',
      description:
        '真实Python沙箱计算、CSV/JSON数据分析及图表/文件产物。当前会话附件尚无工作区entry时，先import_resource按原resourceId和稳定commandId导入已授权原件，返回原ID/hash/bytes与entryId/revision，不从解析文本重建；import_status只查询原commandId，后续任务恢复须加原originTaskId，未找到不证明从未执行，未知禁止换命令重试。files列工作区文件；run显式绑定inputs沙箱相对path和outputs工作区workspacePath/预期版本。workspacePath是完整逻辑路径，保留用户指定的全部目录前缀，与沙箱内path分别指定；Python写新文件前须创建其父目录。Python可用decimal/csv/json/statistics等，标准库不保证额外第三方包。代码无网络、无宿主文件或平台凭据。使用Decimal处理金额，不能把代码文本或模型心算当已执行。结果含runId、实际执行状态、cleanup、真实文件hash和下载路径。计算未知/断线只能status/cancel原runId，禁止换commandId重跑；stdout/stderr较长用read_output分页。只在state=completed时宣称计算和全部指定产物已完成；不代表任务业务验收。',
      schema: agentCalculationToolInputSchema,
    },
  );
}
