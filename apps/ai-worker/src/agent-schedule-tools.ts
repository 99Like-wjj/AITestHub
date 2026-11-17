import { randomUUID } from 'node:crypto';
import { tool } from 'langchain';
import { agentScheduleToolSchema } from '../../../packages/contracts/src/agent-schedules.js';
import type { ScheduledDraftTemplate } from '../../../packages/contracts/src/agent-schedules.js';
import type { ActorContext } from '../../../packages/contracts/src/identity.js';
import type { AgentScheduleService } from '../../../packages/application/src/agent-schedules/service.js';
import { DomainError } from '../../../packages/application/src/errors.js';
import { canonicalJson } from '../../../packages/application/src/operations/service.js';
import type { AiHostEvent } from './host.js';
import type { WorkspaceAccessMode } from '../../../packages/contracts/src/workspace-access.js';

export function createAgentScheduleTool(
  service: AgentScheduleService,
  actor: ActorContext,
  scope: {
    conversationId: string;
    taskId?: string;
    accessMode?: WorkspaceAccessMode;
    authorize: () => Promise<void>;
    modelSelection?: ScheduledDraftTemplate['modelSelection'];
  },
  emit: (event: AiHostEvent) => void,
) {
  return tool(
    async (input) => {
      const invocationId = randomUUID();
      emit({
        type: 'tool',
        name: 'ath_office_schedule',
        invocationId,
        state: 'started',
      });
      try {
        await scope.authorize();
        if (
          (input.action === 'create' || input.action === 'revise') &&
          input.conversationId !== scope.conversationId
        )
          throw new DomainError(
            'FORBIDDEN',
            '对话中的定时任务只能绑定当前会话；其他会话请在本人设置管理。',
            403,
          );
        let result: unknown;
        if (input.action === 'create' || input.action === 'revise') {
          if (
            input.kind !== 'reminder' &&
            (!scope.modelSelection ||
              canonicalJson(input.template?.modelSelection ?? null) !==
                canonicalJson(scope.modelSelection))
          )
            throw new DomainError(
              'PRECONDITIONS_MISSING',
              '对话创建的定时任务须保持本条用户已选的模型与参数；其他模型请在本人设置明确选择。',
              422,
            );
          if (
            input.kind === 'office' &&
            (!scope.accessMode ||
              !input.template ||
              !('accessMode' in input.template) ||
              input.template.accessMode !== scope.accessMode)
          )
            throw new DomainError(
              'FORBIDDEN',
              '定时办公任务须保持本条用户选择的访问模式。',
              403,
            );
        } else if (input.action !== 'list') {
          const selected = await service.detail(actor, input.id);
          if (selected.schedule.conversationId !== scope.conversationId)
            throw new DomainError(
              'FORBIDDEN',
              '当前对话只能管理本会话的定时任务。',
              403,
            );
        }
        if (input.action === 'list')
          result = {
            schedules: (await service.list(actor)).schedules.filter(
              (row) => row.conversationId === scope.conversationId,
            ),
          };
        else if (input.action === 'detail')
          result = await service.detail(actor, input.id);
        else if (input.action === 'create') {
          const { action, ...body } = input;
          void action;
          result = await service.create(
            actor,
            body,
            scope.taskId
              ? { taskId: scope.taskId, conversationId: scope.conversationId }
              : undefined,
          );
        } else if (input.action === 'revise') {
          const { action, id, ...body } = input;
          void action;
          result = await service.revise(
            actor,
            id,
            body,
            scope.taskId
              ? { taskId: scope.taskId, conversationId: scope.conversationId }
              : undefined,
          );
        } else
          result = await service.changeState(
            actor,
            input.id,
            input.action,
            { commandId: input.commandId, rowVersion: input.rowVersion },
            scope.taskId
              ? { taskId: scope.taskId, conversationId: scope.conversationId }
              : undefined,
          );
        emit({
          type: 'tool',
          name: 'ath_office_schedule',
          invocationId,
          state: 'completed',
          sourceRefs: [],
        });
        return JSON.stringify(result);
      } catch (error: unknown) {
        emit({
          type: 'tool',
          name: 'ath_office_schedule',
          invocationId,
          state: 'failed',
          ...(!(error instanceof DomainError) ? { unknownEffect: true } : {}),
        });
        return JSON.stringify({
          ok: false,
          code:
            error instanceof DomainError
              ? error.code
              : 'OPERATION_RESULT_UNKNOWN',
          message:
            error instanceof DomainError
              ? error.message
              : '定时操作回执未知，只查询原命令/计划，不重发。',
        });
      }
    },
    {
      name: 'ath_office_schedule',
      schema: agentScheduleToolSchema,
      description: `本人明确要求时创建/管理当前会话的提醒、定时草稿或办公任务。使用明确IANA时区和未来时间，漏点不补跑；模型任务须保存确切模型selection、资料范围及明确来源。draft物理禁用工具；office实际联网、读取资料、沙箱计算、生成会话私有Office文件及按A12规则提网页动作，不能平台业务写/审批/测试/外部MCP/递归计划。office accessMode只能保持当前可信值${JSON.stringify(scope.accessMode ?? null)}。先list/detail取得当前CAS再修改；unknown只查原命令。当前模型selection=${JSON.stringify(scope.modelSelection ?? null)}；不能改换。`,
    },
  );
}
