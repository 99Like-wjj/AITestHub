import {
  Alert,
  Button,
  Card,
  Checkbox,
  Collapse,
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
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  assertionOperatorSchema,
  apiCaseContentSchema,
  httpMethodSchema,
} from '../../../packages/contracts/src/domain';
import { assetDetailSchema } from '../../../packages/contracts/src/assets';
import { testConfigurationListSchema } from '../../../packages/contracts/src/test-configuration';
import type { TestConfigurationView } from '../../../packages/contracts/src/test-configuration';
import { api, describeError } from './api';
import { ApiCleanupFields } from './api-cleanup-fields';
import { AppIcon } from './app-icon';
import { uiLayers } from './ui-layers';

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
}: {
  items: { key: string; label: ReactNode; children: ReactNode }[];
  workbench: boolean;
}) {
  const order = [
    'parameters',
    'headers',
    'configuration',
    'body',
    'extractors',
    'assertions',
    'scripts',
    'cleanup',
    'documentation',
  ];
  const labels: Record<string, string> = {
    parameters: '参数',
    headers: '请求头',
    configuration: '认证',
    body: '请求体',
    extractors: '提取变量',
    assertions: '断言',
    scripts: '脚本扩展',
  };
  return workbench ? (
    <Tabs
      className="request-section-tabs"
      defaultActiveKey="parameters"
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
}: {
  label: string;
  values: { name: string; value: string }[];
  onChange: (values: { name: string; value: string }[]) => void;
  disabled: boolean;
  options: ApiVariableOption[];
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

export function ApiCaseFields({
  projectId,
  variant = 'business',
  labelPrefix = '请求',
  value,
  onChange,
  disabled,
  presentation = 'stacked',
  documentation,
  previewEnvironmentId,
  onPreviewEnvironmentChange,
  upstreamRequests = [],
  preparationVariables,
}: {
  projectId: string;
  variant?: 'business' | 'cleanup';
  labelPrefix?: string;
  value: ApiDraft;
  onChange: (value: ApiDraft) => void;
  disabled: boolean;
  presentation?: 'stacked' | 'workbench';
  documentation?: ReactNode;
  previewEnvironmentId?: string | undefined;
  onPreviewEnvironmentChange?: (id: string | undefined) => void;
  upstreamRequests?: readonly DraftRequest[];
  preparationVariables?: ApiPreparationVariables | undefined;
}) {
  const workbench = presentation === 'workbench';
  const [activeStep, setActiveStep] = useState(value.requests[0]?.stepId);
  const [settingsStep, setSettingsStep] = useState<string | null>(null);
  const currentStep = value.requests.some(
    (request) => request.stepId === activeStep,
  )
    ? activeStep
    : value.requests[0]?.stepId;
  const [configurations, setConfigurations] = useState<TestConfigurationView[]>(
    [],
  );
  const [configurationError, setConfigurationError] = useState<string>();
  const [configurationLoading, setConfigurationLoading] = useState(false);
  const [configurationRefresh, setConfigurationRefresh] = useState(0);
  const [localEnvironmentId, setLocalEnvironmentId] = useState<string>();
  const pickedEnvironmentId =
    onPreviewEnvironmentChange || variant === 'cleanup'
      ? previewEnvironmentId
      : localEnvironmentId;
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
    <Collapse
      items={[
        {
          key: 'variables',
          label: `用例变量 · ${value.variableEntries.length}`,
          children: (
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
          ),
        },
      ]}
    />
  );
  return (
    <Space
      direction="vertical"
      size="middle"
      className={workbench ? 'api-inline-fields' : ''}
      style={{ width: '100%' }}
    >
      {!workbench && (
        <Typography.Paragraph type="secondary">
          一个用例内的请求按序维护。这里只保存权威
          DSL，不发送请求；断言应判断业务预期。账号用途与认证只保存配置引用，不填写真实凭据。清理现有配置完整保留。
        </Typography.Paragraph>
      )}
      {configurationError && (
        <Alert
          type="warning"
          showIcon
          title={`环境、账号用途或认证目录未完整取得：${configurationError}`}
          description="原引用继续保留，不自动替换或切换账号。"
        />
      )}
      {variant === 'business' && (
        <Space wrap>
          <Typography.Text type="secondary">变量预检环境</Typography.Text>
          <Select
            aria-label="变量预检环境"
            style={{ minWidth: 210, maxWidth: '100%' }}
            allowClear
            disabled={disabled}
            loading={configurationLoading}
            value={pickedEnvironmentId}
            options={environments.map((entry) => ({
              value: entry.id,
              label: entry.content.name,
            }))}
            placeholder="选择环境后可插入公共变量"
            onChange={onPreviewEnvironmentChange ?? setLocalEnvironmentId}
          />
        </Space>
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
      {!workbench && (
        <Button
          disabled={disabled || configurationLoading}
          onClick={() => setConfigurationRefresh((value) => value + 1)}
        >
          刷新账号用途与认证目录
        </Button>
      )}
      {workbench && (
        <div className="request-steps">
          {value.requests.map((request, index) => (
            <button
              type="button"
              className={`request-step ${currentStep === request.stepId ? 'active' : ''}`}
              key={request.stepId}
              onClick={() => setActiveStep(request.stepId)}
            >
              {index + 1}. {request.name}
            </button>
          ))}
          <Button
            size="small"
            icon={<PlusOutlined />}
            disabled={disabled || value.requests.length >= 100}
            onClick={() => {
              const request = newRequest();
              onChange({ ...value, requests: [...value.requests, request] });
              setActiveStep(request.stepId);
            }}
          >
            添加请求
          </Button>
        </div>
      )}
      {variant === 'business' && !workbench && variableFields}
      {value.requests.map((request, index) => {
        if (workbench && currentStep !== request.stepId) return null;
        const options = variableOptions(
          value,
          [...upstreamRequests, ...value.requests.slice(0, index)],
          selectedEnvironment,
          resolvedPreparations,
        );
        return (
          <Card
            className={workbench ? 'workbench-request-card' : ''}
            key={request.stepId}
            size="small"
            title={
              workbench ? null : `${labelPrefix} ${index + 1} · ${request.name}`
            }
            extra={
              variant === 'business' && !workbench ? (
                <Space>
                  <Button
                    aria-label={`上移${labelPrefix} ${index + 1}`}
                    icon={<ArrowUpOutlined />}
                    disabled={disabled || index === 0}
                    onClick={() => move(index, -1)}
                  />
                  <Button
                    aria-label={`下移${labelPrefix} ${index + 1}`}
                    icon={<ArrowDownOutlined />}
                    disabled={disabled || index === value.requests.length - 1}
                    onClick={() => move(index, 1)}
                  />
                  <Button
                    aria-label={`移除${labelPrefix} ${index + 1}`}
                    danger
                    icon={<DeleteOutlined />}
                    disabled={disabled || value.requests.length === 1}
                    onClick={() =>
                      onChange({
                        ...value,
                        requests: value.requests.filter(
                          (_, at) => at !== index,
                        ),
                      })
                    }
                  />
                </Space>
              ) : null
            }
          >
            <Space.Compact block className="section-alert">
              {!workbench && (
                <Input
                  aria-label={`${labelPrefix} ${index + 1} 名称`}
                  value={request.name}
                  disabled={disabled}
                  onChange={(event) =>
                    update(index, { name: event.target.value })
                  }
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
                onChange={(method: Request['method']) =>
                  update(index, { method })
                }
              />
              <VariableField
                label={`${labelPrefix} ${index + 1} URL`}
                value={request.url}
                disabled={disabled}
                options={options}
                onChange={(url) => update(index, { url })}
                placeholder="被测接口 URL 或已定义环境变量引用"
              />
              {workbench && (
                <Button
                  type="text"
                  aria-label={`请求 ${index + 1} 步骤设置`}
                  icon={<AppIcon name="settings" />}
                  onClick={() => setSettingsStep(request.stepId)}
                />
              )}
            </Space.Compact>
            {workbench && (
              <Modal
                title={`请求 ${index + 1} · 步骤设置`}
                open={settingsStep === request.stepId}
                onCancel={() => setSettingsStep(null)}
                zIndex={uiLayers.dialog}
                width={610}
                footer={
                  <Button onClick={() => setSettingsStep(null)}>完成</Button>
                }
              >
                <label className="field-label">
                  请求名称
                  <Input
                    aria-label={`${labelPrefix} ${index + 1} 名称`}
                    value={request.name}
                    disabled={disabled}
                    onChange={(event) =>
                      update(index, { name: event.target.value })
                    }
                  />
                </label>
                <p className="caption mt">
                  修改保留在当前用例草稿中，保存用例后产生新修订。
                </p>
                <Space className="mt">
                  <Button
                    disabled={disabled || index === 0}
                    onClick={() => move(index, -1)}
                  >
                    上移请求
                  </Button>
                  <Button
                    disabled={disabled || index === value.requests.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    下移请求
                  </Button>
                  <Button
                    danger
                    disabled={disabled || value.requests.length === 1}
                    onClick={() => {
                      onChange({
                        ...value,
                        requests: value.requests.filter(
                          (_, at) => at !== index,
                        ),
                      });
                      setSettingsStep(null);
                    }}
                  >
                    移除请求
                  </Button>
                </Space>
              </Modal>
            )}
            <RequestSections
              workbench={workbench}
              items={[
                {
                  key: 'configuration',
                  label: '账号用途、认证与请求超时',
                  children: (
                    <Space direction="vertical" style={{ width: '100%' }}>
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
                    </Space>
                  ),
                },
                {
                  key: 'parameters',
                  label: '参数',
                  children: (
                    <NamedValues
                      label="Query"
                      values={request.query}
                      disabled={disabled}
                      options={options}
                      onChange={(query) => update(index, { query })}
                    />
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
                        value={request.body.format}
                        disabled={disabled}
                        options={['none', 'json', 'text', 'form'].map(
                          (format) => ({ value: format, label: format }),
                        )}
                        onChange={(format: Request['body']['format']) =>
                          update(index, {
                            body:
                              format === 'json'
                                ? { format, value: {} }
                                : format === 'text'
                                  ? {
                                      format,
                                      value: request.bodyText,
                                      mediaType: 'text/plain',
                                    }
                                  : format === 'form'
                                    ? { format, fields: [] }
                                    : { format },
                          })
                        }
                      />
                      {(request.body.format === 'json' ||
                        request.body.format === 'text') && (
                        <VariableField
                          label={`${labelPrefix} ${index + 1} Body内容`}
                          format={request.body.format}
                          value={request.bodyText}
                          disabled={disabled}
                          options={options}
                          onChange={(bodyText) => update(index, { bodyText })}
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
                                'status',
                                'json',
                                'header',
                                'body',
                                'variable',
                              ].map((source) => ({
                                value: source,
                                label: source,
                              }))}
                              onChange={(source: Assertion['source']) =>
                                update(index, {
                                  assertions: request.assertions.map(
                                    (item, pos) =>
                                      pos === at ? { ...item, source } : item,
                                  ),
                                })
                              }
                            />
                            <Input
                              aria-label={`${labelPrefix} ${index + 1} 断言 ${at + 1} 路径`}
                              placeholder="JSON/响应头/变量路径"
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
                            <Select
                              aria-label={`${labelPrefix} ${index + 1} 断言 ${at + 1} 运算符`}
                              value={assertion.operator}
                              disabled={disabled}
                              options={assertionOperatorSchema.options.map(
                                (operator) => ({
                                  value: operator,
                                  label: operator,
                                }),
                              )}
                              onChange={(operator: Assertion['operator']) =>
                                update(index, {
                                  assertions: request.assertions.map(
                                    (item, pos) =>
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
                              placeholder='JSON 预期值，如 200、"ok"、true'
                              value={assertion.expectedText}
                              disabled={disabled}
                              onChange={(event) =>
                                update(index, {
                                  assertions: request.assertions.map(
                                    (item, pos) =>
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
                                extractors: request.extractors.map(
                                  (item, pos) =>
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
                                extractors: request.extractors.map(
                                  (item, pos) =>
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
                                extractors: request.extractors.map(
                                  (item, pos) =>
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
                                extractors: request.extractors.map(
                                  (item, pos) =>
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
                                extractors: request.extractors.map(
                                  (item, pos) =>
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
                {
                  key: 'scripts',
                  label: '受限脚本扩展',
                  children: (
                    <Space direction="vertical" style={{ width: '100%' }}>
                      <Typography.Text type="secondary">
                        脚本将在已审接口执行通道中受限运行；此页面不会执行代码。
                      </Typography.Text>
                      <Input.TextArea
                        aria-label={`${labelPrefix} ${index + 1} 前处理脚本`}
                        placeholder="前处理脚本"
                        rows={4}
                        value={request.preScript ?? ''}
                        disabled={disabled}
                        maxLength={64000}
                        onChange={(event) =>
                          update(index, { preScript: event.target.value })
                        }
                      />
                      <Input.TextArea
                        aria-label={`${labelPrefix} ${index + 1} 响应处理脚本`}
                        placeholder="响应处理/复杂断言脚本"
                        rows={4}
                        value={request.postScript ?? ''}
                        disabled={disabled}
                        maxLength={64000}
                        onChange={(event) =>
                          update(index, { postScript: event.target.value })
                        }
                      />
                    </Space>
                  ),
                },
                ...(workbench && variant === 'business'
                  ? [
                      {
                        key: 'cleanup',
                        label: '数据清理',
                        children: (
                          <ApiCleanupFields
                            projectId={projectId}
                            value={value}
                            onChange={onChange}
                            disabled={disabled}
                            previewEnvironmentId={pickedEnvironmentId}
                            preparationVariables={resolvedPreparations}
                          />
                        ),
                      },
                      {
                        key: 'documentation',
                        label: '用例说明',
                        children: (
                          <Space direction="vertical" style={{ width: '100%' }}>
                            {documentation}
                            {variableFields}
                          </Space>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          </Card>
        );
      })}
      {variant === 'business' && !workbench && (
        <Button
          icon={<PlusOutlined />}
          disabled={disabled || value.requests.length >= 100}
          onClick={() =>
            onChange({ ...value, requests: [...value.requests, newRequest()] })
          }
        >
          追加请求步骤
        </Button>
      )}
      {variant === 'business' && !workbench && (
        <ApiCleanupFields
          projectId={projectId}
          value={value}
          onChange={onChange}
          disabled={disabled}
          previewEnvironmentId={pickedEnvironmentId}
          preparationVariables={resolvedPreparations}
        />
      )}
    </Space>
  );
}
