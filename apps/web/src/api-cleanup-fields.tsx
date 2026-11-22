import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Collapse,
  Input,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { testConfigurationListSchema } from '../../../packages/contracts/src/test-configuration';
import type { TestConfigurationView } from '../../../packages/contracts/src/test-configuration';
import { api, describeError } from './api';
import { ApiCaseFields } from './api-case-fields';
import { newRequest } from './api-draft';
import type { ApiDraft, DraftCleanupStep } from './api-draft';
import type { ApiPreparationVariables } from './api-variable-fields';

export function ApiCleanupFields({
  projectId,
  value,
  onChange,
  disabled,
  previewEnvironmentId,
  preparationVariables,
  expanded = false,
}: {
  projectId: string;
  value: ApiDraft;
  onChange: (value: ApiDraft) => void;
  disabled: boolean;
  previewEnvironmentId?: string | undefined;
  preparationVariables?: ApiPreparationVariables | undefined;
  expanded?: boolean;
}) {
  const [configurations, setConfigurations] = useState<TestConfigurationView[]>(
    [],
  );
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    setConfigurations([]);
    setError(undefined);
    void Promise.allSettled(
      ['environment', 'databaseConnection'].map((kind) =>
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
      const errors = results
        .filter((result) => result.status === 'rejected')
        .map((result) => describeError(result.reason));
      if (errors.length) setError(errors.join('；'));
    });
    return () => controller.abort();
  }, [projectId]);
  function setSteps(steps: DraftCleanupStep[]) {
    onChange({ ...value, cleanupDraft: { ...value.cleanupDraft, steps } });
  }
  function update(id: string, change: Partial<DraftCleanupStep>) {
    setSteps(
      value.cleanupDraft.steps.map((step) =>
        step.cleanupStepId === id
          ? ({ ...step, ...change } as DraftCleanupStep)
          : step,
      ),
    );
  }
  function move(index: number, offset: number) {
    const steps = [...value.cleanupDraft.steps];
    const [step] = steps.splice(index, 1);
    if (step) steps.splice(index + offset, 0, step);
    setSteps(steps);
  }
  function add(type: 'http' | 'sql') {
    const common = {
      cleanupStepId: crypto.randomUUID(),
      requiredTargetsText: '',
    };
    setSteps([
      ...value.cleanupDraft.steps,
      type === 'http'
        ? { ...common, type, request: newRequest() }
        : {
            ...common,
            type,
            environmentId: '',
            connectionId: '',
            driver: 'postgresql',
            statement: '',
            parameters: [],
          },
    ]);
  }
  function choices(
    kind: 'environment' | 'databaseConnection',
    selected: string,
    environmentId?: string,
  ) {
    const options = configurations
      .filter(
        (row) =>
          row.content.kind === kind &&
          (kind !== 'databaseConnection' ||
            ('environmentId' in row.content &&
              row.content.environmentId === environmentId)),
      )
      .map((row) => ({
        value: row.id,
        label: `${row.content.name}${'active' in row.content && !row.content.active ? '（已停用）' : ''}`,
        disabled: 'active' in row.content && !row.content.active,
      }));
    if (selected && !options.some((row) => row.value === selected))
      options.push({
        value: selected,
        label: `原引用 ${selected}（目录/环境不匹配）`,
        disabled: true,
      });
    return options;
  }
  return (
    <Collapse
      {...(expanded ? { defaultActiveKey: ['cleanup'] } : {})}
      items={[
        {
          key: 'cleanup',
          label: `可选清理 · ${value.cleanupDraft.mode} · ${value.cleanupDraft.steps.length} 个草稿步骤`,
          children: (
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <Alert
                type="info"
                showIcon
                title="仅维护清理定义，不在编辑页执行 HTTP 或 SQL"
                description="清理与测试结论独立。运行只按原策略尝试；缺失/空目标跳过相应清理，不自动重试。保存不等于 SQL 范围自查或人工批准已通过，未审清理不得绕过 C6 原已审执行闭包保护。"
              />
              {error && (
                <Alert
                  type="warning"
                  showIcon
                  title={`环境/连接目录未完整取得：${error}`}
                  description="保留原引用，不自动替换环境或数据库。"
                />
              )}
              <Select
                aria-label="清理执行策略"
                value={value.cleanupDraft.mode}
                disabled={disabled}
                style={{ width: '100%' }}
                options={[
                  { value: 'none', label: '不清理' },
                  {
                    value: 'always',
                    label: '始终尝试清理（测试完成或失败后）',
                  },
                  { value: 'onSuccess', label: '仅用例成功后清理' },
                ]}
                onChange={(mode: ApiDraft['cleanupDraft']['mode']) =>
                  onChange({
                    ...value,
                    cleanupDraft: { ...value.cleanupDraft, mode },
                  })
                }
              />
              {value.cleanupDraft.mode === 'none' ? (
                <Typography.Text type="secondary">
                  本次保存不启用清理。窗口内原步骤草稿保留，切回策略可继续编辑；不以未启用清理宣称目标已清理。
                </Typography.Text>
              ) : (
                <>
                  {value.cleanupDraft.steps.map((step, index) => (
                    <Card
                      key={step.cleanupStepId}
                      size="small"
                      title={`清理 ${index + 1} · ${step.type === 'http' ? 'HTTP' : 'SQL'}`}
                      extra={
                        <Space>
                          <Button
                            aria-label={`上移清理 ${index + 1}`}
                            icon={<ArrowUpOutlined />}
                            disabled={disabled || index === 0}
                            onClick={() => move(index, -1)}
                          />
                          <Button
                            aria-label={`下移清理 ${index + 1}`}
                            icon={<ArrowDownOutlined />}
                            disabled={
                              disabled ||
                              index === value.cleanupDraft.steps.length - 1
                            }
                            onClick={() => move(index, 1)}
                          />
                          <Button
                            danger
                            aria-label={`移除清理 ${index + 1}`}
                            icon={<DeleteOutlined />}
                            disabled={disabled}
                            onClick={() =>
                              setSteps(
                                value.cleanupDraft.steps.filter(
                                  (row) =>
                                    row.cleanupStepId !== step.cleanupStepId,
                                ),
                              )
                            }
                          />
                        </Space>
                      }
                    >
                      <Space direction="vertical" style={{ width: '100%' }}>
                        <Typography.Text>
                          本步必要目标引用（每行一项，env/case/extract 开头）
                        </Typography.Text>
                        <Input.TextArea
                          aria-label={`清理 ${index + 1} 必要目标引用`}
                          rows={3}
                          disabled={disabled}
                          value={step.requiredTargetsText}
                          placeholder={'extract.createdId\ncase.syntheticId'}
                          onChange={(event) =>
                            update(step.cleanupStepId, {
                              requiredTargetsText: event.target.value,
                            })
                          }
                        />
                        {step.type === 'http' ? (
                          <ApiCaseFields
                            projectId={projectId}
                            variant="cleanup"
                            labelPrefix={`HTTP清理 ${index + 1} 请求`}
                            disabled={disabled}
                            previewEnvironmentId={previewEnvironmentId}
                            preparationVariables={preparationVariables}
                            upstreamRequests={[
                              ...value.requests,
                              ...value.cleanupDraft.steps
                                .slice(0, index)
                                .flatMap((prior) =>
                                  prior.type === 'http' ? [prior.request] : [],
                                ),
                            ]}
                            value={{ ...value, requests: [step.request] }}
                            onChange={(draft) => {
                              const request = draft.requests[0];
                              if (request)
                                update(step.cleanupStepId, { request });
                            }}
                          />
                        ) : (
                          <>
                            <Typography.Text>清理目标环境</Typography.Text>
                            <Select
                              aria-label={`SQL清理 ${index + 1} 环境`}
                              style={{ width: '100%' }}
                              value={step.environmentId || null}
                              disabled={disabled}
                              placeholder="明确选择环境"
                              options={choices(
                                'environment',
                                step.environmentId,
                              )}
                              onChange={(environmentId: string) =>
                                update(step.cleanupStepId, { environmentId })
                              }
                            />
                            <Typography.Text>该环境数据库连接</Typography.Text>
                            <Select
                              aria-label={`SQL清理 ${index + 1} 数据库连接`}
                              style={{ width: '100%' }}
                              value={step.connectionId || null}
                              disabled={disabled || !step.environmentId}
                              placeholder="不自动换库，明确选择连接"
                              options={choices(
                                'databaseConnection',
                                step.connectionId,
                                step.environmentId,
                              )}
                              onChange={(connectionId: string) => {
                                const connection = configurations.find(
                                  (row) => row.id === connectionId,
                                );
                                update(step.cleanupStepId, {
                                  connectionId,
                                  ...(connection?.content.kind ===
                                  'databaseConnection'
                                    ? { driver: connection.content.driver }
                                    : {}),
                                });
                              }}
                            />
                            <Tag>驱动：{step.driver}</Tag>
                            <Typography.Text>参数化清理 SQL</Typography.Text>
                            <Input.TextArea
                              aria-label={`SQL清理 ${index + 1} 语句`}
                              rows={6}
                              maxLength={64000}
                              disabled={disabled}
                              value={step.statement}
                              placeholder="明确目标范围的参数化删除语句；不要填写秘密"
                              onChange={(event) =>
                                update(step.cleanupStepId, {
                                  statement: event.target.value,
                                })
                              }
                            />
                            <Typography.Text>
                              绑定参数（值只能是已定义变量引用，不拼接 SQL）
                            </Typography.Text>
                            {step.parameters.map((parameter, at) => (
                              <Space.Compact block key={at}>
                                <Input
                                  aria-label={`SQL清理 ${index + 1} 参数 ${at + 1} 名称`}
                                  placeholder="参数名称"
                                  disabled={disabled}
                                  value={parameter.name}
                                  onChange={(event) =>
                                    update(step.cleanupStepId, {
                                      parameters: step.parameters.map(
                                        (row, i) =>
                                          i === at
                                            ? {
                                                ...row,
                                                name: event.target.value,
                                              }
                                            : row,
                                      ),
                                    })
                                  }
                                />
                                <Input
                                  aria-label={`SQL清理 ${index + 1} 参数 ${at + 1} 引用`}
                                  placeholder="extract.createdId"
                                  disabled={disabled}
                                  value={parameter.valueRef}
                                  onChange={(event) =>
                                    update(step.cleanupStepId, {
                                      parameters: step.parameters.map(
                                        (row, i) =>
                                          i === at
                                            ? {
                                                ...row,
                                                valueRef: event.target.value,
                                              }
                                            : row,
                                      ),
                                    })
                                  }
                                />
                                <Button
                                  danger
                                  aria-label={`移除SQL清理 ${index + 1} 参数 ${at + 1}`}
                                  icon={<DeleteOutlined />}
                                  disabled={disabled}
                                  onClick={() =>
                                    update(step.cleanupStepId, {
                                      parameters: step.parameters.filter(
                                        (_, i) => i !== at,
                                      ),
                                    })
                                  }
                                />
                              </Space.Compact>
                            ))}
                            <Button
                              icon={<PlusOutlined />}
                              disabled={
                                disabled || step.parameters.length >= 100
                              }
                              onClick={() =>
                                update(step.cleanupStepId, {
                                  parameters: [
                                    ...step.parameters,
                                    { name: '', valueRef: '' },
                                  ],
                                })
                              }
                            >
                              添加绑定参数
                            </Button>
                          </>
                        )}
                        <Typography.Text type="secondary">
                          本清理标识：{step.cleanupStepId}
                        </Typography.Text>
                      </Space>
                    </Card>
                  ))}
                  <Space wrap>
                    <Button
                      icon={<PlusOutlined />}
                      disabled={
                        disabled || value.cleanupDraft.steps.length >= 100
                      }
                      onClick={() => add('http')}
                    >
                      添加 HTTP 清理
                    </Button>
                    <Button
                      icon={<PlusOutlined />}
                      disabled={
                        disabled || value.cleanupDraft.steps.length >= 100
                      }
                      onClick={() => add('sql')}
                    >
                      添加 SQL 清理
                    </Button>
                  </Space>
                </>
              )}
            </Space>
          ),
        },
      ]}
    />
  );
}
