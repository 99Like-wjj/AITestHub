import { Button, Checkbox, Input, Select, Tabs } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import {
  apiInterfaceDefinitionSchema,
  apiInterfaceMethodSchema,
  apiInterfaceStatusSchema,
  type ApiInterfaceDefinition,
} from '../../../packages/contracts/src/api-catalog';
import type { ReactNode } from 'react';
import type { ApiCatalogStageProvider } from '../../../packages/contracts/src/api-stage-actions';
import { ApiStageFields } from './api-stage-fields';

export const statusLabels: Record<ApiInterfaceDefinition['status'], string> = {
  draft: '草稿',
  active: '已发布',
  deprecated: '已废弃',
};

type Parameter = ApiInterfaceDefinition['parameters'][number];
type Body = ApiInterfaceDefinition['requestBodies'][number];
type Response = ApiInterfaceDefinition['responses'][number];

type ParameterDraft = Omit<Parameter, 'schema' | 'examples'> & {
  id: string;
  schema: string;
  examples: string;
};
type BodyDraft = Omit<Body, 'schema' | 'examples'> & {
  id: string;
  schema: string;
  examples: string;
};
type ResponseDraft = Omit<Response, 'headers' | 'content'> & {
  id: string;
  headers: string;
  content: BodyDraft[];
};

export type CatalogDefinitionDraft = Omit<
  ApiInterfaceDefinition,
  | 'parameters'
  | 'requestBodies'
  | 'responses'
  | 'models'
  | 'mocks'
  | 'basisRefs'
> & {
  parameters: ParameterDraft[];
  requestBodies: BodyDraft[];
  responses: ResponseDraft[];
  models: string;
  mocks: string;
  basisRefs: string;
};

const format = (value: unknown) =>
  value === undefined ? '' : JSON.stringify(value, null, 2);
const parameterDraft = (value: Parameter): ParameterDraft => ({
  ...value,
  id: crypto.randomUUID(),
  schema: format(value.schema),
  examples: format(value.examples),
});
const bodyDraft = (value: Body): BodyDraft => ({
  ...value,
  id: crypto.randomUUID(),
  schema: format(value.schema),
  examples: format(value.examples),
});

export function makeCatalogDraft(
  definition?: ApiInterfaceDefinition,
): CatalogDefinitionDraft {
  const value =
    definition ??
    apiInterfaceDefinitionSchema.parse({
      serviceKey: 'default',
      method: 'GET',
      path: '/',
    });
  return {
    ...value,
    parameters: value.parameters.map(parameterDraft),
    requestBodies: value.requestBodies.map(bodyDraft),
    responses: value.responses.map((response) => ({
      ...response,
      id: crypto.randomUUID(),
      headers: format(response.headers),
      content: response.content.map(bodyDraft),
    })),
    models: format(value.models),
    mocks: format(value.mocks),
    basisRefs: format(value.basisRefs),
  };
}

function readJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}不是有效的 JSON。`);
  }
}

function bodyValue({ id: _id, schema, examples, ...value }: BodyDraft) {
  return {
    ...value,
    ...(schema.trim() && {
      schema: readJson(schema, value.mediaType + ' Schema'),
    }),
    examples: readJson(examples, value.mediaType + '示例'),
  };
}

export function buildCatalogDefinition(draft: CatalogDefinitionDraft) {
  return apiInterfaceDefinitionSchema.parse({
    ...draft,
    parameters: draft.parameters.map(
      ({ id: _id, schema, examples, ...value }) => ({
        ...value,
        ...(schema.trim() && {
          schema: readJson(schema, value.name + ' Schema'),
        }),
        examples: readJson(examples, value.name + '示例'),
      }),
    ),
    requestBodies: draft.requestBodies.map(bodyValue),
    responses: draft.responses.map(
      ({ id: _id, headers, content, ...value }) => ({
        ...value,
        headers: readJson(headers, value.code + ' 响应头'),
        content: content.map(bodyValue),
      }),
    ),
    models: readJson(draft.models, '公共数据模型'),
    mocks: readJson(draft.mocks, 'Mock 期望'),
    basisRefs: readJson(draft.basisRefs, '来源依据'),
  });
}

function jsonInput(
  label: string,
  value: string,
  onChange: (value: string) => void,
  disabled: boolean,
  placeholder?: string,
) {
  return (
    <label className="api-catalog-form-field">
      <span>{label}</span>
      <Input.TextArea
        autoSize={{ minRows: 2, maxRows: 12 }}
        className="api-catalog-code"
        disabled={disabled}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function updateRows<T extends { id: string }>(rows: readonly T[], row: T) {
  return rows.map((item) => (item.id === row.id ? row : item));
}

function mediaBodies(
  rows: BodyDraft[],
  change: (rows: BodyDraft[]) => void,
  disabled: boolean,
) {
  function setRow(row: BodyDraft) {
    change(updateRows(rows, row));
  }
  return (
    <div className="api-catalog-stack">
      {rows.map((item) => (
        <div className="api-catalog-definition-group" key={item.id}>
          <div className="api-catalog-definition-row">
            <Input
              aria-label="内容类型"
              disabled={disabled}
              placeholder="例如 application/json"
              value={item.mediaType}
              onChange={(event) =>
                setRow({ ...item, mediaType: event.target.value })
              }
            />
            <Input
              aria-label="内容说明"
              disabled={disabled}
              placeholder="内容说明"
              value={item.description}
              onChange={(event) =>
                setRow({ ...item, description: event.target.value })
              }
            />
            <Checkbox
              checked={item.required}
              disabled={disabled}
              onChange={(event) =>
                setRow({ ...item, required: event.target.checked })
              }
            >
              必填
            </Checkbox>
            <Button
              aria-label="删除内容类型"
              disabled={disabled}
              icon={<DeleteOutlined />}
              onClick={() => change(rows.filter((row) => row.id !== item.id))}
            />
          </div>
          <div className="api-catalog-form-grid">
            {jsonInput(
              'Schema',
              item.schema,
              (schema) => setRow({ ...item, schema }),
              disabled,
            )}
            {jsonInput(
              '示例列表',
              item.examples,
              (examples) => setRow({ ...item, examples }),
              disabled,
              '[{"name":"正常响应","value":{}}]',
            )}
          </div>
        </div>
      ))}
      <Button
        disabled={disabled}
        icon={<PlusOutlined />}
        onClick={() =>
          change([
            ...rows,
            bodyDraft({
              mediaType: 'application/json',
              description: '',
              required: false,
              examples: [],
            }),
          ])
        }
      >
        添加内容类型
      </Button>
    </div>
  );
}

const locations = [
  ['path', 'Path'],
  ['query', 'Query'],
  ['header', 'Header'],
  ['cookie', 'Cookie'],
] as const;

export function ApiCatalogDefinitionEditor({
  projectId,
  draft,
  onChange,
  disabled = false,
  notes,
  stageProviders,
}: {
  projectId: string;
  draft: CatalogDefinitionDraft;
  onChange: (value: CatalogDefinitionDraft) => void;
  disabled?: boolean;
  notes?: ReactNode;
  stageProviders?: readonly ApiCatalogStageProvider[] | undefined;
}) {
  const update = (value: Partial<CatalogDefinitionDraft>) =>
    onChange({ ...draft, ...value });
  const parameterTabs = locations.map(([location, label]) => ({
    key: location,
    label,
    children: (
      <div className="api-catalog-stack">
        {draft.parameters
          .filter((parameter) => parameter.location === location)
          .map((item) => {
            const setRow = (value: ParameterDraft) =>
              update({ parameters: updateRows(draft.parameters, value) });
            return (
              <div className="api-catalog-definition-group" key={item.id}>
                <div className="api-catalog-definition-row">
                  <Input
                    aria-label="参数名称"
                    placeholder="参数名称"
                    disabled={disabled}
                    value={item.name}
                    onChange={(event) =>
                      setRow({ ...item, name: event.target.value })
                    }
                  />
                  <Input
                    aria-label="参数说明"
                    placeholder="参数说明"
                    disabled={disabled}
                    value={item.description}
                    onChange={(event) =>
                      setRow({ ...item, description: event.target.value })
                    }
                  />
                  <Checkbox
                    checked={item.required}
                    disabled={disabled || location === 'path'}
                    onChange={(event) =>
                      setRow({ ...item, required: event.target.checked })
                    }
                  >
                    必填
                  </Checkbox>
                  <Button
                    aria-label="删除参数"
                    icon={<DeleteOutlined />}
                    disabled={disabled}
                    onClick={() =>
                      update({
                        parameters: draft.parameters.filter(
                          (p) => p.id !== item.id,
                        ),
                      })
                    }
                  />
                </div>
                <div className="api-catalog-form-grid">
                  {jsonInput(
                    'Schema',
                    item.schema,
                    (schema) => setRow({ ...item, schema }),
                    disabled,
                  )}
                  {jsonInput(
                    '示例列表',
                    item.examples,
                    (examples) => setRow({ ...item, examples }),
                    disabled,
                  )}
                </div>
              </div>
            );
          })}
        <Button
          disabled={disabled}
          icon={<PlusOutlined />}
          onClick={() =>
            update({
              parameters: [
                ...draft.parameters,
                parameterDraft({
                  location,
                  name: '',
                  required: location === 'path',
                  description: '',
                  examples: [],
                }),
              ],
            })
          }
        >
          添加{label}参数
        </Button>
      </div>
    ),
  }));
  return (
    <div className="api-catalog-stack">
      <div className="api-catalog-definition-row is-address">
        <Select
          aria-label="HTTP 方法"
          disabled={disabled}
          value={draft.method}
          onChange={(method: ApiInterfaceDefinition['method']) =>
            update({ method })
          }
          options={apiInterfaceMethodSchema.options.map((method) => ({
            label: method,
            value: method,
          }))}
        />
        <Input
          aria-label="接口路径"
          disabled={disabled}
          placeholder="/path/{id}"
          value={draft.path}
          onChange={(event) => update({ path: event.target.value })}
        />
      </div>
      <div className="api-catalog-form-grid">
        <label className="api-catalog-form-field">
          <span>服务标识</span>
          <Input
            disabled={disabled}
            value={draft.serviceKey}
            onChange={(event) => update({ serviceKey: event.target.value })}
          />
        </label>
        <label className="api-catalog-form-field">
          <span>状态</span>
          <Select
            disabled={disabled}
            value={draft.status}
            onChange={(status: ApiInterfaceDefinition['status']) =>
              update({ status })
            }
            options={apiInterfaceStatusSchema.options.map((status) => ({
              value: status,
              label: statusLabels[status],
            }))}
          />
        </label>
        <label className="api-catalog-form-field">
          <span>标签</span>
          <Select
            mode="tags"
            disabled={disabled}
            value={draft.tags}
            onChange={(tags: string[]) => update({ tags })}
          />
        </label>
        <label className="api-catalog-form-field">
          <span>端点说明</span>
          <Input.TextArea
            disabled={disabled}
            value={draft.description}
            onChange={(event) => update({ description: event.target.value })}
          />
        </label>
      </div>
      {notes}
      <Tabs
        items={[
          {
            key: 'parameters',
            label: '参数',
            children: <Tabs size="small" items={parameterTabs} />,
          },
          {
            key: 'body',
            label: '请求体',
            children: mediaBodies(
              draft.requestBodies,
              (requestBodies) => update({ requestBodies }),
              disabled,
            ),
          },
          {
            key: 'responses',
            label: '响应',
            children: (
              <div className="api-catalog-stack">
                {draft.responses.map((item) => {
                  const setRow = (row: ResponseDraft) =>
                    update({ responses: updateRows(draft.responses, row) });
                  return (
                    <div className="api-catalog-definition-group" key={item.id}>
                      <div className="api-catalog-definition-row is-response">
                        <Input
                          aria-label="响应状态码"
                          placeholder="200 / 4XX / default"
                          disabled={disabled}
                          value={item.code}
                          onChange={(event) =>
                            setRow({ ...item, code: event.target.value })
                          }
                        />
                        <Input
                          aria-label="响应说明"
                          placeholder="响应说明"
                          disabled={disabled}
                          value={item.description}
                          onChange={(event) =>
                            setRow({ ...item, description: event.target.value })
                          }
                        />
                        <Button
                          aria-label="删除响应"
                          disabled={disabled}
                          icon={<DeleteOutlined />}
                          onClick={() =>
                            update({
                              responses: draft.responses.filter(
                                (response) => response.id !== item.id,
                              ),
                            })
                          }
                        />
                      </div>
                      {jsonInput(
                        '响应头声明',
                        item.headers,
                        (headers) => setRow({ ...item, headers }),
                        disabled,
                      )}
                      {mediaBodies(
                        item.content,
                        (content) => setRow({ ...item, content }),
                        disabled,
                      )}
                    </div>
                  );
                })}
                <Button
                  disabled={disabled}
                  icon={<PlusOutlined />}
                  onClick={() =>
                    update({
                      responses: [
                        ...draft.responses,
                        {
                          id: crypto.randomUUID(),
                          code: '200',
                          description: '',
                          headers: '[]',
                          content: [],
                        },
                      ],
                    })
                  }
                >
                  添加响应
                </Button>
              </div>
            ),
          },
          {
            key: 'auth',
            label: '认证',
            children: (
              <div className="api-catalog-form-grid">
                <label className="api-catalog-form-field">
                  <span>认证方式</span>
                  <Select
                    disabled={disabled}
                    value={draft.auth.mode}
                    options={[
                      {
                        value: 'inherit',
                        label: '按上级明确授权继承（无默认用途）',
                      },
                      { value: 'none', label: '无需认证' },
                      { value: 'purpose', label: '项目账号用途' },
                    ]}
                    onChange={(mode: ApiInterfaceDefinition['auth']['mode']) =>
                      update({
                        auth:
                          mode === 'purpose'
                            ? { mode, purposeId: '' }
                            : { mode },
                      })
                    }
                  />
                </label>
                {draft.auth.mode === 'purpose' && (
                  <label className="api-catalog-form-field">
                    <span>账号用途 ID</span>
                    <Input
                      disabled={disabled}
                      value={draft.auth.purposeId}
                      onChange={(event) =>
                        update({
                          auth: {
                            mode: 'purpose',
                            purposeId: event.target.value,
                          },
                        })
                      }
                    />
                  </label>
                )}
              </div>
            ),
          },
          {
            key: 'models',
            label: '公共模型',
            children: jsonInput(
              '模型名称 → Schema',
              draft.models,
              (models) => update({ models }),
              disabled,
            ),
          },
          {
            key: 'stages',
            label: '前后置',
            children: (
              <ApiStageFields
                projectId={projectId}
                value={draft.stageSettings}
                {...(stageProviders && { providers: stageProviders })}
                disabled={disabled}
                onChange={(stageSettings) => update({ stageSettings })}
              />
            ),
          },
          {
            key: 'mock',
            label: 'Mock 规则',
            children: jsonInput(
              'Mock 期望列表',
              draft.mocks,
              (mocks) => update({ mocks }),
              disabled,
            ),
          },
          {
            key: 'basis',
            label: '来源',
            children: jsonInput(
              '来源依据列表',
              draft.basisRefs,
              (basisRefs) => update({ basisRefs }),
              disabled,
            ),
          },
        ]}
      />
    </div>
  );
}
