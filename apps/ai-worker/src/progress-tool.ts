import { tool } from 'langchain';
import { z } from 'zod';
import { aiProgressPayloadSchema } from '../../../packages/contracts/src/ai-presentation.js';
import { assertSafeModelInput } from '../../../packages/application/src/security/model-input.js';

export const AI_PROGRESS_TOOL_NAME = 'ath_update_plan';

/** A bounded display-only plan. No business mutation or additional capability. */
export function createProgressTool(options: {
  assertActive: () => Promise<void>;
  emit: (event: z.infer<typeof aiProgressPayloadSchema>) => void;
}) {
  return tool(
    async ({ plan, explanation }) => {
      await options.assertActive();
      const event = aiProgressPayloadSchema.parse({
        type: 'progress',
        items: plan.map((item, index) => ({
          id: `step-${index + 1}`,
          ...item,
        })),
        explanation: explanation ?? null,
      });
      assertSafeModelInput(JSON.stringify(event));
      options.emit(event);
      return JSON.stringify({
        recorded: true,
        plan: event.items,
        notice:
          '已记录AI声明的计划状态；业务成功仍以实际工具回执为准，不授予批准或执行权限。',
      });
    },
    {
      name: AI_PROGRESS_TOOL_NAME,
      description:
        '为复杂多步工作发布或完整更新真实计划；仅展示，不执行业务。plan包含全部步骤，状态pending/in_progress/completed，同时最多一项in_progress。只按实际已完成的工作更新，不假造百分比；等待人工决定的业务不得标为已执行成功。简单问题无需计划。',
      schema: z.strictObject({
        explanation: z.string().max(1000).optional(),
        plan: z
          .array(
            z.strictObject({
              step: z.string().trim().min(1).max(300),
              status: z.enum(['pending', 'in_progress', 'completed']),
            }),
          )
          .min(1)
          .max(20),
      }),
    },
  );
}
