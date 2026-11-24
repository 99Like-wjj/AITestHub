import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Input, InputNumber, Select } from 'antd';
import { z } from 'zod';
import { apiCatalogGetResultSchema } from '../../../packages/contracts/src/api-catalog';
import { apiDatabaseReadSchema } from '../../../packages/contracts/src/api-database-reads';
import {
  apiNoStages,
  type ApiCatalogStageProvider,
  type ApiStageAction,
  type ApiStageSettings,
} from '../../../packages/contracts/src/api-stage-actions';
import type { ApiRequestStep } from '../../../packages/contracts/src/domain';
import { api, describeError } from './api';
import { ApiSharedScriptPicker } from './api-shared-script-picker';

type Phase = 'pre' | 'post';
const labels: Record<ApiStageAction['type'], string> = {
  wait: '等待',
  script: '受限脚本',
  sharedScript: '公共脚本',
  databaseRead: '已审核数据库读取',
};
const databaseReads = z.strictObject({
  queries: z.array(apiDatabaseReadSchema),
});
type Query = z.output<typeof apiDatabaseReadSchema>;

function action(type: ApiStageAction['type']): ApiStageAction {
  const base = {
    id: crypto.randomUUID(),
    name: labels[type],
    enabled: true,
    overridable: false,
  };
  switch (type) {
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
  }
}

export function ApiStageFields({
  projectId,
  value = apiNoStages,
  onChange,
  disabled,
  providers = [],
  showPhases = ['pre', 'post'],
}: {
  projectId: string;
  value?: ApiStageSettings | undefined;
  onChange: (settings: ApiStageSettings) => void;
  disabled: boolean;
  providers?: readonly ApiCatalogStageProvider[];
  showPhases?: readonly Phase[];
}) {
  const [queries, setQueries] = useState<Query[]>([]);
  const [error, setError] = useState<string>();
  const hasDatabaseRead = [...value.pre, ...value.post].some(
    (row) => row.type === 'databaseRead',
  );
  useEffect(() => {
    if (!hasDatabaseRead) return;
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
      (result) => {
        if (!controller.signal.aborted) {
          setQueries(result.queries);
          setError(undefined);
        }
      },
      (failure: unknown) => {
        if (!controller.signal.aborted) setError(describeError(failure));
      },
    );
    return () => controller.abort();
  }, [projectId, hasDatabaseRead]);
  function replace(phase: Phase, row: ApiStageAction) {
    onChange({
      ...value,
      [phase]: value[phase].map((item) => (item.id === row.id ? row : item)),
    });
  }
  function move(phase: Phase, index: number, change: number) {
    const rows = [...value[phase]];
    const [row] = rows.splice(index, 1);
    if (!row) return;
    rows.splice(index + change, 0, row);
    onChange({ ...value, [phase]: rows });
  }
  return (
    <div className="api-catalog-stack">
      {error && <Alert type="error" title={error} showIcon />}
      {showPhases.map((phase) => (
        <section className="api-catalog-stack" key={phase}>
          <h3>{phase === 'pre' ? '前置操作' : '后置操作'}</h3>
          {providers.flatMap((provider) =>
            provider.settings[phase].map((row) => {
              const suppressed = value.suppress.some(
                (entry) =>
                  entry.providerId === provider.id && entry.actionId === row.id,
              );
              return (
                <div
                  className="api-catalog-usage-row"
                  key={provider.id + ':' + row.id}
                >
                  <span>
                    {provider.title} · {row.name} · {labels[row.type]}
                  </span>
                  <Checkbox
                    checked={suppressed}
                    disabled={disabled || !row.enabled || !row.overridable}
                    onChange={(event) =>
                      onChange({
                        ...value,
                        suppress: event.target.checked
                          ? [
                              ...value.suppress,
                              { providerId: provider.id, actionId: row.id },
                            ]
                          : value.suppress.filter(
                              (entry) =>
                                entry.providerId !== provider.id ||
                                entry.actionId !== row.id,
                            ),
                      })
                    }
                  >
                    {row.enabled ? '停用继承动作' : '来源已停用'}
                  </Checkbox>
                </div>
              );
            }),
          )}
          {value[phase].map((row, index) => (
            <div className="api-catalog-definition-group" key={row.id}>
              <div className="row wrap">
                <strong>
                  {index + 1} · {labels[row.type]}
                </strong>
                <Checkbox
                  checked={row.enabled}
                  disabled={disabled}
                  onChange={(event) =>
                    replace(phase, { ...row, enabled: event.target.checked })
                  }
                >
                  启用
                </Checkbox>
                <Checkbox
                  checked={row.overridable}
                  disabled={disabled}
                  onChange={(event) =>
                    replace(phase, {
                      ...row,
                      overridable: event.target.checked,
                    })
                  }
                >
                  允许下层停用
                </Checkbox>
                <Button
                  size="small"
                  disabled={disabled || index === 0}
                  onClick={() => move(phase, index, -1)}
                >
                  上移
                </Button>
                <Button
                  size="small"
                  disabled={disabled || index === value[phase].length - 1}
                  onClick={() => move(phase, index, 1)}
                >
                  下移
                </Button>
                <Button
                  size="small"
                  danger
                  disabled={disabled}
                  onClick={() =>
                    onChange({
                      ...value,
                      [phase]: value[phase].filter(
                        (item) => item.id !== row.id,
                      ),
                    })
                  }
                >
                  删除
                </Button>
              </div>
              <label className="api-catalog-form-field">
                <span>动作名称</span>
                <Input
                  value={row.name}
                  disabled={disabled}
                  maxLength={200}
                  onChange={(event) =>
                    replace(phase, { ...row, name: event.target.value })
                  }
                />
              </label>
              {row.type === 'wait' && (
                <label className="api-catalog-form-field">
                  <span>等待毫秒数</span>
                  <InputNumber
                    min={1}
                    max={30000}
                    value={row.milliseconds}
                    disabled={disabled}
                    onChange={(milliseconds) =>
                      replace(phase, {
                        ...row,
                        milliseconds: milliseconds ?? 1,
                      })
                    }
                  />
                </label>
              )}
              {row.type === 'script' && (
                <label className="api-catalog-form-field">
                  <span>受限脚本</span>
                  <Input.TextArea
                    className="api-catalog-code"
                    value={row.script}
                    disabled={disabled}
                    onChange={(event) =>
                      replace(phase, { ...row, script: event.target.value })
                    }
                  />
                </label>
              )}
              {row.type === 'sharedScript' && (
                <ApiSharedScriptPicker
                  projectId={projectId}
                  value={row}
                  disabled={disabled}
                  onChange={(reference) =>
                    replace(phase, { ...row, ...reference })
                  }
                />
              )}
              {row.type === 'databaseRead' && (
                <>
                  <div className="api-catalog-form-grid">
                    <label className="api-catalog-form-field">
                      <span>已审核查询</span>
                      <Select
                        showSearch
                        optionFilterProp="label"
                        value={row.queryId || null}
                        disabled={disabled}
                        options={queries.map((query) => ({
                          value: query.id,
                          label: query.definition.name,
                        }))}
                        onChange={(queryId: string) => {
                          const query = queries.find(
                            (item) => item.id === queryId,
                          );
                          replace(phase, {
                            ...row,
                            queryId,
                            parameters: Object.fromEntries(
                              (query?.definition.filters ?? []).map(
                                ({ parameter }) => [
                                  parameter,
                                  row.parameters[parameter] ?? '',
                                ],
                              ),
                            ),
                          });
                        }}
                      />
                    </label>
                    <label className="api-catalog-form-field">
                      <span>结果变量</span>
                      <Input
                        value={row.resultVariable}
                        disabled={disabled}
                        onChange={(event) =>
                          replace(phase, {
                            ...row,
                            resultVariable: event.target.value,
                          })
                        }
                      />
                    </label>
                  </div>
                  {Object.entries(row.parameters).map(
                    ([parameter, expression]) => (
                      <label className="api-catalog-form-field" key={parameter}>
                        <span>{parameter} · 绑定表达式</span>
                        <Input
                          value={expression}
                          disabled={disabled}
                          onChange={(event) =>
                            replace(phase, {
                              ...row,
                              parameters: {
                                ...row.parameters,
                                [parameter]: event.target.value,
                              },
                            })
                          }
                        />
                      </label>
                    ),
                  )}
                </>
              )}
            </div>
          ))}
          <Select
            aria-label={phase === 'pre' ? '添加前置操作' : '添加后置操作'}
            placeholder={phase === 'pre' ? '添加前置操作' : '添加后置操作'}
            disabled={disabled || value[phase].length >= 30}
            value={null}
            options={Object.entries(labels).map(([value, label]) => ({
              value,
              label,
            }))}
            onChange={(type: ApiStageAction['type']) =>
              onChange({ ...value, [phase]: [...value[phase], action(type)] })
            }
          />
        </section>
      ))}
    </div>
  );
}

export function ApiRequestStageFields({
  projectId,
  source,
  value,
  phase,
  disabled,
  onChange,
}: {
  projectId: string;
  source?: ApiRequestStep['source'];
  value?: ApiStageSettings | undefined;
  phase: Phase;
  disabled: boolean;
  onChange: (value: ApiStageSettings) => void;
}) {
  const [providers, setProviders] = useState<ApiCatalogStageProvider[]>([]);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setProviders([]);
    setError(undefined);
    if (!source) return;
    const controller = new AbortController();
    void api(
      `/projects/${source.projectId}/api-catalog/nodes/${source.interfaceId}?revisionId=${source.revisionId}`,
      {
        signal: controller.signal,
      },
      apiCatalogGetResultSchema,
    ).then(
      (result) => {
        if (!controller.signal.aborted)
          setProviders(result.revision?.stageProviders ?? []);
      },
      (failure: unknown) => {
        if (!controller.signal.aborted) setError(describeError(failure));
      },
    );
    return () => controller.abort();
  }, [source?.projectId, source?.interfaceId, source?.revisionId]);
  return (
    <>
      {error && <Alert type="error" title={error} showIcon />}
      <ApiStageFields
        projectId={projectId}
        value={value}
        providers={providers}
        showPhases={[phase]}
        onChange={onChange}
        disabled={disabled}
      />
    </>
  );
}
