import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Modal } from 'antd';
import { z } from 'zod';
import {
  externalServiceListSchema,
  externalServiceReceiptSchema,
  externalServiceInputSchema,
  externalServiceUpdateSchema,
  externalPersonalServicesSchema,
  externalConnectionReceiptSchema,
  externalCatalogSchema,
  externalManagementStatusSchema,
  externalApprovedToolSchema,
  externalAvailableToolsSchema,
  externalInvocationReceiptSchema,
  externalInvocationListSchema,
  externalManualCallInputSchema,
} from '../../../packages/contracts/src/external-mcp';
import {
  userSummarySchema,
  meSchema,
} from '../../../packages/contracts/src/identity';
import { parseStrictJsonText } from '../../../packages/contracts/src/safe-json';
import { api, ApiError, describeError } from './api';
import { useBusinessCommand } from './business-command';
import { uiLayers } from './ui-layers';
import { PageHeading } from './page-heading';
import type { PreparedReference } from './workspace-references';
import {
  currentIdentityOwner,
  subscribeIdentityChanges,
} from './identity-context';
import {
  beginExternalDecision,
  canInlineExternalDecision,
  clearExternalDecision,
  externalDecisionPending,
} from './external-decision-state';

type Service = z.infer<typeof externalServiceReceiptSchema>['service'];
type Personal = z.infer<
  typeof externalPersonalServicesSchema
>['services'][number];
type Catalog = z.infer<typeof externalCatalogSchema>;
type Invocation = z.infer<typeof externalInvocationReceiptSchema>['invocation'];
type Command = ReturnType<typeof useBusinessCommand>;
const base = '/external-mcp';
const uncertain = (error: unknown) =>
  error instanceof ApiError && (error.status === 0 || error.status >= 500);
const stateLabel = {
  waitingConsent: '待本人决定',
  dispatching: '已受理，正在调用',
  completed: '已收到工具回执',
  declined: '本人已拒绝',
  cancelled: '发送前已取消',
  failed: '未发出工具调用',
  unknown: '结果未知，禁止重发',
};
function Notice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <div
      className={`notice mt ${error ? 'red' : ''}`}
      role={error ? 'alert' : 'status'}
    >
      {children}
    </div>
  );
}
function Dialog({
  title,
  children,
  footer,
  onClose,
  busy = false,
  wide = false,
  zIndex = uiLayers.dialog,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
  zIndex?: number;
}) {
  return (
    <Modal
      open
      centered
      title={title}
      width={wide ? 1030 : 610}
      zIndex={zIndex}
      rootClassName="external-mcp-page"
      classNames={{
        container: `dialog ${wide ? 'wide' : ''}`,
        header: 'dialog-head',
        body: 'dialog-body',
        footer: 'dialog-foot',
        close: 'iconbtn',
      }}
      styles={{
        container: { padding: 0, maxHeight: '90vh' },
        body: { overflow: 'auto' },
        footer: { margin: 0 },
      }}
      mask={{ closable: !busy }}
      closable={!busy}
      keyboard={!busy}
      onCancel={onClose}
      destroyOnHidden
      footer={
        footer ?? (
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        )
      }
    >
      {children}
    </Modal>
  );
}
function Recovery<T>({
  operation,
  command,
  schema,
  onRecovered,
}: {
  operation: string;
  command: Command;
  schema: z.ZodType<T>;
  onRecovered: (value: T) => void;
}) {
  const [pending, setPending] = useState(false),
    [status, setStatus] = useState('');
  if (!command.uncertain) return null;
  return (
    <Notice>
      <p>
        回执尚未确认，已停止重发。原标识{' '}
        <span className="mono">{command.commandId}</span>
      </p>
      <button
        className="btn small mt"
        disabled={pending}
        onClick={() => {
          setPending(true);
          void api(
            `${base}/operation-status?operation=${encodeURIComponent(operation)}&key=${command.commandId}`,
            {},
            externalManagementStatusSchema,
          )
            .then((receipt) => {
              if (receipt.command.status === 'completed') {
                const value = schema.parse(receipt.command.response);
                command.confirmRecoveredReceipt();
                onRecovered(value);
              } else setStatus(`原状态：${receipt.command.status}，未重发。`);
            })
            .catch((error) =>
              setStatus(
                error instanceof ApiError && error.status === 404
                  ? '暂未取得原回执，不代表操作未发生；请继续只读核对。'
                  : describeError(error),
              ),
            )
            .finally(() => setPending(false));
        }}
      >
        查询原操作
      </button>
      {status && <p className="caption mt">{status}</p>}
    </Notice>
  );
}
function EditDialog({
  title,
  command,
  dirty,
  onClose,
  onSave,
  children,
  allowSave = true,
  wide = false,
  saveLabel = '保存',
}: {
  title: string;
  command: Command;
  dirty: boolean;
  onClose: () => void;
  onSave: () => void;
  children: ReactNode;
  allowSave?: boolean;
  wide?: boolean;
  saveLabel?: string;
}) {
  const [discard, setDiscard] = useState(false);
  function close() {
    if (command.pending) return;
    if (dirty && !command.uncertain) setDiscard(true);
    else onClose();
  }
  return (
    <>
      <Dialog
        title={title}
        busy={command.pending}
        wide={wide}
        onClose={close}
        footer={
          <>
            <button className="btn" disabled={command.pending} onClick={close}>
              取消
            </button>
            <button
              className="btn primary"
              disabled={command.pending || command.uncertain || !allowSave}
              onClick={onSave}
            >
              {command.pending ? '提交中…' : saveLabel}
            </button>
          </>
        }
      >
        {command.error && <Notice error>{command.error}</Notice>}
        {children}
        <details className="caption mt" open={command.uncertain}>
          <summary>原操作标识</summary>
          <span className="mono">{command.commandId}</span>
        </details>
      </Dialog>
      {discard && (
        <Dialog
          title="有未保存修改"
          zIndex={uiLayers.confirmation}
          onClose={() => setDiscard(false)}
          footer={
            <>
              <button className="btn" onClick={() => setDiscard(false)}>
                继续编辑
              </button>
              <button className="btn danger" onClick={onClose}>
                放弃本地修改
              </button>
              <button
                className="btn primary"
                disabled={!allowSave || command.uncertain}
                onClick={() => {
                  setDiscard(false);
                  onSave();
                }}
              >
                保存
              </button>
            </>
          }
        >
          <p>放弃只清除尚未保存的输入，不撤销已受理的操作。</p>
        </Dialog>
      )}
    </>
  );
}
function GrantPicker({
  value,
  onChange,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const [search, setSearch] = useState(''),
    [options, setOptions] = useState<z.infer<typeof userSummarySchema>[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      void api(
        `/users?search=${encodeURIComponent(search)}`,
        { signal: abort.signal },
        z.strictObject({ users: z.array(userSummarySchema) }),
      )
        .then((result) => {
          if (!abort.signal.aborted) {
            setOptions(result.users.filter((user) => user.active));
            setError('');
          }
        })
        .catch((error) => {
          if (!abort.signal.aborted) setError(describeError(error));
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [search]);
  return (
    <div className="mt">
      <label className="field-label">
        开放账号
        <input
          className="field"
          type="search"
          value={search}
          placeholder="按姓名或账号查找"
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      {error && <Notice error>{error}</Notice>}
      <p className="caption mt">
        已明确选择 {value.length} 个账号。默认不开放给未选择的人。
      </p>
      {options.map((user) => (
        <label className="checkrow" key={user.id}>
          <input
            type="checkbox"
            checked={value.includes(user.id)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...value, user.id]
                  : value.filter((id) => id !== user.id),
              )
            }
          />
          <span>
            {user.displayName}
            <small>{user.account}</small>
          </span>
        </label>
      ))}
      {value
        .filter((id) => !options.some((user) => user.id === id))
        .map((id) => (
          <label className="checkrow" key={id}>
            <input
              type="checkbox"
              checked
              onChange={() => onChange(value.filter((item) => item !== id))}
            />
            <span>
              已选账号<small>{id}（当前搜索未返回，保留明确选择）</small>
            </span>
          </label>
        ))}
    </div>
  );
}
function ServiceEditor({
  existing,
  onClose,
  onSaved,
}: {
  existing: Service | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const initial = {
    name: existing?.name ?? '',
    endpoint: existing?.endpoint ?? '',
    enabled: existing?.enabled ?? false,
    accessPolicy: existing?.accessPolicy ?? 'restricted',
    allowedUsers: existing?.allowedUserIds.join('\n') ?? '',
    tools: JSON.stringify(existing?.tools ?? [], null, 2),
  };
  const [draft, setDraft] = useState(initial),
    command = useBusinessCommand(`external-service:${existing?.id ?? 'new'}`);
  const operation = existing
    ? 'external-mcp.service.revise'
    : 'external-mcp.service.create';
  function set<K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) {
    setDraft({ ...draft, [key]: value });
  }
  async function saved() {
    onClose();
    await onSaved();
  }
  async function save() {
    const receipt = await command.run(async (key) => {
      let tools: unknown;
      try {
        tools = z
          .array(externalApprovedToolSchema)
          .parse(parseStrictJsonText(draft.tools));
      } catch {
        throw new Error('工具上限须为无重复字段的完整JSON数组。');
      }
      const common = {
        commandId: key,
        name: draft.name,
        endpoint: draft.endpoint,
        enabled: draft.enabled,
        accessPolicy: draft.accessPolicy,
        allowedUserIds:
          draft.accessPolicy === 'allActive'
            ? []
            : draft.allowedUsers.split(/[\s,，]+/).filter(Boolean),
        protocolMode: 'modern',
        tools,
      };
      const body = existing
        ? externalServiceUpdateSchema.parse({
            ...common,
            rowVersion: existing.rowVersion,
          })
        : externalServiceInputSchema.parse(common);
      return api(
        `${base}/services${existing ? `/${existing.id}` : ''}`,
        { method: existing ? 'PUT' : 'POST', body },
        externalServiceReceiptSchema,
      );
    });
    if (receipt) await saved();
  }
  return (
    <EditDialog
      title="远程 MCP 服务"
      command={command}
      dirty={JSON.stringify(draft) !== JSON.stringify(initial)}
      onClose={onClose}
      onSave={() => void save()}
      wide
      allowSave={Boolean(draft.name.trim() && draft.endpoint.trim())}
    >
      <div className="formgrid">
        <label className="field-label">
          服务名称
          <input
            className="field"
            value={draft.name}
            maxLength={200}
            disabled={command.pending || command.uncertain}
            onChange={(event) => set('name', event.target.value)}
          />
        </label>
        <label className="field-label">
          远程服务地址
          <input
            className="field"
            type="url"
            value={draft.endpoint}
            disabled={command.pending || command.uncertain}
            onChange={(event) => set('endpoint', event.target.value)}
          />
        </label>
      </div>
      <p className="caption mt">
        首版仅远程Streamable
        HTTP与用户个人Key，不使用stdio、共享Key或OAuth。目的地固定为登记的HTTPS地址，不跟随重定向。
      </p>
      <fieldset
        disabled={command.pending || command.uncertain}
        style={{ border: 0, padding: 0, margin: 0 }}
      >
        <div className="formgrid mt">
          <label className="field-label">
            开放策略
            <select
              value={draft.accessPolicy}
              onChange={(event) =>
                set(
                  'accessPolicy',
                  event.target.value as 'restricted' | 'allActive',
                )
              }
            >
              <option value="restricted">仅明确指定账号</option>
              <option value="allActive">所有有效注册账号</option>
            </select>
          </label>
          <div className="caption">MCP 协议版本 2026-07-28</div>
        </div>
        <label className="checkrow mt">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => set('enabled', event.target.checked)}
          />
          <span>
            启用已登记服务
            <small>
              仍需本人维护个人Key并检查连接；空工具上限不能调用业务工具。
            </small>
          </span>
        </label>
        {draft.accessPolicy === 'restricted' && (
          <GrantPicker
            value={draft.allowedUsers.split(/[\s,，]+/).filter(Boolean)}
            onChange={(ids) => set('allowedUsers', ids.join('\n'))}
          />
        )}
        <details className="mt">
          <summary>批准工具上限与Schema</summary>
          <p className="caption mt">
            先由本人配置Key检查远端目录，再从真实目录复制工具定义。只接受精确名称、Schema和说明；新增/变化工具不会自动批准。effect为write时须选择当前项目业务权限；管理员身份不自动等于测试角色。
          </p>
          <textarea
            className="field mono mt"
            rows={12}
            value={draft.tools}
            maxLength={512 * 1024}
            aria-label="批准外部工具JSON"
            onChange={(event) => set('tools', event.target.value)}
          />
          <p className="caption mt">
            每项含name、description、inputSchema、可选outputSchema、metadata、effect（read/write）、projectAction（读可null；写例如assets.write/knowledge.write/issues.handle）。公开搜索另加publicSearch映射，且必须read
            / project.read；此处不填写任何Key或密码。
          </p>
          <p className="caption mt">
            例如 publicSearch:{' '}
            {JSON.stringify({
              queryArgument: 'query',
              resultsPath: ['structuredContent', 'hits'],
              titleField: 'title',
              urlField: 'url',
              snippetField: 'snippet',
            })}
            。只支持唯一query参数的已登记工具；来源只返回标题、网址与摘要，不自动访问链接。搜索词须每次由本人核对公开性。
          </p>
        </details>
      </fieldset>
      <Notice>
        修改服务、开放范围或工具上限会产生新配置修订；已选择的旧连接引用需本人重新检查和选择，不自动扩大权限。
      </Notice>
      <Recovery
        operation={operation}
        command={command}
        schema={externalServiceReceiptSchema}
        onRecovered={() => void saved()}
      />
    </EditDialog>
  );
}
export function ExternalMcpAdminSettings() {
  const [services, setServices] = useState<Service[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [editing, setEditing] = useState<Service | null | undefined>();
  async function load() {
    setLoading(true);
    try {
      const result = await api(
        `${base}/services`,
        {},
        externalServiceListSchema,
      );
      setServices(result.services);
      setError('');
    } catch (error) {
      setError(describeError(error));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  return (
    <div className="external-mcp-page">
      <div className="between mt">
        <h3>外部 MCP 服务</h3>
        <div className="row">
          <button
            className="btn small"
            disabled={loading}
            onClick={() => void load()}
          >
            刷新
          </button>
          <button
            className="btn small primary"
            onClick={() => setEditing(null)}
          >
            添加服务
          </button>
        </div>
      </div>
      {error && <Notice error>{error}</Notice>}
      {loading && !services.length && (
        <p className="caption mt">读取管理员服务配置…</p>
      )}
      {!loading && !error && !services.length && (
        <p className="caption mt">
          暂未配置外部服务。服务配置与用户个人Key分开维护。
        </p>
      )}
      {services.map((service) => (
        <div className="listrow" key={service.id}>
          <div className="grow">
            <b>{service.name}</b>
            <p>
              {service.endpoint} · 远程服务 / 个人Key · {service.tools.length}
              个批准工具
            </p>
          </div>
          <span className="badge">{service.enabled ? '已启用' : '已停用'}</span>
          <button className="btn small" onClick={() => setEditing(service)}>
            配置
          </button>
        </div>
      ))}
      {editing !== undefined && (
        <ServiceEditor
          existing={editing}
          onClose={() => setEditing(undefined)}
          onSaved={load}
        />
      )}
    </div>
  );
}
function KeyEditor({
  service,
  onClose,
  onSaved,
}: {
  service: Personal;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [value, setValue] = useState(''),
    command = useBusinessCommand(`external-key:${service.id}`);
  async function saved() {
    setValue('');
    onClose();
    await onSaved();
  }
  async function save() {
    const key = value;
    const result = await command.run((commandId) =>
      api(
        `${base}/personal/services/${service.id}/key`,
        {
          method: 'PUT',
          body: {
            commandId,
            rowVersion: service.connection?.rowVersion ?? 0,
            key,
          },
        },
        externalConnectionReceiptSchema,
      ),
    );
    setValue('');
    if (result) await saved();
  }
  return (
    <EditDialog
      title="维护本人外部 MCP Key"
      command={command}
      dirty={Boolean(value)}
      onClose={() => {
        setValue('');
        onClose();
      }}
      onSave={() => void save()}
      allowSave={value.length >= 8}
    >
      <label className="field-label">
        {service.name} · 个人Key
        <input
          className="field"
          type="password"
          autoComplete="new-password"
          value={value}
          maxLength={16384}
          disabled={command.pending || command.uncertain}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <p className="caption mt">
        仅由你手动填写。后端加密保存，列表、AI和官方MCP不读取或回显；认证只注入这项服务的固定目的地。
      </p>
      <Recovery
        operation="external-mcp.personal-key.replace"
        command={command}
        schema={externalConnectionReceiptSchema}
        onRecovered={() => void saved()}
      />
    </EditDialog>
  );
}
function CatalogDialog({
  catalog,
  onClose,
}: {
  catalog: Catalog;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState('');
  const approvalTemplate = catalog.tools.map(
    ({ schemaDigest, approved, effect, projectAction, ...definition }) => ({
      ...definition,
      effect: approved ? effect : '请人工选择read或write',
      projectAction: approved
        ? projectAction
        : '写操作填项目业务权限；只读可填null',
    }),
  );
  return (
    <Dialog title="本人当前远端工具目录" wide onClose={onClose}>
      <p className="caption">
        目录 {catalog.catalogId} · 配置r{catalog.configRevision} · 本人凭据版本
        {catalog.credentialVersion}
      </p>
      <Notice>
        这是对方在本人账号下实际返回的目录，不证明具体远端对象的当前业务权限。新增或变化工具须管理员核对，不能由远端提示自动取得权限。
      </Notice>
      <details className="mt">
        <summary>生成待人工审批的工具定义</summary>
        <p className="caption mt">
          未批准项不会预选为只读。请管理员明确选择effect与所需项目权限，保存后仍需本人重查目录。
        </p>
        <pre className="code mt">
          {JSON.stringify(approvalTemplate, null, 2)}
        </pre>
        <button
          className="btn small mt"
          onClick={() =>
            void navigator.clipboard
              .writeText(JSON.stringify(approvalTemplate, null, 2))
              .then(() => setCopied('已复制待审批模板，尚未批准任何新工具。'))
              .catch(() => setCopied('剪贴板不可用，请手动复制上面的模板。'))
          }
        >
          复制待审批模板
        </button>
        {copied && <p className="caption mt">{copied}</p>}
      </details>
      {catalog.tools.map((tool) => (
        <div className="listrow" key={tool.name}>
          <div className="grow">
            <b className="small">{tool.name}</b>
            <p>{tool.description}</p>
            <details className="mt">
              <summary>真实Schema与批准标记</summary>
              <pre className="code mt">{JSON.stringify(tool, null, 2)}</pre>
            </details>
          </div>
          <span className={`badge ${tool.approved ? '' : 'amber'}`}>
            {tool.approved ? '已匹配批准上限' : '未批准/定义已变化'}
          </span>
        </div>
      ))}
    </Dialog>
  );
}
export function ExternalMcpPersonalKeys() {
  const [services, setServices] = useState<Personal[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [editing, setEditing] = useState<Personal>(),
    [catalog, setCatalog] = useState<Catalog>(),
    [busy, setBusy] = useState<string>(),
    [revoking, setRevoking] = useState<Personal>();
  const revoke = useBusinessCommand(revoking?.connection?.id ?? null);
  async function load() {
    setLoading(true);
    try {
      setServices(
        (await api(`${base}/personal`, {}, externalPersonalServicesSchema))
          .services,
      );
      setError('');
    } catch (error) {
      setError(describeError(error));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function check(service: Personal) {
    if (!service.connection) return;
    setBusy(service.id);
    try {
      setCatalog(
        await api(
          `${base}/personal/connections/${service.connection.id}/check`,
          { method: 'POST', body: {}, timeoutMs: 45000 },
          externalCatalogSchema,
        ),
      );
      await load();
    } catch (error) {
      await load();
      setError(describeError(error));
    } finally {
      setBusy(undefined);
    }
  }
  async function removed() {
    setRevoking(undefined);
    await load();
  }
  async function remove() {
    if (!revoking?.connection) return;
    const target = revoking.connection;
    const result = await revoke.run((commandId) =>
      api(
        `${base}/personal/connections/${target.id}/key`,
        {
          method: 'DELETE',
          body: { commandId, rowVersion: target.rowVersion },
        },
        externalConnectionReceiptSchema,
      ),
    );
    if (result) await removed();
  }
  return (
    <div className="external-mcp-page">
      <div className="between">
        <h3>个人外部 MCP Key</h3>
        <button
          className="btn small"
          disabled={loading}
          onClick={() => void load()}
        >
          刷新
        </button>
      </div>
      <p className="caption mt">
        管理员登记服务，本人维护个人凭据。平台AI不读取或代填。检查连接只读取当前工具目录，不执行业务工具。
      </p>
      {error && <Notice error>{error}</Notice>}
      {!loading && !error && !services.length && (
        <p className="caption mt">暂无向本人开放的外部MCP服务。</p>
      )}
      {services.map((service) => (
        <div className="listrow" key={service.id}>
          <div className="grow">
            <b>{service.name}</b>
            <p>
              {service.endpoint} ·{' '}
              {service.connection?.hasCredential
                ? service.connection.status === 'ready'
                  ? '已检查当前目录'
                  : service.connection.status === 'authRequired'
                    ? '对方拒绝凭据，请本人核对'
                    : 'Key已保存，需检查连接'
                : '未配置个人Key'}
              {service.connection && !service.connection.accessGranted
                ? ' · 当前已停止开放'
                : ''}
            </p>
          </div>
          <div className="row wrap">
            <button
              className="btn small"
              disabled={
                !service.enabled ||
                Boolean(service.connection && !service.connection.accessGranted)
              }
              onClick={() => setEditing(service)}
            >
              维护个人Key
            </button>
            {service.connection?.hasCredential && (
              <>
                <button
                  className="btn small"
                  disabled={
                    !service.connection.accessGranted || busy !== undefined
                  }
                  onClick={() => void check(service)}
                >
                  {busy === service.id ? '检查中…' : '检查当前工具'}
                </button>
                <button
                  className="btn small danger"
                  onClick={() => setRevoking(service)}
                >
                  撤销本人Key
                </button>
              </>
            )}
          </div>
        </div>
      ))}
      {editing && (
        <KeyEditor
          service={editing}
          onClose={() => setEditing(undefined)}
          onSaved={load}
        />
      )}{' '}
      {catalog && (
        <CatalogDialog
          catalog={catalog}
          onClose={() => setCatalog(undefined)}
        />
      )}{' '}
      {revoking && (
        <Dialog
          title="撤销本人外部Key"
          busy={revoke.pending}
          onClose={() => {
            if (!revoke.pending) setRevoking(undefined);
          }}
          footer={
            <>
              <button
                className="btn"
                disabled={revoke.pending}
                onClick={() => setRevoking(undefined)}
              >
                取消
              </button>
              <button
                className="btn danger"
                disabled={revoke.pending || revoke.uncertain}
                onClick={() => void remove()}
              >
                撤销本人Key
              </button>
            </>
          }
        >
          <p>
            仅撤销你在「{revoking.name}
            」的凭据。尚未发送的调用会停止，已发送的外部动作不会被当作已经撤销。
          </p>
          {revoke.error && <Notice error>{revoke.error}</Notice>}
          <Recovery
            operation="external-mcp.personal-key.revoke"
            command={revoke}
            schema={externalConnectionReceiptSchema}
            onRecovered={() => void removed()}
          />
        </Dialog>
      )}
    </div>
  );
}
export function ExternalMcpReferenceCandidates({
  remaining,
  onAdd,
}: {
  remaining: number;
  onAdd: (reference: PreparedReference) => void;
}) {
  const [connections, setConnections] = useState<
      z.infer<typeof externalAvailableToolsSchema>['connections']
    >([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    const abort = new AbortController();
    void api(
      `${base}/available`,
      { signal: abort.signal },
      externalAvailableToolsSchema,
    )
      .then((value) => {
        if (!abort.signal.aborted) setConnections(value.connections);
      })
      .catch((error) => {
        if (!abort.signal.aborted) setError(describeError(error));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, []);
  return (
    <div className="external-mcp-page">
      <Notice>
        只列本人已配置、已检查且仍开放的连接。选择只加入当前工具目录元数据，不调用外部工具，不发送当前对话或附件。
      </Notice>
      {error && <Notice error>{error}</Notice>}
      {loading && <p className="caption mt">读取本人当前可用连接…</p>}
      {!loading && !error && !connections.length && (
        <p className="caption mt">
          没有可选连接。请先在个人设置维护本人Key并检查工具目录。
        </p>
      )}
      {connections.map((connection) => (
        <div className="listrow" key={connection.connectionId}>
          <div className="grow">
            <b>{connection.name}</b>
            <p>
              {connection.tools
                .filter((tool) => tool.approved)
                .map((tool) => tool.name)
                .join('、') || '没有匹配批准上限的工具'}
            </p>
          </div>
          <button
            className="btn small"
            disabled={remaining < 1 || !connection.tools.length}
            onClick={() =>
              onAdd({
                id: `externalMcpConnection:${connection.connectionId}`,
                label: connection.name,
                reference: {
                  kind: 'externalMcpConnection',
                  connectionId: connection.connectionId,
                  configRevision: connection.configRevision,
                  credentialVersion: connection.credentialVersion,
                  catalogDigest: connection.catalogDigest,
                  dataScope: 'syntheticPublicOnly',
                },
                note: '已选择固定的当前目录元数据，尚未调用任何外部业务工具；实际外发由本人核对接收方、内容与用途。',
              })
            }
          >
            选择连接
          </button>
        </div>
      ))}
    </div>
  );
}

export function ExternalMcpInvocationsPanel({
  taskId,
  conversationId,
  invocationId,
  pendingOnly = false,
  hideEmpty = false,
  refreshKey,
  onResolved,
  inline = false,
}: {
  taskId?: string;
  conversationId?: string;
  invocationId?: string;
  pendingOnly?: boolean;
  hideEmpty?: boolean;
  refreshKey?: unknown;
  onResolved?: () => void;
  inline?: boolean;
}) {
  const [publicReviews, setPublicReviews] = useState<Record<string, string>>(
    {},
  );
  const [items, setItems] = useState<Invocation[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState<string>(),
    [unconfirmed, setUnconfirmed] = useState<
      Record<string, 'decision' | 'cancel'>
    >({});
  const epoch = useRef(0);
  const sending = useRef(false);
  async function load(signal?: AbortSignal, generation = epoch.current) {
    if (
      (invocationId && !z.uuid().safeParse(invocationId).success) ||
      (conversationId && !z.uuid().safeParse(conversationId).success) ||
      (taskId && !z.uuid().safeParse(taskId).success)
    ) {
      if (generation === epoch.current) {
        setError('调用或任务标识无效，未发起读取请求。');
        setLoading(false);
      }
      return;
    }
    try {
      const values = invocationId
        ? [
            (
              await api(
                `${base}/invocations/${encodeURIComponent(invocationId)}`,
                signal ? { signal } : {},
                externalInvocationReceiptSchema,
              )
            ).invocation,
          ]
        : (
            await api(
              `${base}/invocations?${new URLSearchParams({ ...(taskId ? { taskId } : {}), ...(conversationId ? { conversationId } : {}), pendingOnly: String(pendingOnly) })}`,
              signal ? { signal } : {},
              externalInvocationListSchema,
            )
          ).invocations;
      if (!signal?.aborted && generation === epoch.current) {
        if (
          (conversationId &&
            values.some((row) => row.conversationId !== conversationId)) ||
          (taskId && values.some((row) => row.taskId !== taskId)) ||
          (invocationId && values.some((row) => row.id !== invocationId))
        )
          throw new Error(
            '外部调用所属会话、任务或原调用标识不匹配，未显示内容。',
          );
        setItems(
          pendingOnly
            ? values.filter((row) =>
                ['waitingConsent', 'dispatching', 'failed', 'unknown'].includes(
                  row.state,
                ),
              )
            : values,
        );
        setError('');
        setUnconfirmed((current) => {
          const next = Object.fromEntries(
            Object.entries(current).filter(([id, kind]) =>
              values.some(
                (row) =>
                  row.id === id &&
                  (kind === 'cancel'
                    ? ['waitingConsent', 'dispatching'].includes(row.state)
                    : ['waitingConsent', 'dispatching', 'unknown'].includes(
                        row.state,
                      )),
              ),
            ),
          );
          const owner = currentIdentityOwner();
          if (owner)
            for (const row of values) {
              try {
                if (
                  ['completed', 'declined', 'cancelled', 'failed'].includes(
                    row.state,
                  )
                )
                  clearExternalDecision(window.localStorage, owner, row.id);
                else if (
                  externalDecisionPending(window.localStorage, owner, row.id)
                )
                  next[row.id] = 'decision';
              } catch {
                next[row.id] = 'decision';
              }
            }
          return next;
        });
      }
    } catch (error) {
      if (!signal?.aborted && generation === epoch.current) {
        if (error instanceof ApiError && [401, 403, 404].includes(error.status))
          setItems([]);
        setError(describeError(error));
      }
    } finally {
      if (!signal?.aborted && generation === epoch.current) setLoading(false);
    }
  }
  useLayoutEffect(() => {
    const abort = new AbortController();
    epoch.current++;
    setBusy(undefined);
    setUnconfirmed({});
    setPublicReviews({});
    setLoading(true);
    setItems([]);
    void load(abort.signal);
    return () => abort.abort();
  }, [taskId, conversationId, invocationId, pendingOnly]);
  useEffect(
    () =>
      subscribeIdentityChanges(() => {
        epoch.current++;
        setItems([]);
        setPublicReviews({});
        setUnconfirmed({});
        setBusy(undefined);
        sending.current = false;
      }),
    [],
  );
  useEffect(() => {
    if (refreshKey === undefined) return;
    const abort = new AbortController(),
      generation = epoch.current,
      timer = window.setTimeout(() => void load(abort.signal, generation), 250);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [refreshKey]);
  useEffect(() => {
    let timer: number | undefined;
    const refresh = () => {
      if (document.visibilityState === 'hidden') return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(undefined, epoch.current), 100);
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [conversationId, taskId, invocationId, pendingOnly]);
  useEffect(() => {
    if (!items.some((item) => item.state === 'dispatching')) return;
    const timer = window.setInterval(() => void load(), 2500);
    return () => window.clearInterval(timer);
  }, [
    items.some((item) => item.state === 'dispatching'),
    taskId,
    conversationId,
    invocationId,
    pendingOnly,
  ]);
  async function decide(row: Invocation, decision: 'accept' | 'decline') {
    if (sending.current) return;
    if (
      !canInlineExternalDecision({
        inline,
        taskId: row.taskId,
        conversationId: row.conversationId,
        ...(taskId ? { currentTaskId: taskId } : {}),
        ...(conversationId ? { currentConversationId: conversationId } : {}),
      })
    ) {
      setError('此调用只能在对应AI回复的确认卡中决定。');
      return;
    }
    const owner = currentIdentityOwner();
    if (!owner) {
      setError('当前账号尚未核对，未发出外发决定。');
      return;
    }
    sending.current = true;
    const generation = epoch.current;
    setBusy(row.id);
    try {
      beginExternalDecision(window.localStorage, owner, {
        id: row.id,
        scopeDigest: row.scopeDigest,
        decision,
      });
      setUnconfirmed((current) => ({ ...current, [row.id]: 'decision' }));
      await api(
        `${base}/invocations/${row.id}/resolve`,
        {
          method: 'POST',
          body: {
            scopeDigest: row.scopeDigest,
            decision,
            ...(row.isPublicSearch && decision === 'accept'
              ? {
                  publicQueryConfirmed:
                    publicReviews[row.id] === row.scopeDigest,
                }
              : {}),
          },
        },
        externalInvocationReceiptSchema,
      );
      await load(undefined, generation);
      if (generation === epoch.current) onResolved?.();
    } catch (error) {
      if (generation === epoch.current) {
        setError(describeError(error));
        let fence = true;
        try {
          fence = externalDecisionPending(window.localStorage, owner, row.id);
        } catch {
          fence = true;
        }
        if (uncertain(error) || fence)
          setUnconfirmed((current) => ({ ...current, [row.id]: 'decision' }));
      }
    } finally {
      sending.current = false;
      if (generation === epoch.current) setBusy(undefined);
    }
  }
  async function cancel(row: Invocation) {
    const generation = epoch.current;
    setBusy(row.id);
    try {
      await api(
        `${base}/invocations/${row.id}/cancel`,
        { method: 'POST', body: {} },
        externalInvocationReceiptSchema,
      );
      await load(undefined, generation);
    } catch (error) {
      if (generation === epoch.current) {
        setError(describeError(error));
        if (uncertain(error))
          setUnconfirmed((current) => ({ ...current, [row.id]: 'cancel' }));
      }
    } finally {
      if (generation === epoch.current) setBusy(undefined);
    }
  }
  if (hideEmpty && !error && !items.length) return null;
  return (
    <div
      className={`external-mcp-page${inline ? ' conversation-external-consent' : ''}`}
    >
      {error && (
        <Notice error>
          {error}
          <button
            className="btn small mt"
            disabled={busy !== undefined}
            onClick={() => void load()}
          >
            只读刷新本会话原调用
          </button>
        </Notice>
      )}
      {loading && <p className="caption mt">读取本人外部调用…</p>}
      {!loading && !error && !items.length && (
        <p className="caption mt">没有当前可显示的外部调用提案。</p>
      )}
      {items.map((row) => (
        <section className="card pad mt" key={row.id}>
          <div className="between">
            <div className="grow">
              <h3>
                {row.destinationName} / {row.toolName}
              </h3>
              <p className="caption">
                {row.id} · {new Date(row.updatedAt).toLocaleString('zh-CN')}
              </p>
            </div>
            <span className={`badge ${row.state === 'unknown' ? 'amber' : ''}`}>
              {stateLabel[row.state]}
            </span>
          </div>
          <p className="caption mt">
            接收方：{row.endpoint}
            <br />
            固定目标：{row.projectId ?? '个人无项目'}
            {row.operationTarget?.requirementId
              ? ` · 需求 ${row.operationTarget.requirementId}`
              : ''}
            {row.operationTarget?.objectIds?.length
              ? ` · 对象 ${row.operationTarget.objectIds.join('、')}`
              : ''}
            <br />
            精确摘要：<span className="mono">{row.scopeDigest}</span>
          </p>
          <p className="caption mt">
            用途：{row.purpose || '原内容已按隐私删除'}
          </p>
          {row.arguments !== null ? (
            <details
              className="mt"
              open={!inline && row.state === 'waitingConsent'}
            >
              <summary>本次实际外发参数</summary>
              <pre className="code mt">
                {JSON.stringify(row.arguments, null, 2)}
              </pre>
            </details>
          ) : (
            <Notice>
              原参数已删除、来源失权或连接已变化，不能据旧摘要发送。
            </Notice>
          )}
          {row.state === 'waitingConsent' &&
            canInlineExternalDecision({
              inline,
              taskId: row.taskId,
              conversationId: row.conversationId,
              ...(taskId ? { currentTaskId: taskId } : {}),
              ...(conversationId
                ? { currentConversationId: conversationId }
                : {}),
            }) && (
              <>
                {row.isPublicSearch && (
                  <label className="checkrow mt">
                    <input
                      type="checkbox"
                      checked={publicReviews[row.id] === row.scopeDigest}
                      disabled={
                        busy !== undefined || Boolean(unconfirmed[row.id])
                      }
                      onChange={(event) =>
                        setPublicReviews((current) => ({
                          ...current,
                          [row.id]: event.target.checked ? row.scopeDigest : '',
                        }))
                      }
                    />
                    <span>
                      我已核对实际搜索词「{row.publicQuery ?? '当前不可读取'}
                      」，仅含通用公开信息，可交给上述服务检索。不会发送项目正文、私聊、附件或凭据；模式检查不能保证识别所有非公开内容。
                    </span>
                  </label>
                )}
                <div className="row wrap mt">
                  <button
                    className="btn primary"
                    disabled={
                      busy !== undefined ||
                      Boolean(unconfirmed[row.id]) ||
                      row.arguments === null ||
                      Boolean(
                        row.isPublicSearch &&
                        publicReviews[row.id] !== row.scopeDigest,
                      )
                    }
                    onClick={() => void decide(row, 'accept')}
                  >
                    {inline ? '执行并同意此次外发' : '同意并发送这份内容'}
                  </button>
                  <button
                    className="btn"
                    disabled={
                      busy !== undefined || Boolean(unconfirmed[row.id])
                    }
                    onClick={() => void decide(row, 'decline')}
                  >
                    {inline ? '取消' : '拒绝外发'}
                  </button>
                </div>
              </>
            )}
          {row.state === 'dispatching' && !inline && row.taskId === null && (
            <button
              className="btn danger mt"
              disabled={busy !== undefined || Boolean(unconfirmed[row.id])}
              onClick={() => void cancel(row)}
            >
              取消后续等待
            </button>
          )}
          {Boolean(unconfirmed[row.id]) && (
            <Notice>
              本人决定的回执尚未确认。已禁重复决定，只读刷新原记录；仍待决定不代表原请求未受理。
            </Notice>
          )}
          {row.state === 'unknown' && (
            <Notice>
              已有发送意图但没有确定结果；关闭连接或取消不证明对方已回滚。只读查询原记录，不能换标识重放。
            </Notice>
          )}
          {row.errorCode && (
            <p className="caption mt">
              回执代码：{row.errorCode} · 工具发送意图 {row.toolSends}
              次（不代表对方实际完成）
            </p>
          )}
          {row.result !== null && (
            <details className="mt">
              <summary>查看已保存的真实工具回执</summary>
              <pre className="code mt">
                {JSON.stringify(row.result, null, 2)}
              </pre>
              <p className="caption">
                保留的是当次对方响应，不证明远端对象此刻状态或当前权限；响应内容不是平台写授权。
              </p>
            </details>
          )}
          <div className="row mt">
            <button
              className="btn small"
              disabled={busy !== undefined}
              onClick={() => void load()}
            >
              只读刷新原状态
            </button>
            {!inline && row.taskId !== null ? (
              <span className="caption">
                此调用属于对话，请在原AI回复下的操作卡核对并决定。
              </span>
            ) : null}
          </div>
        </section>
      ))}
    </div>
  );
}

const pendingCallSchema = z.strictObject({
  commandId: z.uuid(),
  connectionId: z.uuid(),
  toolName: z.string(),
});
type PendingCall = z.infer<typeof pendingCallSchema>;
const pendingKey = (ownerId: string) =>
  `aitesthub:external-call-pending:${ownerId}`;
function pendingCalls(ownerId: string) {
  try {
    return z
      .array(pendingCallSchema)
      .parse(JSON.parse(sessionStorage.getItem(pendingKey(ownerId)) ?? '[]'));
  } catch {
    return [];
  }
}
function rememberCall(ownerId: string, call: PendingCall, remove = false) {
  try {
    const next = pendingCalls(ownerId).filter(
      (item) => item.commandId !== call.commandId,
    );
    if (!remove) next.push(call);
    sessionStorage.setItem(pendingKey(ownerId), JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}
function ManualCall({
  me,
  onClose,
  onCreated,
}: {
  me: z.infer<typeof meSchema>;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [available, setAvailable] = useState<
      z.infer<typeof externalAvailableToolsSchema>['connections']
    >([]),
    [personal, setPersonal] = useState<Personal[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const [connectionId, setConnectionId] = useState(''),
    [toolName, setToolName] = useState(''),
    [projectId, setProjectId] = useState(''),
    [purpose, setPurpose] = useState(''),
    [args, setArgs] = useState('{}');
  const [publicQueryConfirmed, setPublicQueryConfirmed] = useState(false);
  const [review, setReview] = useState<{
    payload: z.infer<typeof externalManualCallInputSchema>;
    endpoint: string;
    name: string;
    isPublicSearch: boolean;
  }>();
  const command = useBusinessCommand(`manual-external:${me.user.id}`),
    locked = command.pending || command.uncertain;
  useEffect(() => {
    const abort = new AbortController();
    void Promise.all([
      api(
        `${base}/available`,
        { signal: abort.signal },
        externalAvailableToolsSchema,
      ),
      api(
        `${base}/personal`,
        { signal: abort.signal },
        externalPersonalServicesSchema,
      ),
    ])
      .then(([a, p]) => {
        if (!abort.signal.aborted) {
          setAvailable(a.connections);
          setPersonal(p.services);
        }
      })
      .catch((error) => {
        if (!abort.signal.aborted) setError(describeError(error));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, []);
  const connection = available.find(
      (item) => item.connectionId === connectionId,
    ),
    tool = connection?.tools.find((item) => item.name === toolName);
  function preview() {
    setError('');
    try {
      if (
        pendingCalls(me.user.id).some(
          (item) =>
            item.connectionId === connectionId &&
            item.toolName === toolName &&
            item.commandId !== command.commandId,
        )
      )
        throw new Error(
          '此工具尚有原回执未核对。请先关闭并查询原记录，不能用新标识当作重试。',
        );
      const recipient = personal.find(
          (item) => item.connection?.id === connectionId,
        ),
        current = recipient?.connection;
      if (
        !connection ||
        !recipient ||
        !current ||
        current.configRevision !== connection.configRevision ||
        current.credentialVersion !== connection.credentialVersion ||
        current.catalogDigest !== connection.catalogDigest
      )
        throw new Error('连接版本尚未一致，请关闭后重新加载当前连接。');
      if (new TextEncoder().encode(args).byteLength > 64 * 1024)
        throw new Error('参数最多64KiB，请缩小实际调用范围。');
      const payload = externalManualCallInputSchema.parse({
        commandId: command.commandId,
        connectionId,
        toolName,
        arguments: parseStrictJsonText(args),
        purpose,
        projectId: projectId || null,
        expectedSnapshot: {
          configRevision: connection.configRevision,
          credentialVersion: connection.credentialVersion,
          catalogDigest: connection.catalogDigest,
        },
      });
      if (tool?.effect === 'write' && !projectId)
        throw new Error('请为业务写明确选择本次固定项目。');
      setReview({
        payload,
        endpoint: recipient.endpoint,
        name: recipient.name,
        isPublicSearch: Boolean(tool?.publicSearch),
      });
      setPublicQueryConfirmed(false);
    } catch (error) {
      setError(
        error instanceof z.ZodError
          ? '请完整填写工具、固定项目（写操作）、用途和对象参数。'
          : error instanceof Error && error.message === 'Invalid bounded JSON'
            ? '参数须为无重复字段、结构受限的完整JSON对象。'
            : describeError(error),
      );
    }
  }
  async function recover() {
    try {
      const receipt = await api(
        `${base}/invocations/by-command/${command.commandId}`,
        {},
        externalInvocationReceiptSchema,
      );
      if (connectionId && toolName)
        rememberCall(
          me.user.id,
          { commandId: command.commandId, connectionId, toolName },
          true,
        );
      command.confirmRecoveredReceipt();
      onCreated(receipt.invocation.id);
      onClose();
    } catch (error) {
      setError(
        error instanceof ApiError && error.status === 404
          ? '暂未取得原调用，不代表请求未发生。保留原标识继续只读查询，未重发。'
          : describeError(error),
      );
    }
  }
  async function send() {
    if (!review) return;
    if (review.isPublicSearch && !publicQueryConfirmed) return;
    const snapshot = review;
    const receipt = await command.run(async () => {
      const marker = {
        commandId: snapshot.payload.commandId,
        connectionId: snapshot.payload.connectionId,
        toolName: snapshot.payload.toolName,
      };
      if (!rememberCall(me.user.id, marker))
        throw new Error(
          '浏览器无法保存本次操作标识，尚未发送；请恢复本站会话存储后再提交。',
        );
      try {
        const result = await api(
          `${base}/invocations`,
          {
            method: 'POST',
            body: {
              ...snapshot.payload,
              ...(snapshot.isPublicSearch ? { publicQueryConfirmed } : {}),
            },
          },
          externalInvocationReceiptSchema,
        );
        rememberCall(me.user.id, marker, true);
        return result;
      } catch (error) {
        if (!uncertain(error)) rememberCall(me.user.id, marker, true);
        throw error;
      }
    });
    if (receipt) {
      onCreated(receipt.invocation.id);
      onClose();
    }
  }
  return (
    <>
      <Dialog
        title="明确发起已批准外部工具"
        wide
        busy={command.pending}
        onClose={onClose}
        footer={
          <>
            <button
              className="btn"
              disabled={command.pending}
              onClick={onClose}
            >
              关闭
            </button>
            <button
              className="btn primary"
              disabled={locked || loading || !tool}
              onClick={preview}
            >
              核对外发内容
            </button>
          </>
        }
      >
        <p className="caption">
          只调用管理员已登记的固定服务与工具上限，不提供任意URL或命令入口。账号认证使用你自己的已配置Key。
        </p>
        {(error || command.error) && (
          <Notice error>{error || command.error}</Notice>
        )}
        <fieldset
          disabled={locked || loading}
          style={{ border: 0, padding: 0, margin: 0 }}
        >
          <div className="formgrid mt">
            <label className="field-label">
              本人连接
              <select
                value={connectionId}
                onChange={(event) => {
                  setConnectionId(event.target.value);
                  setToolName('');
                }}
              >
                <option value="">请选择当前已检查连接</option>
                {available.map((item) => (
                  <option key={item.connectionId} value={item.connectionId}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label">
              批准工具
              <select
                value={toolName}
                onChange={(event) => setToolName(event.target.value)}
              >
                <option value="">请选择</option>
                {connection?.tools.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name} · {item.effect === 'write' ? '业务写' : '只读'}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label">
              本次固定项目
              <select
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
              >
                <option value="">个人无项目（只读工具）</option>
                {me.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label">
              实际用途
              <input
                className="field"
                value={purpose}
                maxLength={2000}
                onChange={(event) => setPurpose(event.target.value)}
              />
            </label>
          </div>
          <label className="field-label mt">
            实际参数JSON
            <textarea
              className="field mono"
              rows={10}
              value={args}
              maxLength={65536}
              onChange={(event) => setArgs(event.target.value)}
            />
          </label>
        </fieldset>
        {tool && (
          <details className="mt">
            <summary>当前工具说明与输入Schema</summary>
            <p className="caption mt">{tool.description}</p>
            <pre className="code mt">
              {JSON.stringify(tool.inputSchema, null, 2)}
            </pre>
          </details>
        )}
        {command.uncertain && (
          <Notice>
            <p>
              原调用回执未知，已禁重发。仅保存提交标识，没有保存你的参数或用途。
            </p>
            <button className="btn small mt" onClick={() => void recover()}>
              查询原调用回执
            </button>
          </Notice>
        )}
        <details className="caption mt" open={command.uncertain}>
          <summary>原提交标识</summary>
          <span className="mono">{command.commandId}</span>
        </details>
      </Dialog>
      {review && (
        <Dialog
          title="核对这次实际外发"
          wide
          zIndex={uiLayers.nestedDialog}
          busy={command.pending}
          onClose={() => setReview(undefined)}
          footer={
            <>
              <button
                className="btn"
                disabled={command.pending}
                onClick={() => setReview(undefined)}
              >
                返回修改
              </button>
              <button
                className="btn primary"
                disabled={
                  locked || (review.isPublicSearch && !publicQueryConfirmed)
                }
                onClick={() => void send()}
              >
                发送这份内容
              </button>
            </>
          }
        >
          <p>
            接收方：{review.name}
            <br />
            {review.endpoint}
          </p>
          <p className="caption mt">
            工具：{review.payload.toolName} · 固定项目：
            {me.projects.find(
              (project) => project.id === review.payload.projectId,
            )?.name ?? '个人无项目'}
            <br />
            用途：{review.payload.purpose}
            <br />
            配置r{review.payload.expectedSnapshot.configRevision} · 本人凭据版本
            {review.payload.expectedSnapshot.credentialVersion}
          </p>
          <pre className="code mt">
            {JSON.stringify(review.payload.arguments, null, 2)}
          </pre>
          {review.isPublicSearch && (
            <label className="checkrow mt">
              <input
                type="checkbox"
                checked={publicQueryConfirmed}
                disabled={locked}
                onChange={(event) =>
                  setPublicQueryConfirmed(event.target.checked)
                }
              />
              <span>
                我已核对以上唯一搜索词，仅含通用公开信息，可交给此服务检索。项目正文、私聊、附件、账号凭据及未公开需求不能外发；模式检查不能识别所有非公开内容。
              </span>
            </label>
          )}
          <Notice>
            点击发送表示你同意将以上具体内容交给这个服务用于所列用途。回执仅表明对方实际响应，取消或断流不能当作对方已经回滚。
          </Notice>
          {command.error && <Notice error>{command.error}</Notice>}
          {command.uncertain && (
            <button className="btn mt" onClick={() => void recover()}>
              只读查询原调用
            </button>
          )}
        </Dialog>
      )}
    </>
  );
}

export function ExternalMcpDecisionsPage() {
  const [me, setMe] = useState<z.infer<typeof meSchema>>(),
    [manual, setManual] = useState(false),
    [pending, setPending] = useState<PendingCall[]>([]),
    [lookupError, setLookupError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    void api('/me', { signal: abort.signal }, meSchema)
      .then((value) => {
        if (!abort.signal.aborted) {
          setMe(value);
          setPending(pendingCalls(value.user.id));
        }
      })
      .catch((error) => {
        if (!abort.signal.aborted) setLookupError(describeError(error));
      });
    return () => abort.abort();
  }, []);
  const [id, setId] = useState(
    () =>
      new URLSearchParams(window.location.hash.split('?')[1] ?? '').get(
        'invocationId',
      ) ?? undefined,
  );
  useEffect(() => {
    const changed = () =>
      setId(
        new URLSearchParams(window.location.hash.split('?')[1] ?? '').get(
          'invocationId',
        ) ?? undefined,
      );
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  return (
    <div className="external-mcp-page">
      <PageHeading
        eyebrow="EXTERNAL MCP"
        title="外部工具调用"
        description="核对具体接收方、全部参数与用途，查看本人调用的实际回执。"
        actions={
          <button
            className="btn primary"
            disabled={!me}
            onClick={() => setManual(true)}
          >
            明确发起调用
          </button>
        }
      />
      {lookupError && <Notice error>{lookupError}</Notice>}
      {pending.map((item) => (
        <div className="notice amber mb" key={item.commandId}>
          <p>
            原提交 {item.commandId} 的回执尚未核对。未保存原参数，不会据此重发。
          </p>
          <button
            className="btn small mt"
            onClick={() => {
              void api(
                `${base}/invocations/by-command/${item.commandId}`,
                {},
                externalInvocationReceiptSchema,
              )
                .then((receipt) => {
                  if (me) {
                    rememberCall(me.user.id, item, true);
                    setPending(pendingCalls(me.user.id));
                  }
                  setId(receipt.invocation.id);
                  window.location.hash = `external-mcp?invocationId=${receipt.invocation.id}`;
                  setLookupError('');
                })
                .catch((error) =>
                  setLookupError(
                    error instanceof ApiError && error.status === 404
                      ? '暂未取得原回执，不代表未受理；保留原标识继续只读核对。'
                      : describeError(error),
                  ),
                );
            }}
          >
            查询原调用
          </button>
        </div>
      ))}
      <ExternalMcpInvocationsPanel {...(id ? { invocationId: id } : {})} />
      {manual && me && (
        <ManualCall
          me={me}
          onClose={() => {
            setManual(false);
            setPending(pendingCalls(me.user.id));
          }}
          onCreated={(value) => {
            setId(value);
            window.location.hash = `external-mcp?invocationId=${value}`;
          }}
        />
      )}
    </div>
  );
}
