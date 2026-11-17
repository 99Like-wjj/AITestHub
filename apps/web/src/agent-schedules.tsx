import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Drawer,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { z } from 'zod';
import { api, describeError, isUncertainMutationError } from './api';
import {
  agentScheduleCreateSchema,
  agentScheduleDetailSchema,
  agentScheduleListSchema,
  agentSchedulePreviewSchema,
  agentScheduleReceiptSchema,
  type AgentSchedule,
} from '../../../packages/contracts/src/agent-schedules';
import { conversationListSchema } from '../../../packages/contracts/src/conversations';
import {
  workspaceDataScope,
  type WorkspaceAccessMode,
} from '../../../packages/contracts/src/workspace-access';
import {
  availableModelV2ListSchema,
  type AvailableModelV2,
} from '../../../packages/contracts/src/model-configuration-v2';

const resourcesSchema = z.object({
  resources: z.array(
    z.object({ id: z.uuid(), originalName: z.string(), status: z.string() }),
  ),
});
const labels: Record<AgentSchedule['state'], string> = {
  active: '已启用',
  paused: '已暂停',
  cancelled: '已取消',
  finished: '已结束',
};
type FormValues = {
  title: string;
  kind: 'reminder' | 'draft' | 'office';
  accessMode?: WorkspaceAccessMode;
  conversationId?: string | undefined;
  frequency: 'once' | 'daily' | 'weekly';
  date: string;
  time: string;
  timeZone: string;
  message?: string;
  content?: string | undefined;
  modelKey?: string | undefined;
  dataScope?: 'syntheticPublicOnly' | 'authorizedRelevantTestData';
  resourceIds?: string[];
};
type PendingCommand = {
  operation: 'create' | 'revise' | 'pause' | 'resume' | 'cancel';
  key: string;
};

export function AgentSchedules() {
  const [form] = Form.useForm<FormValues>();
  const kind = Form.useWatch('kind', form);
  const accessMode = Form.useWatch('accessMode', form);
  const [rows, setRows] = useState<AgentSchedule[]>([]),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string>();
  const [open, setOpen] = useState(false),
    [editing, setEditing] = useState<AgentSchedule>(),
    [detail, setDetail] = useState<z.infer<typeof agentScheduleDetailSchema>>();
  const [models, setModels] = useState<AvailableModelV2[]>([]),
    [conversations, setConversations] = useState<
      z.infer<typeof conversationListSchema>['conversations']
    >([]),
    [resources, setResources] = useState<
      z.infer<typeof resourcesSchema>['resources']
    >([]);
  const [preview, setPreview] =
      useState<z.infer<typeof agentSchedulePreviewSchema>>(),
    [pending, setPending] = useState<PendingCommand>();
  async function load(signal?: AbortSignal) {
    setLoading(true);
    try {
      const options = signal ? { signal } : {};
      const result = await api(
        '/me/agent-schedules',
        options,
        agentScheduleListSchema,
      );
      if (signal?.aborted) return;
      setRows(result.schedules);
      setError(undefined);
    } catch (reason: unknown) {
      if (!signal?.aborted) setError(describeError(reason));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, []);
  async function editor(row?: AgentSchedule) {
    setBusy(true);
    setError(undefined);
    try {
      const [modelList, conversationList, resourceList] = await Promise.all([
        api('/model-services', {}, availableModelV2ListSchema),
        api('/me/conversations', {}, conversationListSchema),
        api('/me/resources?limit=100', {}, resourcesSchema),
      ]);
      setModels(modelList.models.filter((m) => m.available));
      setConversations(
        conversationList.conversations.filter((c) => !c.archivedAt),
      );
      setResources(
        resourceList.resources.filter((r) => r.status === 'verified'),
      );
      form.resetFields();
      form.setFieldsValue(
        row
          ? {
              title: row.title,
              kind: row.kind,
              conversationId: row.conversationId ?? undefined,
              frequency: row.rule.frequency,
              date: row.rule.date,
              time: row.rule.time,
              timeZone: row.rule.timeZone,
              message: row.message,
              content: row.template?.content,
              modelKey: row.template
                ? `${row.template.modelSelection.modelServiceId}/${row.template.modelSelection.modelEntryId}`
                : undefined,
              dataScope: row.template?.dataScope ?? 'syntheticPublicOnly',
              accessMode:
                row.template && 'accessMode' in row.template
                  ? row.template.accessMode
                  : 'restricted',
              resourceIds:
                row.template?.references
                  .filter((ref) => ref.kind === 'resource')
                  .map((ref) => ref.resourceId) ?? [],
            }
          : {
              title: '',
              kind: 'reminder',
              frequency: 'once',
              date: '',
              time: '09:00',
              timeZone:
                Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
              message: '',
              dataScope: 'syntheticPublicOnly',
              accessMode: 'restricted',
              resourceIds: [],
            },
      );
      setEditing(row);
      setPreview(undefined);
      setOpen(true);
    } catch (reason: unknown) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  }
  function rule(values: FormValues) {
    return {
      frequency: values.frequency,
      date: values.date,
      time: values.time,
      timeZone: values.timeZone,
    };
  }
  async function previewTime() {
    setBusy(true);
    setError(undefined);
    try {
      const values = await form.validateFields([
        'frequency',
        'date',
        'time',
        'timeZone',
      ]);
      setPreview(
        await api(
          '/me/agent-schedules/preview',
          { method: 'POST', body: rule(values) },
          agentSchedulePreviewSchema,
        ),
      );
    } catch (reason: unknown) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  }
  async function save(values: FormValues) {
    if (pending) return;
    setBusy(true);
    setError(undefined);
    const command: PendingCommand = {
      operation: editing ? 'revise' : 'create',
      key: crypto.randomUUID(),
    };
    try {
      const selected = models.find(
        (m) => `${m.modelServiceId}/${m.modelEntryId}` === values.modelKey,
      );
      if (values.kind !== 'reminder' && !selected)
        throw Error('请明确选择当前可用模型。');
      const officeAccess = values.accessMode ?? 'restricted';
      const dataScope =
        values.kind === 'office'
          ? workspaceDataScope(officeAccess)
          : (values.dataScope ?? 'syntheticPublicOnly');
      const input = agentScheduleCreateSchema.parse({
        commandId: command.key,
        title: values.title,
        kind: values.kind,
        conversationId: values.conversationId || null,
        message: values.message ?? '',
        rule: rule(values),
        template:
          values.kind !== 'reminder' && selected
            ? {
                ...(values.kind === 'office'
                  ? { accessMode: officeAccess }
                  : {}),
                content: values.content ?? '',
                modelSelection: {
                  modelServiceId: selected.modelServiceId,
                  modelEntryId: selected.modelEntryId,
                  serviceRevision: selected.serviceRevision,
                  effort: selected.defaultEffort,
                },
                dataScope,
                references:
                  values.kind === 'office' && officeAccess === 'restricted'
                    ? []
                    : [
                        ...(editing?.template?.references.filter(
                          (ref) => ref.kind !== 'resource',
                        ) ?? []),
                        ...(values.resourceIds ?? []).map((resourceId) => ({
                          kind: 'resource',
                          resourceId,
                          dataScope,
                        })),
                      ],
              }
            : null,
      });
      await api(
        editing ? `/me/agent-schedules/${editing.id}` : '/me/agent-schedules',
        {
          method: editing ? 'PUT' : 'POST',
          body: {
            ...input,
            ...(editing ? { rowVersion: editing.rowVersion } : {}),
          },
        },
        agentScheduleReceiptSchema,
      );
      setOpen(false);
      setEditing(undefined);
      await load();
    } catch (reason: unknown) {
      if (isUncertainMutationError(reason)) setPending(command);
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  }
  async function state(
    row: AgentSchedule,
    action: 'pause' | 'resume' | 'cancel',
  ) {
    if (pending) return;
    setBusy(true);
    setError(undefined);
    const command: PendingCommand = {
      operation: action,
      key: crypto.randomUUID(),
    };
    try {
      await api(
        `/me/agent-schedules/${row.id}/${action}`,
        {
          method: 'POST',
          body: { commandId: command.key, rowVersion: row.rowVersion },
        },
        agentScheduleReceiptSchema,
      );
      await load();
    } catch (reason: unknown) {
      if (isUncertainMutationError(reason)) setPending(command);
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  }
  async function receipt() {
    if (!pending) return;
    setBusy(true);
    try {
      await api(
        `/me/agent-schedules/receipt?operation=${pending.operation}&key=${encodeURIComponent(pending.key)}`,
        {},
        agentScheduleReceiptSchema,
      );
      setPending(undefined);
      setOpen(false);
      await load();
    } catch (reason: unknown) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  }
  async function history(row: AgentSchedule) {
    setBusy(true);
    try {
      setDetail(
        await api(
          `/me/agent-schedules/${row.id}`,
          {},
          agentScheduleDetailSchema,
        ),
      );
    } catch (reason: unknown) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="提醒与定时任务">
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Typography.Paragraph>
          按所选时区提醒、生成草稿或执行办公任务。草稿不使用工具；办公任务可联网、计算并生成文件，网页动作仍须本人决定。结果在原对话查看，错过的时间不会补跑。
        </Typography.Paragraph>
        {error && <Alert type="error" title={error} showIcon />}
        {pending && (
          <Alert
            type="warning"
            title="原提交结果待核对，尚未再次发送。"
            description={
              <Space>
                <Typography.Text>命令 {pending.key}</Typography.Text>
                <Button loading={busy} onClick={() => void receipt()}>
                  查询原提交
                </Button>
              </Space>
            }
          />
        )}
        <Space>
          <Button
            type="primary"
            disabled={busy || Boolean(pending)}
            onClick={() => void editor()}
          >
            新建提醒或定时任务
          </Button>
          <Button loading={loading} disabled={busy} onClick={() => void load()}>
            读取当前计划
          </Button>
        </Space>
        <Table
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={rows}
          scroll={{ x: 700 }}
          columns={[
            { title: '任务', dataIndex: 'title' },
            {
              title: '类型',
              render: (_, row) =>
                row.kind === 'reminder'
                  ? '提醒'
                  : row.kind === 'office'
                    ? '办公任务'
                    : '草稿',
            },
            {
              title: '状态',
              render: (_, row) => <Tag>{labels[row.state]}</Tag>,
            },
            {
              title: '下一次',
              render: (_, row) =>
                row.nextPoint ? (
                  <>
                    <div>
                      {row.nextPoint.wallDate} {row.nextPoint.wallTime}
                    </div>
                    <Typography.Text type="secondary">
                      {row.nextPoint.timeZone}
                      {row.nextPoint.resolution === 'gap'
                        ? ' · 夏令时缺口跳过'
                        : ''}
                    </Typography.Text>
                  </>
                ) : (
                  '无未来时点'
                ),
            },
            {
              title: '操作',
              render: (_, row) => (
                <Space wrap>
                  <Button
                    size="small"
                    disabled={busy}
                    onClick={() => void history(row)}
                  >
                    记录
                  </Button>
                  {['active', 'paused'].includes(row.state) && (
                    <>
                      <Button
                        size="small"
                        disabled={busy || Boolean(pending)}
                        onClick={() => void editor(row)}
                      >
                        编辑
                      </Button>
                      <Button
                        size="small"
                        disabled={busy || Boolean(pending)}
                        onClick={() =>
                          void state(
                            row,
                            row.state === 'active' ? 'pause' : 'resume',
                          )
                        }
                      >
                        {row.state === 'active' ? '暂停' : '恢复'}
                      </Button>
                    </>
                  )}
                  {row.state !== 'cancelled' && (
                    <Button
                      danger
                      size="small"
                      disabled={busy || Boolean(pending)}
                      onClick={() => void state(row, 'cancel')}
                    >
                      取消
                    </Button>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Space>
      <Modal
        open={open}
        title={editing ? '编辑定时任务' : '新建提醒或定时任务'}
        onCancel={() => {
          if (!busy && !pending) setOpen(false);
        }}
        footer={null}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => void save(values)}
          disabled={busy || Boolean(pending)}
        >
          <Form.Item
            name="title"
            label="标题"
            rules={[{ required: true, max: 200 }]}
          >
            <Input maxLength={200} />
          </Form.Item>
          <Form.Item name="kind" label="类型" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'reminder', label: '站内提醒' },
                { value: 'draft', label: '生成草稿' },
                { value: 'office', label: '执行办公任务' },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="conversationId"
            label={kind !== 'reminder' ? '任务保存到对话' : '关联对话（可选）'}
            rules={kind !== 'reminder' ? [{ required: true }] : []}
          >
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              options={conversations.map((c) => ({
                value: c.id,
                label: c.title,
              }))}
            />
          </Form.Item>
          <Space align="start">
            <Form.Item
              name="frequency"
              label="频率"
              rules={[{ required: true }]}
            >
              <Select
                style={{ width: 110 }}
                options={[
                  { value: 'once', label: '单次' },
                  { value: 'daily', label: '每日' },
                  { value: 'weekly', label: '每周' },
                ]}
              />
            </Form.Item>
            <Form.Item
              name="date"
              label="起始日期"
              rules={[{ required: true }]}
            >
              <Input type="date" />
            </Form.Item>
            <Form.Item name="time" label="时间" rules={[{ required: true }]}>
              <Input type="time" step={1} />
            </Form.Item>
          </Space>
          <Form.Item name="timeZone" label="时区" rules={[{ required: true }]}>
            <Input placeholder="Asia/Shanghai" />
          </Form.Item>
          <Form.Item name="message" label="提醒说明">
            <Input.TextArea rows={2} maxLength={2000} />
          </Form.Item>
          {kind !== 'reminder' && (
            <>
              <Form.Item
                name="modelKey"
                label="模型"
                rules={[{ required: true }]}
              >
                <Select
                  showSearch
                  optionFilterProp="label"
                  options={models.map((m) => ({
                    value: `${m.modelServiceId}/${m.modelEntryId}`,
                    label: `${m.serviceName} · ${m.displayName}`,
                  }))}
                />
              </Form.Item>
              <Form.Item
                name="content"
                label={kind === 'office' ? '办公任务' : '草稿任务'}
                rules={[{ required: true, max: 20000 }]}
              >
                <Input.TextArea
                  rows={5}
                  maxLength={20000}
                  placeholder="例如：根据所选文档整理每周工作摘要"
                />
              </Form.Item>
              {kind === 'office' ? (
                <>
                  <Form.Item
                    name="accessMode"
                    label="访问模式"
                    rules={[{ required: true }]}
                  >
                    <Select
                      options={[
                        {
                          value: 'restricted',
                          label: '受限访问（公开信息及本任务产物）',
                        },
                        {
                          value: 'full',
                          label: '完全访问（本人当前允许的资料与网页状态）',
                        },
                      ]}
                    />
                  </Form.Item>
                  <Typography.Paragraph type="secondary">
                    可实际搜索、阅读、计算和生成会话文件；平台业务写入、外部连接器与创建其他定时任务不开放。需要网页动作时请打开原对话核对并决定。
                  </Typography.Paragraph>
                </>
              ) : (
                <Form.Item
                  name="dataScope"
                  label="资料范围"
                  rules={[{ required: true }]}
                >
                  <Select
                    options={[
                      { value: 'syntheticPublicOnly', label: '合成/公开资料' },
                      {
                        value: 'authorizedRelevantTestData',
                        label: '已获准的相关内部资料',
                      },
                    ]}
                  />
                </Form.Item>
              )}
              {(kind !== 'office' || accessMode === 'full') && (
                <Form.Item name="resourceIds" label="固定附件（可选）">
                  <Select
                    mode="multiple"
                    showSearch
                    optionFilterProp="label"
                    options={resources.map((r) => ({
                      value: r.id,
                      label: r.originalName,
                    }))}
                  />
                </Form.Item>
              )}
              {editing?.template?.references.some(
                (ref) => ref.kind !== 'resource',
              ) && (
                <Alert
                  type="warning"
                  title="此计划的知识或需求版本来源按原修订保留。上方可另行选择附件；修改知识来源请通过对话工具编辑。"
                />
              )}
            </>
          )}
          <Space>
            <Button onClick={() => void previewTime()}>预览时点</Button>
            <Button htmlType="submit" type="primary" loading={busy}>
              保存计划
            </Button>
          </Space>
          {preview && (
            <Typography.Paragraph style={{ marginTop: 12 }}>
              {preview.points.map((p) => (
                <span key={p.decisionAt} style={{ display: 'block' }}>
                  {p.wallDate} {p.wallTime} {p.timeZone}{' '}
                  {p.offset ?? '缺口跳过'}
                  {p.resolution === 'foldEarlier'
                    ? '（重复时刻取较早一次）'
                    : ''}
                </span>
              ))}
              {preview.points.length === 0 ? '没有未来时点。' : ''}
            </Typography.Paragraph>
          )}
        </Form>
      </Modal>
      <Drawer
        open={Boolean(detail)}
        onClose={() => setDetail(undefined)}
        title={detail?.schedule.title ?? '运行记录'}
        size="large"
      >
        <Typography.Paragraph>
          每个时点只派发一次。未知结果只能查询原记录；漏点不会补跑。
        </Typography.Paragraph>
        <Table
          rowKey="id"
          size="small"
          dataSource={detail?.occurrences ?? []}
          columns={[
            {
              title: '时点',
              render: (_, row) => `${row.point.wallDate} ${row.point.wallTime}`,
            },
            { title: '状态', dataIndex: 'state' },
            { title: '原因', dataIndex: 'errorCode' },
            {
              title: '原任务',
              render: (_, row) =>
                row.taskId && detail?.schedule.conversationId ? (
                  <a
                    href={`/#workspace?conversationId=${detail.schedule.conversationId}`}
                  >
                    打开原对话
                  </a>
                ) : (
                  '—'
                ),
            },
          ]}
        />
      </Drawer>
    </section>
  );
}
