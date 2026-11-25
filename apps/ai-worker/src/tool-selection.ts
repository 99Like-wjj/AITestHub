import { randomUUID } from 'node:crypto';
import type { BindToolsInput } from '@langchain/core/language_models/chat_models';
import { tool } from 'langchain';
import { z } from 'zod';
import { SHARED_SKILL_RULE_TOOL_NAME } from '../../../packages/application/src/shared-skill-rules/index.js';
import { modelTools } from './adapter-model.js';
import type { AiHostEvent } from './host.js';
import { AI_PROGRESS_TOOL_NAME } from './progress-tool.js';

export const AI_TOOL_DISCOVERY_NAME = 'ath_tool_discovery';

const coreTools = [
  AI_TOOL_DISCOVERY_NAME,
  AI_PROGRESS_TOOL_NAME,
  'ath_projects_list',
  'ath_task_context',
];

// Cap the schemas supplied together, independently of each provider's token budget.
// A request for one unusually large schema still gets the ordinary model preflight.
const preferredSchemaBytes = 48 * 1024;
const additionalToolsLimit = 6;
const requestedToolsLimit = 3;
const catalogPageSize = 40;

const defaultTools = [
  'ath_reports',
  'ath_requirements',
  'ath_problems',
  'ath_issues',
];

const relatedTools = [
  {
    terms: /报告|报表|复盘|执行结果|测试结果|统计|\breports?\b|\bresults?\b/iu,
    names: ['ath_reports', 'ath_ui_executions', 'ath_problems'],
  },
  {
    terms: /需求|原型|\brequirements?\b/iu,
    names: [
      'ath_requirements',
      'ath_requirement_materials',
      'ath_document_read',
    ],
  },
  {
    terms:
      /用例|测点|测试点|评审|ath-case-design|\btest cases?\b|\breviews?\b/iu,
    names: ['ath_assets', 'ath_reviews'],
  },
  {
    terms: /回归|计划|接口测试|复测|ath-api|\btest plans?\b|\bretests?\b/iu,
    names: ['ath_plans', 'ath_ui_executions', 'ath_retests', 'ath_api_runs'],
  },
  {
    terms: /接口|编排|项目场景|ath-api|\bopenapi\b|\bapi\b|\bendpoints?\b/iu,
    names: ['ath_api_catalog', 'ath_api_automation', 'ath_api_runs'],
  },
  {
    terms: /缺陷|候选问题|待确认问题|bug\b|\bdefects?\b/iu,
    names: ['ath_issues', 'ath_problems', 'ath_issue_lifecycle'],
  },
  {
    terms: /知识库|知识条目|项目知识|ath-project-knowledge|\bknowledge\b/iu,
    names: ['ath_knowledge', 'ath_semantic_search', 'ath_knowledge_changes'],
  },
  {
    terms: /附件|文档|搜索|联网|网页|\battachments?\b|\bweb search\b/iu,
    names: ['ath_document_read', 'ath_public_search', 'ath_web_read'],
  },
  {
    terms: /代码|仓库|计算|表格|定时|\brepositor(?:y|ies)\b|\bschedules?\b/iu,
    names: [
      'ath_repository',
      'ath_compute',
      'ath_office',
      'ath_office_schedule',
    ],
  },
];

export function businessRoute(prompt: string): string[] {
  if (/平台管理员|全员|辅助模型|模型配置|外部MCP配置/iu.test(prompt))
    return ['ath_platform_admin'];
  if (/我的(?:草稿|对话|会话|通知|文件)|文件中心|私有工作台/iu.test(prompt))
    return ['ath_personal_workspace'];
  if (
    /我是谁|我(?:的|这个|当前)(?:账号|账户|用户|身份|显示名)|当前登录(?:账号|用户)|who am i/iu.test(
      prompt,
    )
  )
    return ['ath_identity'];
  if (
    /加入|添加|拉入|移出|退出|参与人|participants?/iu.test(prompt) &&
    /需求|requirement/iu.test(prompt)
  )
    return ['ath_requirement_membership', 'ath_requirements', 'ath_identity'];
  if (
    /审批|批准|评审通过|approve/iu.test(prompt) &&
    /用例|测试集|场景|case|评审/iu.test(prompt)
  )
    return ['ath_reviews', 'ath_assets', 'ath_requirements'];
  if (
    /评审|复审|review/iu.test(prompt) &&
    /用例|case|会议|meeting/iu.test(prompt)
  )
    return ['ath_reviews', 'ath_assets', 'ath_requirements'];
  return [];
}

export function needsSkill(prompt: string): boolean {
  return (
    /(?:^|[^a-z0-9-])\/(?:ath-case-design|ath-api-regression|ath-project-knowledge)(?=[\s\]]|$)/iu.test(
      prompt,
    ) ||
    /(?:生成|设计|编写|优化|整理).{0,16}(?:用例|测点|项目知识|接口自动化)|(?:用例|项目知识).{0,8}(?:生成|优化|整理)/iu.test(
      prompt,
    )
  );
}

interface ToolContext {
  prompts: readonly string[];
  referenceKinds: readonly string[];
  officeOnly: boolean;
}

type NamedTool = BindToolsInput & { name: string };

export function createModelToolSelection(
  availableNames: readonly string[],
  authorize: () => Promise<void>,
  emit: (event: AiHostEvent) => void,
) {
  const authorizedNames = new Set(availableNames);
  const requested = new Set<string>();
  const sizes = new WeakMap<NamedTool, number>();
  const discoveryQueries = new Set<string>();
  let discoveredInStep = false;
  let discoveryPaused = false;
  let currentNames: readonly string[] = [];
  let planNext: (() => Set<string>) | undefined;
  const discovery = tool(
    async ({ names, offset = 0 }) => {
      const invocationId = randomUUID();
      const event = {
        type: 'tool' as const,
        name: AI_TOOL_DISCOVERY_NAME,
        invocationId,
      };
      emit({ ...event, state: 'started' });
      try {
        await authorize();
        const distinctNames = names ? [...new Set(names)] : undefined;
        const queryKey = JSON.stringify([
          currentNames,
          distinctNames ?? offset,
        ]);
        const reply = (result: object) => {
          emit({ ...event, state: 'completed' });
          return JSON.stringify(result);
        };
        if (distinctNames && discoveredInStep)
          return reply({
            status: 'alreadyPlanned',
            instruction:
              'A request for definitions already set the next selection. Check the attached definitions on the next step.',
          });
        if (discoveryQueries.has(queryKey)) {
          discoveryPaused = true;
          return reply({
            status: 'alreadyAnswered',
            instruction:
              'This discovery already returned a result. Use a tool whose definition is attached, or finish with the information available.',
          });
        }
        discoveryQueries.add(queryKey);
        if (!distinctNames)
          return reply({
            availableTools: availableNames.slice(
              offset,
              offset + catalogPageSize,
            ),
            nextOffset:
              offset + catalogPageSize < availableNames.length
                ? offset + catalogPageSize
                : null,
            instruction:
              'This catalog lists eligible names. Only attached definitions can be called.',
          });
        discoveredInStep = true;
        const eligible = distinctNames.filter((name) =>
          authorizedNames.has(name),
        );
        for (const name of eligible) {
          requested.delete(name);
          requested.add(name);
        }
        while (requested.size > requestedToolsLimit) {
          const first = requested.values().next().value;
          if (first === undefined) break;
          requested.delete(first);
        }
        const next = planNext?.();
        return reply({
          selectedForNextStep: eligible.filter((name) => next?.has(name)),
          deferred: eligible.filter((name) => !next?.has(name)),
          unavailable: distinctNames.filter(
            (name) => !authorizedNames.has(name),
          ),
          instruction:
            'Use only attached definitions. For a deferred tool, request it alone if still needed. Do not repeat an unchanged discovery request.',
        });
      } catch (error) {
        emit({ ...event, state: 'failed' });
        throw error;
      }
    },
    {
      name: AI_TOOL_DISCOVERY_NAME,
      schema: z.strictObject({
        offset: z.number().int().min(0).max(1000).optional(),
        names: z
          .array(z.string().min(1).max(64))
          .min(1)
          .max(requestedToolsLimit)
          .optional(),
      }),
      description:
        'List eligible tool names (continue with nextOffset) or request up to 3 exact definitions once per model step. The reply separates selected, deferred, and unavailable tools. Use only tools with definitions attached to the current request. Existing permissions, write safety and human approvals still apply.',
    },
  );

  const size = (candidate: NamedTool) => {
    const cached = sizes.get(candidate);
    if (cached !== undefined) return cached;
    const bytes = Buffer.byteLength(JSON.stringify(modelTools([candidate])));
    sizes.set(candidate, bytes);
    return bytes;
  };

  return {
    discovery,
    recordAcceptedCalls(names: readonly string[]) {
      if (!names.some((name) => name !== AI_TOOL_DISCOVERY_NAME)) return;
      discoveryQueries.clear();
      discoveryPaused = false;
    },
    select<T extends NamedTool>(
      candidates: readonly T[],
      context: ToolContext,
    ) {
      const byName = new Map(
        candidates.map((candidate) => [candidate.name, candidate]),
      );
      const prompts = context.prompts.map((prompt) => prompt.slice(0, 4_000));
      const current = prompts[0] ?? '';
      const explicit = new Set(current.match(/\b(?:ath_|ext_)[\w-]+\b/g));
      const priorityActions = businessRoute(current);
      const matched = prompts.flatMap((prompt) =>
        relatedTools
          .filter(({ terms }) => terms.test(prompt))
          .flatMap(({ names }) => names),
      );
      const referenced = context.referenceKinds.flatMap((kind) => {
        if (kind === 'requirementVersion')
          return ['ath_requirements', 'ath_requirement_materials'];
        if (kind === 'knowledge')
          return ['ath_knowledge', 'ath_semantic_search'];
        if (kind === 'resource') return ['ath_document_read'];
        if (kind === 'externalMcpInvocation')
          return ['ath_external_mcp_status'];
        if (kind === 'externalMcpConnection')
          return candidates
            .filter((candidate) => candidate.name.startsWith('ext_'))
            .map((candidate) => candidate.name);
        return [];
      });
      const priorities = [
        ...priorityActions,
        ...explicit,
        ...(needsSkill(current) ? [SHARED_SKILL_RULE_TOOL_NAME] : []),
        ...referenced,
        ...matched,
        ...(context.officeOnly
          ? [
              'ath_office',
              'ath_document_read',
              'ath_public_search',
              'ath_compute',
              'ath_web_read',
            ]
          : defaultTools),
      ];
      planNext = () => {
        const selected = new Set(
          coreTools.filter(
            (name) =>
              byName.has(name) &&
              (name !== AI_TOOL_DISCOVERY_NAME || !discoveryPaused),
          ),
        );
        let bytes = candidates.reduce(
          (total, candidate) =>
            total + (selected.has(candidate.name) ? size(candidate) : 0),
          0,
        );
        let additionalCount = 0;
        for (const name of [...[...requested].reverse(), ...priorities]) {
          const candidate = byName.get(name);
          if (
            !candidate ||
            selected.has(name) ||
            name === AI_TOOL_DISCOVERY_NAME
          )
            continue;
          const total = bytes + size(candidate);
          if (
            total > preferredSchemaBytes &&
            !(
              (requested.has(name) || explicit.has(name)) &&
              additionalCount === 0
            )
          )
            continue;
          selected.add(name);
          bytes = total;
          if (++additionalCount === additionalToolsLimit) break;
        }
        return selected;
      };
      const selected = planNext();
      discoveredInStep = false;
      // Stable registration order keeps repeated schema prefixes reusable.
      const tools = candidates.filter((candidate) =>
        selected.has(candidate.name),
      );
      currentNames = tools.map((candidate) => candidate.name);
      return tools;
    },
  };
}
