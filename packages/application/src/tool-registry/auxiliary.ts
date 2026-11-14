import type { ActorContext } from '../../../contracts/src/identity.js';
import { z } from 'zod';
import { idSchema, commandIdSchema } from '../../../contracts/src/base.js';
import {
  auxiliaryRequestInputSchema,
  auxiliarySourceInputSchema,
  type AuxiliaryRequestInput,
} from '../../../contracts/src/auxiliary.js';
import type { AuxiliaryService } from '../auxiliary/service.js';
import type { ConfirmationScope, BusinessToolRegistry } from './registry.js';
import { DomainError } from '../errors.js';
/** Explicit project analysis jobs. No personal conversation, model key, execution or approval port. */
export function registerAuxiliaryTools(
  registry: BusinessToolRegistry,
  auxiliary: AuxiliaryService,
) {
  const confirmation = async (
    actor: ActorContext,
    input: AuxiliaryRequestInput,
  ): Promise<ConfirmationScope | undefined> => {
    if (actor.entrypoint !== 'official-mcp') return undefined;
    const disclosure = await auxiliary.confirmationDisclosure(actor, input);
    return {
      reason: 'impact',
      summary: `允许本次已预检资料发送到 ${'schemaVersion' in disclosure.model ? disclosure.model.serviceName + ' / ' + disclosure.model.modelDisplayName + ' · ' + disclosure.model.protocol : disclosure.model.provider + ' / ' + disclosure.model.modelId}（配置修订${'schemaVersion' in disclosure.model ? disclosure.model.serviceRevision : disclosure.model.configRevision}）；${input.dataScope === 'syntheticPublicOnly' ? '声明为合成/公开资料' : '声明为已授权相关内部测试资料'}，结果仅为建议，不修改正式业务。`,
      scope: {
        purpose: input.purpose,
        dataScope: input.dataScope,
        ...disclosure,
      },
      links: [],
    };
  };
  const project = { projectId: idSchema };
  const lookup = auxiliaryRequestInputSchema.options[1].omit({
    purpose: true,
    projectId: true,
  });
  const sql = auxiliaryRequestInputSchema.options[2].omit({
    purpose: true,
    projectId: true,
  });
  const advice = auxiliaryRequestInputSchema.options[3].omit({
    purpose: true,
    projectId: true,
  });
  registry.add(
    'ath_requirements',
    '需求业务及明确触发的系统辅助语义候选；独立模型任务只产生建议，配置缺失时保留人工流程。',
    'semantic-candidates',
    z.strictObject({
      op: z.literal('semantic-candidates'),
      ...project,
      input: lookup,
    }),
    'write',
    (a, i) =>
      auxiliary.requestBusiness(a, {
        ...i.input,
        purpose: 'requirementLookup',
        projectId: i.projectId,
      }),
    (a, i) =>
      confirmation(a, {
        ...i.input,
        purpose: 'requirementLookup',
        projectId: i.projectId,
      }),
    false,
  );
  registry.add(
    'ath_assets',
    '独立UI/API权威资产；可明确请求既有修订SQL清理的辅助审核，不执行SQL、不批准。',
    'sql-review-request',
    z.strictObject({
      op: z.literal('sql-review-request'),
      ...project,
      input: sql,
    }),
    'write',
    (a, i) =>
      auxiliary.requestBusiness(a, {
        ...i.input,
        purpose: 'sqlReview',
        projectId: i.projectId,
      }),
    (a, i) =>
      confirmation(a, {
        ...i.input,
        purpose: 'sqlReview',
        projectId: i.projectId,
      }),
  );
  registry.add(
    'ath_issues',
    '正式缺陷及用户主动触发的严重程度/可能技术方向建议；结果不改缺陷状态、严重程度或责任。',
    'advice-request',
    z.strictObject({
      op: z.literal('advice-request'),
      ...project,
      input: advice,
    }),
    'write',
    (a, i) =>
      auxiliary.requestBusiness(a, {
        ...i.input,
        purpose: 'issueAdvice',
        projectId: i.projectId,
      }),
    (a, i) =>
      confirmation(a, {
        ...i.input,
        purpose: 'issueAdvice',
        projectId: i.projectId,
      }),
  );
  for (const [name, purpose] of [
    ['ath_requirements', 'requirementLookup'],
    ['ath_assets', 'sqlReview'],
    ['ath_issues', 'issueAdvice'],
  ] as const) {
    const verify = (
      value: Awaited<ReturnType<AuxiliaryService['getBusiness']>>,
      projectId: string,
    ) => {
      if (
        value.task.source.projectId !== projectId ||
        value.task.purpose !== purpose
      )
        throw new DomainError('NOT_FOUND', '此业务范围没有该辅助任务。', 404);
      return value;
    };
    registry.add(
      name,
      '查看当前辅助资料与模型范围，不发送供应商请求。',
      'auxiliary-preflight',
      z.strictObject({
        op: z.literal('auxiliary-preflight'),
        ...project,
        source: z.union([
          auxiliarySourceInputSchema.options[1],
          auxiliarySourceInputSchema.options[2],
          auxiliarySourceInputSchema.options[3],
        ]),
      }),
      'read',
      async (a, i) => {
        if (i.source.purpose !== purpose || i.source.projectId !== i.projectId)
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '辅助资料须属于当前业务用途及项目。',
            409,
          );
        return auxiliary.preflight(a, { source: i.source }, true);
      },
      undefined,
      false,
    );
    registry.add(
      name,
      '只读取本人当前有权项目辅助任务，不读取个人会话或Key。',
      'auxiliary-status',
      z.strictObject({
        op: z.literal('auxiliary-status'),
        ...project,
        taskId: idSchema,
      }),
      'read',
      async (a, i) =>
        verify(await auxiliary.getBusiness(a, i.taskId), i.projectId),
      undefined,
      false,
    );
    registry.add(
      name,
      '按原command找回本人项目辅助回执；未知不重发。',
      'auxiliary-by-command',
      z.strictObject({
        op: z.literal('auxiliary-by-command'),
        ...project,
        commandId: commandIdSchema,
      }),
      'read',
      async (a, i) =>
        verify(await auxiliary.byCommandBusiness(a, i.commandId), i.projectId),
      undefined,
      false,
    );
  }
}
