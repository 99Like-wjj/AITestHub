import { randomUUID } from 'node:crypto';
import { tool } from 'langchain';
import { z } from 'zod';
import { agentOfficeToolInputSchema } from '../../../packages/contracts/src/agent-office.js';
import { calculationReceiptSchema } from '../../../packages/contracts/src/agent-calculation.js';
import type { ActorContext } from '../../../packages/contracts/src/identity.js';
import type { AgentCalculationScope } from '../../../packages/application/src/agent-calculation/service.js';
import type { AgentOfficeService } from '../../../packages/application/src/agent-office/service.js';
import { DomainError } from '../../../packages/application/src/errors.js';
import { assertSafeModelInput } from '../../../packages/application/src/security/model-input.js';
import type { AiHostEvent } from './host.js';

export function createAgentOfficeTool(
  service: AgentOfficeService,
  actor: ActorContext,
  scope: AgentCalculationScope,
  emit: (event: AiHostEvent) => void,
) {
  return tool(
    async (input) => {
      const invocationId = randomUUID();
      emit({
        type: 'tool',
        name: 'ath_office',
        invocationId,
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
          case 'create':
            result = await service.create(actor, scope, {
              commandId: input.commandId,
              output: input.output,
              document: input.document,
            });
            break;
          case 'edit':
            result = await service.edit(actor, scope, {
              commandId: input.commandId,
              source: input.source,
              output: input.output,
              edit: input.edit,
            });
            break;
          case 'inspect':
            result = await service.inspect(actor, scope, {
              commandId: input.commandId,
              source: input.source,
              format: input.format,
            });
            break;
          case 'status':
            result = await service.status(actor, scope, input.runId);
            break;
          case 'cancel':
            result = await service.cancel(actor, scope, input.runId);
            break;
        }
        const receipt = z
          .object({ calculation: calculationReceiptSchema })
          .safeParse(result);
        const unknown =
          receipt.success && receipt.data.calculation.state === 'unknown';
        const validation = z
          .object({ validationState: z.string() })
          .safeParse(result);
        const failed =
          (validation.success &&
            validation.data.validationState === 'failed') ||
          (receipt.success &&
            [
              'execution_failed',
              'cancelled',
              'artifact_conflict',
              'unknown',
            ].includes(receipt.data.calculation.state));
        assertSafeModelInput(result);
        emit({
          type: 'tool',
          name: 'ath_office',
          invocationId,
          state: failed ? 'failed' : 'completed',
          ...(unknown ? { unknownEffect: true } : {}),
          sourceRefs: receipt.success
            ? [
                ...new Set([
                  ...receipt.data.calculation.sources.map((s) => s.resourceId),
                  ...receipt.data.calculation.artifacts.map(
                    (a) => a.entry.resourceId,
                  ),
                ]),
              ].map((resourceId) => ({ kind: 'resource' as const, resourceId }))
            : [],
        });
        return JSON.stringify(result);
      } catch (error: unknown) {
        emit({
          type: 'tool',
          name: 'ath_office',
          invocationId,
          state: 'failed',
          ...(input.action !== 'files' &&
          (!(error instanceof DomainError) ||
            error.code === 'OPERATION_RESULT_UNKNOWN')
            ? { unknownEffect: true }
            : {}),
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
              : '办公文件没有取得真实执行回执。',
        });
      }
    },
    {
      name: 'ath_office',
      schema: agentOfficeToolInputSchema,
      description:
        '创建实际DOCX/XLSX/PPTX/中文PDF并保存会话文件。先files定位已受理附件：kind=original原件固定只读，edit读取原件后必须output另存新路径（expectedRowVersion=0）为独立成果，不能覆盖原件；继续修改kind=artifact成果使用当前路径和rowVersion追加版本。output.path保留用户指定的完整目录前缀，与沙箱内部artifact路径不同。create支持段落/表格、工作表值/公式/样式/图表、演示幻灯片。仅确实尚无entry的已授权附件才用ath_compute.import_resource按原resourceId导入，禁止从解析文字重建原件。edit局部改Word/PPT精确文本或Excel单元格，要求文本expectedOccurrences；未改OOXML part按hash保留，宏/签名/可执行嵌入不支持。PDF edit仅覆盖文字/追加页：覆盖不会删除底层文字，绝不能用于脱敏。inspect返回真实结构及公式缓存状态，公式不自动求值；会话文件可只读预览，复杂视觉布局仍需核对。复杂自定义处理可用ath_compute同一授权沙箱。status/cancel仅查/停原runId，未知结果不得重跑。',
    },
  );
}
