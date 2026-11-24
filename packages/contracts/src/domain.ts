import { z } from 'zod';
import {
  apiSharedScriptReferenceSchema,
  apiSharedScriptSourceSchema,
} from './api-shared-scripts.js';
import { apiBinaryRequestBodySchema, multipartRequestBodySchema } from './api-multipart.js';
import { apiStageSettingsSchema, apiStageSourceSchema } from './api-stage-actions.js';
import {
safeSourceLinkSchema,
sanitizeSourceLinkFields,
sourceLinkUnavailableReasonSchema,
} from './source-links.js';
import {
commandIdSchema,
decimalCountSchema,
idSchema,
kindSchema,
persistedRowVersionSchema,
safeTextSchema,
sha256Schema,
timestampSchema,
titleSchema,
} from './base.js';

export const requirementLifecycleSchema = z.enum(['inProgress', 'archived']);
export const reviewStateSchema = z.enum([
  'pending',
  'needsOptimization',
  'aiOptimized',
  'approved',
]);
export const issueSeveritySchema = z.enum(['severe', 'normal', 'minor']);
export const issueStateSchema = z.enum([
  'pending',
  'inProgress',
  'awaitingRetest',
  'closed',
]);
export const problemStateSchema = z.enum([
  'pendingConfirmation',
  'confirmed',
  'dismissed',
]);
export const readabilitySchema = z.enum([
  'readable',
  'unreadable',
  'notChecked',
  'partial',
]);
export const materialPurposeSchema = z.enum([
  'requirement',
  'prototype',
  'supplement',
]);
export const localIdSchema = z.string().min(1).max(200);
export const basisRefSchema = z.strictObject({
  kind: z.enum(['material', 'knowledge', 'rule', 'explicitStatement']),
  objectId: idSchema.optional(),
  revisionId: idSchema.optional(),
  locator: z.string().max(2000).optional(),
  description: z.string().min(1).max(4000),
  readability: readabilitySchema,
});
export const versionReferenceSchema = z.strictObject({
  id: idSchema,
  revisionId: idSchema,
  revisionNo: z.number().int().min(1),
  rowVersion: persistedRowVersionSchema,
});
const materialFields = {
  purpose: materialPurposeSchema,
  originalName: z.string().min(1).max(512),
  fileResourceId: idSchema.optional(),
  readability: readabilitySchema,
  order: z.number().int().min(0),
};
export const materialInputSchema = z
  .strictObject({
    ...materialFields,
    sourceLink: safeSourceLinkSchema.optional(),
  })
  .refine(
    (material) =>
      Boolean(material.fileResourceId) !== Boolean(material.sourceLink),
    {
      message: '材料必须且只能指定文件或来源链接之一',
    },
  );
// Historical storage stays byte/logically unchanged. Only output projection can omit an unsafe URL.
export const materialStoredSchema = z
  .strictObject({
    ...materialFields,
    id: idSchema,
    sourceLink: z.string().max(4000).optional(),
  })
  .refine(
    (material) =>
      Boolean(material.fileResourceId) !== Boolean(material.sourceLink),
    '历史材料须有一个原件来源',
  );
const materialDtoSchema = z
  .strictObject({
    ...materialFields,
    id: idSchema,
    sourceLink: safeSourceLinkSchema.optional(),
    sourceLinkUnavailableReason: sourceLinkUnavailableReasonSchema.optional(),
  })
  .refine(
    (material) =>
      Number(Boolean(material.fileResourceId)) +
        Number(Boolean(material.sourceLink)) +
        Number(Boolean(material.sourceLinkUnavailableReason)) ===
      1,
    '材料须有一个文件、安全链接或链接不可用说明',
  );
export const materialSchema = z.preprocess(
  (value) => sanitizeSourceLinkFields(value),
  materialDtoSchema,
);
export const requirementSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema,
  businessNumber: z.string().trim().min(1).max(100).nullable(),
  title: titleSchema,
  lifecycle: requirementLifecycleSchema,
  inactive: z.boolean().default(false),
  archivedAt: timestampSchema.nullable(),
  businessUpdatedAt: timestampSchema,
  rowVersion: persistedRowVersionSchema,
});
export const requirementVersionSchema = z.strictObject({
  id: idSchema,
  requirementId: idSchema,
  projectId: idSchema,
  versionNo: z.number().int().min(1),
  summary: z.string().max(10_000),
  createdBy: idSchema,
  createdAt: timestampSchema,
  materialSetDigest: sha256Schema,
  materials: z.array(materialSchema).max(200),
});
export const requirementAssetBasisSchema = z.strictObject({
  requirementId: idSchema,
  basisVersionId: idSchema,
  basisVersionNo: z.number().int().positive(),
  lockedVersionId: idSchema,
  lockedVersionNo: z.number().int().positive(),
  warning: z.literal('REQUIREMENT_BASIS_DIFFERS_FROM_LOCKED').nullable(),
});
export type RequirementAssetBasis = z.infer<typeof requirementAssetBasisSchema>;

export const scenarioContentSchema = z.strictObject({
  kind: kindSchema,
  requirementVersionId: idSchema,
  setId: idSchema,
  title: titleSchema,
  objective: safeTextSchema,
  sharedPreconditions: z.array(z.string().max(10_000)).max(100),
  basisRefs: z.array(basisRefSchema).max(100),
});
const uiBusinessStepsSchema = z.array(z.strictObject({
  action: z.string().trim().min(1).max(10_000),
  expected: z.string().trim().min(1).max(10_000).optional(),
})).min(1).max(100);

export const uiAssertionSchema = z.strictObject({
  id: localIdSchema,
  expected: z.string().trim().min(1).max(10_000),
  evidenceHint: z.string().trim().min(1).max(2000).optional(),
});

export const uiCaseContentSchema = z.strictObject({
  kind: z.literal('UI'),
  scenarioId: idSchema,
  title: titleSchema,
  testPoint: safeTextSchema,
  preconditions: z.array(z.string().max(10_000)).max(100),
  steps: uiBusinessStepsSchema.optional(),
  assertions: z.array(uiAssertionSchema).min(1).max(100)
    .refine((items) => new Set(items.map((item) => item.id)).size === items.length, '业务断言标识不可重复')
    .optional(),
  expected: safeTextSchema,
  basisRefs: z.array(basisRefSchema).max(100),
});

export const httpMethodSchema = z.enum([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);
export const namedValueSchema = z.strictObject({
  name: z.string().min(1).max(256),
  value: z.string().max(100_000),
});
export const variableNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
export const variableRefSchema = z
  .string()
  .regex(/^(env|case|extract|auth)\.[A-Za-z_][A-Za-z0-9_.]{0,255}$/);
export const extractorSchema = z.strictObject({
  name: variableNameSchema,
  source: z.enum(['json', 'header', 'status', 'body']),
  path: z.string().max(2000).optional(),
  required: z.boolean(),
  sensitive: z.boolean().optional(),
});
export const assertionOperatorSchema = z.enum([
  'equals',
  'notEquals',
  'contains',
  'exists',
  'matches',
  'greaterThan',
  'lessThan',
]);
export const apiXmlElementPathSchema = z
  .string()
  .max(2000)
  .regex(/^\/[A-Za-z_][A-Za-z0-9_.:-]*(?:\[[1-9]\d{0,3}\])?(?:\/[A-Za-z_][A-Za-z0-9_.:-]*(?:\[[1-9]\d{0,3}\])?)*$/u);

export const assertionSchema = z
  .strictObject({
    id: localIdSchema,
    source: z.enum(['status', 'json', 'header', 'body', 'variable', 'elapsedMs', 'xml', 'contract']),
    path: z.string().max(2000).optional(),
    operator: assertionOperatorSchema,
    expected: z.json().optional(),
  })
  .superRefine((assertion, context) => {
    if (assertion.operator !== 'exists' && assertion.expected === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['expected'],
        message: '此断言运算符需要预期值',
      });
    }
    if (
      ['json', 'header', 'variable'].includes(assertion.source) &&
      !assertion.path
    ) {
      context.addIssue({
        code: 'custom',
        path: ['path'],
        message: '此断言来源需要字段路径',
      });
    }
    const { source, path, operator, expected } = assertion;
    if ((source === 'elapsedMs' || source === 'contract') && path !== undefined)
      context.addIssue({code:'custom',path:['path'],message:'此断言不使用字段路径'});
    if (source === 'elapsedMs' && operator !== 'exists' &&
      (!['equals','notEquals','greaterThan','lessThan'].includes(operator)
      || typeof expected !== 'number' || !Number.isFinite(expected) || expected < 0))
      context.addIssue({code:'custom',path:['expected'],message:'耗时断言需要非负毫秒数及数值比较运算符'});
    if (source === 'xml') {
      if (!apiXmlElementPathSchema.safeParse(path).success)
        context.addIssue({code:'custom',path:['path'],message:'请输入 XML 元素路径，如 /order/items/item[2]'});
      if (operator !== 'exists' &&
        (!['equals','notEquals','contains','matches'].includes(operator)||typeof expected !== 'string'))
        context.addIssue({code:'custom',path:['expected'],message:'XML 元素文本需要字符串及文本比较运算符'});
    }
    if (source === 'contract' && (operator !== 'equals' || typeof expected !== 'boolean'))
      context.addIssue({code:'custom',path:['expected'],message:'响应契约断言使用等于 true 或 false'});
  });
export const requestBodySchema = z.discriminatedUnion('format', [
  z.strictObject({ format: z.literal('none') }),
  z.strictObject({ format: z.literal('json'), value: z.json() }),
  z.strictObject({
    format: z.literal('text'),
    value: z.string().max(1_000_000),
    mediaType: z.string().max(256),
  }),
  multipartRequestBodySchema,
  apiBinaryRequestBodySchema,
  z.strictObject({
    format: z.literal('form'),
    fields: z.array(namedValueSchema).max(200),
  }),
]);
export const scriptSchema = z.string().max(64_000);
export const apiInterfaceSourceSchema = z.strictObject({
  projectId: idSchema,
  interfaceId: idSchema,
  revisionId: idSchema,
});
export const apiRequestStepSchema = z
  .strictObject({
    stepId: z.string().regex(/^[A-Za-z0-9_-]{1,140}$/),
    name: titleSchema,
    method: httpMethodSchema,
    url: z.string().min(1).max(8000),
    query: z.array(namedValueSchema).max(200),
    headers: z.array(namedValueSchema).max(200),
    body: requestBodySchema,
    authMode: z.enum(['none', 'inherit', 'explicit']).optional(),
    purposeRef: idSchema.optional(),
    authProfileRef: idSchema.optional(),
    extractors: z.array(extractorSchema).max(100),
    assertions: z.array(assertionSchema).max(200),
    preScript: scriptSchema.optional(),
    postScript: scriptSchema.optional(),
    stageSettings: apiStageSettingsSchema.optional(),
    timeoutMs: z.number().int().min(100).max(120_000).optional(),
    source: apiInterfaceSourceSchema.optional(),
  })
  .superRefine((step, context) => {
    if (step.authMode === 'inherit' && !step.source)
      context.addIssue({ code: 'custom', path: ['source'], message: '继承认证需要选定固定接口修订。' });
    if ((step.authMode === 'none' || step.authMode === 'inherit') && (step.purposeRef || step.authProfileRef))
      context.addIssue({ code: 'custom', path: ['authMode'], message: '无需认证或继承认证不能同时填写显式配置。' });
    if (step.authMode === 'explicit' && !step.purposeRef && !step.authProfileRef)
      context.addIssue({ code: 'custom', path: ['authMode'], message: '手工认证需要选择明确的账号用途或认证配置。' });
    if (step.assertions.some((assertion) => assertion.source === 'contract') && !step.source)
      context.addIssue({code:'custom',path:['source'],message:'响应契约断言需要固定接口修订'});
    const names = step.extractors.map((extractor) => extractor.name);
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: 'custom',
        path: ['extractors'],
        message: '提取变量名不可重复',
      });
    }
  });
export const cleanupHttpStepSchema = z.strictObject({
  type: z.literal('http'),
  cleanupStepId: localIdSchema,
  requiredTargets: z.array(variableRefSchema).min(1).max(100),
  request: apiRequestStepSchema,
});
export const cleanupSqlStepSchema = z.strictObject({
  type: z.literal('sql'),
  cleanupStepId: localIdSchema,
  environmentId: idSchema,
  connectionId: idSchema,
  driver: z.enum(['postgresql', 'mysql']),
  statement: z.string().min(1).max(64_000),
  parameters: z
    .array(
      z.strictObject({ name: variableNameSchema, valueRef: variableRefSchema }),
    )
    .min(1)
    .max(100),
  requiredTargets: z.array(variableRefSchema).min(1).max(100),
});
export const cleanupStepSchema = z.discriminatedUnion('type', [
  cleanupHttpStepSchema,
  cleanupSqlStepSchema,
]);
export const cleanupPolicySchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('none') }),
  z.strictObject({
    mode: z.enum(['always', 'onSuccess']),
    steps: z.array(cleanupStepSchema).min(1).max(100),
  }),
]);
export const apiDataRowSchema = z.strictObject({
  id: localIdSchema,
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().optional(),
  values: z.record(variableNameSchema, z.json()),
});
export const apiPreparationReferenceSchema = z.strictObject({
  caseId: idSchema,
  revisionId: idSchema,
  parameters: z.record(variableNameSchema, z.json()),
});
export const apiDataRowAnchorSchema = apiDataRowSchema.pick({ id: true, name: true });
export const apiPreparationAnchorSchema = apiPreparationReferenceSchema.pick({ caseId: true, revisionId: true });
const apiFlowIdentitySchema = z.strictObject({
  nodeId: z.string().regex(/^[A-Za-z0-9_-]{1,140}$/),
  name: titleSchema,
  enabled: z.boolean().optional(),
  stageSource: apiStageSourceSchema.optional(),
});
export const apiFlowConditionSchema = z.strictObject({
  left: z.string().min(1).max(2000),
  operator: z.enum(['eq', 'neq', 'exists', 'gt', 'gte', 'lt', 'lte', 'contains']),
  right: z.json().optional(),
}).superRefine((condition, ctx) => {
  if (condition.operator !== 'exists' && condition.right === undefined)
    ctx.addIssue({ code: 'custom', path: ['right'], message: '该条件需要实际比较值。' });
});
const apiLeafFlowNodeSchemas = [
  apiFlowIdentitySchema.extend({ type: z.literal('request'), stepId: localIdSchema }),
  apiFlowIdentitySchema.extend({ type: z.literal('wait'), milliseconds: z.number().int().min(1).max(30_000) }),
  apiFlowIdentitySchema.extend({
    type: z.literal('script'),
    script: scriptSchema,
    sharedScriptSource: apiSharedScriptSourceSchema.optional(),
  }),
  apiFlowIdentitySchema.extend({
    type: z.literal('sharedScript'),
    ...apiSharedScriptReferenceSchema.shape,
  }),
  apiFlowIdentitySchema.extend({
    type: z.literal('databaseRead'),
    queryId: idSchema,
    parameters: z.record(variableNameSchema, z.string().max(8000)),
    resultVariable: variableNameSchema,
  }),
  apiFlowIdentitySchema.extend({
    type: z.literal('case'),
    projectId: idSchema,
    caseId: idSchema,
    revisionId: idSchema,
    parameters: z.record(variableNameSchema, z.json()),
  }),
] as const;

type ApiFlowVariables = Record<string, z.infer<ReturnType<typeof z.json>>>;
export type ApiFlowNode =
  | z.infer<(typeof apiLeafFlowNodeSchemas)[number]>
  | (z.infer<typeof apiFlowIdentitySchema> & (
      | { type: 'group'; children: ApiFlowNode[]; variables?: ApiFlowVariables | undefined; sourceCase?: { projectId: string; caseId: string; revisionId: string } | undefined }
      | { type: 'if'; condition: z.infer<typeof apiFlowConditionSchema>; whenTrue: ApiFlowNode[]; whenFalse: ApiFlowNode[] }
      | { type: 'forEach'; source: string; itemVariable: string; indexVariable: string; maxItems: number; children: ApiFlowNode[] }
      | { type: 'repeat'; count: number; indexVariable: string; children: ApiFlowNode[] }
    ));
const apiFlowChildrenSchema = z.lazy(() => boundedApiFlowList);
const apiFlowNodeSchema: z.ZodType<ApiFlowNode> = z.discriminatedUnion('type', [
  ...apiLeafFlowNodeSchemas,
  apiFlowIdentitySchema.extend({
    type: z.literal('group'), children: apiFlowChildrenSchema,
    variables: z.record(variableNameSchema, z.json()).optional(),
    sourceCase: z.strictObject({ projectId: idSchema, caseId: idSchema, revisionId: idSchema }).optional(),
  }),
  apiFlowIdentitySchema.extend({
    type: z.literal('if'), condition: apiFlowConditionSchema,
    whenTrue: apiFlowChildrenSchema, whenFalse: apiFlowChildrenSchema,
  }),
  apiFlowIdentitySchema.extend({
    type: z.literal('forEach'), source: z.string().min(1).max(2000),
    itemVariable: variableNameSchema, indexVariable: variableNameSchema,
    maxItems: z.number().int().min(1).max(100), children: apiFlowChildrenSchema,
  }),
  apiFlowIdentitySchema.extend({
    type: z.literal('repeat'), count: z.number().int().min(1).max(100),
    indexVariable: variableNameSchema, children: apiFlowChildrenSchema,
  }),
]);
const boundedApiFlowList = z.array(apiFlowNodeSchema).max(100);

function flowFitsBudget(value: unknown): boolean {
  const pending: { node: unknown; depth: number }[] = [];
  if (!Array.isArray(value) || !value.length || value.length > 100) return false;
  pending.push(...value.map((node: unknown) => ({ node, depth: 1 })));
  let count = 0;
  while (pending.length) {
    const entry = pending.pop();
    if (!entry || ++count > 200 || entry.depth > 8) return false;
    if (typeof entry.node !== 'object' || entry.node === null) continue;
    for (const key of ['children', 'whenTrue', 'whenFalse'] as const) {
      const list = Object.getOwnPropertyDescriptor(entry.node, key)?.value;
      if (!Array.isArray(list)) continue;
      if (list.length > 100) return false;
      pending.push(...list.map((node: unknown) => ({ node, depth: entry.depth + 1 })));
    }
  }
  return true;
}

export const apiFlowSchema = z.preprocess(
  (value) => flowFitsBudget(value) ? value : [],
  boundedApiFlowList.min(1, '编排至少一个节点，最多八层、二百个节点。'),
);

export function apiFlowNodes(flow: readonly ApiFlowNode[]): ApiFlowNode[] {
  return flow.flatMap((node): ApiFlowNode[] => {
    switch (node.type) {
      case 'group':
      case 'repeat':
      case 'forEach':
        return [node, ...apiFlowNodes(node.children)];
      case 'if':
        return [node, ...apiFlowNodes(node.whenTrue), ...apiFlowNodes(node.whenFalse)];
      default:
        return [node];
    }
  });
}

export const apiCaseContentSchema = z
  .strictObject({
    kind: z.literal('API'),
    scenarioId: idSchema.nullable(),
    title: titleSchema,
    testPoint: safeTextSchema,
    preconditions: z.array(z.string().max(10_000)).max(100),
    expected: safeTextSchema,
    basisRefs: z.array(basisRefSchema).max(100),
    dslVersion: z.literal('ath.api-case.v2'),
    tags: z.array(titleSchema).max(20).optional(),
    variables: z.record(variableNameSchema, z.json()),
    dataRows: z.array(apiDataRowSchema).min(1).max(100).optional(),
    preparations: z.array(apiPreparationReferenceSchema).min(1).max(20).optional(),
    steps: z.array(apiRequestStepSchema).max(100),
    flow: apiFlowSchema,
    stageSettings: apiStageSettingsSchema.optional(),
    cleanup: cleanupPolicySchema,
  })
  .superRefine((content, context) => {
    if (content.dataRows && new Set(content.dataRows.map(row => row.id)).size !== content.dataRows.length)
      context.addIssue({ code:'custom',path:['dataRows'],message:'数据行标识不可重复' });
    if (
      new Set(content.steps.map((step) => step.stepId)).size !==
      content.steps.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['steps'],
        message: '请求步骤标识不可重复',
      });
    }
    if (content.cleanup.mode !== 'none') {
      const ids = content.cleanup.steps.map((step) => step.cleanupStepId);
      if (new Set(ids).size !== ids.length) {
        context.addIssue({
          code: 'custom',
          path: ['cleanup', 'steps'],
          message: '清理步骤标识不可重复',
        });
      }
    }
    const nodes = apiFlowNodes(content.flow);
    if (new Set(nodes.map((node) => node.nodeId)).size !== nodes.length)
      context.addIssue({ code: 'custom', path: ['flow'], message: '编排节点标识不可重复。' });
    const registry = new Set(content.steps.map((step) => step.stepId));
    const requests = nodes.flatMap((node) => node.type === 'request' ? [node.stepId] : []);
    if (new Set(requests).size !== requests.length || requests.length !== registry.size || requests.some((id) => !registry.has(id)))
      context.addIssue({ code: 'custom', path: ['flow'], message: '每条请求须在编排中出现一次，并引用已登记的步骤。' });
    if (nodes.some((node) => node.type === 'forEach' && node.itemVariable === node.indexVariable))
      context.addIssue({ code: 'custom', path: ['flow'], message: '循环元素和索引须使用不同变量。' });
  });
export const caseContentSchema = z.discriminatedUnion('kind', [
  uiCaseContentSchema,
  apiCaseContentSchema,
]);
export const assetOperationSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('create'),
    localId: localIdSchema,
    targetType: z.enum(['set', 'scenario', 'case']),
    parentId: idSchema.optional(),
    parentLocalId: localIdSchema.optional(),
    content: z.union([
      scenarioContentSchema,
      caseContentSchema,
      z.strictObject({
        title: titleSchema,
        basisRefs: z.array(basisRefSchema),
      }),
    ]),
  }),
  z.strictObject({
    operation: z.literal('update'),
    targetType: z.enum(['set', 'scenario', 'case']),
    targetId: idSchema,
    baseRevisionId: idSchema,
    content: z.union([
      scenarioContentSchema,
      caseContentSchema,
      z.strictObject({
        title: titleSchema,
        basisRefs: z.array(basisRefSchema),
      }),
    ]),
  }),
  z.strictObject({
    operation: z.literal('explicitRemove'),
    targetType: z.enum(['set', 'scenario', 'case']),
    targetId: idSchema,
    baseRevisionId: idSchema,
  }),
]);
export const assetChangeSetSchema = z
  .strictObject({
    schemaVersion: z.literal('ath.asset-changes.v1'),
    submissionId: commandIdSchema,
    kind: kindSchema,
    projectId: idSchema,
    requirementVersionId: idSchema.optional(),
    requirementId: idSchema.optional(),
    mode: z.enum(['incremental', 'completeSet']),
    operations: z.array(assetOperationSchema).min(1).max(10_000),
    baseRevisionMap: z.record(idSchema, idSchema),
  })
  .superRefine((changeSet, context) => {
    if (!changeSet.requirementId && !changeSet.requirementVersionId)
      context.addIssue({code:'custom',path:['requirementId'],message:'请选择提交所属的需求。'});
    for (const [index, operation] of changeSet.operations.entries()) {
      if (operation.operation === 'explicitRemove') continue;
      const content = operation.content;
      const isCase = 'scenarioId' in content;
      const isScenario = 'objective' in content;
      if (
        (operation.targetType === 'case') !== isCase ||
        (operation.targetType === 'scenario') !== isScenario
      ) {
        context.addIssue({
          code: 'custom',
          path: ['operations', index, 'content'],
          message: '资产目标类型与内容不符',
        });
      }
      if ('kind' in content && content.kind !== changeSet.kind) {
        context.addIssue({
          code: 'custom',
          path: ['operations', index, 'content', 'kind'],
          message: '提交不得混合UI与API资产',
        });
      }
    }
  });
export const approvalSnapshotSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema,
  kind: kindSchema,
  caseId: idSchema,
  caseRevisionId: idSchema,
  scenarioRevisionId: idSchema.nullable(),
  setRevisionId: idSchema.nullable(),
  opinionContextDigest: sha256Schema,
  approvedBy: idSchema,
  approvedAt: timestampSchema,
});
export const precisePreviewItemSchema = z.strictObject({
  id: idSchema,
  title: titleSchema,
  kind: kindSchema.optional(),
  requirementVersionId: idSchema.optional(),
  rowVersion: persistedRowVersionSchema,
  revisionId: idSchema.optional(),
  eligible: z.boolean(),
  reasons: z.array(z.string().max(1000)),
});
export const precisePreviewSchema = z.strictObject({
  previewId: idSchema,
  scopeDigest: sha256Schema,
  items: z.array(precisePreviewItemSchema).max(10_000),
  createdAt: timestampSchema,
});
export const preciseCommitInputSchema = z.strictObject({
  previewId: idSchema,
  scopeDigest: sha256Schema,
  objectIds: z.array(idSchema).min(1).max(10_000),
  commandId: commandIdSchema,
});
const planBase = {
  id: idSchema,
  projectId: idSchema,
  planRevisionId: idSchema,
  name: titleSchema,
  environmentId: idSchema,
  productBuild: z.string().max(200).nullable(),
  createdBy: idSchema,
  rowVersion: persistedRowVersionSchema,
};
export const uiPlanSchema = z.strictObject({
  ...planBase,
  kind: z.literal('UI'),
  requirementVersionId: idSchema,
  items: z
    .array(z.strictObject({ caseId: idSchema, approvalSnapshotId: idSchema }))
    .min(1)
    .max(10_000),
});
export const apiPlanSchema = z.strictObject({
  ...planBase,
  kind: z.literal('API'),
  items: z
    .array(z.strictObject({ caseId: idSchema }))
    .min(1)
    .max(10_000),
});
export const planSchema = z.discriminatedUnion('kind', [
  uiPlanSchema,
  apiPlanSchema,
]);
export const runStateSchema = z.enum([
  'prepared',
  'queued',
  'running',
  'stopping',
  'completed',
  'terminated',
  'interrupted',
  'recoveryRequired',
]);
export const uiOutcomeSchema = z.enum([
  'passed',
  'failed',
  'blocked',
  'inconclusive',
  'notExecuted',
]);
export const apiOutcomeSchema = z.enum(['passed', 'failed', 'notExecuted']);
export const deliveryStatusSchema = z.enum([
  'notSubmitted',
  'receiving',
  'incomplete',
  'complete',
]);
export const cleanupStateSchema = z.enum([
  'notConfigured',
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
  'interrupted',
]);
export const sideEffectCertaintySchema = z.enum([
  'known',
  'unknown',
  'notApplicable',
]);
export const missingRequirementSchema = z.strictObject({
  code: z.string().min(1).max(100),
  objectId: idSchema.optional(),
  message: z.string().min(1).max(2000),
});
export const apiRunScenarioSchema = z.strictObject({
  title: titleSchema,
  objective: safeTextSchema,
  sharedPreconditions: z.array(z.string().max(10_000)).max(100),
  basisRefs: z.array(basisRefSchema).max(100),
  requirementVersionId: idSchema.nullable(),
});
export const scopeItemSchema = z.strictObject({
  runItemId: idSchema,
  caseId: idSchema,
  caseRevisionId: idSchema.optional(),
  disabledNodeIds: z.array(localIdSchema).max(200).optional(),
  approvalSnapshotId: idSchema,
  requirementVersionId: idSchema.nullable(),
  setId: idSchema.nullable(),
  scenarioId: idSchema.nullable(),
  scenario: z.union([scenarioContentSchema, apiRunScenarioSchema]).nullable(),
  content: caseContentSchema,
  ordinal: z.number().int().min(0),
  issueIds: z.array(idSchema),
  dataRow: apiDataRowAnchorSchema.optional(),
  preparationSources: z.array(apiPreparationAnchorSchema).max(20).optional(),
});
export const executionScopeSchema = z
  .strictObject({
    schemaVersion: z.literal('ath.execution-scope.v1'),
    runId: idSchema,
    sourceType: z.enum(['plan', 'retestPreparation', 'debug']),
    sourceRevisionId: idSchema,
    projectId: idSchema,
    kind: kindSchema,
    environmentId: idSchema,
    environmentRevisionId: idSchema,
    productBuild: z.string().max(200).nullable(),
    items: z.array(scopeItemSchema).max(10_000),
    snapshotDigest: sha256Schema,
    missingRequirements: z.array(missingRequirementSchema),
    retestContext: z
      .strictObject({
        label: z.string().max(2000),
        sourceRunIds: z.array(idSchema).max(1000),
      })
      .optional(),
  })
  .superRefine((scope, context) => {
    for (const [index, item] of scope.items.entries()) {
      const scenario = item.scenario;
      const validUi = item.content.kind === 'UI' && scenario && 'kind' in scenario &&
        scenario.kind === 'UI' && item.requirementVersionId !== null && item.setId !== null && item.scenarioId !== null;
      const validApi = item.content.kind === 'API' && item.setId === null &&
        item.content.scenarioId === item.scenarioId &&
        (scenario ? !('kind' in scenario) && item.scenarioId !== null &&
          scenario.requirementVersionId === item.requirementVersionId :
          item.scenarioId === null && item.requirementVersionId === null);
      if (scope.kind === 'UI' ? !validUi : !validApi) {
        context.addIssue({
          code: 'custom',
          path: ['items', index],
          message: '执行范围不得混合UI与API资产',
        });
      }
    }
  });
export const claimUiExecutionInputSchema = z.strictObject({
  sourceType: z.enum(['plan', 'retestPreparation']),
  sourceRevisionId: idSchema,
  localExecutionId: commandIdSchema,
});
export const uiProgressInputSchema = z.strictObject({
  runId: idSchema,
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  completedItems: z.number().int().min(0).max(10_000),
  summary: z.string().max(4000),
  observedAt: timestampSchema,
});
export const fileRegistrationSchema = z
  .strictObject({
    ownerScope: z.enum(['personal', 'project']),
    projectId: idSchema.optional(),
    runId: idSchema.optional(),
    localFileId: localIdSchema,
    mediaType: z.string().min(1).max(256),
    originalName: z.string().min(1).max(512),
    bytes: decimalCountSchema
      .max(19)
      .refine(
        (value) =>
          /^(0|[1-9][0-9]*)$/.test(value) &&
          value.length <= 19 &&
          BigInt(value) <= 9_223_372_036_854_775_807n,
        '文件字节数超出持久表示范围',
      ),
    sha256: sha256Schema,
  })
  .refine((file) => file.ownerScope !== 'project' || Boolean(file.projectId), {
    path: ['projectId'],
    message: '项目文件必须指定项目',
  });
export const evidenceManifestItemSchema = z.strictObject({
  localEvidenceId: localIdSchema,
  fileId: idSchema,
  type: z.enum([
    'screenshot',
    'requestResponse',
    'conversation',
    'log',
    'attachment',
    'other',
  ]),
  sha256: sha256Schema,
  bytes: decimalCountSchema,
  captureCompleteness: z.enum([
    'full',
    'viewport',
    'partial',
    'summary',
    'interrupted',
    'missing',
  ]),
  capturedAt: timestampSchema.optional(),
  source: z.enum(['original', 'derived', 'manualAddition']).default('original'),
});
const evidenceStepOrdinal = z.number().int().min(1).max(100);
const uniqueList = <T extends z.ZodType>(entry: T, limit: number) =>
  z.array(entry).max(limit).refine((values) => new Set(values).size === values.length, '关联项不可重复');
const observationAssertionIds = uniqueList(localIdSchema, 100);
export const resultObservationSchema = z.strictObject({
  actual: z.string().trim().min(1).max(10_000),
  assertionIds: observationAssertionIds.optional(),
  stepOrdinals: uniqueList(evidenceStepOrdinal, 100).optional(),
  actionOrdinals: uniqueList(z.number().int().min(1).max(1000), 1000).optional(),
  evidenceRefs: uniqueList(localIdSchema, 100).optional(),
});
export const resultAssertionSchema = z.strictObject({
  assertionId: localIdSchema,
  outcome: uiOutcomeSchema,
  reason: z.string().trim().min(1).max(10_000).optional(),
});
export const resultStepObservationSchema = z.strictObject({
  ordinal: evidenceStepOrdinal,
  actual: z.string().trim().min(1).max(10_000),
  outcome: uiOutcomeSchema.optional(),
  evidenceRefs: z.array(localIdSchema).max(100).default([]),
});
export const resultEvidenceGapSchema = z.strictObject({
  ordinal: evidenceStepOrdinal.optional(),
  assertionIds: observationAssertionIds.optional(),
  label: z.string().trim().min(1).max(200),
  state: z.enum(['notCaptured', 'pendingUpload', 'uploadFailed']),
  reason: z.string().trim().min(1).max(2000),
});
export const resultItemSchema = z.strictObject({
  runItemId: idSchema,
  localResultId: localIdSchema,
  originalOutcome: uiOutcomeSchema,
  actualObservations: safeTextSchema,
  actualActions: z.array(z.string().max(10_000)).max(1000).optional(),
  reason: z.string().max(10_000).optional(),
  basis: z.array(basisRefSchema).max(100).optional(),
  sideEffectCertainty: sideEffectCertaintySchema,
  evidenceRefs: z.array(localIdSchema).max(1000),
  stepObservations: z
    .array(resultStepObservationSchema)
    .max(100)
    .refine((steps) => new Set(steps.map((step) => step.ordinal)).size === steps.length, '步骤序号不可重复')
    .optional(),
  observations: z.array(resultObservationSchema).max(1000).optional(),
  assertionResults: z.array(resultAssertionSchema).max(100)
    .refine((items) => new Set(items.map((item) => item.assertionId)).size === items.length, '断言结论不可重复')
    .optional(),
  evidenceGaps: z.array(resultEvidenceGapSchema).max(100).optional(),
  startedAt: timestampSchema.optional(),
  endedAt: timestampSchema.optional(),
});
export const resultSubmissionSchema = z
  .strictObject({
    schemaVersion: z.literal('ath.result-submission.v1'),
    runId: idSchema,
    submissionId: commandIdSchema,
    snapshotDigest: sha256Schema,
    completion: z.enum(['partial', 'complete']),
    endedAt: timestampSchema,
    items: z.array(resultItemSchema).max(10_000),
    evidenceManifest: z.array(evidenceManifestItemSchema).max(100),
    notExecutedItemIds: z.array(idSchema).max(10_000),
  })
  .superRefine((submission, context) => {
    const ids = [
      ...submission.items.map((item) => item.runItemId),
      ...submission.notExecutedItemIds,
    ];
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: 'custom',
        path: ['items'],
        message: '结果项与未执行项不得重复或交叠',
      });
    }
    const localResultIds = submission.items.map((item) => item.localResultId);
    if (new Set(localResultIds).size !== localResultIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['items'],
        message: '本地结果标识不可重复',
      });
    }
    const evidenceIds = submission.evidenceManifest.map(
      (item) => item.localEvidenceId,
    );
    const known = new Set(evidenceIds);
    if (known.size !== evidenceIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['evidenceManifest'],
        message: '本地证据标识不可重复',
      });
    }
    for (const [index, item] of submission.items.entries()) {
      if (item.evidenceRefs.some((id) => !known.has(id))) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'evidenceRefs'],
          message: '结果引用的证据必须在本次清单中登记',
        });
      }
    }
  });
export const resultAmendmentSchema = z.strictObject({
  schemaVersion: z.literal('ath.result-amendment.v1'),
  runId: idSchema,
  amendmentId: commandIdSchema,
  resultId: idSchema,
  baseResultRevisionId: idSchema,
  reason: z.string().min(1).max(10_000),
  replacement: resultItemSchema,
});
export const perItemResultSchema = z.strictObject({
  objectId: z.string().min(1).max(200),
  status: z.enum(['accepted', 'conflict', 'rejected', 'skipped']),
  revisionId: idSchema.optional(),
  code: z.string().max(100).optional(),
  message: z.string().max(2000).optional(),
});
/** Wider server representation; a trusted active/accepted ResourcePolicy enforces the actual budget. */
export const resultSubmissionResourceSchema = resultSubmissionSchema.safeExtend(
  { evidenceManifest: z.array(evidenceManifestItemSchema).max(200) },
);
export const resultSubmissionReceiptSchema = z.strictObject({
  submissionId: commandIdSchema,
  semanticDigest: sha256Schema,
  resultsAccepted: z.number().int().min(0),
  missingFileIds: z.array(idSchema),
  deliveryStatus: deliveryStatusSchema,
  reportId: idSchema.nullable(),
  reportUrl: z.string().max(4000).nullable(),
  perItemResults: z.array(perItemResultSchema),
});
export const toolReceiptSchema = z.strictObject({
  schemaVersion: z.literal('ath.tool-receipt.v1'),
  operationId: commandIdSchema,
  status: z.enum([
    'accepted',
    'completed',
    'partial',
    'rejected',
    'unknown',
    'waitingConfirmation',
  ]),
  objectRefs: z.array(
    z.strictObject({
      id: idSchema,
      revisionId: idSchema.optional(),
      type: z.string().min(1).max(100),
    }),
  ),
  safeSummary: z.string().max(4000),
  perItemResults: z.array(perItemResultSchema),
  recoveryLink: z.string().max(4000).optional(),
});
export const persistentEventSchema = z.strictObject({
  schemaVersion: z.literal('ath.event.v1'),
  eventId: idSchema,
  aggregateId: idSchema,
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  type: z.string().min(1).max(100),
  occurredAt: timestampSchema,
  actorSafe: z.strictObject({ userId: idSchema }).nullable(),
  payloadSafe: z.record(z.string(), z.json()),
});

export type RequirementLifecycle = z.infer<typeof requirementLifecycleSchema>;
export type ReviewState = z.infer<typeof reviewStateSchema>;
export type IssueSeverity = z.infer<typeof issueSeveritySchema>;
export type ScenarioContent = z.infer<typeof scenarioContentSchema>;
export type UiCaseContent = z.infer<typeof uiCaseContentSchema>;
export type ApiCaseContent = z.infer<typeof apiCaseContentSchema>;
export type ApiRequestStep = z.infer<typeof apiRequestStepSchema>;
export type AssetChangeSet = z.infer<typeof assetChangeSetSchema>;
export type ApprovalSnapshot = z.infer<typeof approvalSnapshotSchema>;
export type Plan = z.infer<typeof planSchema>;
export type ExecutionScope = z.infer<typeof executionScopeSchema>;
export type RunState = z.infer<typeof runStateSchema>;
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;
export type ResultSubmission = z.infer<typeof resultSubmissionSchema>;
export type ResultAmendment = z.infer<typeof resultAmendmentSchema>;
export type ResultItem = z.infer<typeof resultItemSchema>;
export type FileRegistration = z.infer<typeof fileRegistrationSchema>;
export type ToolReceipt = z.infer<typeof toolReceiptSchema>;
export type PersistentEvent = z.infer<typeof persistentEventSchema>;

/** Only the trusted top-level requirement in these two historical receipt shapes is projected.
 * Arbitrary API/result/knowledge JSON and all stored response bytes remain untouched. */
export function projectRequirementReceiptView<T>(
  operation: string,
  value: T,
): T {
  if (
    !['requirements.create', 'requirements.add-version'].includes(operation) ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  )
    return value;
  const envelope = value as Record<string, unknown>,
    raw = envelope.requirement;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return value;
  const record = raw as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    typeof record.projectId !== 'string' ||
    typeof record.title !== 'string' ||
    !('businessNumber' in record) ||
    typeof record.businessUpdatedAt !== 'string' ||
    typeof record.lifecycle !== 'string' ||
    !['inProgress', 'archived', 'paused', 'completed', 'terminated'].includes(
      record.lifecycle,
    )
  )
    return value;
  const lifecycle =
    record.archivedAt != null || record.lifecycle !== 'inProgress'
      ? 'archived'
      : 'inProgress';
  return {
    ...envelope,
    requirement: {
      ...record,
      lifecycle,
      inactive: lifecycle === 'inProgress' && record.inactive === true,
    },
  } as T;
}
