import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  SHARED_SKILL_RULE_TOOL_NAME,
  type SharedSkillRuleReadMetadata,
  type SharedSkillRuleSnapshot,
} from './types.js';
import type { SharedSkillRuleRegistry } from './registry.js';

export const sharedSkillRulesReadInputSchema = z.discriminatedUnion('skillId', [
  z.strictObject({
    skillId: z.literal('ath-case-design'),
    section: z.enum([
      'entry',
      'business-rules',
      'coverage',
      'contracts',
      'review',
      'platform-adapter',
    ]),
  }),
  z.strictObject({
    skillId: z.literal('ath-project-knowledge'),
    section: z.enum([
      'entry',
      'content-and-sources',
      'platform-workflow',
      'runtime',
    ]),
  }),
  z.strictObject({
    skillId: z.literal('ath-api-regression'),
    section: z.enum([
      'entry',
      'generation',
      'native-api',
      'maintenance-and-recovery',
      'platform-debug',
      'platform-adapter',
    ]),
  }),
]);

/** Host-local only: never register this in the official MCP or business tool registry. */
export function createSharedSkillRulesTool(options: {
  registry: SharedSkillRuleRegistry;
  snapshot: SharedSkillRuleSnapshot;
  authorize: () => Promise<void>;
  onReceipt?: (receipt: SharedSkillRuleReadMetadata) => Promise<void>;
}) {
  // Capture independent metadata once, so a mutable host variable cannot switch an in-flight task's release.
  const snapshot = structuredClone(options.snapshot);
  return tool(
    async (input) => {
      await options.authorize();
      const receipt = options.registry.read(snapshot, input);
      const metadata: SharedSkillRuleReadMetadata =
        receipt.status === 'loaded'
          ? (({ text: _text, ...rest }) => rest)(receipt)
          : receipt;
      await options.onReceipt?.(metadata);
      return JSON.stringify(receipt);
    },
    {
      name: SHARED_SKILL_RULE_TOOL_NAME,
      description:
        '读取当前任务已固定版本的用例设计、项目知识或接口自动化 Skill 指引 section。仅静态规则；不是业务操作、文件读取或权限授予。先读 entry，按需读取相关 section。',
      schema: sharedSkillRulesReadInputSchema,
    },
  );
}
