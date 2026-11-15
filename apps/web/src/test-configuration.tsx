import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Checkbox,
  Collapse,
  Descriptions,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Tabs,
  Typography,
} from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { z } from 'zod';
import {
  configurationKindSchema,
  projectCredentialInputSchema,
  saveTestConfigurationInputSchema,
  testConfigurationContentSchema,
  testConfigurationDtoSchema,
  testConfigurationListSchema,
  testConfigurationReceiptSchema,
} from '../../../packages/contracts/src/test-configuration';
import type {
  ConfigurationKind,
  TestConfigurationContent,
  TestConfigurationView,
} from '../../../packages/contracts/src/test-configuration';
import { api, ApiError, describeError } from './api';
import { ProjectSettings } from './project-settings';
import { PlatformProjects } from './project-settings';
import { PlatformUsers } from './platform-users';
import { PlatformModelSettings } from './model-settings';
import type { Me, Project } from './types';
import { uiLayers } from './ui-layers';
import { PageHeading } from './page-heading';
import { AppIcon } from './app-icon';
import './test-configuration.css';
import { skillGuidanceCatalogSchema } from '../../../packages/contracts/src/skill-guidance';
import type { SkillGuidanceCatalog } from '../../../packages/contracts/src/skill-guidance';

type Configuration = z.infer<typeof testConfigurationDtoSchema>;
interface Pair {
  name: string;
  value: string;
}
interface ConfigurationFields {
  name: string;
  description: string;
  active: boolean;
  baseUrls: Pair[];
  variables: Pair[];
  headers: Pair[];
  authenticationMode: 'token' | 'login';
  destinationLocation: 'header' | 'cookie' | 'query';
  destinationName: string;
  destinationPrefix: string;
  baseUrlName: string;
  path: string;
  method: 'GET' | 'POST';
  bodyTemplate: string;
  extractorSource: 'json' | 'header' | 'body';
  extractorPath: string;
  environmentId: string;
  purposeId: string;
  accountId: string;
  authProfileId: string | null;
  driver: 'postgresql' | 'mysql';
  host: string;
  port: number;
  database: string;
  tls: boolean;
}
const labels: Record<ConfigurationKind, string> = {
  environment: '环境',
  purpose: '账号用途',
  account: '测试账号',
  authProfile: '认证定义',
  binding: '环境用途绑定',
  databaseConnection: '数据库连接',
};
const pairs = (values: Record<string, string>): Pair[] =>
  Object.entries(values).map(([name, value]) => ({ name, value }));
function record(
  values: Pair[] | undefined,
  title: string,
): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const value of values ?? []) {
    if (!value.name?.trim()) throw new Error(`${title}名称不能为空。`);
    if (
      value.name.length > 100 ||
      !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(value.name)
    )
      throw new Error(
        `${title}${title === '服务地址' ? '别名' : '名称'}须以英文字母或下划线开头，只能包含英文字母、数字、下划线和连字符，最多100个字符。`,
      );
    if (Object.hasOwn(result, value.name))
      throw new Error(`${title}名称 ${value.name} 重复，不能覆盖原值。`);
    result[value.name] = value.value ?? '';
  }
  return result;
}
export function configurationFromFields(
  kind: ConfigurationKind,
  fields: ConfigurationFields,
): TestConfigurationContent {
  const base = {
    name: fields.name,
    description: fields.description ?? '',
    active: fields.active,
  };
  if (kind === 'environment')
    return testConfigurationContentSchema.parse({
      kind,
      ...base,
      baseUrls: record(fields.baseUrls, '服务地址'),
      variables: record(fields.variables, '公共变量'),
    });
  if (kind === 'purpose' || kind === 'account')
    return testConfigurationContentSchema.parse({ kind, ...base });
  if (kind === 'binding')
    return testConfigurationContentSchema.parse({
      kind,
      ...base,
      environmentId: fields.environmentId,
      purposeId: fields.purposeId,
      accountId: fields.accountId,
      authProfileId: fields.authProfileId ?? null,
    });
  if (kind === 'databaseConnection')
    return testConfigurationContentSchema.parse({
      kind,
      ...base,
      environmentId: fields.environmentId,
      driver: fields.driver,
      host: fields.host,
      port: fields.port,
      database: fields.database,
      tls: fields.tls ?? false,
    });
  const destination = {
    location: fields.destinationLocation,
    name: fields.destinationName,
    prefix: fields.destinationPrefix ?? '',
  };
  if (fields.authenticationMode === 'token')
    return testConfigurationContentSchema.parse({
      kind,
      ...base,
      authentication: { mode: 'token', destination },
    });
  let bodyTemplate: unknown;
  try {
    bodyTemplate = JSON.parse(fields.bodyTemplate);
  } catch {
    throw new Error(
      '登录请求 Body 模板须为合法 JSON；受保护值只填写 {{account.username}}、{{account.password}} 等引用。',
    );
  }
  return testConfigurationContentSchema.parse({
    kind,
    ...base,
    authentication: {
      mode: 'login',
      destination,
      baseUrlName: fields.baseUrlName,
      path: fields.path,
      method: fields.method,
      headers: record(fields.headers, '认证Header'),
      bodyTemplate,
      extractor: {
        source: fields.extractorSource,
        path: fields.extractorPath ?? '',
      },
    },
  });
}
function initialFields(
  content: TestConfigurationContent | undefined,
): Partial<ConfigurationFields> {
  const base = {
    name: content?.name ?? '',
    description: content?.description ?? '',
    active: content?.active ?? true,
    baseUrls: [],
    variables: [],
    headers: [],
    authenticationMode: 'token' as const,
    destinationLocation: 'header' as const,
    destinationName: '',
    destinationPrefix: '',
    method: 'POST' as const,
    bodyTemplate: '{}',
    extractorSource: 'json' as const,
    extractorPath: '',
    driver: 'postgresql' as const,
    port: 5432,
    tls: false,
  };
  if (!content) return base;
  if (content.kind === 'environment')
    return {
      ...base,
      baseUrls: pairs(content.baseUrls),
      variables: pairs(content.variables),
    };
  if (content.kind === 'binding') return { ...base, ...content };
  if (content.kind === 'databaseConnection') return { ...base, ...content };
  if (content.kind === 'authProfile') {
    const auth = content.authentication;
    return {
      ...base,
      authenticationMode: auth.mode,
      destinationLocation: auth.destination.location,
      destinationName: auth.destination.name,
      destinationPrefix: auth.destination.prefix,
      ...(auth.mode === 'login'
        ? {
            baseUrlName: auth.baseUrlName,
            path: auth.path,
            method: auth.method,
            headers: pairs(auth.headers),
            bodyTemplate: JSON.stringify(auth.bodyTemplate, null, 2),
            extractorSource: auth.extractor.source,
            extractorPath: auth.extractor.path,
          }
        : {}),
    };
  }
  return base;
}
const failureText = (failure: unknown) =>
  failure instanceof z.ZodError
    ? failure.issues.map((issue) => issue.message).join('；')
    : describeError(failure);

function PairFields({
  name,
  title,
  disabled,
}: {
  name: 'baseUrls' | 'variables' | 'headers';
  title: string;
  disabled: boolean;
}) {
  return (
    <Form.List name={name}>
      {(fields, { add, remove }) => (
        <Space direction="vertical" style={{ width: '100%' }}>
          {fields.map((field) => (
            <Space.Compact block key={field.key}>
              <Form.Item
                name={[field.name, 'name']}
                rules={[
                  {
                    required: true,
                    message: `${name === 'baseUrls' ? '服务别名' : '名称'}必填`,
                  },
                  {
                    pattern: /^[A-Za-z_][A-Za-z0-9_-]*$/,
                    max: 100,
                    message:
                      '以英文字母或下划线开头，仅支持英文、数字、下划线和连字符，最多100个字符。',
                  },
                ]}
                style={{ marginBottom: 8, flex: 1 }}
              >
                <Input
                  aria-label={`${title} ${field.name + 1} ${name === 'baseUrls' ? '服务别名' : '名称'}`}
                  placeholder={
                    name === 'baseUrls'
                      ? '服务别名，如 orders'
                      : '名称，如 request_id'
                  }
                  maxLength={100}
                  disabled={disabled}
                />
              </Form.Item>
              <Form.Item
                name={[field.name, 'value']}
                style={{ marginBottom: 8, flex: 2 }}
              >
                <Input
                  aria-label={`${title} ${field.name + 1} 值`}
                  placeholder={
                    name === 'baseUrls'
                      ? '无凭据的 HTTP(S) 地址'
                      : '非秘密值或受保护引用'
                  }
                  disabled={disabled}
                />
              </Form.Item>
              <Button
                danger
                icon={<DeleteOutlined />}
                aria-label={`移除${title} ${field.name + 1}`}
                disabled={disabled}
                onClick={() => remove(field.name)}
              />
            </Space.Compact>
          ))}
          <Button
            icon={<PlusOutlined />}
            disabled={disabled}
            onClick={() => add({ name: '', value: '' })}
          >
            添加{title}
          </Button>
        </Space>
      )}
    </Form.List>
  );
}

function ConfigurationEditor({
  projectId,
  kind,
  target,
  open,
  onClose,
  onSaved,
  canManageEnvironment = false,
  layer = uiLayers.dialog,
}: {
  projectId: string;
  kind: ConfigurationKind;
  target: Configuration | null;
  open: boolean;
  onClose: () => void;
  onSaved: (configuration: Configuration) => Promise<void>;
  canManageEnvironment?: boolean;
  layer?: number;
}) {
  const [form] = Form.useForm<ConfigurationFields>();
  const [references, setReferences] = useState<TestConfigurationView[]>([]);
  const [referenceError, setReferenceError] = useState<string>();
  const [referencesLoading, setReferencesLoading] = useState(false);
  const [environmentEditor, setEnvironmentEditor] = useState<{
    target: Configuration | null;
    epoch: number;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [uncertain, setUncertain] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [discard, setDiscard] = useState(false);
  const commandId = useRef(crypto.randomUUID());
  const editorEpoch = useRef(0);
  const mode = Form.useWatch('authenticationMode', form);
  useEffect(() => {
    if (!open) return;
    const epoch = ++editorEpoch.current;
    const controller = new AbortController();
    commandId.current = crypto.randomUUID();
    form.resetFields();
    form.setFieldsValue(initialFields(target?.content));
    setError(undefined);
    setUncertain(false);
    setDirty(false);
    setDiscard(false);
    setReferences([]);
    setReferencesLoading(true);
    setReferenceError(undefined);
    setEnvironmentEditor(null);
    void api(
      `/projects/${projectId}/test-configuration`,
      { signal: controller.signal },
      testConfigurationListSchema,
    )
      .then((result) => {
        if (!controller.signal.aborted) setReferences(result.configurations);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setReferenceError(describeError(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setReferencesLoading(false);
      });
    return () => {
      controller.abort();
      if (editorEpoch.current === epoch) editorEpoch.current += 1;
    };
  }, [open, target, kind, projectId, form]);
  function options(
    referenceKind: ConfigurationKind,
    selected: string | undefined | null,
  ) {
    const result = references
      .filter((row) => row.content.kind === referenceKind)
      .map((row) => ({
        value: row.id,
        label: `${row.content.name}${'active' in row.content && !row.content.active ? '（已停用）' : ''}`,
        disabled: 'active' in row.content && !row.content.active,
      }));
    if (selected && !result.some((row) => row.value === selected))
      result.push({
        value: selected,
        label: `原引用 ${selected}（目录未取得）`,
        disabled: true,
      });
    return result;
  }
  async function save(values: ConfigurationFields) {
    if (pending || uncertain) return;
    setPending(true);
    setError(undefined);
    try {
      const body = saveTestConfigurationInputSchema.parse({
        commandId: commandId.current,
        rowVersion: target?.rowVersion ?? 0,
        content: configurationFromFields(kind, values),
      });
      const saved = await api(
        `/projects/${projectId}/test-configuration${target ? `/${target.id}` : ''}`,
        { method: target ? 'PUT' : 'POST', body },
        testConfigurationReceiptSchema,
      );
      setDirty(false);
      await onSaved(saved.configuration);
      onClose();
    } catch (failure) {
      if (
        failure instanceof ApiError &&
        (failure.status === 0 || failure.status >= 500)
      )
        setUncertain(true);
      setError(failureText(failure));
    } finally {
      setPending(false);
    }
  }
  function close() {
    if (pending) return;
    if (dirty) setDiscard(true);
    else onClose();
  }
  const environmentId = Form.useWatch('environmentId', form) as
    string | undefined;
  const purposeId = Form.useWatch('purposeId', form) as string | undefined;
  const accountId = Form.useWatch('accountId', form) as string | undefined;
  const authProfileId = Form.useWatch('authProfileId', form) as
    string | undefined;
  const environments = references.filter(
    (row) => row.content.kind === 'environment',
  );
  const hasActiveEnvironment = environments.some(
    (row) => 'active' in row.content && row.content.active,
  );
  async function refreshEnvironments() {
    const epoch = editorEpoch.current;
    setReferencesLoading(true);
    setReferenceError(undefined);
    try {
      const result = await api(
        `/projects/${projectId}/test-configuration`,
        {},
        testConfigurationListSchema,
      );
      if (editorEpoch.current === epoch) setReferences(result.configurations);
    } catch (failure) {
      if (editorEpoch.current === epoch)
        setReferenceError(describeError(failure));
    } finally {
      if (editorEpoch.current === epoch) setReferencesLoading(false);
    }
  }
  return (
    <>
      <Modal
        open={open}
        zIndex={layer}
        title={`${target ? '编辑' : '新增'}${labels[kind]}`}
        width={850}
        onCancel={close}
        closable={!pending}
        maskClosable={!pending}
        keyboard={!pending}
        destroyOnHidden
        footer={
          <Space>
            <Button disabled={pending} onClick={close}>
              取消
            </Button>
            <Button
              type="primary"
              loading={pending}
              disabled={uncertain}
              onClick={() => form.submit()}
            >
              保存配置
            </Button>
          </Space>
        }
      >
        <Alert
          type="info"
          showIcon
          title="配置保存不执行接口、登录或数据库操作"
          description="普通保存直接创建配置修订；停用会影响后续访问，实际权限与运行中的 C6 保护由服务端检查。秘密使用独立安全输入，不写入公共变量、知识或请求模板。"
          className="section-alert"
        />
        {error && (
          <Alert
            type="error"
            showIcon
            title={error}
            className="section-alert"
          />
        )}
        {uncertain && (
          <Alert
            type="warning"
            showIcon
            title={`本次保存回执未知：${commandId.current}`}
            description="已禁重复提交，请先刷新核对当前配置；保留原提交标识，不通过新标识重放未知操作。"
            className="section-alert"
          />
        )}
        {referenceError && (
          <Alert
            type="warning"
            showIcon
            title={`引用目录未取得：${referenceError}`}
            description="既有引用保留，不自动替换。"
            className="section-alert"
          />
        )}
        <Form
          form={form}
          layout="vertical"
          onValuesChange={() => setDirty(true)}
          onFinish={(values) => void save(values)}
        >
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, whitespace: true, max: 200 }]}
          >
            <Input maxLength={200} disabled={pending} />
          </Form.Item>
          <Form.Item name="description" label="非秘密说明">
            <Input.TextArea rows={3} maxLength={10000} disabled={pending} />
          </Form.Item>
          <Form.Item name="active" valuePropName="checked">
            <Checkbox disabled={pending}>启用此配置</Checkbox>
          </Form.Item>
          {kind === 'environment' && (
            <>
              <Typography.Title level={5}>服务地址</Typography.Title>
              <Typography.Paragraph type="secondary">
                服务别名用于用例引用，例如
                orders；须以英文字母或下划线开头，仅支持英文、数字、下划线和连字符，最多100个字符。
              </Typography.Paragraph>
              <PairFields name="baseUrls" title="服务地址" disabled={pending} />
              <Typography.Title level={5}>公共变量</Typography.Title>
              <PairFields
                name="variables"
                title="公共变量"
                disabled={pending}
              />
            </>
          )}
          {(kind === 'binding' || kind === 'databaseConnection') && (
            <>
              {!referencesLoading &&
                !referenceError &&
                !hasActiveEnvironment && (
                  <Alert
                    type="info"
                    showIcon
                    className="section-alert"
                    title={
                      environments.length
                        ? '当前环境均已停用'
                        : '此项目尚未创建环境'
                    }
                    description={
                      <Space direction="vertical">
                        <span>
                          启用{labels[kind]}
                          前需要一个启用的环境。可先创建或启用环境，当前未保存输入会保留。
                          {!canManageEnvironment &&
                            '请联系项目管理员或测试人员维护环境。'}
                        </span>
                        <Space wrap>
                          {canManageEnvironment && (
                            <Button
                              size="small"
                              onClick={() =>
                                setEnvironmentEditor({
                                  target: null,
                                  epoch: editorEpoch.current,
                                })
                              }
                            >
                              新建环境并返回
                            </Button>
                          )}
                          {canManageEnvironment &&
                            environments.map((row) => {
                              const parsed =
                                testConfigurationDtoSchema.safeParse(row);
                              return parsed.success ? (
                                <Button
                                  size="small"
                                  key={row.id}
                                  onClick={() =>
                                    setEnvironmentEditor({
                                      target: parsed.data,
                                      epoch: editorEpoch.current,
                                    })
                                  }
                                >
                                  维护 {row.content.name}
                                </Button>
                              ) : null;
                            })}
                          <Button
                            size="small"
                            onClick={() => void refreshEnvironments()}
                          >
                            刷新环境列表
                          </Button>
                        </Space>
                      </Space>
                    }
                  />
                )}
              <Form.Item
                name="environmentId"
                label="所属环境"
                rules={[{ required: true, message: '请选择启用的环境' }]}
              >
                <Select
                  disabled={pending}
                  showSearch
                  loading={referencesLoading}
                  placeholder="选择启用的环境"
                  optionFilterProp="label"
                  options={options('environment', environmentId)}
                />
              </Form.Item>
            </>
          )}
          {kind === 'binding' && (
            <>
              <Form.Item
                name="purposeId"
                label="账号用途"
                rules={[{ required: true }]}
              >
                <Select
                  disabled={pending}
                  showSearch
                  optionFilterProp="label"
                  options={options('purpose', purposeId)}
                />
              </Form.Item>
              <Form.Item
                name="accountId"
                label="此环境实际测试账号"
                rules={[{ required: true }]}
              >
                <Select
                  disabled={pending}
                  showSearch
                  optionFilterProp="label"
                  options={options('account', accountId)}
                />
              </Form.Item>
              <Form.Item name="authProfileId" label="认证定义（可不指定）">
                <Select
                  allowClear
                  disabled={pending}
                  showSearch
                  optionFilterProp="label"
                  options={options('authProfile', authProfileId)}
                />
              </Form.Item>
              <Typography.Paragraph type="secondary">
                同环境、同用途只允许一个有效绑定；缺失不自动换用其他账号。
              </Typography.Paragraph>
            </>
          )}
          {kind === 'databaseConnection' && (
            <>
              <Form.Item
                name="driver"
                label="数据库类型"
                rules={[{ required: true }]}
              >
                <Select
                  disabled={pending}
                  options={[
                    { value: 'postgresql', label: 'PostgreSQL' },
                    { value: 'mysql', label: 'MySQL' },
                  ]}
                  onChange={(driver: string) => {
                    if (!target)
                      form.setFieldValue(
                        'port',
                        driver === 'mysql' ? 3306 : 5432,
                      );
                  }}
                />
              </Form.Item>
              <Form.Item
                name="host"
                label="目标主机"
                rules={[{ required: true }]}
              >
                <Input disabled={pending} />
              </Form.Item>
              <Form.Item
                name="port"
                label="端口"
                rules={[
                  { required: true, message: '请输入数据库端口' },
                  {
                    type: 'integer',
                    min: 1,
                    max: 65535,
                    message: '端口必须为 1 至 65535 的整数，请修改后再保存',
                  },
                ]}
              >
                <InputNumber disabled={pending} />
              </Form.Item>
              <Form.Item
                name="database"
                label="数据库名"
                rules={[{ required: true }]}
              >
                <Input maxLength={128} disabled={pending} />
              </Form.Item>
              <Form.Item name="tls" valuePropName="checked">
                <Checkbox disabled={pending}>使用 TLS</Checkbox>
              </Form.Item>
              <Typography.Paragraph type="secondary">
                连接配置不提供任意 SQL
                执行。用户名/密码保存后从此列表的独立安全输入维护。
              </Typography.Paragraph>
            </>
          )}
          {kind === 'authProfile' && (
            <>
              <Form.Item
                name="authenticationMode"
                label="认证方式"
                rules={[{ required: true }]}
              >
                <Select
                  disabled={pending}
                  options={[
                    { value: 'token', label: '已有 Token' },
                    { value: 'login', label: '登录请求获取 Token' },
                  ]}
                />
              </Form.Item>
              <Form.Item
                name="destinationLocation"
                label="Token 携带位置"
                rules={[{ required: true }]}
              >
                <Select
                  disabled={pending}
                  options={['header', 'cookie', 'query'].map((value) => ({
                    value,
                    label: value,
                  }))}
                />
              </Form.Item>
              <Form.Item
                name="destinationName"
                label="实际 Header/Cookie/Query 名称"
                rules={[{ required: true }]}
              >
                <Input
                  disabled={pending}
                  placeholder="按被测服务明确填写，不假定字段"
                />
              </Form.Item>
              <Form.Item
                name="destinationPrefix"
                label="携带前缀（可空，保留尾部空格）"
              >
                <Input disabled={pending} />
              </Form.Item>
              {mode === 'login' && (
                <>
                  <Form.Item
                    name="baseUrlName"
                    label="环境服务地址名称"
                    rules={[{ required: true }]}
                  >
                    <Input
                      disabled={pending}
                      placeholder="所选环境中服务地址的名称"
                    />
                  </Form.Item>
                  <Form.Item
                    name="path"
                    label="登录路径"
                    rules={[{ required: true }]}
                  >
                    <Input
                      disabled={pending}
                      placeholder="以 / 开头的相对路径"
                    />
                  </Form.Item>
                  <Form.Item
                    name="method"
                    label="登录方法"
                    rules={[{ required: true }]}
                  >
                    <Select
                      disabled={pending}
                      options={['GET', 'POST'].map((value) => ({
                        value,
                        label: value,
                      }))}
                    />
                  </Form.Item>
                  <Typography.Title level={5}>
                    登录 Header 模板
                  </Typography.Title>
                  <PairFields
                    name="headers"
                    title="登录Header"
                    disabled={pending}
                  />
                  <Form.Item
                    name="bodyTemplate"
                    label="登录 Body JSON 模板（仅受保护引用，无真实凭据）"
                    rules={[{ required: true }]}
                  >
                    <Input.TextArea
                      rows={5}
                      disabled={pending}
                      placeholder={
                        '{"username":"{{account.username}}","password":"{{account.password}}"}'
                      }
                    />
                  </Form.Item>
                  <Form.Item
                    name="extractorSource"
                    label="Token 提取来源"
                    rules={[{ required: true }]}
                  >
                    <Select
                      disabled={pending}
                      options={['json', 'header', 'body'].map((value) => ({
                        value,
                        label: value,
                      }))}
                    />
                  </Form.Item>
                  <Form.Item name="extractorPath" label="Token 字段/路径">
                    <Input disabled={pending} />
                  </Form.Item>
                </>
              )}
            </>
          )}
        </Form>
        <Typography.Text type="secondary">
          保存创建新修订，历史配置继续保留。
        </Typography.Text>
      </Modal>
      {environmentEditor && (
        <ConfigurationEditor
          projectId={projectId}
          kind="environment"
          target={environmentEditor.target}
          open
          canManageEnvironment={canManageEnvironment}
          layer={uiLayers.nestedDialog}
          onClose={() => setEnvironmentEditor(null)}
          onSaved={async (saved) => {
            if (environmentEditor.epoch !== editorEpoch.current) return;
            setReferences((current) => [
              ...current.filter((row) => row.id !== saved.id),
              saved,
            ]);
            if (saved.content.active) {
              form.setFieldValue('environmentId', saved.id);
              setDirty(true);
            }
          }}
        />
      )}
      <Modal
        open={discard}
        zIndex={uiLayers.confirmation}
        title="配置有未保存修改"
        onCancel={() => setDiscard(false)}
        footer={
          <Space>
            <Button onClick={() => setDiscard(false)}>继续编辑</Button>
            <Button
              danger
              onClick={() => {
                setDiscard(false);
                onClose();
              }}
            >
              放弃修改
            </Button>
            <Button
              type="primary"
              disabled={uncertain}
              onClick={() => {
                setDiscard(false);
                form.submit();
              }}
            >
              保存
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph>
          保存创建新修订；放弃仅丢弃当前未保存输入。
        </Typography.Paragraph>
      </Modal>
    </>
  );
}

function CredentialEditor({
  projectId,
  target,
  onClose,
  onSaved,
}: {
  projectId: string;
  target: Configuration | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form] = Form.useForm<{
    username: string;
    password: string;
    value: string;
  }>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [uncertain, setUncertain] = useState(false);
  const commandId = useRef(crypto.randomUUID());
  const isToken = target?.content.kind === 'authProfile';
  useEffect(() => {
    commandId.current = crypto.randomUUID();
    form.resetFields();
    setError(undefined);
    setUncertain(false);
  }, [target, form]);
  async function save(values: {
    username: string;
    password: string;
    value: string;
  }) {
    if (!target || pending || uncertain) return;
    setPending(true);
    setError(undefined);
    try {
      const body = projectCredentialInputSchema.parse({
        commandId: commandId.current,
        rowVersion: target.rowVersion,
        credential: isToken
          ? { value: values.value }
          : { username: values.username, password: values.password },
      });
      await api(
        `/projects/${projectId}/test-configuration/${target.id}/credential`,
        { method: 'PUT', body },
        testConfigurationReceiptSchema,
      );
      form.resetFields();
      await onSaved();
      onClose();
    } catch (failure) {
      if (
        failure instanceof ApiError &&
        (failure.status === 0 || failure.status >= 500)
      )
        setUncertain(true);
      setError(failureText(failure));
    } finally {
      form.resetFields();
      setPending(false);
    }
  }
  return (
    <Modal
      open={target !== null}
      zIndex={uiLayers.dialog}
      title={`安全输入凭据：${target?.content.name ?? ''}`}
      onCancel={onClose}
      closable={!pending}
      maskClosable={!pending}
      keyboard={!pending}
      onOk={() => form.submit()}
      confirmLoading={pending}
      okButtonProps={{ disabled: uncertain }}
      okText="保存受保护凭据"
      cancelText="关闭"
      destroyOnHidden
    >
      <Alert
        type="info"
        showIcon
        title="既有凭据不回显；新值仅发送到本机安全配置通道"
        description="关闭或提交后清空输入。凭据不进入普通配置、模型上下文或报告。"
        className="section-alert"
      />
      {error && (
        <Alert type="error" title={error} showIcon className="section-alert" />
      )}
      {uncertain && (
        <Alert
          type="warning"
          showIcon
          title={`本次凭据保存回执未知：${commandId.current}`}
          description="已清空输入并禁重发；刷新当前配置核对版本，不通过新标识重复提交未知操作。"
          className="section-alert"
        />
      )}
      <Form
        form={form}
        layout="vertical"
        onFinish={(values) => void save(values)}
      >
        {isToken ? (
          <Form.Item name="value" label="新 Token" rules={[{ required: true }]}>
            <Input.Password autoComplete="off" disabled={pending} />
          </Form.Item>
        ) : (
          <>
            <Form.Item
              name="username"
              label="受保护用户名"
              rules={[{ required: true }]}
            >
              <Input autoComplete="off" disabled={pending} />
            </Form.Item>
            <Form.Item
              name="password"
              label="新密码"
              rules={[{ required: true }]}
            >
              <Input.Password autoComplete="new-password" disabled={pending} />
            </Form.Item>
          </>
        )}
      </Form>
    </Modal>
  );
}

export function TestConfigurationPage({
  project,
  databaseOnly = false,
}: {
  project: Project | null;
  databaseOnly?: boolean;
}) {
  const { message } = App.useApp();
  const [kind, setKind] = useState<ConfigurationKind>(
    databaseOnly ? 'databaseConnection' : 'environment',
  );
  const [rows, setRows] = useState<TestConfigurationView[]>([]);
  const [references, setReferences] = useState<TestConfigurationView[]>([]);
  const [referenceError, setReferenceError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [editor, setEditor] = useState(false);
  const [editing, setEditing] = useState<Configuration | null>(null);
  const [credential, setCredential] = useState<Configuration | null>(null);
  const [selected, setSelected] = useState<TestConfigurationView | null>(null);
  const generation = useRef(0);
  const canWrite = Boolean(
    project &&
    (project.isAdmin ||
      project.roles.includes('tester') ||
      (kind === 'databaseConnection' && project.roles.includes('developer'))),
  );
  async function load(signal?: AbortSignal) {
    const epoch = ++generation.current;
    if (!project) return;
    setLoading(true);
    try {
      const result = await api(
        `/projects/${project.id}/test-configuration?kind=${kind}`,
        signal ? { signal } : {},
        testConfigurationListSchema,
      );
      if (!signal?.aborted && epoch === generation.current) {
        setRows(result.configurations);
        setError(undefined);
      }
    } catch (failure) {
      if (!signal?.aborted && epoch === generation.current) {
        setRows([]);
        setError(describeError(failure));
      }
    } finally {
      if (!signal?.aborted && epoch === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    setRows([]);
    setEditor(false);
    setEditing(null);
    setCredential(null);
    setSelected(null);
    void load(controller.signal);
    return () => controller.abort();
  }, [project?.id, kind]);
  useEffect(() => {
    if (!project || kind !== 'environment') return;
    const controller = new AbortController();
    setReferences([]);
    setReferenceError(undefined);
    void Promise.allSettled(
      ['binding', 'purpose', 'account'].map((type) =>
        api(
          `/projects/${project.id}/test-configuration?kind=${type}`,
          { signal: controller.signal },
          testConfigurationListSchema,
        ),
      ),
    ).then((results) => {
      if (controller.signal.aborted) return;
      setReferences(
        results.flatMap((result) =>
          result.status === 'fulfilled' ? result.value.configurations : [],
        ),
      );
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length)
        setReferenceError(
          failures.map((result) => describeError(result.reason)).join('；'),
        );
    });
    return () => controller.abort();
  }, [project?.id, kind, rows]);
  if (!project) return <Empty description="请先选择当前有效项目。" />;
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <section className="card pad configuration-card">
        <div className="between">
          <h2>{kind === 'environment' ? '环境与账号用途' : labels[kind]}</h2>
          <div className="row">
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={loading}
              onClick={() => void load()}
              aria-label="刷新测试配置"
            />
            <Button
              size="small"
              type="primary"
              icon={<PlusOutlined />}
              disabled={!canWrite}
              onClick={() => {
                setEditing(null);
                setEditor(true);
              }}
            >
              新增{labels[kind]}
            </Button>
          </div>
        </div>
        {!databaseOnly && (
          <div
            className="row wrap mt configuration-kinds"
            aria-label="测试配置分类"
          >
            {configurationKindSchema.options
              .filter((type) => type !== 'databaseConnection')
              .map((type) => (
                <button
                  type="button"
                  key={type}
                  className={`btn small ${kind === type ? 'primary' : ''}`}
                  aria-pressed={kind === type}
                  onClick={() => setKind(type)}
                >
                  {labels[type]}
                </button>
              ))}
          </div>
        )}
        <p className="caption mt">
          {kind === 'environment'
            ? '用例引用用途，执行时按环境解析账号。临时提取值不写回公共环境。'
            : kind === 'databaseConnection'
              ? '连接信息与受保护凭据分开维护；此处不提供任意 SQL 执行。'
              : '配置引用独立保存，凭据通过安全输入维护。保存不代表目标已经联通。'}
        </p>
        {!canWrite && (
          <p className="caption mt">
            当前权限只读。环境与账号由测试人员或项目管理员维护，数据库连接也允许开发人员维护。
          </p>
        )}
        {error && (
          <Alert
            type="error"
            showIcon
            title={error}
            className="section-alert"
          />
        )}
        {referenceError && kind === 'environment' && (
          <Alert
            type="warning"
            showIcon
            title={`绑定摘要未完整取得：${referenceError}`}
            className="section-alert"
          />
        )}
        {loading ? (
          <p className="caption mt" role="status">
            正在读取配置…
          </p>
        ) : !rows.length ? (
          <Empty
            className="mt"
            description={error ? '配置尚未取得。' : '此分类尚无配置。'}
          />
        ) : (
          rows.map((row) => {
            const parsed = testConfigurationDtoSchema.safeParse(row);
            const content = row.content;
            const bindings = references.filter(
              (ref) =>
                ref.content.kind === 'binding' &&
                ref.content.environmentId === row.id,
            );
            const credentialApplicable =
              content.kind === 'account' ||
              content.kind === 'databaseConnection' ||
              (content.kind === 'authProfile' &&
                content.authentication.mode === 'token');
            return (
              <div className="listrow" key={row.id}>
                <div className="grow">
                  <b>{content.name}</b>
                  <p>
                    {content.kind === 'environment' && 'baseUrls' in content
                      ? Object.entries(content.baseUrls)
                          .map(([name, url]) => `${name} · ${url}`)
                          .join('；')
                      : content.kind === 'binding'
                        ? `环境 ${content.environmentId} · 用途 ${content.purposeId}`
                        : 'description' in content && content.description
                          ? content.description
                          : `${labels[content.kind]} · v${row.rowVersion}`}
                  </p>
                  {content.kind === 'environment' && !!bindings.length && (
                    <div className="row wrap binding-summary">
                      {bindings.map((ref) => {
                        const binding = ref.content;
                        return binding.kind === 'binding' ? (
                          <span className="badge" key={ref.id}>
                            {references.find(
                              (item) => item.id === binding.purposeId,
                            )?.content.name ?? binding.purposeId}{' '}
                            →{' '}
                            {references.find(
                              (item) => item.id === binding.accountId,
                            )?.content.name ?? binding.accountId}
                            {!binding.active ? '（已停用）' : ''}
                          </span>
                        ) : null;
                      })}
                    </div>
                  )}
                </div>
                <div className="row wrap configuration-row-actions">
                  {'active' in content && !content.active && (
                    <span className="badge amber">已停用</span>
                  )}
                  {credentialApplicable && 'hasCredential' in row && (
                    <span className="badge">
                      {row.hasCredential ? '凭据已配置' : '未配置凭据'}
                    </span>
                  )}
                  <Button size="small" onClick={() => setSelected(row)}>
                    查看
                  </Button>
                  {canWrite && parsed.success && (
                    <Button
                      size="small"
                      icon={<EditOutlined />}
                      onClick={() => {
                        setEditing(parsed.data);
                        setEditor(true);
                      }}
                    >
                      维护
                    </Button>
                  )}
                  {canWrite && parsed.success && credentialApplicable && (
                    <Button
                      size="small"
                      onClick={() => setCredential(parsed.data)}
                    >
                      安全输入凭据
                    </Button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </section>
      <ConfigurationEditor
        projectId={project.id}
        kind={kind}
        target={editing}
        open={editor}
        canManageEnvironment={
          project.isAdmin || project.roles.includes('tester')
        }
        onClose={() => setEditor(false)}
        onSaved={async () => {
          await load();
          void message.success('配置已保存；未执行接口或数据库操作。');
        }}
      />
      <CredentialEditor
        projectId={project.id}
        target={credential}
        onClose={() => setCredential(null)}
        onSaved={async () => {
          await load();
          void message.success('受保护凭据已保存，输入已清空。');
        }}
      />
      <Modal
        open={selected !== null}
        title={selected?.content.name ?? '配置详情'}
        footer={null}
        onCancel={() => setSelected(null)}
        width={800}
        destroyOnHidden
      >
        {selected && (
          <>
            <Descriptions
              column={1}
              bordered
              items={[
                { key: 'id', label: '配置ID', children: selected.id },
                {
                  key: 'rev',
                  label: '不可变修订ID',
                  children: selected.revisionId,
                },
                {
                  key: 'version',
                  label: '当前并发版本',
                  children: selected.rowVersion,
                },
              ]}
            />
            <Collapse
              className="section-alert"
              items={[
                {
                  key: 'metadata',
                  label: '当前权限可见的非秘密配置',
                  children: (
                    <pre className="message-code">
                      {JSON.stringify(selected.content, null, 2)}
                    </pre>
                  ),
                },
              ]}
            />
          </>
        )}
      </Modal>
    </Space>
  );
}

function SkillGuidanceSettings({ ownerId }: { ownerId: string }) {
  const [catalog, setCatalog] = useState<SkillGuidanceCatalog | null>(null);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setCatalog(null);
    setError(undefined);
    void api(
      '/me/skill-guidance',
      { signal: controller.signal },
      skillGuidanceCatalogSchema,
    )
      .then((value) => {
        if (!controller.signal.aborted) setCatalog(value);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(describeError(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [ownerId, refresh]);
  const availability = {
    available: '平台规则可选',
    unavailable: '平台规则暂不可用',
    localOnly: '仅本地执行',
    deferred: '延期',
  };
  return (
    <>
      <div className="between mt">
        <h3>当前 Skill 指引目录</h3>
        <Button
          size="small"
          loading={loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          刷新目录
        </Button>
      </div>
      {loading && (
        <p role="status" className="caption mt">
          正在读取当前目录…
        </p>
      )}
      {error && (
        <Alert
          className="section-alert"
          type="warning"
          showIcon
          title={`Skill 目录未取得：${error}`}
        />
      )}
      <div className="two mt">
        {catalog?.skills.map((skill) => (
          <div className="card pad" key={skill.skillId}>
            <div className="between">
              <h3>{skill.name}</h3>
              <span
                className={`badge ${skill.availability === 'available' ? 'green' : skill.availability === 'localOnly' ? '' : 'amber'}`}
              >
                {availability[skill.availability]}
              </span>
            </div>
            {skill.version && (
              <p className="caption mt">版本 {skill.version}</p>
            )}
            <p className="caption mt">{skill.description}</p>
            {skill.unavailableCode && (
              <p className="caption mt">不可用原因：{skill.unavailableCode}</p>
            )}
          </div>
        ))}
      </div>
      <div className="notice mt">
        平台规则可选仅表示平台可读取共享指引，不代表外部宿主已安装、自动加载或实际执行已通过验证。
        UI 自主测试仍由本地 AI、Skill 和 Ego 执行。官方 MCP
        不开放项目创建、成员角色管理、平台全局配置或任意数据库执行。
      </div>
    </>
  );
}

export function ProjectConfigurationPage({
  project,
  me,
  onMembershipChanged,
  onPersonalSettings,
}: {
  project: Project | null;
  me: Me;
  onMembershipChanged: () => Promise<void>;
  onPersonalSettings: (tab?: string) => void;
}) {
  return (
    <div className="project-settings-page">
      <PageHeading
        eyebrow="PROJECT & SETTINGS"
        title="项目与设置"
        description="平台管理、项目管理及个人能力分别授权。"
        actions={
          <Button
            icon={<AppIcon name="user" />}
            onClick={() => onPersonalSettings()}
          >
            个人设置
          </Button>
        }
      />
      <Tabs
        className="project-setting-tabs"
        destroyOnHidden
        defaultActiveKey={
          project ? 'environment' : me.user.isPlatformAdmin ? 'projects' : 'mcp'
        }
        items={[
          ...(project
            ? [
                {
                  key: 'environment',
                  label: '环境与账号',
                  children: (
                    <TestConfigurationPage
                      key={`${project.id}:environment`}
                      project={project}
                    />
                  ),
                },
                {
                  key: 'databases',
                  label: '数据库连接',
                  children: (
                    <TestConfigurationPage
                      key={`${project.id}:databases`}
                      project={project}
                      databaseOnly
                    />
                  ),
                },
                {
                  key: 'members',
                  label: '项目成员',
                  children: (
                    <ProjectSettings
                      project={project}
                      canManage={project.isAdmin}
                      onMembershipChanged={onMembershipChanged}
                    />
                  ),
                },
              ]
            : []),
          ...(me.user.isPlatformAdmin
            ? [
                {
                  key: 'projects',
                  label: '项目管理',
                  children: (
                    <PlatformProjects onRefresh={onMembershipChanged} />
                  ),
                },
                {
                  key: 'accounts',
                  label: '平台账号',
                  children: <PlatformUsers onRefresh={onMembershipChanged} />,
                },
                {
                  key: 'models',
                  label: '模型与外部 MCP',
                  children: <PlatformModelSettings />,
                },
              ]
            : []),
          {
            key: 'mcp',
            label: '官方 MCP 与 Skill',
            children: (
              <section className="card pad">
                <h2>官方测试业务 MCP 与共享 Skill</h2>
                <p className="caption mt">
                  本地 AI 使用当前用户的个人
                  Key，执行相同项目权限、评审、版本和提交规则。
                </p>
                <div className="setting-row">
                  <div>
                    <h3>官方 MCP</h3>
                    <p>
                      Streamable HTTP · 个人 Key Bearer 鉴权；当前权限实时校验。
                    </p>
                  </div>
                  <code>{window.location.origin}/mcp</code>
                </div>
                <SkillGuidanceSettings ownerId={me.user.id} />
                <Button
                  className="mt"
                  type="primary"
                  onClick={() => onPersonalSettings('keys')}
                >
                  管理个人 Key
                </Button>
              </section>
            ),
          },
        ]}
      />
    </div>
  );
}
