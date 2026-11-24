import { createHash } from 'node:crypto';
import { apiPlaceholderPattern } from '../../../contracts/src/api-variable-refs.js';
import type { ApiSharedScriptReference } from '../../../contracts/src/api-shared-scripts.js';
import {
  apiCaseContentSchema,
  apiFlowNodes,
  apiRequestStepSchema,
  type ApiCaseContent,
  type ApiFlowNode,
} from '../../../contracts/src/domain.js';
import {
  apiNoStages,
  apiStageSettingsSchema,
  type ApiStageSettings,
} from '../../../contracts/src/api-stage-actions.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import {
  getApiProjectCase,
  validateInterfaceSources,
} from '../assets/api-automation.js';
import { requireApiInterfaceRevision } from '../api-catalog/service.js';
import { DomainError } from '../errors.js';
import { requireApiSharedScriptRevision } from './shared-scripts.js';
import {
  applyStageSuppressions,
  localStageSettings,
  requireValidStageSettings,
  stageSuppressionKey,
  type StageProvider,
} from './stage-actions.js';

const scopedId = (namespace: string, id: string) =>
  namespace
    ? `ref-${createHash('sha256').update(namespace).update('\0').update(id).digest('hex').slice(0, 28)}`
    : id;

function rewritePath(
  value: string,
  stepIds: ReadonlyMap<string, string>,
): string {
  if (!value.startsWith('steps.')) return value;
  for (const [before, after] of stepIds)
    if (value.startsWith(`steps.${before}.response.`))
      return `steps.${after}.${value.slice(before.length + 7)}`;
  return value;
}

function rewriteReferences(
  value: unknown,
  stepIds: ReadonlyMap<string, string>,
): unknown {
  if (typeof value === 'string')
    return value.replace(
      apiPlaceholderPattern(),
      (_, path: string) => `{{${rewritePath(path, stepIds)}}}`,
    );
  if (Array.isArray(value))
    return value.map((entry) => rewriteReferences(entry, stepIds));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        rewriteReferences(entry, stepIds),
      ]),
    );
  return value;
}

function rewriteCaseStages(
  settings: ApiStageSettings,
  ids: ReadonlyMap<string, string>,
): ApiStageSettings {
  return apiStageSettingsSchema.parse(rewriteReferences(settings, ids));
}

type Source = { projectId: string; caseId: string; revisionId: string };
type CaseContext = {
  caseId?: string | undefined;
  revisionId?: string | undefined;
};
type FrozenGraph = {
  pre: ApiFlowNode[];
  flow: ApiFlowNode[];
  post: ApiFlowNode[];
};
const graphNodes = ({ pre, flow, post }: FrozenGraph) => [
  ...pre,
  ...flow,
  ...post,
];
export async function freezeApiCaseComposition(
  tx: SqlExecutor,
  actor: ActorContext,
  projectId: string,
  authored: ApiCaseContent,
  authoredCaseId?: string,
  options: { caseRevisionId?: string | undefined; stepOnly?: boolean } = {},
) {
  const { preparations = [], dataRows, ...main } = authored;
  const preparedVariables: ApiCaseContent['variables'][] = [];
  const steps: ApiCaseContent['steps'] = [];
  const disabledNodeIds: string[] = [];
  let nodesExpanded = 0;

  function resolvePinnedAuth(
    step: ApiCaseContent['steps'][number],
    frozen: Awaited<ReturnType<typeof requireApiInterfaceRevision>> | null,
  ): ApiCaseContent['steps'][number] {
    if (step.authMode !== 'inherit') return step;
    const pinnedAuth = frozen?.definition.auth;
    if (pinnedAuth?.mode === 'none')
      return apiRequestStepSchema.parse({ ...step, authMode: 'none' });
    if (pinnedAuth?.mode === 'purpose' && step.source?.projectId === projectId)
      return apiRequestStepSchema.parse({
        ...step,
        authMode: 'explicit',
        purposeRef: pinnedAuth.purposeId,
      });
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '固定接口修订未提供可继承的本项目认证，请在步骤中明确选择无需认证或指定项目认证。',
      422,
    );
  }

  function countNode() {
    if (++nodesExpanded > 200)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '引用与前后置动作展开后超过二百个节点。',
        422,
      );
  }

  const sharedScripts = new Map<
    string,
    Awaited<ReturnType<typeof requireApiSharedScriptRevision>>
  >();

  async function compiledSharedScript(
    sourceProjectId: string,
    source: ApiSharedScriptReference,
  ) {
    if (sourceProjectId !== projectId)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '跨项目编排的共享脚本需要在本项目登记并引用固定修订。',
        422,
      );
    const key = source.scriptId + ':' + source.scriptRevisionId;
    let revision = sharedScripts.get(key);
    if (!revision) {
      revision = await requireApiSharedScriptRevision(tx, projectId, source);
      sharedScripts.set(key, revision);
    }
    return {
      type: 'script' as const,
      script: revision.body,
      sharedScriptSource: {
        projectId,
        scriptId: source.scriptId,
        scriptRevisionId: revision.revisionId,
        title: revision.title,
      },
    };
  }

  async function stagedNodes(
    providers: StageProvider[],
    phase: 'pre' | 'post',
    scope: string,
    requestStepId?: string,
  ): Promise<ApiFlowNode[]> {
    const ordered = phase === 'pre' ? providers : [...providers].reverse();
    const result: ApiFlowNode[] = [];
    for (const provider of ordered) {
      for (const action of provider.settings[phase]) {
        if (!action.enabled) continue;
        countNode();
        const stepPath = [
          scope,
          phase,
          provider.kind,
          provider.id,
          action.id,
        ].join('/');
        const metadata = {
          nodeId: scopedId('stage', stepPath),
          name: action.name,
          stageSource: {
            phase,
            kind: provider.kind,
            projectId: provider.projectId,
            providerId: provider.id,
            title: provider.title,
            actionId: action.id,
            ...(provider.revisionId ? { revisionId: provider.revisionId } : {}),
            ...(provider.rowVersion ? { rowVersion: provider.rowVersion } : {}),
            ...(requestStepId ? { requestStepId } : {}),
          },
        };
        switch (action.type) {
          case 'wait':
            result.push({
              ...metadata,
              type: 'wait',
              milliseconds: action.milliseconds,
            });
            break;
          case 'script':
            result.push({ ...metadata, type: 'script', script: action.script });
            break;
          case 'sharedScript':
            result.push({
              ...metadata,
              ...(await compiledSharedScript(provider.projectId, action)),
            });
            break;
          case 'databaseRead':
            if (provider.projectId !== projectId)
              throw new DomainError(
                'PRECONDITIONS_MISSING',
                '跨项目继承的数据库动作需要显式迁入本项目的已登记只读查询。',
                422,
              );
            result.push({
              ...metadata,
              type: 'databaseRead',
              queryId: action.queryId,
              parameters: action.parameters,
              resultVariable: action.resultVariable,
            });
            break;
        }
      }
    }
    return result;
  }

  async function readSource(source: Source, chain: readonly string[]) {
    if (chain.includes(source.caseId) || chain.length > 8)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '用例引用出现循环或层级过深。',
        422,
      );
    if (source.projectId !== projectId)
      await requireProject(tx, actor, source.projectId, 'project.read');
    return getApiProjectCase(tx, source.projectId, source.caseId, {
      revisionId: source.revisionId,
    });
  }

  async function expand(
    ownerProject: string,
    content: ApiCaseContent,
    namespace: string,
    chain: readonly string[],
    caseContext: CaseContext,
    stepOnly = false,
  ): Promise<FrozenGraph> {
    function executableNodes(nodes: ApiFlowNode[]): ApiFlowNode[] {
      return nodes.flatMap((node): ApiFlowNode[] => {
        if (node.enabled === false) {
          countNode();
          disabledNodeIds.push(scopedId(namespace, node.nodeId));
          return [];
        }
        switch (node.type) {
          case 'group':
          case 'repeat':
          case 'forEach':
            return [{ ...node, children: executableNodes(node.children) }];
          case 'if':
            return [
              {
                ...node,
                whenTrue: executableNodes(node.whenTrue),
                whenFalse: executableNodes(node.whenFalse),
              },
            ];
          default:
            return [node];
        }
      });
    }
    const activeFlow = executableNodes(content.flow);
    if (!activeFlow.length)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '此编排没有启用的业务节点。',
        422,
      );
    const activeStepIds = new Set(
      apiFlowNodes(activeFlow).flatMap((node) =>
        node.type === 'request' ? [node.stepId] : [],
      ),
    );
    const activeSteps = content.steps.filter((step) =>
      activeStepIds.has(step.stepId),
    );
    await validateInterfaceSources(tx, actor, ownerProject, {
      ...content,
      steps: activeSteps,
    });
    const caseStages = content.stageSettings ?? apiNoStages;
    if (content.stageSettings)
      await requireValidStageSettings(tx, ownerProject, caseStages);
    const suppressionFound = new Set<string>();
    const perStep = new Map<string, StageProvider[]>();
    const ids = new Map(
      activeSteps.map((step) => [
        step.stepId,
        scopedId(namespace, step.stepId),
      ]),
    );
    for (const original of activeSteps) {
      const step = apiRequestStepSchema.parse(rewriteReferences(original, ids));
      const frozen = step.source
        ? await requireApiInterfaceRevision(
            tx,
            step.source.projectId,
            step.source.interfaceId,
            step.source.revisionId,
          )
        : null;
      const authorizedStep = resolvePinnedAuth(step, frozen);
      steps.push({
        ...authorizedStep,
        stepId: scopedId(namespace, original.stepId),
        assertions: step.assertions.map((assertion) =>
          assertion.source === 'variable' && assertion.path
            ? { ...assertion, path: rewritePath(assertion.path, ids) }
            : assertion,
        ),
      });
      const stageSettings = step.stageSettings ?? apiNoStages;
      if (step.stageSettings)
        await requireValidStageSettings(tx, ownerProject, stageSettings);
      const inherited = applyStageSuppressions(
        frozen?.stageProviders ?? [],
        caseStages.suppress,
        { missing: 'ignore', encountered: suppressionFound },
      );
      const effective: StageProvider[] = applyStageSuppressions(
        inherited,
        stageSettings.suppress,
      );
      if (step.stageSettings)
        effective.push({
          kind: 'step',
          projectId: ownerProject,
          id: step.stepId,
          title: step.name,
          settings: localStageSettings(stageSettings),
          ...(caseContext.revisionId
            ? { revisionId: caseContext.revisionId }
            : {}),
        });
      perStep.set(original.stepId, effective);
    }
    if (
      !stepOnly &&
      activeSteps.length === content.steps.length &&
      caseStages.suppress.some(
        (entry) => !suppressionFound.has(stageSuppressionKey(entry)),
      )
    )
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '用例已选停用项不在当前接口引用中，请重新选择。',
        422,
      );

    async function children(flow: ApiFlowNode[]): Promise<ApiFlowNode[]> {
      const result: ApiFlowNode[] = [];
      for (const node of flow) {
        countNode();
        const nodeId = scopedId(namespace, node.nodeId);
        const label = { nodeId, name: node.name };
        switch (node.type) {
          case 'request':
            result.push(
              ...(await stagedNodes(
                perStep.get(node.stepId) ?? [],
                'pre',
                nodeId,
                scopedId(namespace, node.stepId),
              )),
              {
                ...node,
                nodeId,
                stepId: scopedId(namespace, node.stepId),
              },
              ...(await stagedNodes(
                perStep.get(node.stepId) ?? [],
                'post',
                nodeId,
                scopedId(namespace, node.stepId),
              )),
            );
            break;
          case 'if':
            result.push({
              ...node,
              nodeId,
              condition: {
                ...node.condition,
                left: rewritePath(node.condition.left, ids),
              },
              whenTrue: await children(node.whenTrue),
              whenFalse: await children(node.whenFalse),
            });
            break;
          case 'forEach':
            result.push({
              ...node,
              nodeId,
              source: rewritePath(node.source, ids),
              children: await children(node.children),
            });
            break;
          case 'group':
            result.push({
              ...node,
              nodeId,
              children: await children(node.children),
            });
            break;
          case 'repeat':
            result.push({
              ...node,
              nodeId,
              children: await children(node.children),
            });
            break;
          case 'case': {
            const source = {
              projectId: node.projectId,
              caseId: node.caseId,
              revisionId: node.revisionId,
            };
            const included = await readSource(source, chain);
            if (
              included.content.preparations?.length ||
              included.content.dataRows?.length ||
              included.content.cleanup.mode !== 'none'
            )
              throw new DomainError(
                'PRECONDITIONS_MISSING',
                '引用编排须选择无独立准备、数据行或清理的用例版本。',
                422,
              );
            result.push({
              ...label,
              type: 'group',
              variables: { ...included.content.variables, ...node.parameters },
              sourceCase: source,
              children: graphNodes(
                await expand(
                  source.projectId,
                  included.content,
                  nodeId,
                  [...chain, included.id],
                  {
                    caseId: included.id,
                    revisionId: included.revisionId,
                  },
                ),
              ),
            });
            break;
          }
          case 'sharedScript':
            result.push({
              ...label,
              ...(await compiledSharedScript(ownerProject, node)),
            });
            break;
          case 'databaseRead':
            result.push({
              ...node,
              nodeId,
              parameters: Object.fromEntries(
                Object.entries(node.parameters).map(([name, path]) => [
                  name,
                  rewritePath(path, ids),
                ]),
              ),
            });
            break;
          default:
            result.push({ ...node, nodeId });
        }
      }
      return result;
    }
    const graph = await children(activeFlow);
    const caseProviders: StageProvider[] =
      stepOnly || !content.stageSettings
        ? []
        : [
            {
              kind: 'case',
              projectId: ownerProject,
              id: caseContext.caseId ?? 'draft:' + ownerProject,
              title: content.title,
              settings: localStageSettings(rewriteCaseStages(caseStages, ids)),
              ...(caseContext.revisionId
                ? { revisionId: caseContext.revisionId }
                : {}),
            },
          ];
    return {
      pre: await stagedNodes(caseProviders, 'pre', namespace + '/case'),
      flow: graph,
      post: await stagedNodes(caseProviders, 'post', namespace + '/case'),
    };
  }

  const chain = authoredCaseId ? [authoredCaseId] : [];
  const flow: ApiFlowNode[] = [];
  for (const [position, reference] of preparations.entries()) {
    const source = {
      projectId,
      caseId: reference.caseId,
      revisionId: reference.revisionId,
    };
    const prepared = await readSource(source, chain);
    if (
      prepared.content.preparations?.length ||
      prepared.content.cleanup.mode !== 'none'
    )
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '准备步骤须直接引用无嵌套准备或清理的用例修订。',
        422,
      );
    preparedVariables.push(prepared.content.variables, reference.parameters);
    flow.push(
      ...graphNodes(
        await expand(
          projectId,
          prepared.content,
          `prepare-${position + 1}`,
          [...chain, prepared.id],
          { caseId: prepared.id, revisionId: prepared.revisionId },
        ),
      ),
    );
  }
  const rootCase = await expand(
    projectId,
    authored,
    '',
    chain,
    {
      caseId: authoredCaseId,
      revisionId: options.caseRevisionId,
    },
    options.stepOnly === true,
  );
  const cleanup = main.cleanup;
  const frozenCleanup =
    cleanup.mode === 'none'
      ? cleanup
      : {
          ...cleanup,
          steps: await Promise.all(
            cleanup.steps.map(async (entry) => {
              if (entry.type !== 'http' || !entry.request.source) return entry;
              const source = entry.request.source;
              if (source.projectId !== projectId)
                await requireProject(
                  tx,
                  actor,
                  source.projectId,
                  'project.read',
                );
              const pinned = await requireApiInterfaceRevision(
                tx,
                source.projectId,
                source.interfaceId,
                source.revisionId,
              );
              return {
                ...entry,
                request: resolvePinnedAuth(entry.request, pinned),
              };
            }),
          ),
        };
  const effective = apiCaseContentSchema.safeParse({
    ...main,
    cleanup: frozenCleanup,
    flow: [...rootCase.pre, ...flow, ...rootCase.flow, ...rootCase.post],
    steps,
    variables: Object.fromEntries(
      [...preparedVariables, main.variables].flatMap(Object.entries),
    ),
  });
  if (!effective.success)
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '已展开编排的步骤范围或标识不符合要求。',
      422,
    );
  return {
    content: effective.data,
    dataRows: dataRows ?? [],
    disabledNodeIds,
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
    ? composition.dataRows
        .filter((row) => row.enabled !== false)
        .map(({ id, name, values }) => ({
          content: {
            ...composition.content,
            variables: { ...composition.content.variables, ...values },
          },
          dataRow: { id, name },
        }))
    : [{ content: composition.content, dataRow: undefined }];
}
