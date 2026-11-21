import {
  apiCaseContentSchema,
  type ApiCaseContent,
} from '../../../contracts/src/domain.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { DomainError } from '../errors.js';

export async function freezeApiCaseComposition(
  tx: SqlExecutor,
  projectId: string,
  authored: ApiCaseContent,
) {
  const { preparations = [], dataRows, ...main } = authored;
  const preparedVariables: ApiCaseContent['variables'][] = [];
  const steps: ApiCaseContent['steps'] = [];
  for (const [position, reference] of preparations.entries()) {
    const saved = (
      await tx.query<{ content: unknown }>(
        `SELECT r.content FROM app.asset_revisions r JOIN app.test_assets a ON a.id=r.asset_id
         WHERE a.project_id=$1 AND a.id=$2 AND r.id=$3 AND a.kind='API'
           AND a.target_type='case' AND a.removed_at IS NULL FOR SHARE OF a`,
        [projectId, reference.caseId, reference.revisionId],
      )
    ).rows[0];
    const prepared = apiCaseContentSchema.safeParse(saved?.content);
    if (!prepared.success)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        `准备步骤 ${position + 1} 的指定接口修订不可用。`,
        422,
      );
    if (prepared.data.preparations?.length)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        `准备步骤 ${position + 1} 必须引用可直接执行的接口用例。`,
        422,
      );
    preparedVariables.push(prepared.data.variables, reference.parameters);
    prepared.data.steps.forEach((step, index) =>
      steps.push({
        ...step,
        stepId: `prepare-${position + 1}-${index + 1}`,
        name: `准备 · ${step.name}`.slice(0, 200),
      }),
    );
  }
  const effective = apiCaseContentSchema.safeParse({
    ...main,
    steps: [...steps, ...main.steps],
    variables: Object.fromEntries(
      [...preparedVariables, main.variables].flatMap(Object.entries),
    ),
  });
  if (!effective.success)
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '准备与业务请求合并后超出步骤范围或标识不可用。',
      422,
    );
  return {
    content: effective.data,
    dataRows: dataRows ?? [],
    preparationSources: preparations.map(({ caseId, revisionId }) => ({
      caseId,
      revisionId,
    })),
  };
}

export function materializedApiRows(
  composition: Awaited<ReturnType<typeof freezeApiCaseComposition>>,
) {
  return composition.dataRows.length
    ? composition.dataRows.map(({ id, name, values }) => ({
        content: {
          ...composition.content,
          variables: { ...composition.content.variables, ...values },
        },
        dataRow: { id, name },
      }))
    : [{ content: composition.content, dataRow: undefined }];
}
