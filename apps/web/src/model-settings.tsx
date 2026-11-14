import { useEffect, useRef, useState } from 'react';
import { Alert, App, Empty, Input, Modal, Select, Spin, Tabs } from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  KeyOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { z } from 'zod';
import {
  auxiliaryModelInputV2Schema,
  auxiliaryModelV2ReceiptSchema,
  availableModelV2ListSchema,
  modelCredentialV2Schema,
  modelDiscoveryV2InputSchema,
  modelDiscoveryV2ReceiptSchema,
  modelServiceCasV2Schema,
  modelServiceV2ListSchema,
  type ModelServiceV2,
  type AvailableModelV2,
} from '../../../packages/contracts/src/model-configuration-v2';
import { defaultModelAuthScheme } from '../../../packages/contracts/src/model-protocol';
import { userSummarySchema } from '../../../packages/contracts/src/identity';
import { api, describeError } from './api';
import {
  currentIdentityOwner,
  identityContextEpoch,
  subscribeIdentityChanges,
} from './identity-context';
import { ExternalMcpAdminSettings } from './external-mcp-settings';
import { PageHeading } from './page-heading';
import { uiLayers } from './ui-layers';
import { registerNavigationBlocker } from './navigation-guard';
import {
  dispatchModelCommand,
  pendingModelCommands,
  prepareModelCommand,
  recoverModelCommand,
  type ModelCommandIntent,
  type ModelCommandOperation,
  type ModelCommandReceipt,
} from './model-configuration-command';
import {
  credentialBindingChanged,
  auxiliaryBindingUnavailable,
  emptyModelEntry,
  emptyServiceDraft,
  prepareServiceBody,
  protocolLabels,
  serviceDraft,
  type ModelServiceDraft,
} from './model-settings-values';
import './model-settings-v2.css';
import {
  AuxiliaryReadbackGuard,
  reconcileAuxiliarySnapshot,
  type AuxiliaryModelView,
} from './auxiliary-model-readback';
const userSearchSchema = z.strictObject({ users: z.array(userSummarySchema) });
type Auxiliary = z.infer<typeof auxiliaryModelV2ReceiptSchema>['auxiliary'];
const verificationLabels = {
  unverified: '尚未验证',
  partial: '部分验证',
  verified: '已验证',
  failed: '验证未通过',
};
const errorText = (failure: unknown) =>
  failure instanceof z.ZodError
    ? failure.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('；')
    : describeError(failure);
const scopesText = (scopes: string[]) =>
  scopes
    .map((scope) =>
      scope === 'syntheticPublicOnly'
        ? '合成与公开资料'
        : '已授权的相关内部测试资料',
    )
    .join('、');
function Verification({
  model,
}: {
  model: Pick<AvailableModelV2, 'verification'>;
}) {
  return (
    <details className="model-verification">
      <summary>
        <span
          className={`badge ${model.verification.status === 'failed' ? 'red' : model.verification.status === 'verified' ? 'green' : ''}`}
        >
          {verificationLabels[model.verification.status]}
        </span>
      </summary>
      <div className="caption mt">
        最近实际验证：
        {model.verification.checkedAt
          ? new Date(model.verification.checkedAt).toLocaleString('zh-CN')
          : '未执行'}
      </div>
      <div className="row wrap mt">
        {Object.entries(model.verification.checks).map(([name, status]) => (
          <span className="badge" key={name}>
            {name}：
            {status === 'passed'
              ? '通过'
              : status === 'failed'
                ? '失败'
                : '未验证'}
          </span>
        ))}
      </div>
      <p className="caption">
        保存配置、设置 Key 或获取模型列表不会标记联通成功。
      </p>
    </details>
  );
}
export function AvailableModelList() {
  const [models, setModels] = useState<AvailableModelV2[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<string>();
  const generation = useRef(0);
  async function load(signal?: AbortSignal) {
    const attempt = ++generation.current;
    setLoading(true);
    try {
      const result = await api(
        '/model-services',
        signal ? { signal } : {},
        availableModelV2ListSchema,
      );
      if (!signal?.aborted && attempt === generation.current) {
        setModels(result.models);
        setError(undefined);
      }
    } catch (failure) {
      if (!signal?.aborted && attempt === generation.current) {
        setModels([]);
        setError(errorText(failure));
      }
    } finally {
      if (!signal?.aborted && attempt === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
      generation.current++;
    };
  }, []);
  return (
    <section className="model-settings-v2">
      <div className="between">
        <h2>可用模型</h2>
        <button
          className="btn small"
          disabled={loading}
          onClick={() => void load()}
        >
          <ReloadOutlined /> 刷新
        </button>
      </div>
      <p className="caption mt">
        这里只读取向本人开放的模型配置，不发送模型请求。菜单显示名与实际模型标识分别展示。
      </p>
      {error && (
        <Alert className="section-alert" type="error" showIcon title={error} />
      )}
      {loading ? (
        <Spin />
      ) : !models.length ? (
        <Empty
          description={error ? '列表未能加载' : '当前没有向本人开放的模型'}
        />
      ) : (
        <div className="model-row-list mt">
          {models.map((model) => (
            <article
              className="card pad"
              key={`${model.modelServiceId}:${model.modelEntryId}`}
            >
              <div className="between">
                <div>
                  <h2>{model.displayName || model.modelId}</h2>
                  <p className="caption">
                    {model.serviceName} · {protocolLabels[model.protocol]}
                  </p>
                </div>
                <span className={`badge ${model.available ? 'green' : ''}`}>
                  {model.available ? '凭据已配置' : '缺少凭据'}
                </span>
              </div>
              <dl className="model-facts">
                <div>
                  <dt>实际模型</dt>
                  <dd>{model.modelId}</dd>
                </div>
                <div>
                  <dt>服务地址</dt>
                  <dd>{model.baseUrl}</dd>
                </div>
                <div>
                  <dt>服务修订</dt>
                  <dd>r{model.serviceRevision}</dd>
                </div>
                <div>
                  <dt>资料范围</dt>
                  <dd>{scopesText(model.allowedDataScopes)}</dd>
                </div>
                <div>
                  <dt>上下文 / 最大输出</dt>
                  <dd>
                    {model.contextLimit ?? '未指定'} /{' '}
                    {model.maxOutput ?? '未指定'}
                  </dd>
                </div>
                <div>
                  <dt>强度</dt>
                  <dd>{model.effortValues.join('、') || '未配置'}</dd>
                </div>
              </dl>
              <Verification model={model} />
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
function AllowedUserPicker({
  value,
  onChange,
  disabled,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  disabled: boolean;
}) {
  const [search, setSearch] = useState(''),
    [options, setOptions] = useState<{ value: string; label: string }[]>([]),
    [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api(
        `/users?search=${encodeURIComponent(search)}`,
        { signal: controller.signal },
        userSearchSchema,
      )
        .then((result) => {
          if (controller.signal.aborted) return;
          setOptions((current) => {
            const byId = new Map(
              current.map((option) => [option.value, option]),
            );
            result.users
              .filter((user) => user.active)
              .forEach((user) =>
                byId.set(user.id, {
                  value: user.id,
                  label: `${user.displayName}（${user.account}）`,
                }),
              );
            return [...byId.values()];
          });
          setError(undefined);
        })
        .catch((failure) => {
          if (!controller.signal.aborted) setError(errorText(failure));
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [search]);
  return (
    <>
      <Select
        aria-label="可使用此服务的账号"
        mode="multiple"
        showSearch
        filterOption={false}
        value={value}
        onChange={onChange}
        onSearch={setSearch}
        options={[
          ...options,
          ...value
            .filter((id) => !options.some((option) => option.value === id))
            .map((id) => ({ value: id, label: `已授权账号 ${id}` })),
        ]}
        disabled={disabled}
        placeholder="搜索姓名或账号；空名单不向普通账号开放"
      />
      {error && (
        <div role="alert" className="model-error">
          {error}
        </div>
      )}
    </>
  );
}
function useConfigurationCommands(
  onReceipt: (receipt: ModelCommandReceipt) => void,
  onRecovered: () => void,
) {
  const [, setIdentityVersion] = useState(0),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string>(),
    [records, setRecords] = useState<ModelCommandIntent[]>([]),
    [storageError, setStorageError] = useState<string>();
  const busy = useRef(false),
    mounted = useRef(true),
    owner = currentIdentityOwner();
  function refresh() {
    const actor = currentIdentityOwner();
    if (!actor) return;
    try {
      setRecords(pendingModelCommands(actor));
      setStorageError(undefined);
    } catch (failure) {
      setStorageError(errorText(failure));
    }
  }
  useEffect(() => {
    mounted.current = true;
    refresh();
    const stop = subscribeIdentityChanges(() => {
      setIdentityVersion((value) => value + 1);
      setError(undefined);
      setRecords([]);
    });
    const listener = () => refresh();
    window.addEventListener('storage', listener);
    return () => {
      mounted.current = false;
      stop();
      window.removeEventListener('storage', listener);
    };
  }, []);
  useEffect(() => {
    refresh();
  }, [owner]);
  async function run(
    operation: ModelCommandOperation,
    serviceId: string | null,
    path: string,
    method: 'POST' | 'PUT' | 'DELETE',
    build: (commandId: string) => Record<string, unknown>,
  ) {
    if (
      !owner ||
      currentIdentityOwner() !== owner ||
      busy.current ||
      records.length ||
      storageError
    )
      return null;
    build(crypto.randomUUID());
    const start = identityContextEpoch();
    busy.current = true;
    setPending(true);
    setError(undefined);
    try {
      const intent = prepareModelCommand(owner, operation, serviceId);
      refresh();
      const receipt = await dispatchModelCommand(
        intent,
        path,
        method,
        build(intent.commandId),
      );
      if (
        !mounted.current ||
        currentIdentityOwner() !== owner ||
        identityContextEpoch() !== start
      )
        return null;
      onReceipt(receipt);
      return receipt;
    } catch (failure) {
      if (
        mounted.current &&
        currentIdentityOwner() === owner &&
        identityContextEpoch() === start
      )
        setError(errorText(failure));
      return null;
    } finally {
      busy.current = false;
      if (mounted.current) {
        setPending(false);
        refresh();
      }
    }
  }
  async function recover(record: ModelCommandIntent) {
    if (!owner || busy.current || currentIdentityOwner() !== owner) return;
    const start = identityContextEpoch();
    busy.current = true;
    setPending(true);
    setError(undefined);
    try {
      const result = await recoverModelCommand(record);
      if (
        !mounted.current ||
        currentIdentityOwner() !== owner ||
        identityContextEpoch() !== start
      )
        return;
      if (result) {
        onReceipt(result);
        onRecovered();
      } else
        setError(
          '当前仍未查到确定回执，已保留原命令。不会重发或自动继续后续配置。',
        );
    } catch (failure) {
      if (
        mounted.current &&
        currentIdentityOwner() === owner &&
        identityContextEpoch() === start
      )
        setError(`${errorText(failure)}；保留原命令，不代表未执行。`);
    } finally {
      busy.current = false;
      if (mounted.current) {
        setPending(false);
        refresh();
      }
    }
  }
  return {
    run,
    recover,
    pending,
    error,
    records,
    storageError,
    blocked: !owner || pending || records.length > 0 || !!storageError,
  };
}
type ConfigurationCommands = ReturnType<typeof useConfigurationCommands>;
function ServiceEditor({
  initial,
  commands,
  onClose,
  onCredential,
}: {
  initial: ModelServiceV2 | null;
  commands: ConfigurationCommands;
  onClose: () => void;
  onCredential: (service: ModelServiceV2) => void;
}) {
  const { modal } = App.useApp();
  const [baseline, setBaseline] = useState(initial),
    [serviceId] = useState(() => initial?.id ?? crypto.randomUUID()),
    [draft, setDraft] = useState<ModelServiceDraft>(() =>
      initial ? serviceDraft(initial) : emptyServiceDraft(),
    ),
    [error, setError] = useState<string>(),
    [discovery, setDiscovery] = useState<z.infer<
      typeof modelDiscoveryV2ReceiptSchema
    > | null>(null),
    [discovering, setDiscovering] = useState(false);
  const [savedDraft, setSavedDraft] = useState(() =>
    JSON.stringify(initial ? serviceDraft(initial) : draft),
  );
  const dirty = JSON.stringify(draft) !== savedDraft,
    bindingChanged = baseline
      ? credentialBindingChanged(baseline, draft)
      : false,
    bindingBlocked = !!baseline?.hasCredential && bindingChanged;
  const alive = useRef(true),
    epoch = useRef(identityContextEpoch());
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(
    () =>
      registerNavigationBlocker((proceed) => {
        if (commands.pending || discovering) return;
        if (!dirty) {
          onClose();
          proceed();
          return;
        }
        modal.confirm({
          title: '有未保存的模型配置',
          content: '只丢弃本地表单，原命令回执仍保留。',
          okText: '放弃修改并离开',
          cancelText: '继续编辑',
          zIndex: uiLayers.confirmation,
          onOk: () => {
            onClose();
            proceed();
          },
        });
      }),
    [dirty, commands.pending, discovering, modal, onClose],
  );
  function close() {
    if (commands.pending || discovering) return;
    if (dirty)
      modal.confirm({
        title: '放弃未保存的配置？',
        content: '只丢弃本地表单。已提交的原命令仍保留，可从页面顶部只读查回。',
        okText: '放弃修改',
        cancelText: '继续编辑',
        zIndex: uiLayers.confirmation,
        onOk: onClose,
      });
    else onClose();
  }
  function patch<K extends keyof ModelServiceDraft>(
    key: K,
    value: ModelServiceDraft[K],
  ) {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setDiscovery(null);
  }
  async function save() {
    setError(undefined);
    try {
      const result = await commands.run(
        baseline ? 'configuration.model-update' : 'configuration.model-create',
        serviceId,
        `/admin/model-services${baseline ? `/${serviceId}` : ''}`,
        baseline ? 'PUT' : 'POST',
        (commandId) =>
          prepareServiceBody(draft, commandId, serviceId, baseline),
      );
      if (
        result &&
        'modelService' in result &&
        alive.current &&
        epoch.current === identityContextEpoch()
      ) {
        setBaseline(result.modelService);
        const next = serviceDraft(result.modelService);
        setDraft(next);
        setSavedDraft(JSON.stringify(next));
      }
    } catch (failure) {
      setError(errorText(failure));
    }
  }
  async function revoke() {
    if (!baseline) return;
    const result = await commands.run(
      'configuration.model-credential-revoke',
      baseline.id,
      `/admin/model-services/${baseline.id}/credential`,
      'DELETE',
      (commandId) =>
        modelServiceCasV2Schema.parse({
          commandId,
          rowVersion: baseline.rowVersion,
        }),
    );
    if (
      result &&
      'modelService' in result &&
      alive.current &&
      epoch.current === identityContextEpoch()
    )
      setBaseline(result.modelService);
  }
  async function discover() {
    if (!baseline || dirty || discovering || commands.blocked) return;
    const revision = baseline.serviceRevision;
    setDiscovering(true);
    setError(undefined);
    try {
      const result = await api(
        `/admin/model-services/${baseline.id}/discover-models`,
        {
          method: 'POST',
          body: modelDiscoveryV2InputSchema.parse({
            serviceRevision: revision,
          }),
        },
        modelDiscoveryV2ReceiptSchema,
      );
      if (alive.current && epoch.current === identityContextEpoch()) {
        if (
          result.modelServiceId !== baseline.id ||
          result.serviceRevision !== revision
        )
          throw new Error('模型发现回执不属于当前保存修订');
        setDiscovery(result);
      }
    } catch (failure) {
      if (alive.current && epoch.current === identityContextEpoch())
        setError(errorText(failure));
    } finally {
      if (alive.current) setDiscovering(false);
    }
  }
  function updateEntry(
    index: number,
    update: Partial<ModelServiceDraft['models'][number]>,
  ) {
    patch(
      'models',
      draft.models.map((row, position) =>
        position === index ? { ...row, ...update } : row,
      ),
    );
  }
  return (
    <Modal
      open
      title={baseline ? `编辑模型服务 · ${baseline.name}` : '添加模型服务'}
      centered
      width={1030}
      zIndex={uiLayers.dialog}
      onCancel={close}
      destroyOnHidden
      closable={!commands.pending && !discovering}
      maskClosable={false}
      className="model-config-modal"
      footer={
        <div className="row model-dialog-actions">
          <button
            className="btn"
            disabled={commands.pending || discovering}
            onClick={close}
          >
            关闭
          </button>
          <button
            className="btn primary"
            disabled={
              commands.blocked || discovering || bindingBlocked || !dirty
            }
            onClick={() => void save()}
          >
            {commands.pending ? '正在提交…' : '保存服务与模型'}
          </button>
        </div>
      }
    >
      <div className="model-settings-v2">
        <p className="caption">
          服务管理连接与访问权限；每个模型行独立配置菜单显示名和实际标识。配置只保存草稿，不发起模型调用。
        </p>
        {(error || commands.error) && (
          <Alert
            className="section-alert"
            type="error"
            showIcon
            title={error || commands.error}
          />
        )}
        {commands.records.length > 0 && (
          <Alert
            className="section-alert"
            type="warning"
            showIcon
            title="原命令回执待核对"
            description="关闭后可从页面顶部恢复；不会重发或自动继续后续操作。"
          />
        )}
        <fieldset
          disabled={commands.blocked || discovering}
          className="model-fieldset"
        >
          <div className="model-formgrid">
            <label className="field-label">
              服务名称
              <input
                className="field"
                value={draft.name}
                maxLength={200}
                onChange={(event) => patch('name', event.target.value)}
              />
            </label>
            <label className="field-label">
              接口协议
              <Select
                value={draft.protocol}
                disabled={commands.blocked || discovering}
                onChange={(protocol) => {
                  patch('protocol', protocol);
                  patch('authScheme', defaultModelAuthScheme(protocol));
                }}
                options={Object.entries(protocolLabels).map(
                  ([value, label]) => ({ value, label }),
                )}
              />
            </label>
            <label className="field-label model-span">
              API 基础地址
              <input
                className="field"
                type="url"
                placeholder="https://…"
                value={draft.baseUrl}
                maxLength={2048}
                onChange={(event) => patch('baseUrl', event.target.value)}
              />
            </label>
            <label className="field-label model-span">
              备注
              <textarea
                className="field"
                rows={2}
                value={draft.note}
                maxLength={2000}
                onChange={(event) => patch('note', event.target.value)}
              />
            </label>
          </div>
          <details className="mt">
            <summary>高级鉴权设置</summary>
            <p className="caption">
              默认 Messages 使用 x-api-key，其余使用
              Bearer；只有上游明确要求时修改。
            </p>
            <Select
              aria-label="鉴权方式"
              disabled={commands.blocked || discovering}
              value={draft.authScheme}
              onChange={(authScheme) => patch('authScheme', authScheme)}
              options={[
                { value: 'bearer', label: 'Authorization: Bearer' },
                { value: 'xApiKey', label: 'x-api-key' },
              ]}
            />
          </details>
          <div className="model-key-summary mt">
            <span className="badge">
              {baseline?.hasCredential ? 'API Key 已配置' : 'API Key 未配置'}
            </span>
            <span className="caption">
              Key 通过独立安全输入保存；普通配置和列表不含明文。
              {!baseline && '先保存服务，再配置 Key。'}
            </span>
            {baseline && !dirty && (
              <button
                className="btn small"
                type="button"
                onClick={() => onCredential(baseline)}
              >
                <KeyOutlined />{' '}
                {baseline.hasCredential ? '更新 Key' : '配置 Key'}
              </button>
            )}
          </div>
          {bindingBlocked && (
            <Alert
              className="section-alert"
              type="warning"
              showIcon
              title="连接目标已变化，不能沿用原 Key"
              description={
                <>
                  <p>
                    请先明确撤销旧
                    Key，再保存协议、地址或鉴权方式，最后为新目标安全重填。此处保留当前表单。
                  </p>
                  <button
                    className="btn danger small"
                    type="button"
                    onClick={() =>
                      modal.confirm({
                        title: '撤销原目标的 API Key？',
                        content:
                          '后续请求将因缺少凭据被拒绝，历史配置与用量保留。撤销成功后仍需明确保存当前表单。',
                        okText: '撤销旧 Key',
                        cancelText: '取消',
                        zIndex: uiLayers.confirmation,
                        onOk: revoke,
                      })
                    }
                  >
                    撤销旧 Key
                  </button>
                </>
              }
            />
          )}
          <div className="between mt">
            <h2>模型列表</h2>
            <div className="row wrap">
              <button
                className="btn small"
                type="button"
                disabled={!baseline || dirty || commands.blocked || discovering}
                onClick={() => void discover()}
              >
                <ReloadOutlined /> {discovering ? '正在获取…' : '获取模型列表'}
              </button>
              <button
                className="btn small"
                type="button"
                disabled={draft.models.length >= 200}
                onClick={() =>
                  patch('models', [...draft.models, emptyModelEntry()])
                }
              >
                <PlusOutlined /> 手动添加模型
              </button>
            </div>
          </div>
          <p className="caption">
            获取列表只在点击后请求已保存的服务；不支持时可继续手动填写。不会自动替换现有模型行。
          </p>
          {discovery && (
            <div className="notice mt">
              <strong>上游返回 {discovery.models.length} 个模型</strong>
              <div className="model-discovery-list">
                {discovery.models.map((row) => (
                  <div className="between" key={row.modelId}>
                    <span>
                      {row.displayName || row.modelId}
                      <small className="caption"> · {row.modelId}</small>
                    </span>
                    <button
                      className="btn small"
                      type="button"
                      disabled={draft.models.length >= 200}
                      onClick={() =>
                        patch('models', [
                          ...draft.models,
                          {
                            ...emptyModelEntry(),
                            modelId: row.modelId,
                            displayName: row.displayName || row.modelId,
                          },
                        ])
                      }
                    >
                      加入配置
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="model-entry-list">
            {!draft.models.length && (
              <div className="notice">
                尚未配置模型。可先保存服务并配置 API
                Key，再明确获取模型列表或手动添加；不会自动创建占位模型或替你选择。
              </div>
            )}
            {draft.models.map((row, index) => (
              <section className="model-entry-card" key={row.id}>
                <div className="between">
                  <strong>模型 {index + 1}</strong>
                  <div className="row">
                    <label className="checkrow">
                      <input
                        type="checkbox"
                        checked={row.enabled}
                        onChange={(event) =>
                          updateEntry(index, { enabled: event.target.checked })
                        }
                      />
                      启用
                    </label>
                    <button
                      className="btn small danger"
                      type="button"
                      onClick={() =>
                        patch(
                          'models',
                          draft.models.filter((item) => item.id !== row.id),
                        )
                      }
                    >
                      <DeleteOutlined /> 移除
                    </button>
                  </div>
                </div>
                <div className="model-formgrid mt">
                  <label className="field-label">
                    菜单显示名
                    <input
                      className="field"
                      value={row.displayName}
                      maxLength={200}
                      placeholder="留空时使用实际模型标识"
                      onChange={(event) =>
                        updateEntry(index, { displayName: event.target.value })
                      }
                    />
                  </label>
                  <label className="field-label">
                    实际模型标识
                    <input
                      className="field"
                      value={row.modelId}
                      maxLength={200}
                      placeholder="上游实际 model ID"
                      onChange={(event) =>
                        updateEntry(index, { modelId: event.target.value })
                      }
                    />
                  </label>
                  <label className="field-label">
                    上下文上限
                    <input
                      className="field"
                      type="number"
                      min={1}
                      step={1}
                      value={row.contextLimit ?? ''}
                      placeholder="未指定"
                      onChange={(event) =>
                        updateEntry(index, {
                          contextLimit:
                            event.target.value === ''
                              ? null
                              : event.target.valueAsNumber,
                        })
                      }
                    />
                  </label>
                  <label className="field-label">
                    最大输出
                    <input
                      className="field"
                      type="number"
                      min={1}
                      step={1}
                      value={row.maxOutput ?? ''}
                      placeholder="未指定"
                      onChange={(event) =>
                        updateEntry(index, {
                          maxOutput:
                            event.target.value === ''
                              ? null
                              : event.target.valueAsNumber,
                        })
                      }
                    />
                  </label>
                  <label className="field-label">
                    支持的强度
                    <Select
                      mode="tags"
                      disabled={commands.blocked || discovering}
                      tokenSeparators={[',', '，']}
                      value={row.effortValues}
                      onChange={(effortValues) =>
                        updateEntry(index, { effortValues })
                      }
                      placeholder="仅填写上游支持的值，不猜测"
                    />
                  </label>
                  <label className="field-label">
                    默认强度
                    <Select
                      allowClear
                      disabled={commands.blocked || discovering}
                      value={row.defaultEffort}
                      onChange={(effort) =>
                        updateEntry(index, { defaultEffort: effort ?? null })
                      }
                      options={[
                        ...row.effortValues,
                        ...(row.defaultEffort &&
                        !row.effortValues.includes(row.defaultEffort)
                          ? [row.defaultEffort]
                          : []),
                      ].map((value) => ({ value, label: value }))}
                      placeholder="未指定"
                    />
                  </label>
                </div>
                <details className="model-entry-metadata">
                  <summary>模型行标识</summary>
                  <code>{row.id}</code>
                </details>
              </section>
            ))}
          </div>
          <div className="model-formgrid mt">
            <label className="field-label">
              访问权限
              <Select
                disabled={commands.blocked || discovering}
                value={draft.accessPolicy}
                onChange={(accessPolicy) => patch('accessPolicy', accessPolicy)}
                options={[
                  { value: 'restricted', label: '仅指定账号' },
                  { value: 'allActive', label: '全部有效账号' },
                ]}
              />
            </label>
            <label className="checkrow">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => patch('enabled', event.target.checked)}
              />
              启用此服务
            </label>
            {draft.accessPolicy === 'restricted' && (
              <div className="field-label model-span">
                授权账号
                <AllowedUserPicker
                  value={draft.allowedUserIds}
                  onChange={(value) => patch('allowedUserIds', value)}
                  disabled={commands.blocked || discovering}
                />
              </div>
            )}
          </div>
          <div className="mt">
            <strong>允许外发的资料范围</strong>
            <p className="caption">
              资料许可与服务使用权限独立；每次发送仍需选择范围并确认实际接收地址。
            </p>
            {(
              ['syntheticPublicOnly', 'authorizedRelevantTestData'] as const
            ).map((scope) => (
              <label className="checkrow" key={scope}>
                <input
                  type="checkbox"
                  checked={draft.allowedDataScopes.includes(scope)}
                  onChange={(event) =>
                    patch(
                      'allowedDataScopes',
                      event.target.checked
                        ? [...draft.allowedDataScopes, scope]
                        : draft.allowedDataScopes.filter(
                            (value) => value !== scope,
                          ),
                    )
                  }
                />
                {scopesText([scope])}
              </label>
            ))}
          </div>
          {baseline?.models.some((row) => row.removedAt) && (
            <p className="caption mt">
              此服务保留 {baseline.models.filter((row) => row.removedAt).length}{' '}
              条已移除模型历史；不会重新启用或更改既有任务。
            </p>
          )}
        </fieldset>
      </div>
    </Modal>
  );
}
function AuxiliarySettings({
  services,
  commands,
  recovered,
  onDirty,
}: {
  services: ModelServiceV2[];
  commands: ConfigurationCommands;
  recovered: Auxiliary | null;
  onDirty: (dirty: boolean) => void;
}) {
  const [view, setView] = useState<AuxiliaryModelView>({
      configuration: null,
      draft: null,
    }),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<string>();
  const guard = useRef(new AuxiliaryReadbackGuard());
  const { configuration, draft } = view;
  const setDraft = (next: Auxiliary) =>
    setView((current) => ({ ...current, draft: next }));
  useEffect(() => {
    const controller = new AbortController();
    const ticket = guard.current.begin();
    void api(
      '/admin/auxiliary-model',
      { signal: controller.signal },
      auxiliaryModelV2ReceiptSchema,
    )
      .then((result) => {
        if (!controller.signal.aborted && guard.current.current(ticket)) {
          setView((current) =>
            reconcileAuxiliarySnapshot(current, result.auxiliary, 'read'),
          );
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted && guard.current.current(ticket))
          setError(errorText(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted && guard.current.current(ticket))
          setLoading(false);
      });
    return () => {
      controller.abort();
      guard.current.invalidate();
    };
  }, []);
  useEffect(() => {
    if (recovered) {
      guard.current.invalidate();
      setLoading(false);
      setView((current) =>
        reconcileAuxiliarySnapshot(current, recovered, 'receipt'),
      );
    }
  }, [recovered]);
  useEffect(
    () =>
      subscribeIdentityChanges(() => {
        guard.current.invalidate();
        setView({ configuration: null, draft: null });
        setLoading(false);
        setError('当前身份已变化，请重新读取辅助模型配置。');
      }),
    [],
  );
  useEffect(() => {
    onDirty(
      !!configuration &&
        !!draft &&
        JSON.stringify(configuration) !== JSON.stringify(draft),
    );
  }, [configuration, draft, onDirty]);
  if (loading) return <Spin />;
  if (!configuration || !draft)
    return (
      <Alert type="error" showIcon title={error || '辅助模型配置不可读'} />
    );
  const service = services.find((item) => item.id === draft.modelServiceId),
    row = service?.models.find((item) => item.id === draft.modelEntryId),
    unavailable = auxiliaryBindingUnavailable(services, draft);
  async function save() {
    if (!draft || unavailable) return;
    setError(undefined);
    try {
      const result = await commands.run(
        'configuration.model-auxiliary-set',
        null,
        '/admin/auxiliary-model',
        'PUT',
        (commandId) =>
          auxiliaryModelInputV2Schema.parse({ ...draft, commandId }),
      );
      if (result && 'auxiliary' in result) {
        guard.current.invalidate();
        setView((current) =>
          reconcileAuxiliarySnapshot(current, result.auxiliary, 'receipt'),
        );
      }
    } catch (failure) {
      setError(errorText(failure));
    }
  }
  const choices = services
    .filter((item) => !item.removedAt)
    .map((item) => ({
      value: item.id,
      label: `${item.name}${!item.enabled ? '（已停用）' : !item.hasCredential ? '（缺少凭据）' : ''}`,
    }));
  if (
    draft.modelServiceId &&
    !choices.some((option) => option.value === draft.modelServiceId)
  )
    choices.push({
      value: draft.modelServiceId,
      label: '原服务绑定不可用（保留原值）',
    });
  const rows =
    service?.models
      .filter((item) => !item.removedAt)
      .map((item) => ({
        value: item.id,
        label: `${item.displayName || item.modelId}${!item.enabled ? '（已停用）' : ''}`,
      })) ?? [];
  if (
    draft.modelEntryId &&
    !rows.some((option) => option.value === draft.modelEntryId)
  )
    rows.push({
      value: draft.modelEntryId,
      label: '原模型行绑定不可用（保留原值）',
    });
  return (
    <section className="card pad model-settings-v2">
      <h2>系统辅助模型</h2>
      <p className="caption mt">
        查重、精简命名、SQL
        辅助审核、缺陷建议共用此明确模型行，不借用聊天模型。保存配置不发起推理。
      </p>
      {error && (
        <Alert type="error" showIcon title={error} className="section-alert" />
      )}
      {view.readbackConflict && (
        <Alert
          type="error"
          showIcon
          title="相同行版本的辅助配置不一致，未覆盖当前表单。"
          className="section-alert"
        />
      )}
      <fieldset className="model-fieldset" disabled={commands.blocked}>
        <label className="checkrow mt">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) =>
              setDraft({ ...draft, enabled: event.target.checked })
            }
          />
          启用系统辅助模型
        </label>
        <div className="model-formgrid mt">
          <label className="field-label">
            服务
            <Select
              allowClear
              disabled={commands.blocked}
              value={draft.modelServiceId}
              options={choices}
              onChange={(value) =>
                setDraft({
                  ...draft,
                  modelServiceId: value ?? null,
                  modelEntryId: null,
                  effort: null,
                })
              }
            />
          </label>
          <label className="field-label">
            具体模型
            <Select
              allowClear
              value={draft.modelEntryId}
              options={rows}
              disabled={!draft.modelServiceId || commands.blocked}
              onChange={(value) =>
                setDraft({
                  ...draft,
                  modelEntryId: value ?? null,
                  effort: null,
                })
              }
            />
          </label>
          <label className="field-label">
            强度
            <Select
              allowClear
              disabled={commands.blocked}
              value={draft.effort}
              options={[
                ...(row?.effortValues ?? []),
                ...(draft.effort && !row?.effortValues.includes(draft.effort)
                  ? [draft.effort]
                  : []),
              ].map((value) => ({ value, label: value }))}
              onChange={(value) =>
                setDraft({ ...draft, effort: value ?? null })
              }
            />
          </label>
        </div>
        {unavailable && (
          <Alert
            className="section-alert"
            type="warning"
            showIcon
            title="当前绑定不可用"
            description="启用时须选有效服务、凭据、模型行和受支持强度；也可保留原绑定并关闭辅助模型。不会自动替换配置。"
          />
        )}
        <button
          className="btn primary mt"
          disabled={
            commands.blocked ||
            unavailable ||
            JSON.stringify(draft) === JSON.stringify(configuration)
          }
          onClick={() => void save()}
        >
          保存辅助配置
        </button>
      </fieldset>
    </section>
  );
}
export function PlatformModelSettings() {
  const { modal, message } = App.useApp();
  const [services, setServices] = useState<ModelServiceV2[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<string>(),
    [editor, setEditor] = useState<{
      key: string;
      service: ModelServiceV2 | null;
    } | null>(null),
    [credential, setCredential] = useState<ModelServiceV2 | null>(null),
    [credentialValue, setCredentialValue] = useState(''),
    [credentialError, setCredentialError] = useState<string>(),
    [auxiliaryDirty, setAuxiliaryDirty] = useState(false),
    [auxiliary, setAuxiliary] = useState<Auxiliary | null>(null);
  const generation = useRef(0),
    owner = currentIdentityOwner();
  function received(receipt: ModelCommandReceipt) {
    generation.current++;
    setLoading(false);
    if ('modelService' in receipt)
      setServices((current) => [
        ...current.filter((item) => item.id !== receipt.modelService.id),
        current.find(
          (item) =>
            item.id === receipt.modelService.id &&
            item.rowVersion > receipt.modelService.rowVersion,
        ) ?? receipt.modelService,
      ]);
    else setAuxiliary(receipt.auxiliary);
  }
  const commands = useConfigurationCommands(received, () => {
    setEditor(null);
    setCredential(null);
    setCredentialValue('');
    void load();
  });
  async function load(signal?: AbortSignal) {
    const attempt = ++generation.current,
      start = identityContextEpoch();
    setLoading(true);
    try {
      const response = await api(
        '/admin/model-services',
        signal ? { signal } : {},
        modelServiceV2ListSchema,
      );
      if (
        !signal?.aborted &&
        attempt === generation.current &&
        start === identityContextEpoch()
      ) {
        setServices(response.services);
        setError(undefined);
      }
    } catch (failure) {
      if (
        !signal?.aborted &&
        attempt === generation.current &&
        start === identityContextEpoch()
      )
        setError(errorText(failure));
    } finally {
      if (!signal?.aborted && attempt === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
      generation.current++;
    };
  }, []);
  useEffect(
    () =>
      subscribeIdentityChanges(() => {
        setEditor(null);
        setCredential(null);
        setCredentialValue('');
        setServices([]);
        setAuxiliary(null);
        generation.current++;
      }),
    [],
  );
  useEffect(() => {
    if (editor || (!credential && !auxiliaryDirty && !commands.pending)) return;
    return registerNavigationBlocker((proceed) => {
      if (commands.pending) return;
      if (credentialValue || auxiliaryDirty)
        modal.confirm({
          title: '放弃未保存的配置？',
          content:
            'API Key 输入只保存在当前表单，离开时清空；已发出的原命令标识仍保留。',
          okText: '放弃并离开',
          cancelText: '继续编辑',
          zIndex: uiLayers.confirmation,
          onOk: () => {
            setCredentialValue('');
            setCredential(null);
            proceed();
          },
        });
      else {
        setCredentialValue('');
        setCredential(null);
        proceed();
      }
    });
  }, [
    editor,
    credential,
    credentialValue,
    auxiliaryDirty,
    commands.pending,
    modal,
  ]);
  function credentialClose() {
    if (commands.pending) return;
    setCredentialValue('');
    setCredentialError(undefined);
    setCredential(null);
  }
  async function saveCredential() {
    if (!credential) return;
    setCredentialError(undefined);
    const value = credentialValue;
    setCredentialValue('');
    try {
      const result = await commands.run(
        'configuration.model-credential-set',
        credential.id,
        `/admin/model-services/${credential.id}/credential`,
        'PUT',
        (commandId) =>
          modelCredentialV2Schema.parse({
            commandId,
            rowVersion: credential.rowVersion,
            credential: value,
          }),
      );
      if (result && 'modelService' in result) {
        setCredential(null);
        void message.success('API Key 已保存');
      }
    } catch (failure) {
      setCredentialError(errorText(failure));
    }
  }
  async function action(service: ModelServiceV2, kind: 'remove' | 'revoke') {
    await commands.run(
      kind === 'remove'
        ? 'configuration.model-remove'
        : 'configuration.model-credential-revoke',
      service.id,
      `/admin/model-services/${service.id}${kind === 'revoke' ? '/credential' : ''}`,
      'DELETE',
      (commandId) =>
        modelServiceCasV2Schema.parse({
          commandId,
          rowVersion: service.rowVersion,
        }),
    );
  }
  return (
    <div className="model-settings-v2">
      <PageHeading
        eyebrow="PLATFORM SETTINGS"
        title="模型服务"
        description="连接协议、模型行与资料许可独立管理；所有账号仅能选择获授权的具体模型。"
        actions={
          <>
            <button
              className="btn"
              disabled={loading || commands.pending}
              onClick={() => void load()}
            >
              <ReloadOutlined /> 刷新
            </button>
            <button
              className="btn primary"
              disabled={commands.blocked || loading}
              onClick={() =>
                setEditor({ key: crypto.randomUUID(), service: null })
              }
            >
              <PlusOutlined /> 添加服务
            </button>
          </>
        }
      />
      {(error || commands.error || commands.storageError) && (
        <Alert
          className="section-alert"
          type="error"
          showIcon
          title={error || commands.error || commands.storageError}
        />
      )}
      {commands.records.length > 0 && (
        <section className="notice mb">
          <strong>配置命令结果待核对</strong>
          <p>
            仅查询原回执，不重发；查回后请重新打开当前配置确认，后续操作不会自动继续。
          </p>
          {commands.records.map((record) => (
            <div className="between model-recovery-row" key={record.commandId}>
              <code>
                {record.operation} · {record.commandId}
              </code>
              <button
                className="btn small"
                disabled={commands.pending}
                onClick={() => void commands.recover(record)}
              >
                查询原回执
              </button>
            </div>
          ))}
        </section>
      )}
      <Tabs
        items={[
          {
            key: 'services',
            label: '模型服务',
            children: (
              <>
                <div className="notice mb">
                  API Key
                  只在安全输入中配置，不会在列表或普通草稿中显示。此处不自动探测模型，不将保存或发现列表算作验证通过。
                </div>
                {loading ? (
                  <Spin />
                ) : !services.filter((item) => !item.removedAt).length ? (
                  <Empty
                    description={error ? '配置未能加载' : '尚未添加模型服务'}
                  />
                ) : (
                  <div className="model-service-list">
                    {services
                      .filter((item) => !item.removedAt)
                      .map((service) => (
                        <section className="card pad" key={service.id}>
                          <div className="between">
                            <div>
                              <h2>{service.name}</h2>
                              <div className="row wrap mt">
                                <span className="badge">
                                  {protocolLabels[service.protocol]}
                                </span>
                                <span
                                  className={`badge ${service.enabled ? 'green' : ''}`}
                                >
                                  {service.enabled ? '已启用' : '已停用'}
                                </span>
                                <span className="badge">
                                  {service.hasCredential
                                    ? '凭据已配置'
                                    : '缺少凭据'}
                                </span>
                                <span className="caption">
                                  r{service.serviceRevision}
                                </span>
                              </div>
                            </div>
                            <div className="row wrap">
                              <button
                                className="btn small"
                                disabled={commands.blocked}
                                onClick={() =>
                                  setEditor({
                                    key: crypto.randomUUID(),
                                    service,
                                  })
                                }
                              >
                                <EditOutlined /> 编辑
                              </button>
                              <button
                                className="btn small"
                                disabled={commands.blocked}
                                onClick={() => {
                                  setCredential(service);
                                  setCredentialValue('');
                                  setCredentialError(undefined);
                                }}
                              >
                                <KeyOutlined /> API Key
                              </button>
                              <button
                                className="btn small danger"
                                disabled={
                                  commands.blocked || !service.hasCredential
                                }
                                onClick={() =>
                                  modal.confirm({
                                    title: '撤销此服务的 API Key？',
                                    content:
                                      '后续请求因缺少凭据被拒绝。历史用量与配置保留。',
                                    okText: '撤销凭据',
                                    cancelText: '取消',
                                    zIndex: uiLayers.confirmation,
                                    onOk: () => action(service, 'revoke'),
                                  })
                                }
                              >
                                撤销凭据
                              </button>
                              <button
                                className="btn small danger"
                                disabled={commands.blocked}
                                onClick={() =>
                                  modal.confirm({
                                    title: `移除服务「${service.name}」？`,
                                    content:
                                      '新任务不再可选择此服务；历史消息、任务模型快照与用量保留，不会切换到其他服务。',
                                    okText: '移除服务',
                                    cancelText: '取消',
                                    zIndex: uiLayers.confirmation,
                                    onOk: () => action(service, 'remove'),
                                  })
                                }
                              >
                                <DeleteOutlined /> 移除
                              </button>
                            </div>
                          </div>
                          {service.note && (
                            <p className="caption mt">{service.note}</p>
                          )}
                          <p className="model-endpoint mt">{service.baseUrl}</p>
                          <div className="model-table-scroll mt">
                            <table className="table">
                              <thead>
                                <tr>
                                  <th>菜单显示名</th>
                                  <th>实际模型标识</th>
                                  <th>配置</th>
                                  <th>验证</th>
                                </tr>
                              </thead>
                              <tbody>
                                {!service.models.some(
                                  (row) => !row.removedAt,
                                ) && (
                                  <tr>
                                    <td colSpan={4}>
                                      <span className="caption">
                                        尚未配置模型。保存连接与 Key
                                        后，可编辑服务并获取列表或手动添加。
                                      </span>
                                    </td>
                                  </tr>
                                )}
                                {service.models
                                  .filter((row) => !row.removedAt)
                                  .map((row) => (
                                    <tr key={row.id}>
                                      <td>
                                        <strong>
                                          {row.displayName || row.modelId}
                                        </strong>
                                        <div className="caption">
                                          {row.enabled ? '已启用' : '已停用'}
                                        </div>
                                      </td>
                                      <td>
                                        <code>{row.modelId}</code>
                                      </td>
                                      <td>
                                        <span className="caption">
                                          上下文 {row.contextLimit ?? '未指定'}{' '}
                                          · 输出 {row.maxOutput ?? '未指定'}
                                          <br />
                                          强度{' '}
                                          {row.effortValues.join(' / ') ||
                                            '未配置'}
                                        </span>
                                      </td>
                                      <td>
                                        <Verification model={row} />
                                      </td>
                                    </tr>
                                  ))}
                              </tbody>
                            </table>
                          </div>
                          <p className="caption mt">
                            {service.accessPolicy === 'allActive'
                              ? '全部有效账号'
                              : `指定 ${service.allowedUserIds.length} 个账号`}{' '}
                            · {scopesText(service.allowedDataScopes)}
                          </p>
                        </section>
                      ))}
                  </div>
                )}
              </>
            ),
          },
          {
            key: 'auxiliary',
            label: '系统辅助模型',
            children: (
              <AuxiliarySettings
                services={services}
                commands={commands}
                recovered={auxiliary}
                onDirty={setAuxiliaryDirty}
              />
            ),
          },
        ]}
      />
      {editor && owner && (
        <ServiceEditor
          key={`${owner}:${editor.key}`}
          initial={editor.service}
          commands={commands}
          onClose={() => setEditor(null)}
          onCredential={(service) => {
            setEditor(null);
            setCredential(service);
            setCredentialValue('');
            setCredentialError(undefined);
          }}
        />
      )}
      <Modal
        open={!!credential}
        title={
          credential
            ? `安全配置 API Key · ${credential.name}`
            : '安全配置 API Key'
        }
        centered
        width={610}
        zIndex={uiLayers.nestedDialog}
        maskClosable={false}
        closable={!commands.pending}
        onCancel={credentialClose}
        onOk={() => void saveCredential()}
        confirmLoading={commands.pending}
        okButtonProps={{ disabled: commands.blocked || !credentialValue }}
        okText="保存 Key"
        cancelText="取消"
        className="model-config-modal"
      >
        <div className="model-settings-v2">
          <div className="notice">
            只向此已保存目标设置
            Key。输入不会存入浏览器恢复记录；点击提交后、关闭或身份变化时立即清空。留空不会覆盖已有
            Key。
          </div>
          {credential && (
            <dl className="model-facts">
              <div>
                <dt>接收地址</dt>
                <dd>{credential.baseUrl}</dd>
              </div>
              <div>
                <dt>协议 / 鉴权</dt>
                <dd>
                  {protocolLabels[credential.protocol]} /{' '}
                  {credential.authScheme}
                </dd>
              </div>
              <div>
                <dt>服务修订</dt>
                <dd>r{credential.serviceRevision}</dd>
              </div>
            </dl>
          )}
          {(credentialError || commands.error) && (
            <Alert
              className="section-alert"
              type="error"
              showIcon
              title={credentialError || commands.error}
            />
          )}
          <label className="field-label">
            新的 API Key
            <Input.Password
              autoComplete="new-password"
              visibilityToggle={false}
              value={credentialValue}
              disabled={commands.blocked}
              onChange={(event) => setCredentialValue(event.target.value)}
              onPressEnter={() => {
                if (credentialValue && !commands.blocked) void saveCredential();
              }}
            />
          </label>
        </div>
      </Modal>
      <ExternalMcpAdminSettings />
    </div>
  );
}
