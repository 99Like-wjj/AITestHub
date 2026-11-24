import {
  Alert,
  Button,
  Card,
  Checkbox,
  Collapse,
  Dropdown,
  Popconfirm,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Tabs,
  Typography,
} from 'antd';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import {
  assertionOperatorSchema,
  apiCaseContentSchema,
  httpMethodSchema,
  variableNameSchema,
} from '../../../packages/contracts/src/domain';
import { assetDetailSchema } from '../../../packages/contracts/src/assets';
import { testConfigurationListSchema } from '../../../packages/contracts/src/test-configuration';
import type { TestConfigurationView } from '../../../packages/contracts/src/test-configuration';
import { api, describeError } from './api';
import { ApiCleanupFields } from './api-cleanup-fields';
import { ApiMultipartFields } from './api-multipart-fields';
import { ApiBinaryFields } from './api-file-fields';
import { ApiRequestStageFields } from './api-stage-fields';
import { storedExplorerSetting, storeExplorerSetting } from './explorer-tree';
import { multipartMaxFileBytes } from '../../../packages/contracts/src/api-multipart';
import { AppIcon } from './app-icon';
import { uiLayers } from './ui-layers';
import {
  parseCurlDraft,
  parseQueryPaste,
  safeRequestDraftPreview,
} from './api-import';
import { apiTemplateReferences } from '../../../packages/contracts/src/api-variable-refs';

export {
  apiDraftFromContent,
  emptyApiDraft,
  serializeApiDraft,
} from './api-draft';
export type { ApiDraft, ApiCase } from './api-draft';
import { newRequest } from './api-draft';
import type { ApiDraft, DraftRequest, Request, Assertion } from './api-draft';
import {
  draftVariableIssues,
  variableOptions,
  VariableField,
  type ApiPreparationVariables,
  type ApiVariableOption,
} from './api-variable-fields';

function RequestSections({
  items,
  workbench,
  focus,
}: {
  items: { key: string; label: ReactNode; children: ReactNode }[];
  workbench: boolean;
  focus?: { tab: 'parameters' | 'assertions' | 'extractors'; nonce: string };
}) {
  const [selected, setSelected] = useState('parameters');
  useEffect(() => {
    if (focus) setSelected(focus.tab);
  }, [focus]);
  const order = [
    'parameters',
    'body',
    'headers',
    'cookies',
    'configuration',
    'preScript',
    'postScript',
    'assertions',
    'extractors',
    'settings',
  ];
  const labels: Record<string, string> = {
    parameters: 'Params',
    headers: 'Headers',
    cookies: 'Cookies',
    configuration: 'Auth',
    body: 'Body',
    preScript: '前置',
    postScript: '后置',
    settings: '设置',
  };
  return workbench ? (
    <Tabs
      className="request-section-tabs"
      activeKey={selected}
      onChange={setSelected}
      items={[...items]
        .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
        .map((item) => ({ ...item, label: labels[item.key] ?? item.label }))}
    />
  ) : (
    <Collapse items={items} />
  );
}

function NamedValues({
  label,
  values,
  onChange,
  disabled,
  options,
  onDisable,
}: {
  label: string;
  values: { name: string; value: string }[];
  onChange: (values: { name: string; value: string }[]) => void;
  disabled: boolean;
  options: ApiVariableOption[];
  onDisable?: (index: number) => void;
}) {
  return (
    <div className="named-values-editor">
      <table className="kv">
        <thead>
          <tr>
            <th>{label} 名称</th>
            <th>值</th>
            <th aria-label="移除" />
          </tr>
        </thead>
        <tbody>
          {values.map((entry, index) => (
            <tr key={index}>
              <td>
                <Input
                  aria-label={`${label}名称 ${index + 1}`}
                  placeholder="名称"
                  value={entry.name}
                  disabled={disabled}
                  onChange={(event) =>
                    onChange(
                      values.map((item, at) =>
                        at === index
                          ? { ...item, name: event.target.value }
                          : item,
                      ),
                    )
                  }
                />
              </td>
              <td>
                <VariableField
                  label={`${label}值 ${index + 1}`}
                  placeholder="值或变量引用；不要填写真实凭据"
                  value={entry.value}
                  disabled={disabled}
                  options={options}
                  onChange={(next) =>
                    onChange(
                      values.map((item, at) =>
                        at === index ? { ...item, value: next } : item,
                      ),
                    )
                  }
                />
              </td>
              <td>
                {onDisable && (
                  <Button
                    size="small"
                    disabled={disabled}
                    onClick={() => onDisable(index)}
                  >
                    停用
                  </Button>
                )}
                <Button
                  type="text"
                  aria-label={`移除${label} ${index + 1}`}
                  danger
                  icon={<DeleteOutlined />}
                  disabled={disabled}
                  onClick={() =>
                    onChange(values.filter((_, at) => at !== index))
                  }
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!values.length && (
        <p className="caption" style={{ padding: '10px 8px' }}>
          尚未配置{label}参数，保存时保持为空。
        </p>
      )}
      <Button
        size="small"
        icon={<PlusOutlined />}
        disabled={disabled || values.length >= 200}
        onClick={() => onChange([...values, { name: '', value: '' }])}
      >
        添加{label}
      </Button>
    </div>
  );
}

type ApiPane =
  'request' | 'data' | 'variables' | 'cleanup' | 'revisions' | 'sources';
const paneTitles: Record<Exclude<ApiPane, 'request'>, string> = {
  data: '运行数据',
  variables: '用例变量',
  cleanup: '数据清理',
  revisions: '修订与资格',
  sources: '接口定义',
};

export function ApiCaseFields({
  projectId,
  variant = 'business',
  labelPrefix = '请求',
  value,
  onChange,
  disabled,
  presentation = 'stacked',
  previewEnvironmentId,
  onPreviewEnvironmentChange,
  upstreamRequests = [],
  preparationVariables,
  onSingleDiagnostic,
  ruleFocus,
  workspacePanels,
  workspaceSummary,
  environmentHost,
  onValidate,
  maxRequests = 100,
  workspaceKey,
}: {
  projectId: string;
  variant?: 'business' | 'cleanup';
  labelPrefix?: string;
  value: ApiDraft;
  onChange: (value: ApiDraft) => void;
  disabled: boolean;
  presentation?: 'stacked' | 'workbench';
  previewEnvironmentId?: string | undefined;
  onPreviewEnvironmentChange?: (id: string | undefined) => void;
  upstreamRequests?: readonly DraftRequest[];
  preparationVariables?: ApiPreparationVariables | undefined;
  onSingleDiagnostic?: (stepId: string) => void;
  workspacePanels?: {
    data: ReactNode;
    revisions: ReactNode;
    sources?: ReactNode;
  };
  workspaceSummary?: ReactNode;
  environmentHost?: HTMLDivElement | null;
  onValidate?: () => void;
  maxRequests?: number;
  workspaceKey?: string | undefined;

  ruleFocus?:
    | {
        stepId: string;
        tab: 'parameters' | 'assertions' | 'extractors';
        nonce: string;
      }
    | undefined;
}) {
  const workbench = presentation === 'workbench';
  const stepPreference = workspaceKey && `automation:step:${workspaceKey}`;
  const [activeStep, setActiveStep] = useState(
    () =>
      (stepPreference && storedExplorerSetting(stepPreference)) ||
      value.requests[0]?.stepId,
  );
  const [activePane, setActivePane] = useState<ApiPane>('request');
  const [openedPanes, setOpenedPanes] = useState(new Set<ApiPane>());
  const showPane = (pane: ApiPane) => {
    setActivePane(pane);
    if (pane !== 'request' && !openedPanes.has(pane))
      setOpenedPanes((previous) => new Set([...previous, pane]));
  };

  const [curlOpen, setCurlOpen] = useState(false);
  const [curlText, setCurlText] = useState('');
  const [curlPreview, setCurlPreview] = useState<DraftRequest>();
  const [curlError, setCurlError] = useState<string>();
  const [requestPreview, setRequestPreview] = useState<{
    text?: string;
    error?: string;
  }>();
  const [queryImport, setQueryImport] = useState<{
    stepId: string;
    source: string;
    preview?: DraftRequest['query'];
    error?: string;
  }>();
  const [graphParts, setGraphParts] = useState<
    Record<string, { query: string; variables: string; operationName: string }>
  >({});

  const bodyDrafts = useRef(
    new Map<string, Map<string, Pick<DraftRequest, 'body' | 'bodyText'>>>(),
  );
  const [bodyChoices, setBodyChoices] = useState<Record<string, string>>({});
  useEffect(() => {
    if (ruleFocus) {
      setActiveStep(ruleFocus.stepId);
      setActivePane('request');
    }
  }, [ruleFocus]);

  const currentStep = value.requests.some(
    (request) => request.stepId === activeStep,
  )
    ? activeStep
    : value.requests[0]?.stepId;
  useEffect(() => {
    if (stepPreference && currentStep)
      storeExplorerSetting(stepPreference, currentStep);
  }, [stepPreference, currentStep]);
  const [configurations, setConfigurations] = useState<TestConfigurationView[]>(
    [],
  );
  const [configurationError, setConfigurationError] = useState<string>();
  const [configurationLoading, setConfigurationLoading] = useState(false);
  const [configurationRefresh, setConfigurationRefresh] = useState(0);
  const pickedEnvironmentId = previewEnvironmentId;
  const environments = configurations.filter(
    (entry) => entry.content.kind === 'environment' && entry.content.active,
  );
  const selectedEnvironment = environments.find(
    (entry) => entry.id === pickedEnvironmentId,
  );
  const references = value.base.preparations;
  const [preparations, setPreparations] = useState<{
    projectId: string;
    references: typeof references;
    context?: ApiPreparationVariables;
  }>();
  const currentPreparations =
    preparations?.projectId === projectId &&
    preparations.references === references
      ? preparations
      : undefined;
  const resolvedPreparations =
    preparationVariables ?? currentPreparations?.context;
  const variableIssues = useMemo(
    () =>
      variant === 'business'
        ? draftVariableIssues(value, selectedEnvironment, resolvedPreparations)
        : [],
    [variant, value, selectedEnvironment, resolvedPreparations],
  );
  useEffect(() => {
    if (variant !== 'business' || !references?.length) return;
    const controller = new AbortController();
    const caseIds = [
      ...new Set(references.map((reference) => reference.caseId)),
    ];
    void Promise.all(
      caseIds.map(
        async (caseId) =>
          [
            caseId,
            await api(
              `/projects/${projectId}/assets/${caseId}`,
              { signal: controller.signal },
              assetDetailSchema,
            ),
          ] as const,
      ),
    )
      .then((catalog) => {
        if (controller.signal.aborted) return;
        const assets = new Map(catalog);
        const context: ApiPreparationVariables = { steps: [], variables: {} };
        for (const [index, reference] of references.entries()) {
          const asset = assets.get(reference.caseId);
          const snapshot = asset?.revisions.find(
            (revision) => revision.id === reference.revisionId,
          );
          const source = apiCaseContentSchema.safeParse(snapshot?.content);
          if (
            !source.success ||
            asset?.asset.removedAt ||
            source.data.preparations?.length
          ) {
            setPreparations({ projectId, references });
            return;
          }
          context.variables = {
            ...context.variables,
            ...source.data.variables,
            ...reference.parameters,
          };
          context.steps.push(
            ...source.data.steps.map((step) => ({
              ...step,
              name: `准备 ${index + 1} · ${step.name}`,
            })),
          );
        }
        setPreparations({ projectId, references, context });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setPreparations({ projectId, references });
      });
    return () => controller.abort();
  }, [projectId, references, variant]);
  useEffect(() => {
    const controller = new AbortController();
    setConfigurations([]);
    setConfigurationError(undefined);
    setConfigurationLoading(true);
    void Promise.allSettled(
      ['purpose', 'authProfile', 'environment'].map((kind) =>
        api(
          `/projects/${projectId}/test-configuration?kind=${kind}`,
          { signal: controller.signal },
          testConfigurationListSchema,
        ),
      ),
    ).then((results) => {
      if (controller.signal.aborted) return;
      setConfigurations(
        results.flatMap((result) =>
          result.status === 'fulfilled' ? result.value.configurations : [],
        ),
      );
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length)
        setConfigurationError(
          failures.map((result) => describeError(result.reason)).join('；'),
        );
      setConfigurationLoading(false);
    });
    return () => controller.abort();
  }, [projectId, configurationRefresh]);
  function referenceOptions(
    kind: 'purpose' | 'authProfile',
    selected: string | undefined,
  ) {
    const options = configurations
      .filter((entry) => entry.content.kind === kind)
      .map((entry) => ({
        value: entry.id,
        label: `${entry.content.name}${'active' in entry.content && !entry.content.active ? '（已停用）' : ''}`,
        disabled: 'active' in entry.content && !entry.content.active,
      }));
    if (selected && !options.some((option) => option.value === selected))
      options.push({
        value: selected,
        label: `原引用 ${selected}（当前目录未取得）`,
        disabled: true,
      });
    return options;
  }
  function confirmCurl() {
    if (disabled || value.requests.length >= maxRequests) return;
    if (curlPreview) {
      onChange({ ...value, requests: [...value.requests, curlPreview] });
      setActiveStep(curlPreview.stepId);
      setActivePane('request');
      setCurlText('');
      setCurlPreview(undefined);
      setCurlOpen(false);
      setCurlError(undefined);
      return;
    }
    try {
      setCurlPreview(parseCurlDraft(curlText));
      setCurlError(undefined);
    } catch (failure) {
      setCurlError(describeError(failure));
    }
  }

  function setPathVariable(name: string, valueText: string) {
    const current = value.variableEntries.find((entry) => entry.name === name);
    onChange({
      ...value,
      variableEntries: current
        ? value.variableEntries.map((entry) =>
            entry.id === current.id ? { ...entry, valueText } : entry,
          )
        : [
            ...value.variableEntries,
            { id: crypto.randomUUID(), name, valueText },
          ],
    });
  }
  function importQuery() {
    if (!queryImport || disabled) return;
    const position = value.requests.findIndex(
      (request) => request.stepId === queryImport.stepId,
    );
    const request = value.requests[position];
    if (!request) return;
    try {
      const fields = queryImport.preview ?? parseQueryPaste(queryImport.source);
      if (fields.length + request.query.length > 200)
        throw Error('追加后启用的查询参数超过 200 项。');
      if (queryImport.preview) {
        update(position, { query: [...request.query, ...fields] });
        setQueryImport(undefined);
      } else {
        setQueryImport({ ...queryImport, preview: fields });
      }
    } catch (failure) {
      setQueryImport({ ...queryImport, error: describeError(failure) });
    }
  }

  function changeGraph(
    request: DraftRequest,
    index: number,
    parts: { query: string; variables: string; operationName: string },
  ) {
    setGraphParts((current) => ({ ...current, [request.stepId]: parts }));
    let bodyText = '';
    try {
      const variables: unknown = JSON.parse(parts.variables);
      if (
        variables &&
        typeof variables === 'object' &&
        !Array.isArray(variables) &&
        parts.query.trim()
      )
        bodyText = JSON.stringify(
          {
            query: parts.query,
            variables,
            ...(parts.operationName.trim() && {
              operationName: parts.operationName.trim(),
            }),
          },
          null,
          2,
        );
    } catch {
      // Invalid Variables remain in the typed input; the request cannot be saved until corrected.
    }
    update(index, { bodyText });
  }

  function bodyChoice(request: DraftRequest) {
    return (
      bodyChoices[request.stepId] ??
      (request.body.format === 'text' &&
      /^(?:application|text)\/xml$/i.test(request.body.mediaType)
        ? 'xml'
        : request.body.format)
    );
  }

  function chooseBody(request: DraftRequest, index: number, next: string) {
    const drafts = bodyDrafts.current.get(request.stepId) ?? new Map();
    drafts.set(bodyChoice(request), {
      body: request.body,
      bodyText: request.bodyText,
    });
    bodyDrafts.current.set(request.stepId, drafts);
    setBodyChoices((choices) => ({ ...choices, [request.stepId]: next }));
    const saved = drafts.get(next);
    if (saved) {
      update(index, saved);
      return;
    }
    if (next === 'graphql') {
      const payload = { query: '', variables: {} };
      update(index, {
        body: { format: 'json', value: payload },
        bodyText: '',
      });
    } else if (next === 'json') {
      update(index, { body: { format: 'json', value: {} }, bodyText: '{}' });
    } else if (next === 'multipart') {
      update(index, { body: { format: 'multipart', parts: [] }, bodyText: '' });
    } else if (next === 'binary') {
      update(index, {
        body: {
          format: 'binary',
          fileResourceId: '',
          mediaType: 'application/octet-stream',
        },
        bodyText: '',
      });
    } else if (next === 'form') {
      update(index, { body: { format: 'form', fields: [] }, bodyText: '' });
    } else if (next === 'text' || next === 'xml') {
      update(index, {
        body: {
          format: 'text',
          value: '',
          mediaType: next === 'xml' ? 'application/xml' : 'text/plain',
        },
        bodyText: '',
      });
    } else if (next === 'none') {
      update(index, { body: { format: 'none' }, bodyText: '' });
    }
  }

  function update(index: number, change: Partial<DraftRequest>) {
    onChange({
      ...value,
      requests: value.requests.map((request, at) =>
        at === index ? { ...request, ...change } : request,
      ),
    });
  }
  function move(index: number, offset: number) {
    const requests = [...value.requests];
    const [request] = requests.splice(index, 1);
    if (request) requests.splice(index + offset, 0, request);
    onChange({ ...value, requests });
  }
  const variableFields = (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Typography.Text type="secondary">
        仅保存非秘密测试数据；变量值为 JSON，可通过 case.变量名
        引用。重复名称和无效 JSON 会阻止保存。
      </Typography.Text>
      {value.variableEntries.map((entry, index) => (
        <Space.Compact block key={entry.id}>
          <Input
            aria-label={`用例变量 ${index + 1} 名称`}
            placeholder="变量名"
            value={entry.name}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...value,
                variableEntries: value.variableEntries.map((row) =>
                  row.id === entry.id
                    ? { ...row, name: event.target.value }
                    : row,
                ),
              })
            }
          />
          <Input
            aria-label={`用例变量 ${index + 1} JSON值`}
            placeholder='JSON值，如 2、"synthetic"、true'
            value={entry.valueText}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...value,
                variableEntries: value.variableEntries.map((row) =>
                  row.id === entry.id
                    ? { ...row, valueText: event.target.value }
                    : row,
                ),
              })
            }
          />
          <Button
            danger
            icon={<DeleteOutlined />}
            disabled={disabled}
            aria-label={`移除用例变量 ${index + 1}`}
            onClick={() =>
              onChange({
                ...value,
                variableEntries: value.variableEntries.filter(
                  (row) => row.id !== entry.id,
                ),
              })
            }
          />
        </Space.Compact>
      ))}
      <Button
        icon={<PlusOutlined />}
        disabled={disabled || value.variableEntries.length >= 200}
        onClick={() =>
          onChange({
            ...value,
            variableEntries: [
              ...value.variableEntries,
              { id: crypto.randomUUID(), name: '', valueText: '' },
            ],
          })
        }
      >
        添加用例变量
      </Button>
    </Space>
  );
  const requests = value.requests.map((request, index) => {
    if (workbench && currentStep !== request.stepId) return null;
    const options = variableOptions(
      value,
      [...upstreamRequests, ...value.requests.slice(0, index)],
      selectedEnvironment,
      resolvedPreparations,
    );
    const references = [
      ...new Set(apiTemplateReferences(request.url.split('?')[0])),
    ].filter((ref) => !ref.startsWith('env.baseUrls.'));
    const authMode =
      request.authMode ??
      (request.purposeRef || request.authProfileRef ? 'explicit' : 'none');
    const authProfile = configurations.find(
      (entry) => entry.id === request.authProfileRef,
    )?.content;
    const destination =
      authProfile?.kind === 'authProfile'
        ? authProfile.authentication.destination
        : undefined;
    const storedGraph =
      request.body.format === 'json' &&
      request.body.value &&
      typeof request.body.value === 'object' &&
      !Array.isArray(request.body.value)
        ? request.body.value
        : null;
    const graph = graphParts[request.stepId] ?? {
      query: typeof storedGraph?.query === 'string' ? storedGraph.query : '',
      variables: JSON.stringify(storedGraph?.variables ?? {}, null, 2),
      operationName:
        typeof storedGraph?.operationName === 'string'
          ? storedGraph.operationName
          : '',
    };
    return (
      <Card
        className={workbench ? 'workbench-request-card' : ''}
        key={request.stepId}
        size="small"
        title={
          workbench ? null : `${labelPrefix} ${index + 1} · ${request.name}`
        }
      >
        {workbench && (
          <div className="api-active-step-heading">
            <Input
              aria-label={labelPrefix + ' ' + (index + 1) + ' 名称'}
              variant="borderless"
              value={request.name}
              disabled={disabled}
              onChange={(event) => update(index, { name: event.target.value })}
            />
            <Button
              size="small"
              type="text"
              aria-label="上移此步骤"
              title="上移此步骤"
              icon={<ArrowUpOutlined />}
              disabled={disabled || index === 0}
              onClick={() => move(index, -1)}
            />
            <Button
              size="small"
              type="text"
              aria-label="下移此步骤"
              title="下移此步骤"
              icon={<ArrowDownOutlined />}
              disabled={disabled || index === value.requests.length - 1}
              onClick={() => move(index, 1)}
            />
            <Popconfirm
              title="移除此请求步骤？"
              okText="移除"
              cancelText="取消"
              onConfirm={() =>
                onChange({
                  ...value,
                  requests: value.requests.filter((_, at) => at !== index),
                })
              }
            >
              <Button
                size="small"
                type="text"
                danger
                aria-label="删除此步骤"
                title="删除此步骤"
                icon={<DeleteOutlined />}
                disabled={disabled || value.requests.length === 1}
              />
            </Popconfirm>
          </div>
        )}
        <Space.Compact
          block
          className={workbench ? 'api-active-method-url' : 'section-alert'}
        >
          {!workbench && (
            <Input
              aria-label={`${labelPrefix} ${index + 1} 名称`}
              value={request.name}
              disabled={disabled}
              onChange={(event) => update(index, { name: event.target.value })}
              placeholder="请求名称"
            />
          )}
          <Select
            aria-label={`${labelPrefix} ${index + 1} HTTP方法`}
            style={{ minWidth: workbench ? 88 : 120, flex: '0 0 auto' }}
            value={request.method}
            disabled={disabled}
            options={httpMethodSchema.options.map((method) => ({
              value: method,
              label: method,
            }))}
            onChange={(method: Request['method']) => update(index, { method })}
          />
          <VariableField
            label={`${labelPrefix} ${index + 1} URL`}
            value={request.url}
            disabled={disabled}
            options={options}
            onChange={(url) => update(index, { url })}
            placeholder="被测接口 URL 或已定义环境变量引用"
          />
        </Space.Compact>
        {workbench && (
          <Space wrap className="api-request-inline-actions">
            <Button
              type="link"
              size="small"
              onClick={() => {
                try {
                  setRequestPreview({
                    text: JSON.stringify(
                      safeRequestDraftPreview(request),
                      null,
                      2,
                    ),
                  });
                } catch {
                  setRequestPreview({
                    error: '请求体结构需要修正后才能预览。',
                  });
                }
              }}
            >
              请求预览
            </Button>
            {onSingleDiagnostic && (
              <Button
                size="small"
                disabled={disabled}
                onClick={() => onSingleDiagnostic(request.stepId)}
              >
                单步诊断
              </Button>
            )}
          </Space>
        )}
        <RequestSections
          workbench={workbench}
          {...(ruleFocus?.stepId === request.stepId
            ? { focus: ruleFocus }
            : {})}
          items={[
            {
              key: 'configuration',
              label: '账号用途与认证',
              children: (
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Select
                    aria-label={`${labelPrefix} ${index + 1} 认证方式`}
                    value={authMode}
                    disabled={disabled}
                    style={{ width: '100%' }}
                    options={[
                      { value: 'none', label: '无需认证' },
                      {
                        value: 'inherit',
                        label: '继承固定接口来源',
                        disabled: !request.source,
                      },
                      { value: 'explicit', label: '手工选择项目认证' },
                    ]}
                    onChange={(mode: NonNullable<DraftRequest['authMode']>) =>
                      update(
                        index,
                        mode === 'explicit'
                          ? { authMode: mode }
                          : {
                              authMode: mode,
                              purposeRef: undefined,
                              authProfileRef: undefined,
                            },
                      )
                    }
                  />
                  {authMode === 'inherit' && (
                    <div className="stack">
                      <span className="caption">
                        诊断读取本步骤固定接口修订的认证定义。若上级没有明确认证，需手工选择用途或无需认证。
                      </span>
                      {request.source && (
                        <Button
                          size="small"
                          type="link"
                          href={
                            '#api-catalog?' +
                            new URLSearchParams({
                              projectId: request.source.projectId,
                              endpointId: request.source.interfaceId,
                              revisionId: request.source.revisionId,
                            })
                          }
                        >
                          查看固定认证来源
                        </Button>
                      )}
                    </div>
                  )}
                  {authMode === 'explicit' && (
                    <>
                      <Select
                        aria-label={`${labelPrefix} ${index + 1} 账号用途`}
                        value={request.purposeRef}
                        allowClear
                        showSearch
                        optionFilterProp="label"
                        loading={configurationLoading}
                        disabled={disabled}
                        style={{ width: '100%' }}
                        options={referenceOptions(
                          'purpose',
                          request.purposeRef,
                        )}
                        placeholder="不指定账号用途"
                        onChange={(id: string | undefined) =>
                          update(index, { purposeRef: id })
                        }
                      />
                      <Select
                        aria-label={`${labelPrefix} ${index + 1} 认证定义`}
                        value={request.authProfileRef}
                        allowClear
                        showSearch
                        optionFilterProp="label"
                        loading={configurationLoading}
                        disabled={disabled}
                        style={{ width: '100%' }}
                        options={referenceOptions(
                          'authProfile',
                          request.authProfileRef,
                        )}
                        placeholder="不指定认证定义；不自动借用其他账号"
                        onChange={(id: string | undefined) =>
                          update(index, { authProfileRef: id })
                        }
                      />
                    </>
                  )}
                </Space>
              ),
            },
            {
              key: 'settings',
              label: '设置',
              children: (
                <div className="stack">
                  <Space wrap>
                    <Typography.Text>单次请求超时（毫秒）</Typography.Text>
                    <InputNumber<number>
                      aria-label={`${labelPrefix} ${index + 1} 超时毫秒`}
                      min={100}
                      max={120000}
                      step={100}
                      precision={0}
                      value={request.timeoutMs ?? null}
                      disabled={disabled}
                      placeholder="平台默认"
                      onChange={(number) =>
                        update(index, { timeoutMs: number ?? undefined })
                      }
                    />
                    <Typography.Text type="secondary">
                      100～120000；不自动重试。
                    </Typography.Text>
                  </Space>
                  <p className="caption">
                    TLS 验证、目标范围与业务请求重试遵循当前项目执行规则。GET 和
                    HEAD 不支持请求体。
                  </p>
                  {onValidate && (
                    <Button size="small" onClick={onValidate}>
                      结构检查
                    </Button>
                  )}
                </div>
              ),
            },
            {
              key: 'cookies',
              label: 'Cookies',
              children: (
                <div className="stack">
                  {destination?.location === 'cookie' && (
                    <strong>
                      {authProfile?.name} · {destination.name}
                    </strong>
                  )}
                  <p className="caption">
                    {destination?.location === 'cookie'
                      ? '所选认证将按环境和账号用途注入此 Cookie。'
                      : '当前请求未明确引用 Cookie 注入的认证定义。实际认证按项目环境与账号用途解析。'}
                    此处不显示凭据或会话值。
                  </p>
                </div>
              ),
            },
            {
              key: 'parameters',
              label: '参数',
              children: (
                <div className="stack">
                  <strong>Path</strong>
                  {!references.length && (
                    <p className="caption">
                      未引用路径变量。可在上方 URL 插入当前可用的变量。
                    </p>
                  )}
                  {references.length > 0 && (
                    <table className="kv">
                      <thead>
                        <tr>
                          <th>引用</th>
                          <th>来源 / 用例默认值</th>
                        </tr>
                      </thead>
                      <tbody>
                        {references.map((reference) => {
                          const variable =
                            reference.startsWith('case.') &&
                            variableNameSchema.safeParse(reference.slice(5));
                          const owned =
                            variable && variable.success
                              ? variable.data
                              : undefined;
                          return (
                            <tr key={reference}>
                              <td>
                                <code>{reference}</code>
                              </td>
                              <td>
                                {owned ? (
                                  <Input
                                    aria-label={'Path 变量默认值 ' + owned}
                                    title="修改当前用例的默认变量，所选数据行仍可覆盖。"
                                    placeholder='用例 JSON 值，例如 "TKT-01"'
                                    value={
                                      value.variableEntries.find(
                                        (entry) => entry.name === owned,
                                      )?.valueText ?? ''
                                    }
                                    onChange={(event) =>
                                      setPathVariable(owned, event.target.value)
                                    }
                                    disabled={disabled}
                                  />
                                ) : (
                                  <span>
                                    {options.find(
                                      (option) => option.value === reference,
                                    )?.label ?? '当前尚未解析'}
                                  </span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                  <NamedValues
                    label="Query"
                    values={request.query}
                    disabled={disabled}
                    options={options}
                    onChange={(query) => update(index, { query })}
                    {...(workbench
                      ? {
                          onDisable: (at: number) => {
                            const field = request.query[at];
                            if (field)
                              update(index, {
                                query: request.query.filter(
                                  (_, position) => position !== at,
                                ),
                                disabledQuery: [
                                  ...(request.disabledQuery ?? []),
                                  { index: at, field },
                                ],
                              });
                          },
                        }
                      : {})}
                  />
                  {Boolean(request.disabledQuery?.length) && (
                    <div className="stack">
                      <strong>停用的 Query 参数</strong>
                      {request.disabledQuery?.map(
                        ({ index: original, field }, at) => (
                          <Space key={at} wrap>
                            <span>{field.name}</span>
                            <Button
                              disabled={disabled || request.query.length >= 200}
                              size="small"
                              onClick={() => {
                                const query = [...request.query];
                                query.splice(original, 0, field);
                                update(index, {
                                  query,
                                  disabledQuery:
                                    request.disabledQuery?.filter(
                                      (_, position) => position !== at,
                                    ) ?? [],
                                });
                              }}
                            >
                              启用
                            </Button>
                            <Button
                              disabled={disabled}
                              size="small"
                              onClick={() => {
                                update(index, {
                                  disabledQuery:
                                    request.disabledQuery?.filter(
                                      (_, position) => position !== at,
                                    ) ?? [],
                                });
                              }}
                            >
                              移除
                            </Button>
                          </Space>
                        ),
                      )}
                      <p className="caption">
                        停用项仅在当前草稿保留，保存和执行只采用启用项。
                      </p>
                    </div>
                  )}
                  {workbench && (
                    <Button
                      disabled={disabled || request.query.length >= 200}
                      size="small"
                      onClick={() =>
                        setQueryImport({
                          stepId: request.stepId,
                          source: '',
                        })
                      }
                    >
                      批量粘贴 Query
                    </Button>
                  )}
                </div>
              ),
            },
            {
              key: 'headers',
              label: '请求头',
              children: (
                <NamedValues
                  label="Header"
                  values={request.headers}
                  disabled={disabled}
                  options={options}
                  onChange={(headers) => update(index, { headers })}
                />
              ),
            },
            {
              key: 'body',
              label: `Body · ${request.body.format}`,
              children: (
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Select
                    aria-label={`${labelPrefix} ${index + 1} Body格式`}
                    value={bodyChoice(request)}
                    disabled={disabled}
                    options={[
                      { value: 'none', label: 'none' },
                      { value: 'json', label: 'JSON' },
                      { value: 'form', label: 'x-www-form-urlencoded' },
                      { value: 'multipart', label: 'form-data' },
                      { value: 'binary', label: 'Binary' },
                      { value: 'xml', label: 'XML' },
                      { value: 'graphql', label: 'GraphQL JSON' },
                      { value: 'text', label: 'Raw' },
                    ]}
                    onChange={(format: string) =>
                      chooseBody(request, index, format)
                    }
                  />
                  {request.body.format === 'text' && (
                    <Input
                      aria-label="请求体媒体类型"
                      value={request.body.mediaType}
                      disabled={disabled || bodyChoice(request) === 'xml'}
                      onChange={(event) => {
                        if (request.body.format === 'text')
                          update(index, {
                            body: {
                              ...request.body,
                              mediaType: event.target.value,
                            },
                          });
                      }}
                    />
                  )}
                  {bodyChoice(request) === 'graphql' ? (
                    <div className="stack">
                      <VariableField
                        label="GraphQL Query"
                        format="text"
                        value={graph.query}
                        disabled={disabled}
                        options={options}
                        onChange={(query) =>
                          changeGraph(request, index, { ...graph, query })
                        }
                      />
                      <Input
                        aria-label="GraphQL Operation Name"
                        placeholder="Operation Name（可选）"
                        disabled={disabled}
                        value={graph.operationName}
                        onChange={(event) =>
                          changeGraph(request, index, {
                            ...graph,
                            operationName: event.target.value,
                          })
                        }
                      />
                      <VariableField
                        label="GraphQL Variables"
                        format="json"
                        value={graph.variables}
                        disabled={disabled}
                        options={options}
                        onChange={(variables) =>
                          changeGraph(request, index, {
                            ...graph,
                            variables,
                          })
                        }
                      />
                      <p className="caption">
                        以 JSON 请求体传输 query 与 variables。Variables 须为
                        JSON 对象。
                      </p>
                    </div>
                  ) : request.body.format === 'json' ||
                    request.body.format === 'text' ? (
                    <>
                      <VariableField
                        label={labelPrefix + ' ' + (index + 1) + ' Body内容'}
                        format={request.body.format}
                        value={request.bodyText}
                        disabled={disabled}
                        options={options}
                        onChange={(bodyText) => update(index, { bodyText })}
                      />
                      {request.body.format === 'json' && (
                        <Button
                          size="small"
                          disabled={disabled}
                          onClick={() => {
                            try {
                              const parsed: unknown = JSON.parse(
                                request.bodyText,
                              );
                              update(index, {
                                bodyText: JSON.stringify(parsed, null, 2),
                              });
                            } catch {
                              setRequestPreview({
                                error: 'JSON 格式无效，请修正后重新格式化。',
                              });
                            }
                          }}
                        >
                          格式化 JSON
                        </Button>
                      )}
                    </>
                  ) : null}
                  {request.body.format === 'multipart' &&
                    request.headers.some(
                      (header) => header.name.toLowerCase() === 'content-type',
                    ) && (
                      <Alert
                        type="warning"
                        showIcon
                        title="form-data 的 Content-Type 和 boundary 由 Worker 设置。"
                        action={
                          <Button
                            size="small"
                            disabled={disabled}
                            onClick={() =>
                              update(index, {
                                headers: request.headers.filter(
                                  (header) =>
                                    header.name.toLowerCase() !==
                                    'content-type',
                                ),
                              })
                            }
                          >
                            移除手工 Content-Type
                          </Button>
                        }
                      />
                    )}
                  {request.body.format === 'multipart' && (
                    <ApiMultipartFields
                      projectId={projectId}
                      parts={request.body.parts}
                      disabled={disabled}
                      variableOptions={options}
                      onChange={(parts) =>
                        update(index, {
                          body: { format: 'multipart', parts },
                        })
                      }
                    />
                  )}
                  {request.body.format === 'binary' && (
                    <ApiBinaryFields
                      projectId={projectId}
                      maximumBytes={multipartMaxFileBytes}
                      disabled={disabled}
                      fileResourceId={request.body.fileResourceId}
                      mediaType={request.body.mediaType}
                      onChange={(body) => update(index, { body })}
                    />
                  )}
                  {request.body.format === 'form' && (
                    <NamedValues
                      label="表单字段"
                      values={request.body.fields}
                      disabled={disabled}
                      options={options}
                      onChange={(fields) =>
                        update(index, {
                          body: { format: 'form', fields },
                        })
                      }
                    />
                  )}
                </Space>
              ),
            },
            {
              key: 'assertions',
              label: `断言 · ${request.assertions.length}`,
              children: (
                <Space direction="vertical" style={{ width: '100%' }}>
                  {request.assertions.map((assertion, at) => (
                    <Space
                      direction="vertical"
                      key={assertion.id}
                      className="assertion-editor"
                    >
                      <Space wrap>
                        <Select
                          aria-label={`${labelPrefix} ${index + 1} 断言 ${at + 1} 来源`}
                          value={assertion.source}
                          disabled={disabled}
                          options={[
                            { value: 'status', label: 'HTTP 状态' },
                            { value: 'elapsedMs', label: '响应耗时（毫秒）' },
                            { value: 'json', label: 'JSON 路径' },
                            { value: 'xml', label: 'XML 元素' },
                            { value: 'header', label: '响应头' },
                            { value: 'body', label: '响应正文' },
                            { value: 'variable', label: '变量' },
                            {
                              value: 'contract',
                              label: '响应契约',
                              disabled: !request.source,
                            },
                          ]}
                          onChange={(source: Assertion['source']) =>
                            update(index, {
                              assertions: request.assertions.map(
                                (item, pos) => {
                                  if (pos !== at) return item;
                                  const { path: _path, ...base } = item;
                                  return {
                                    ...base,
                                    source,
                                    operator: 'equals',
                                    expectedText:
                                      source === 'contract' ? 'true' : '',
                                  };
                                },
                              ),
                            })
                          }
                        />
                        {!['status', 'elapsedMs', 'contract', 'body'].includes(
                          assertion.source,
                        ) && (
                          <Input
                            aria-label={`${labelPrefix} ${index + 1} 断言 ${at + 1} 路径`}
                            placeholder={
                              assertion.source === 'xml'
                                ? '/order/items/item[2]'
                                : 'JSON/响应头/变量路径'
                            }
                            value={assertion.path ?? ''}
                            disabled={disabled}
                            onChange={(event) =>
                              update(index, {
                                assertions: request.assertions.map(
                                  (item, pos) =>
                                    pos === at
                                      ? {
                                          ...item,
                                          path: event.target.value,
                                        }
                                      : item,
                                ),
                              })
                            }
                          />
                        )}
                        <Select
                          aria-label={`${labelPrefix} ${index + 1} 断言 ${at + 1} 运算符`}
                          value={assertion.operator}
                          disabled={disabled || assertion.source === 'contract'}
                          options={assertionOperatorSchema.options
                            .filter((operator) => {
                              if (assertion.source === 'contract')
                                return operator === 'equals';
                              if (assertion.source === 'elapsedMs')
                                return [
                                  'equals',
                                  'notEquals',
                                  'greaterThan',
                                  'lessThan',
                                  'exists',
                                ].includes(operator);
                              if (assertion.source === 'xml')
                                return [
                                  'equals',
                                  'notEquals',
                                  'contains',
                                  'matches',
                                  'exists',
                                ].includes(operator);
                              return true;
                            })
                            .map((operator) => ({
                              value: operator,
                              label: operator,
                            }))}
                          onChange={(operator: Assertion['operator']) =>
                            update(index, {
                              assertions: request.assertions.map((item, pos) =>
                                pos === at ? { ...item, operator } : item,
                              ),
                            })
                          }
                        />
                        <Button
                          aria-label={`移除${labelPrefix} ${index + 1} 断言 ${at + 1}`}
                          danger
                          icon={<DeleteOutlined />}
                          disabled={disabled}
                          onClick={() =>
                            update(index, {
                              assertions: request.assertions.filter(
                                (_, pos) => pos !== at,
                              ),
                            })
                          }
                        />
                      </Space>
                      {assertion.operator !== 'exists' && (
                        <Input
                          aria-label={`${labelPrefix} ${index + 1} 断言 ${at + 1} 预期JSON值`}
                          placeholder={
                            assertion.source === 'contract'
                              ? 'true 或 false'
                              : assertion.source === 'elapsedMs'
                                ? '非负毫秒数'
                                : 'JSON 预期值，如 200、"ok"、true'
                          }
                          value={assertion.expectedText}
                          disabled={disabled}
                          onChange={(event) =>
                            update(index, {
                              assertions: request.assertions.map((item, pos) =>
                                pos === at
                                  ? {
                                      ...item,
                                      expectedText: event.target.value,
                                    }
                                  : item,
                              ),
                            })
                          }
                        />
                      )}
                    </Space>
                  ))}
                  <Button
                    icon={<PlusOutlined />}
                    disabled={disabled || request.assertions.length >= 200}
                    onClick={() =>
                      update(index, {
                        assertions: [
                          ...request.assertions,
                          {
                            id: crypto.randomUUID(),
                            source: 'status',
                            operator: 'equals',
                            expectedText: '',
                          },
                        ],
                      })
                    }
                  >
                    添加业务断言
                  </Button>
                </Space>
              ),
            },
            {
              key: 'extractors',
              label: `变量提取 · ${request.extractors.length}`,
              children: (
                <Space direction="vertical" style={{ width: '100%' }}>
                  {request.extractors.map((extractor, at) => (
                    <Space wrap key={at}>
                      <Input
                        aria-label={`提取变量名 ${at + 1}`}
                        placeholder="变量名"
                        disabled={disabled}
                        value={extractor.name}
                        onChange={(event) =>
                          update(index, {
                            extractors: request.extractors.map((item, pos) =>
                              pos === at
                                ? { ...item, name: event.target.value }
                                : item,
                            ),
                          })
                        }
                      />
                      <Select
                        value={extractor.source}
                        aria-label={`提取来源 ${at + 1}`}
                        disabled={disabled}
                        options={['json', 'header', 'status', 'body'].map(
                          (source) => ({ value: source, label: source }),
                        )}
                        onChange={(
                          source: Request['extractors'][number]['source'],
                        ) =>
                          update(index, {
                            extractors: request.extractors.map((item, pos) =>
                              pos === at ? { ...item, source } : item,
                            ),
                          })
                        }
                      />
                      <Input
                        aria-label={`提取路径 ${at + 1}`}
                        placeholder="路径"
                        disabled={disabled}
                        value={extractor.path ?? ''}
                        onChange={(event) =>
                          update(index, {
                            extractors: request.extractors.map((item, pos) =>
                              pos === at
                                ? { ...item, path: event.target.value }
                                : item,
                            ),
                          })
                        }
                      />
                      <Checkbox
                        checked={extractor.required}
                        disabled={disabled}
                        onChange={(event) =>
                          update(index, {
                            extractors: request.extractors.map((item, pos) =>
                              pos === at
                                ? {
                                    ...item,
                                    required: event.target.checked,
                                  }
                                : item,
                            ),
                          })
                        }
                      >
                        必须提取
                      </Checkbox>
                      <Checkbox
                        checked={extractor.sensitive === true}
                        disabled={disabled}
                        onChange={(event) =>
                          update(index, {
                            extractors: request.extractors.map((item, pos) =>
                              pos === at
                                ? {
                                    ...item,
                                    sensitive: event.target.checked,
                                  }
                                : item,
                            ),
                          })
                        }
                      >
                        敏感文本
                      </Checkbox>
                      <Button
                        aria-label={`移除变量提取 ${at + 1}`}
                        danger
                        icon={<DeleteOutlined />}
                        disabled={disabled}
                        onClick={() =>
                          update(index, {
                            extractors: request.extractors.filter(
                              (_, pos) => pos !== at,
                            ),
                          })
                        }
                      />
                    </Space>
                  ))}
                  <Button
                    icon={<PlusOutlined />}
                    disabled={disabled || request.extractors.length >= 100}
                    onClick={() =>
                      update(index, {
                        extractors: [
                          ...request.extractors,
                          { name: '', source: 'json', required: true },
                        ],
                      })
                    }
                  >
                    添加变量提取
                  </Button>
                  <Typography.Text type="secondary">
                    敏感提取值只在本次用例的请求变量中使用，报告和脚本只显示遮蔽值。
                  </Typography.Text>
                </Space>
              ),
            },
            ...(['preScript', 'postScript'] as const).map((field) => ({
              key: field,
              label: field === 'preScript' ? '前置操作' : '后置操作',
              children: (
                <Space orientation="vertical" style={{ width: '100%' }}>
                  <ApiRequestStageFields
                    projectId={projectId}
                    source={request.source}
                    value={request.stageSettings}
                    phase={field === 'preScript' ? 'pre' : 'post'}
                    disabled={disabled}
                    onChange={(stageSettings) =>
                      update(index, { stageSettings })
                    }
                  />
                  {request[field] && (
                    <Input.TextArea
                      aria-label={
                        labelPrefix +
                        ' ' +
                        (index + 1) +
                        (field === 'preScript'
                          ? ' 前处理脚本'
                          : ' 响应处理脚本')
                      }
                      rows={5}
                      value={request[field] ?? ''}
                      disabled={disabled}
                      maxLength={64000}
                      onChange={(event) =>
                        update(index, { [field]: event.target.value })
                      }
                    />
                  )}
                </Space>
              ),
            })),
          ]}
        />
      </Card>
    );
  });
  const warningFields = (
    <>
      {configurationError && (
        <Alert
          type="warning"
          showIcon
          title={`环境、账号用途或认证目录未完整取得：${configurationError}`}
          description="原引用继续保留，不自动替换或切换账号。"
        />
      )}
      {variableIssues.length > 0 && (
        <Alert
          type="error"
          showIcon
          title="变量引用预检未通过"
          description={
            <ul>
              {variableIssues.slice(0, 5).map((issue) => (
                <li key={`${issue.path.join(':')}:${issue.message}`}>
                  {issue.path.join('/')}：{issue.message}
                </li>
              ))}
            </ul>
          }
        />
      )}
      {variant === 'business' &&
        currentPreparations &&
        !resolvedPreparations && (
          <Alert
            type="warning"
            showIcon
            title="准备步骤的固定修订未加载，请检查用例与修订引用。"
          />
        )}
    </>
  );
  const environmentControl = (
    <Select
      aria-label="变量预检环境"
      className="api-workbench-environment"
      allowClear
      disabled={disabled}
      loading={configurationLoading}
      value={pickedEnvironmentId}
      options={environments.map((entry) => ({
        value: entry.id,
        label: entry.content.name,
      }))}
      placeholder="选择诊断环境"
      {...(onPreviewEnvironmentChange
        ? { onChange: onPreviewEnvironmentChange }
        : {})}
    />
  );
  const cleanupFields = (
    <ApiCleanupFields
      expanded={workbench}
      projectId={projectId}
      value={value}
      onChange={onChange}
      disabled={disabled}
      previewEnvironmentId={pickedEnvironmentId}
      preparationVariables={resolvedPreparations}
    />
  );
  if (workbench) {
    const panels = {
      data: workspacePanels?.data,
      variables: variableFields,
      cleanup: cleanupFields,
      revisions: workspacePanels?.revisions,
      sources: workspacePanels?.sources,
    };
    const paneOrder = [
      'data',
      'variables',
      'cleanup',
      'sources',
      'revisions',
    ] as const;
    const indicators = {
      data: value.base.dataRows?.length ?? 0,
      variables: value.variableEntries.length,
      cleanup:
        value.cleanupDraft.mode === 'none'
          ? '未配置'
          : value.cleanupDraft.steps.length,
      revisions: undefined,
      sources: value.requests.filter((request) => request.source).length,
    };
    const paneIcons = {
      data: 'calendar',
      variables: 'api',
      cleanup: 'check',
      revisions: 'book',
      sources: 'api',
    } as const;
    return (
      <div className="api-proto-fields">
        {environmentHost && createPortal(environmentControl, environmentHost)}
        <aside
          className="api-proto-pane api-sequence-pane"
          aria-label="执行编排"
        >
          <div className="api-proto-pane-heading">
            <h2>执行编排</h2>
            <Dropdown
              trigger={['click']}
              disabled={disabled || value.requests.length >= maxRequests}
              menu={{
                items: [
                  { key: 'manual', label: '手工添加请求' },
                  { key: 'curl', label: '导入 cURL' },
                  ...(panels.sources
                    ? [{ key: 'source', label: '从接口定义新增请求' }]
                    : []),
                ],
                onClick: ({ key }) => {
                  if (key === 'curl') setCurlOpen(true);
                  else if (key === 'source') showPane('sources');
                  else if (key === 'manual') {
                    const request = newRequest();
                    onChange({
                      ...value,
                      requests: [...value.requests, request],
                    });
                    setActiveStep(request.stepId);
                    setActivePane('request');
                  }
                },
              }}
            >
              <Button
                type="text"
                size="small"
                aria-label="添加请求步骤"
                icon={<PlusOutlined />}
              />
            </Dropdown>
          </div>
          <div className="api-proto-scroll api-sequence-scroll">
            <div className="api-proto-small-label">
              请求步骤 · {value.requests.length}
            </div>
            {value.requests.map((request, index) => (
              <button
                type="button"
                key={request.stepId}
                aria-current={
                  activePane === 'request' && currentStep === request.stepId
                    ? 'step'
                    : undefined
                }
                className={`api-sequence-step${activePane === 'request' && currentStep === request.stepId ? ' selected' : ''}`}
                title={request.method + ' ' + request.url}
                onClick={() => {
                  setActiveStep(request.stepId);
                  setActivePane('request');
                }}
              >
                <span className="api-sequence-number">{index + 1}</span>
                <span className="api-sequence-text">
                  <strong>{request.name}</strong>
                  <span className="api-sequence-url">
                    <b>{request.method}</b> {request.url}
                  </span>
                </span>
              </button>
            ))}
            <div className="api-proto-small-label">用例设置</div>
            {paneOrder.map((pane) =>
              panels[pane] ? (
                <button
                  key={pane}
                  type="button"
                  aria-pressed={activePane === pane}
                  className={`api-sequence-link${activePane === pane ? ' selected' : ''}`}
                  onClick={() => showPane(pane)}
                >
                  <AppIcon name={paneIcons[pane]} />
                  <span>{paneTitles[pane]}</span>
                  {indicators[pane] !== undefined && (
                    <small>{indicators[pane]}</small>
                  )}
                </button>
              ) : null,
            )}
          </div>
          {workspaceSummary && (
            <div className="api-proto-pane-foot">{workspaceSummary}</div>
          )}
        </aside>
        <section
          className="api-proto-pane api-request-pane"
          aria-label={
            activePane === 'request' ? '请求配置' : paneTitles[activePane]
          }
        >
          {activePane !== 'request' && (
            <div className="api-proto-pane-heading">
              <h2>{paneTitles[activePane]}</h2>
            </div>
          )}
          <div className="api-proto-scroll api-request-scroll">
            {activePane === 'request' && (
              <>
                {warningFields}
                {requests}
                {!value.requests.length && (
                  <p className="api-proof-placeholder">
                    还没有请求步骤。使用左侧添加手工请求、cURL 或接口定义。
                  </p>
                )}
              </>
            )}
            {[...openedPanes].map((pane) =>
              pane === 'request' ? null : (
                <div
                  key={pane}
                  hidden={activePane !== pane}
                  className="api-request-global"
                >
                  {panels[pane]}
                </div>
              ),
            )}
          </div>
        </section>
        <Modal
          zIndex={uiLayers.dialog}
          title={curlPreview ? '预览 cURL 字段映射' : '导入 cURL 配置'}
          open={curlOpen}
          onCancel={() => {
            setCurlOpen(false);
            setCurlPreview(undefined);
            setCurlError(undefined);
            setCurlText('');
          }}
          onOk={confirmCurl}
          okText={curlPreview ? '添加为请求草稿' : '预览导入'}
          destroyOnHidden
        >
          <Space orientation="vertical" style={{ width: '100%' }}>
            {curlPreview ? (
              <>
                <Alert
                  type="info"
                  showIcon
                  title="采用相对路径。实际执行仍使用当前项目认可的环境；多基址时在步骤中明确引用。"
                />
                <pre className="message-code">
                  {JSON.stringify(
                    {
                      method: curlPreview.method,
                      path: curlPreview.url,
                      query: curlPreview.query,
                      headers: curlPreview.headers,
                      body: curlPreview.body,
                    },
                    null,
                    2,
                  )}
                </pre>
                <Button onClick={() => setCurlPreview(undefined)}>
                  返回修改
                </Button>
              </>
            ) : (
              <>
                <Input.TextArea
                  rows={6}
                  spellCheck={false}
                  maxLength={12000}
                  aria-label="cURL 文本"
                  value={curlText}
                  onChange={(event) => setCurlText(event.target.value)}
                />
                <p className="caption">
                  带入方法、相对路径、查询、普通头及内联 JSON 或 URL
                  编码表单。项目认证和目标环境独立配置。
                </p>
              </>
            )}
            {curlError && <Alert type="error" showIcon title={curlError} />}
          </Space>
        </Modal>
        <Modal
          title="请求配置预览"
          open={Boolean(requestPreview)}
          onCancel={() => setRequestPreview(undefined)}
          footer={
            <Button onClick={() => setRequestPreview(undefined)}>关闭</Button>
          }
        >
          <p className="caption">
            显示脱敏后的工作稿配置。变量与项目环境在实际诊断时解析。
          </p>
          {requestPreview?.error ? (
            <Alert type="warning" showIcon title={requestPreview.error} />
          ) : (
            <pre className="message-code">{requestPreview?.text}</pre>
          )}
        </Modal>
        <Modal
          title="批量粘贴 Query 参数"
          open={Boolean(queryImport)}
          onCancel={() => setQueryImport(undefined)}
          onOk={importQuery}
          okText={queryImport?.preview ? '追加到请求草稿' : '预览查询参数'}
          destroyOnHidden
        >
          <div className="stack">
            {queryImport?.preview ? (
              <pre className="message-code">
                {JSON.stringify(queryImport.preview, null, 2)}
              </pre>
            ) : (
              <Input.TextArea
                aria-label="批量查询参数"
                rows={5}
                maxLength={12000}
                placeholder="name=value"
                value={queryImport?.source ?? ''}
                onChange={(event) =>
                  queryImport &&
                  setQueryImport({
                    stepId: queryImport.stepId,
                    source: event.target.value,
                  })
                }
              />
            )}
            <p className="caption">
              接受每行 name=value 或一段 URL
              编码的查询参数。确认时按输入次序追加，原参数保留。
            </p>
            {queryImport?.error && (
              <Alert type="error" showIcon title={queryImport.error} />
            )}
          </div>
        </Modal>
      </div>
    );
  }
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {warningFields}
      <Button
        disabled={disabled || configurationLoading}
        onClick={() => setConfigurationRefresh((value) => value + 1)}
      >
        刷新账号用途与认证目录
      </Button>
      {requests}
    </Space>
  );
}
