import { useEffect, useState, type ReactNode } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Collapse,
  Input,
  InputNumber,
  Modal,
  Select,
} from 'antd';
import { z } from 'zod';
import {
  apiFlowNodes,
  apiFlowSchema,
  apiFlowConditionSchema,
  type ApiFlowNode,
} from '../../../packages/contracts/src/domain';
import {
  apiCatalogGetResultSchema,
  apiCatalogListResultSchema,
  type ApiCatalogNode,
  type ApiCatalogGetResult,
} from '../../../packages/contracts/src/api-catalog';
import type { ApiProjectCase } from '../../../packages/contracts/src/api-automation';
import { apiDatabaseReadSchema } from '../../../packages/contracts/src/api-database-reads';
import { api, describeError } from './api';
import { ApiSharedScriptPicker } from './api-shared-script-picker';
import { composeDraftFlow, newRequest, type ApiDraft } from './api-draft';
import {
  catalogFieldValue,
  catalogMergeFields,
  makeCatalogRequest,
  mergeCatalogRequest,
  type CatalogMergeField,
} from './api-catalog-source';

const flowNames: Record<ApiFlowNode['type'], string> = {
  request: 'HTTP 请求',
  group: '分组',
  if: '条件分支',
  forEach: 'ForEach 循环',
  repeat: 'For 循环',
  wait: '等待时间',
  script: '受控脚本',
  sharedScript: '公共脚本',
  databaseRead: '数据库观察',
  case: '引用用例',
};
const flowTypes = [
  'request',
  'group',
  'if',
  'forEach',
  'repeat',
  'wait',
  'script',
  'sharedScript',
  'databaseRead',
  'case',
] as const satisfies readonly ApiFlowNode['type'][];
const databaseReads = z.strictObject({
  queries: z.array(apiDatabaseReadSchema),
});

function defaultNode(
  type: ApiFlowNode['type'],
  projectId: string,
): ApiFlowNode {
  const base = { nodeId: crypto.randomUUID(), name: flowNames[type] };
  switch (type) {
    case 'request':
      return { ...base, type, stepId: base.nodeId };
    case 'group':
      return { ...base, type, children: [] };
    case 'if':
      return {
        ...base,
        type,
        condition: { left: '', operator: 'exists' },
        whenTrue: [],
        whenFalse: [],
      };
    case 'forEach':
      return {
        ...base,
        type,
        source: '',
        itemVariable: 'item',
        indexVariable: 'index',
        maxItems: 10,
        children: [],
      };
    case 'repeat':
      return { ...base, type, count: 1, indexVariable: 'index', children: [] };
    case 'wait':
      return { ...base, type, milliseconds: 1000 };
    case 'script':
      return { ...base, type, script: '' };
    case 'sharedScript':
      return { ...base, type, scriptId: '', scriptRevisionId: '' };
    case 'databaseRead':
      return {
        ...base,
        type,
        queryId: '',
        parameters: {},
        resultVariable: 'databaseResult',
      };
    case 'case':
      return {
        ...base,
        type,
        projectId,
        caseId: '',
        revisionId: '',
        parameters: {},
      };
  }
}

function RowField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <label className="api-catalog-form-field">
      <span>{label}</span>
      <Input
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function FlowJson<T>({
  label,
  value,
  change,
  parse,
  disabled,
  onError,
}: {
  label: string;
  value: T;
  change: (value: T) => void;
  parse: (value: unknown) => T;
  disabled: boolean;
  onError: (error: string | undefined) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2) ?? '');
  return (
    <label className="api-catalog-form-field">
      <span>{label}</span>
      <Input.TextArea
        value={text}
        disabled={disabled}
        className="api-catalog-code"
        autoSize={{ minRows: 2, maxRows: 8 }}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          try {
            change(parse(JSON.parse(next)));
            onError(undefined);
          } catch {
            onError(label + '需要符合字段类型的 JSON。');
          }
        }}
      />
    </label>
  );
}

function boolJson(value: unknown) {
  if (value === undefined) throw new Error('缺少 JSON 值。');
  return value;
}

export function ApiFlowEditor({
  projectId,
  projectCases,
  caseId,
  draft,
  disabled,
  allowStructure = true,
  onChange,
  onClose,
}: {
  projectId: string;
  projectCases: readonly ApiProjectCase[];
  caseId?: string | undefined;
  draft: ApiDraft;
  disabled: boolean;
  allowStructure?: boolean;
  onChange: (draft: ApiDraft) => void;
  onClose: () => void;
}) {
  const [nodes, setNodes] = useState(() =>
    composeDraftFlow(draft.base.flow, draft.requests),
  );
  const [queries, setQueries] = useState<
    z.output<typeof apiDatabaseReadSchema>[]
  >([]);
  const [queryError, setQueryError] = useState<string>();
  const [error, setError] = useState<string>();
  const [jsonErrors, setJsonErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    const controller = new AbortController();
    void api(
      `/projects/${projectId}/api-catalog`,
      {
        method: 'POST',
        body: { op: 'list-database-reads', input: {} },
        signal: controller.signal,
      },
      databaseReads,
    ).then(
      ({ queries }) => {
        if (!controller.signal.aborted) setQueries(queries);
      },
      (failure: unknown) => {
        if (!controller.signal.aborted) setQueryError(describeError(failure));
      },
    );
    return () => controller.abort();
  }, [projectId]);
  function jsonError(nodeId: string, failure: string | undefined) {
    setJsonErrors((before) => {
      const next = { ...before };
      if (failure) next[nodeId] = failure;
      else delete next[nodeId];
      return next;
    });
  }
  function apply() {
    try {
      const flow = apiFlowSchema.parse(nodes);
      const flattened = apiFlowNodes(flow);
      const invalid = flattened.find((node) => jsonErrors[node.nodeId]);
      if (invalid) throw new Error(jsonErrors[invalid.nodeId]);
      const requests = flattened.flatMap((node) =>
        node.type === 'request'
          ? [
              draft.requests.find((step) => step.stepId === node.stepId) ?? {
                ...newRequest(),
                stepId: node.stepId,
                name: node.name,
              },
            ]
          : [],
      );
      onChange({ ...draft, requests, base: { ...draft.base, flow } });
      onClose();
    } catch (failure) {
      setError(describeError(failure));
    }
  }
  const textChanges = (
    node: ApiFlowNode,
    update: (value: ApiFlowNode) => void,
  ) => (
    <RowField
      label="节点名称"
      value={node.name}
      disabled={disabled}
      onChange={(name) => update({ ...node, name })}
    />
  );

  function compose(
    items: ApiFlowNode[],
    change: (value: ApiFlowNode[]) => void,
    depth: number,
  ) {
    function shift(index: number, target: number) {
      const next = [...items];
      const [node] = next.splice(index, 1);
      if (!node) return;
      next.splice(target, 0, node);
      change(next);
    }
    return (
      <div className="api-catalog-stack">
        {items.map((node, index) => {
          const update = (value: ApiFlowNode) =>
            change(
              items.map((item) => (item.nodeId === node.nodeId ? value : item)),
            );
          let settings: ReactNode;
          switch (node.type) {
            case 'request':
              settings = (
                <p className="caption">请求字段在请求步骤编辑区维护。</p>
              );
              break;
            case 'wait':
              settings = (
                <label className="api-catalog-form-field">
                  <span>等待毫秒数</span>
                  <InputNumber
                    min={1}
                    max={30000}
                    value={node.milliseconds}
                    disabled={disabled}
                    onChange={(milliseconds) =>
                      update({ ...node, milliseconds: milliseconds ?? 1 })
                    }
                  />
                </label>
              );
              break;
            case 'group':
              settings = compose(
                node.children,
                (children) => update({ ...node, children }),
                depth + 1,
              );
              break;
            case 'repeat':
              settings = (
                <>
                  <div className="api-catalog-form-grid">
                    <label className="api-catalog-form-field">
                      <span>重复次数</span>
                      <InputNumber
                        min={1}
                        max={100}
                        value={node.count}
                        disabled={disabled}
                        onChange={(count) =>
                          update({ ...node, count: count ?? 1 })
                        }
                      />
                    </label>
                    <RowField
                      label="当前索引变量"
                      value={node.indexVariable}
                      disabled={disabled}
                      onChange={(indexVariable) =>
                        update({ ...node, indexVariable })
                      }
                    />
                  </div>
                  {compose(
                    node.children,
                    (children) => update({ ...node, children }),
                    depth + 1,
                  )}
                </>
              );
              break;
            case 'forEach':
              settings = (
                <>
                  <div className="api-catalog-form-grid">
                    <RowField
                      label="集合表达式"
                      value={node.source}
                      disabled={disabled}
                      onChange={(source) => update({ ...node, source })}
                    />
                    <RowField
                      label="当前元素变量"
                      value={node.itemVariable}
                      disabled={disabled}
                      onChange={(itemVariable) =>
                        update({ ...node, itemVariable })
                      }
                    />
                    <RowField
                      label="当前索引变量"
                      value={node.indexVariable}
                      disabled={disabled}
                      onChange={(indexVariable) =>
                        update({ ...node, indexVariable })
                      }
                    />
                    <label className="api-catalog-form-field">
                      <span>最大元素数</span>
                      <InputNumber
                        min={1}
                        max={100}
                        value={node.maxItems}
                        disabled={disabled}
                        onChange={(maxItems) =>
                          update({ ...node, maxItems: maxItems ?? 1 })
                        }
                      />
                    </label>
                  </div>
                  {compose(
                    node.children,
                    (children) => update({ ...node, children }),
                    depth + 1,
                  )}
                </>
              );
              break;
            case 'if':
              settings = (
                <>
                  <div className="api-catalog-form-grid">
                    <RowField
                      label="左值表达式"
                      value={node.condition.left}
                      disabled={disabled}
                      onChange={(left) =>
                        update({
                          ...node,
                          condition: { ...node.condition, left },
                        })
                      }
                    />
                    <label className="api-catalog-form-field">
                      <span>比较方式</span>
                      <Select
                        value={node.condition.operator}
                        disabled={disabled}
                        options={apiFlowConditionSchema.shape.operator.options.map(
                          (value) => ({ value, label: value }),
                        )}
                        onChange={(
                          operator: typeof node.condition.operator,
                        ) => {
                          const { right, ...condition } = node.condition;
                          update({
                            ...node,
                            condition: {
                              ...condition,
                              operator,
                              ...(operator !== 'exists' && {
                                right: right ?? null,
                              }),
                            },
                          });
                        }}
                      />
                    </label>
                    {node.condition.operator !== 'exists' && (
                      <FlowJson
                        label="比较值"
                        value={node.condition.right}
                        disabled={disabled}
                        change={(right) =>
                          update({
                            ...node,
                            condition: { ...node.condition, right },
                          })
                        }
                        parse={(value) =>
                          apiFlowConditionSchema.shape.right
                            .unwrap()
                            .parse(boolJson(value))
                        }
                        onError={(failure) => jsonError(node.nodeId, failure)}
                      />
                    )}
                  </div>
                  <h4>满足条件</h4>
                  {compose(
                    node.whenTrue,
                    (whenTrue) => update({ ...node, whenTrue }),
                    depth + 1,
                  )}
                  <h4>否则</h4>
                  {compose(
                    node.whenFalse,
                    (whenFalse) => update({ ...node, whenFalse }),
                    depth + 1,
                  )}
                </>
              );
              break;
            case 'script':
              settings = (
                <label className="api-catalog-form-field">
                  <span>受限脚本正文</span>
                  <Input.TextArea
                    className="api-catalog-code"
                    disabled={disabled}
                    value={node.script}
                    onChange={(event) =>
                      update({ ...node, script: event.target.value })
                    }
                  />
                </label>
              );
              break;
            case 'sharedScript':
              settings = (
                <ApiSharedScriptPicker
                  projectId={projectId}
                  value={node}
                  disabled={disabled}
                  onChange={(reference) => update({ ...node, ...reference })}
                />
              );
              break;
            case 'databaseRead':
              settings = (
                <div className="api-catalog-form-grid">
                  <label className="api-catalog-form-field">
                    <span>已审核查询</span>
                    <Select
                      showSearch
                      optionFilterProp="label"
                      value={node.queryId || null}
                      disabled={disabled}
                      options={queries.map(({ id, definition }) => ({
                        value: id,
                        label: definition.name + ' · ' + definition.table,
                      }))}
                      onChange={(queryId: string) => {
                        const selected = queries.find(
                          ({ id }) => id === queryId,
                        );
                        update({
                          ...node,
                          queryId,
                          parameters: Object.fromEntries(
                            (selected?.definition.filters ?? []).map(
                              ({ parameter }) => [
                                parameter,
                                node.parameters[parameter] ?? '',
                              ],
                            ),
                          ),
                        });
                      }}
                    />
                  </label>
                  {queryError && <Alert type="error" title={queryError} />}
                  <RowField
                    label="结果变量"
                    value={node.resultVariable}
                    disabled={disabled}
                    onChange={(resultVariable) =>
                      update({ ...node, resultVariable })
                    }
                  />
                  <FlowJson
                    key={node.queryId}
                    label="绑定参数"
                    value={node.parameters}
                    disabled={disabled}
                    change={(parameters) => update({ ...node, parameters })}
                    parse={(input) => {
                      if (
                        !input ||
                        Array.isArray(input) ||
                        typeof input !== 'object'
                      )
                        throw new Error('绑定参数需要对象。');
                      const entries = Object.entries(input);
                      if (
                        !entries.every(([, value]) => typeof value === 'string')
                      )
                        throw new Error('参数值应为表达式字符串。');
                      return Object.fromEntries(
                        entries.map(([name, value]) => [name, String(value)]),
                      );
                    }}
                    onError={(failure) => jsonError(node.nodeId, failure)}
                  />
                </div>
              );
              break;
            case 'case':
              settings = (
                <>
                  <label className="api-catalog-form-field">
                    <span>固定用例修订</span>
                    <Select
                      disabled={disabled}
                      showSearch
                      optionFilterProp="label"
                      value={node.caseId || null}
                      options={projectCases
                        .filter(
                          (entry) => entry.id !== caseId && !entry.removedAt,
                        )
                        .map((entry) => ({
                          value: entry.id,
                          label: `${entry.title} · r${entry.revisionNo}`,
                        }))}
                      onChange={(value: string) => {
                        const picked = projectCases.find(
                          (entry) => entry.id === value,
                        );
                        if (picked)
                          update({
                            ...node,
                            caseId: picked.id,
                            revisionId: picked.revisionId,
                          });
                      }}
                    />
                  </label>
                  {node.revisionId && <code>{node.revisionId}</code>}
                </>
              );
              break;
          }
          return (
            <section className="api-catalog-definition-group" key={node.nodeId}>
              <div className="row wrap">
                <b>
                  {index + 1} · {flowNames[node.type]}
                </b>
                {!disabled && allowStructure && (
                  <>
                    <Button
                      size="small"
                      disabled={index === 0}
                      onClick={() => shift(index, index - 1)}
                    >
                      上移
                    </Button>
                    <Button
                      size="small"
                      disabled={index === items.length - 1}
                      onClick={() => shift(index, index + 1)}
                    >
                      下移
                    </Button>
                    <Button
                      size="small"
                      danger
                      onClick={() =>
                        change(
                          items.filter((item) => item.nodeId !== node.nodeId),
                        )
                      }
                    >
                      删除节点
                    </Button>
                  </>
                )}
              </div>
              <Checkbox
                checked={node.enabled !== false}
                disabled={disabled}
                onChange={(event) =>
                  update({ ...node, enabled: event.target.checked })
                }
              >
                参与执行
              </Checkbox>
              {textChanges(node, update)}
              {jsonErrors[node.nodeId] && (
                <Alert type="error" title={jsonErrors[node.nodeId]} />
              )}
              {settings}
            </section>
          );
        })}
        {!disabled && allowStructure && depth < 8 && (
          <Select
            aria-label="添加编排节点"
            placeholder="添加编排节点"
            value={null}
            options={flowTypes.map((type) => ({
              value: type,
              label: flowNames[type],
            }))}
            onChange={(type: ApiFlowNode['type']) =>
              change([...items, defaultNode(type, projectId)])
            }
          />
        )}
      </div>
    );
  }
  return (
    <Modal
      title="执行流程"
      open
      width={860}
      onCancel={onClose}
      onOk={apply}
      okText="应用编排"
      okButtonProps={{ disabled }}
    >
      {error && <Alert type="error" title={error} showIcon />}
      {compose(nodes, setNodes, 0)}
    </Modal>
  );
}

export function ApiAutomationSources({
  projectId,
  draft,
  disabled,
  standalone,
  onChange,
}: {
  projectId: string;
  caseId?: string | undefined;
  draft: ApiDraft;
  projectCases: readonly ApiProjectCase[];
  disabled: boolean;
  standalone: boolean;
  onChange: (value: ApiDraft) => void;
}) {
  const [nodes, setNodes] = useState<ApiCatalogNode[]>([]);
  const [endpoint, setEndpoint] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [sourcePreview, setSourcePreview] = useState<{
    result: ApiCatalogGetResult;
    existing?: ApiCatalogGetResult;
    candidate: ReturnType<typeof makeCatalogRequest>;
    stepId?: string;
  }>();
  const [selectedFields, setSelectedFields] = useState<
    ReadonlySet<CatalogMergeField>
  >(new Set());
  const [advanceRevision, setAdvanceRevision] = useState(false);
  function loadDefinition(project: string, id: string, revision?: string) {
    const query = revision
      ? '?' + new URLSearchParams({ revisionId: revision })
      : '';
    return api(
      `/projects/${project}/api-catalog/nodes/${id}${query}`,
      {},
      apiCatalogGetResultSchema,
    );
  }
  useEffect(() => {
    const controller = new AbortController();
    void api(
      `/projects/${projectId}/api-catalog/nodes`,
      { signal: controller.signal },
      apiCatalogListResultSchema,
    ).then(
      ({ nodes }) => {
        if (!controller.signal.aborted) setNodes(nodes);
      },
      (failure: unknown) => {
        if (!controller.signal.aborted) setError(describeError(failure));
      },
    );
    return () => controller.abort();
  }, [projectId]);
  async function preview(project: string, id: string, stepId?: string) {
    setBusy(true);
    setError(undefined);
    try {
      const previous = draft.requests.find((item) => item.stepId === stepId);
      if (stepId && !previous?.source)
        throw new Error('先为请求选择固定的接口修订。');
      const [result, existing] = await Promise.all([
        loadDefinition(project, id),
        previous?.source
          ? loadDefinition(
              previous.source.projectId,
              previous.source.interfaceId,
              previous.source.revisionId,
            )
          : undefined,
      ]);
      if (!result.revision) throw new Error('该对象没有接口定义。');
      if (
        previous?.source &&
        existing?.revision?.id !== previous.source.revisionId
      )
        throw new Error('未能核对原来固定的来源修订。');
      setSelectedFields(new Set());
      setAdvanceRevision(false);
      setSourcePreview({
        result,
        ...(existing && { existing }),
        candidate: makeCatalogRequest(result, draft.variableEntries),
        ...(stepId && { stepId }),
      });
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  }
  function accept() {
    if (!sourcePreview) return;
    const { request, variables } = sourcePreview.candidate;
    let requests = draft.requests;
    if (sourcePreview.stepId) {
      const previous = draft.requests.find(
        (step) => step.stepId === sourcePreview.stepId,
      );
      if (
        !previous?.source ||
        previous.source.revisionId !== sourcePreview.existing?.revision?.id
      ) {
        setError('来源修订在应用前发生变化，请重新预览。');
        setSourcePreview(undefined);
        return;
      }
      requests = requests.map((previous) =>
        previous.stepId === sourcePreview.stepId
          ? mergeCatalogRequest(
              previous,
              request,
              selectedFields,
              advanceRevision,
            )
          : previous,
      );
    } else requests = standalone ? [request] : [...requests, request];
    onChange({
      ...draft,
      requests,
      variableEntries:
        !sourcePreview.stepId || selectedFields.has('url')
          ? [...draft.variableEntries, ...variables]
          : draft.variableEntries,
    });
    setSourcePreview(undefined);
  }
  const active = draft.requests.find(
    (step) => step.stepId === sourcePreview?.stepId,
  );
  const priorRevision = sourcePreview?.existing?.revision;
  const nextRevision = sourcePreview?.result.revision;
  const newer = Boolean(
    priorRevision && nextRevision && priorRevision.id !== nextRevision.id,
  );
  const needsAuthAnchor =
    newer &&
    selectedFields.has('auth') &&
    sourcePreview?.candidate.request.authMode === 'inherit' &&
    !advanceRevision;
  const stageSummary = (
    revision: ApiCatalogGetResult['revision'] | undefined,
  ) =>
    revision?.stageProviders.map((provider) => ({
      source: provider.title,
      pre: provider.settings.pre.map((action) => ({
        name: action.name,
        type: action.type,
        enabled: action.enabled,
      })),
      post: provider.settings.post.map((action) => ({
        name: action.name,
        type: action.type,
        enabled: action.enabled,
      })),
    })) ?? [];
  return (
    <div className="api-catalog-stack">
      {error && <Alert type="error" title={error} showIcon />}
      <header>
        <strong>接口来源</strong>
      </header>
      <div className="row wrap">
        <Select
          aria-label="选择接口定义"
          showSearch
          optionFilterProp="label"
          className="grow"
          disabled={disabled || busy}
          value={endpoint}
          onChange={setEndpoint}
          options={nodes
            .filter((node) => node.kind === 'interface' && !node.archivedAt)
            .map((node) => ({
              value: node.id,
              label: `${node.title} · ${node.method} ${node.path}`,
            }))}
        />
        <Button
          disabled={!endpoint || disabled || busy}
          loading={busy}
          onClick={() => {
            if (endpoint) void preview(projectId, endpoint);
          }}
        >
          预览引用
        </Button>
      </div>
      <Collapse
        items={draft.requests.flatMap((step) => {
          const source = step.source;
          return source
            ? [
                {
                  key: step.stepId,
                  label: step.name,
                  children: (
                    <div className="row wrap">
                      <Button
                        href={`#api-catalog?${new URLSearchParams({ projectId: source.projectId, endpointId: source.interfaceId, revisionId: source.revisionId })}`}
                      >
                        查看固定来源修订
                      </Button>
                      <Button
                        disabled={disabled || busy}
                        onClick={() =>
                          void preview(
                            source.projectId,
                            source.interfaceId,
                            step.stepId,
                          )
                        }
                      >
                        比较最新定义
                      </Button>
                    </div>
                  ),
                },
              ]
            : [];
        })}
      />
      {sourcePreview && (
        <Modal
          title={sourcePreview.stepId ? '同步接口来源' : '引用接口到用例'}
          open
          width={860}
          onCancel={() => setSourcePreview(undefined)}
          onOk={accept}
          okText="应用到当前草稿"
          okButtonProps={{
            disabled: Boolean(
              sourcePreview.stepId &&
              (!active ||
                needsAuthAnchor ||
                (!selectedFields.size && !advanceRevision)),
            ),
          }}
        >
          <p>
            {sourcePreview.result.revision?.title} · r
            {sourcePreview.result.revision?.revisionNumber}
          </p>
          {active ? (
            <div className="api-catalog-stack">
              <div className="api-catalog-form-grid">
                <div>
                  <strong>当前固定修订 r{priorRevision?.revisionNumber}</strong>
                  <p>
                    <code>{priorRevision?.id}</code>
                  </p>
                </div>
                <div>
                  <strong>预览来源 r{nextRevision?.revisionNumber}</strong>
                  <p>
                    <code>{nextRevision?.id}</code>
                  </p>
                </div>
              </div>
              <p className="caption">
                只应用勾选的请求字段。本地断言、提取、步骤前后置与未勾选的值继续保留。
              </p>
              {needsAuthAnchor && (
                <Alert
                  type="info"
                  showIcon
                  title="新定义的认证需要继承其修订。请更新固定来源，或取消认证字段选择。"
                />
              )}
              {catalogMergeFields.map(({ key, label }) => (
                <section className="api-catalog-definition-group" key={key}>
                  <Checkbox
                    checked={selectedFields.has(key)}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setSelectedFields((previous) => {
                        const next = new Set(previous);
                        if (checked) next.add(key);
                        else next.delete(key);
                        return next;
                      });
                    }}
                  >
                    同步{label}
                  </Checkbox>
                  <div className="api-catalog-form-grid">
                    <div>
                      <span className="caption">本地草稿</span>
                      <pre className="api-catalog-result">
                        {JSON.stringify(
                          catalogFieldValue(active, key),
                          null,
                          2,
                        )}
                      </pre>
                    </div>
                    <div>
                      <span className="caption">预览来源</span>
                      <pre className="api-catalog-result">
                        {JSON.stringify(
                          catalogFieldValue(
                            sourcePreview.candidate.request,
                            key,
                          ),
                          null,
                          2,
                        )}
                      </pre>
                    </div>
                  </div>
                </section>
              ))}
              <section className="api-catalog-definition-group">
                <Checkbox
                  disabled={!newer}
                  checked={advanceRevision}
                  onChange={(event) => setAdvanceRevision(event.target.checked)}
                >
                  更新固定来源修订并采用对应的继承设置
                </Checkbox>
                <div className="api-catalog-form-grid">
                  <div>
                    <span className="caption">当前修订继承的动作</span>
                    <pre className="api-catalog-result">
                      {JSON.stringify(stageSummary(priorRevision), null, 2)}
                    </pre>
                  </div>
                  <p className="caption">
                    继承认证和前后置按选择的固定修订解析，本地配置保持原值。
                  </p>
                  <div>
                    <span className="caption">预览修订继承的动作</span>
                    <pre className="api-catalog-result">
                      {JSON.stringify(stageSummary(nextRevision), null, 2)}
                    </pre>
                  </div>
                </div>
              </section>
            </div>
          ) : (
            <code>
              {sourcePreview.candidate.request.method}{' '}
              {sourcePreview.candidate.request.url}
            </code>
          )}
        </Modal>
      )}
    </div>
  );
}
