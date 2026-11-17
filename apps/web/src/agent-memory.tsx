import { useEffect, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Form,
  Input,
  Modal,
  Space,
  Switch,
  Table,
  Typography,
} from 'antd';
import { api, describeError } from './api';
import {
  agentMemoryListSchema,
  type AgentMemoryEntry,
} from '../../../packages/contracts/src/agent-memory';
import type { z } from 'zod';

export function AgentMemoryPanel() {
  const { modal } = App.useApp();
  const [data, setData] = useState<z.infer<typeof agentMemoryListSchema>>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState<
    Pick<AgentMemoryEntry, 'id' | 'rowVersion'> | 'new'
  >();
  const [form] = Form.useForm<{
    title: string;
    content: string;
    enabled: boolean;
  }>();
  useEffect(() => {
    const abort = new AbortController();
    void api(
      '/me/agent-memory',
      { signal: abort.signal },
      agentMemoryListSchema,
    )
      .then(setData)
      .catch((e) => {
        if (!abort.signal.aborted) setError(describeError(e));
      });
    return () => abort.abort();
  }, []);
  const mutate = async (
    work: () => Promise<z.infer<typeof agentMemoryListSchema>>,
  ) => {
    setPending(true);
    setError(undefined);
    try {
      setData(await work());
      return true;
    } catch (e) {
      setError(describeError(e));
      return false;
    } finally {
      setPending(false);
    }
  };
  return (
    <Space orientation="vertical" className="fullwidth">
      <Typography.Paragraph>
        保存本人常用偏好和约定。开启后，启用条目会提供给后续对话所选模型；项目资料请使用项目知识或附件。不会自动从私聊提取记忆，删除条目不会改写历史消息。
      </Typography.Paragraph>
      {error ? <Alert type="error" showIcon title={error} /> : null}
      {data &&
      (data.unavailableEntries.length > 0 ||
        data.entries.some(
          (entry) => entry.availability === 'restoredNeedsReview',
        )) ? (
        <Alert
          type="warning"
          showIcon
          title="恢复后有记忆需要复核"
          description="旧修订正文仍保留，复核保存前不会提供给模型；备份中缺失的正文无法根据摘要重建，请重新补充或忘记该条。"
        />
      ) : null}
      <Space>
        <span>在后续对话使用个人记忆</span>
        <Switch
          aria-label="在后续对话使用个人记忆"
          checked={data?.enabled ?? false}
          disabled={!data || pending}
          onChange={(enabled) => {
            if (data)
              void mutate(() =>
                api(
                  '/me/agent-memory/preference',
                  {
                    method: 'PUT',
                    body: { enabled, rowVersion: data.rowVersion },
                  },
                  agentMemoryListSchema,
                ),
              );
          }}
        />
      </Space>
      <Button
        disabled={!data || pending}
        onClick={() => {
          form.resetFields();
          form.setFieldsValue({ title: '', content: '', enabled: true });
          setEditing('new');
        }}
      >
        新增记忆
      </Button>
      {data?.unavailableEntries.map((entry) => (
        <Space key={entry.id} wrap>
          <Typography.Text type="secondary">
            原文未包含在备份中：{entry.id}
          </Typography.Text>
          <Button
            disabled={pending}
            onClick={() => {
              form.resetFields();
              form.setFieldsValue({ title: '', content: '', enabled: true });
              setEditing({ id: entry.id, rowVersion: entry.rowVersion });
            }}
          >
            重新补充
          </Button>
          <Button
            danger
            disabled={pending}
            onClick={() =>
              modal.confirm({
                title: '忘记这条缺失记忆？',
                content:
                  '正文未保存在此备份中；此操作保留当前忘记决定，不会重建原文。',
                okText: '忘记',
                cancelText: '取消',
                onOk: () =>
                  mutate(() =>
                    api(
                      `/me/agent-memory/${entry.id}`,
                      {
                        method: 'DELETE',
                        body: { rowVersion: entry.rowVersion },
                      },
                      agentMemoryListSchema,
                    ),
                  ),
              })
            }
          >
            忘记该条
          </Button>
        </Space>
      ))}
      <Table<AgentMemoryEntry>
        rowKey="id"
        loading={!data && !error}
        dataSource={data?.entries ?? []}
        pagination={false}
        columns={[
          { title: '名称', dataIndex: 'title' },
          { title: '内容', dataIndex: 'content' },
          {
            title: '状态',
            render: (_, entry) =>
              entry.availability === 'restoredNeedsReview'
                ? '恢复后待复核'
                : entry.enabled
                  ? '启用'
                  : '停用',
          },
          {
            title: '操作',
            render: (_, entry) => (
              <Space>
                <Button
                  disabled={pending}
                  onClick={() => {
                    form.setFieldsValue(entry);
                    setEditing(entry);
                  }}
                >
                  编辑
                </Button>
                <Button
                  danger
                  disabled={pending}
                  onClick={() =>
                    modal.confirm({
                      title: '删除这条个人记忆？',
                      content:
                        '后续对话将不再重新注入此条，历史消息保持原记录。',
                      okText: '删除',
                      cancelText: '取消',
                      onOk: () =>
                        mutate(() =>
                          api(
                            `/me/agent-memory/${entry.id}`,
                            {
                              method: 'DELETE',
                              body: { rowVersion: entry.rowVersion },
                            },
                            agentMemoryListSchema,
                          ),
                        ),
                    })
                  }
                >
                  删除
                </Button>
              </Space>
            ),
          },
        ]}
      />
      <Modal
        open={Boolean(editing)}
        title={editing === 'new' ? '新增个人记忆' : '编辑个人记忆'}
        okText="保存"
        cancelText="取消"
        confirmLoading={pending}
        onCancel={() => {
          if (!pending) setEditing(undefined);
        }}
        onOk={() => form.submit()}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={async (values) => {
            if (!editing) return;
            const saved = await mutate(() =>
              api(
                '/me/agent-memory',
                {
                  method: 'POST',
                  body: {
                    ...values,
                    id: editing === 'new' ? crypto.randomUUID() : editing.id,
                    rowVersion: editing === 'new' ? 0 : editing.rowVersion,
                  },
                },
                agentMemoryListSchema,
              ),
            );
            if (saved) setEditing(undefined);
          }}
        >
          <Form.Item
            name="title"
            label="名称"
            rules={[{ required: true, whitespace: true, max: 100 }]}
          >
            <Input maxLength={100} />
          </Form.Item>
          <Form.Item
            name="content"
            label="通用偏好或约定"
            rules={[{ required: true, whitespace: true, max: 2000 }]}
          >
            <Input.TextArea rows={5} maxLength={2000} showCount />
          </Form.Item>
          <Form.Item name="enabled" label="启用条目" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
