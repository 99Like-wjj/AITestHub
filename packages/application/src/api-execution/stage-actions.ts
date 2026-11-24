import {
  apiNoStages,
  type ApiStageSettings,
  type ApiStageSource,
} from '../../../contracts/src/api-stage-actions.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { DomainError } from '../errors.js';
import { assertSafeModelInput } from '../security/model-input.js';
import { getApprovedApiDatabaseRead } from './database-reads.js';
import { requireApiSharedScriptRevision } from './shared-scripts.js';

export type StageProvider = {
  kind: ApiStageSource['kind'];
  projectId: string;
  id: string;
  title: string;
  revisionId?: string | undefined;
  rowVersion?: number | undefined;
  settings: ApiStageSettings;
};

/** Validate authored values before a revision can retain them. No query is executed. */
export async function requireValidStageSettings(
  tx: SqlExecutor,
  projectId: string,
  settings: ApiStageSettings,
): Promise<void> {
  try {
    assertSafeModelInput(settings);
  } catch {
    throw new DomainError(
      'VALIDATION_ERROR',
      '前后置动作含疑似明文凭据。',
      400,
    );
  }
  if (Buffer.byteLength(JSON.stringify(settings)) > 512 * 1024)
    throw new DomainError(
      'VALIDATION_ERROR',
      '该层前后置动作定义超过 512 KiB。',
      400,
    );
  for (const action of [...settings.pre, ...settings.post]) {
    if (action.type === 'sharedScript')
      await requireApiSharedScriptRevision(tx, projectId, action);
    if (action.type !== 'databaseRead') continue;
    const { definition } = await getApprovedApiDatabaseRead(
      tx,
      projectId,
      action.queryId,
    );
    const given = new Set(Object.keys(action.parameters));
    const expected = definition.filters.map(({ parameter }) => parameter);
    if (
      given.size !== expected.length ||
      expected.some((name) => !given.has(name))
    )
      throw new DomainError(
        'VALIDATION_ERROR',
        '前后置数据库观察参数与登记的查询参数不一致。',
        400,
      );
    if (
      ['__proto__', 'constructor', 'prototype'].includes(action.resultVariable)
    )
      throw new DomainError(
        'VALIDATION_ERROR',
        '数据库观察结果变量名不可修改对象原型。',
        400,
      );
  }
}

export function localStageSettings(
  settings: ApiStageSettings | undefined,
): ApiStageSettings {
  return settings ? { ...settings, suppress: [] } : apiNoStages;
}

export function applyStageSuppressions<T extends StageProvider>(
  providers: readonly T[],
  suppress: ApiStageSettings['suppress'],
  options: { missing?: 'report' | 'ignore'; encountered?: Set<string> } = {},
): T[] {
  let effective = [...providers];
  for (const rule of suppress) {
    const source = effective.find((item) => item.id === rule.providerId);
    const action =
      source &&
      [...source.settings.pre, ...source.settings.post].find(
        (item) => item.id === rule.actionId,
      );
    const key = stageSuppressionKey(rule);
    if (!action) {
      if (options.missing === 'ignore') continue;
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '所选继承动作已不存在，请重新选择覆盖范围。',
        422,
      );
    }
    if (!action.overridable)
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '该继承动作由上级锁定，不能停用。',
        409,
      );
    options.encountered?.add(key);
    effective = effective.map((provider) =>
      provider.id === rule.providerId
        ? {
            ...provider,
            settings: {
              ...provider.settings,
              pre: provider.settings.pre.map((item) =>
                item.id === rule.actionId ? { ...item, enabled: false } : item,
              ),
              post: provider.settings.post.map((item) =>
                item.id === rule.actionId ? { ...item, enabled: false } : item,
              ),
            },
          }
        : provider,
    );
  }
  return effective;
}

export function stageSuppressionKey(
  rule: ApiStageSettings['suppress'][number],
): string {
  return JSON.stringify([rule.providerId, rule.actionId]);
}
