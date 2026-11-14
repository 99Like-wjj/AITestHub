import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { z } from 'zod';
import {
  assetReceiptSchema,
  opinionsResponseSchema,
} from '../../../packages/contracts/src/assets';
import type { Asset } from '../../../packages/contracts/src/assets';
import { api, describeError } from './api';

type Opinions = z.infer<typeof opinionsResponseSchema>;
const opinionCreatedSchema = z.strictObject({
  opinionId: z.uuid(),
  asset: assetReceiptSchema.shape.asset,
});
export const reviewLabels = {
  pending: '待确认',
  needsOptimization: '需要优化',
  aiOptimized: 'AI 已优化（仍待人工）',
  approved: '通过',
};
export const reviewTones = {
  pending: 'amber',
  needsOptimization: 'red',
  aiOptimized: 'blue',
  approved: 'green',
} as const;

export function AssetReviewPanel({
  projectId,
  asset,
  revisionId,
  tester,
  onChanged,
}: {
  projectId: string;
  asset: Asset;
  revisionId: string;
  tester: boolean;
  onChanged: () => Promise<void>;
}) {
  const [data, setData] = useState<Opinions | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [opinionForm] = Form.useForm<{ body: string }>();
  const [noteForm] = Form.useForm<{ opinionId: string; note: string }>();
  async function load(signal?: AbortSignal) {
    setLoading(true);
    try {
      const response = await api(
        `/projects/${projectId}/assets/${asset.id}/opinions?revisionId=${revisionId}`,
        signal ? { signal } : {},
        opinionsResponseSchema,
      );
      if (!signal?.aborted) {
        setData(response);
        setError(undefined);
      }
    } catch (err) {
      if (!signal?.aborted) {
        setData(null);
        setError(describeError(err));
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    opinionForm.resetFields();
    noteForm.resetFields();
    void load(controller.signal);
    return () => controller.abort();
  }, [projectId, asset.id, revisionId, opinionForm, noteForm]);
  async function write(
    path: string,
    method: 'POST' | 'DELETE',
    body: unknown,
    created = false,
  ) {
    setPending(true);
    setError(undefined);
    try {
      await api(
        `/projects/${projectId}/assets/${asset.id}/${path}`,
        { method, body },
        created ? opinionCreatedSchema : assetReceiptSchema,
      );
      await onChanged();
      await load();
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    } finally {
      setPending(false);
    }
  }
  return (
    <Card title="此对象、此修订的评审意见" loading={loading} size="small">
      {error && (
        <Alert type="error" showIcon title={error} className="section-alert" />
      )}
      {data && (
        <>
          {!data.isCurrentRevision && (
            <Alert
              type="info"
              showIcon
              title="正在查看历史修订的意见。当前资产评审状态不代表此历史修订的批准状态。"
              className="section-alert"
            />
          )}
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {data.opinions.map((opinion) => (
              <div className="review-opinion" key={opinion.id}>
                <Space
                  style={{ justifyContent: 'space-between', width: '100%' }}
                >
                  <Typography.Text type="secondary">
                    {new Date(opinion.createdAt).toLocaleString('zh-CN')} ·{' '}
                    {opinion.createdBy}
                  </Typography.Text>
                  {opinion.removedAt ? (
                    <Tag>已移除，历史保留</Tag>
                  ) : tester && data.isCurrentRevision ? (
                    <Button
                      danger
                      type="text"
                      icon={<DeleteOutlined />}
                      loading={pending}
                      onClick={() =>
                        void write(`opinions/${opinion.id}`, 'DELETE', {
                          commandId: crypto.randomUUID(),
                          rowVersion: opinion.rowVersion,
                        })
                      }
                    >
                      移除意见
                    </Button>
                  ) : null}
                </Space>
                <Typography.Paragraph className="preserve-lines">
                  {opinion.body}
                </Typography.Paragraph>
                {data.optimizationNotes
                  .filter((note) => note.opinionId === opinion.id)
                  .map((note) => (
                    <Alert
                      key={note.id}
                      type="info"
                      title="已登记的处理说明"
                      description={
                        <Space direction="vertical" size={4}>
                          <span className="preserve-lines">{note.note}</span>
                          {note.sourceOpinionRevisionId !==
                            note.targetRevisionId && (
                            <Typography.Text type="secondary">
                              来自历史意见的说明 · 来源修订{' '}
                              {note.sourceOpinionRevisionId.slice(0, 8)} →
                              目标修订 {note.targetRevisionId.slice(0, 8)}
                              ；不代表原意见移除或人工批准。
                            </Typography.Text>
                          )}
                        </Space>
                      }
                    />
                  ))}
              </div>
            ))}
            {data.optimizationNotes
              .filter(
                (note) =>
                  !data.opinions.some(
                    (opinion) => opinion.id === note.opinionId,
                  ),
              )
              .map((note) => (
                <Alert
                  key={note.id}
                  type="info"
                  title="历史意见的优化处理说明 · 仍待人工确认"
                  description={
                    <Space direction="vertical" size={4}>
                      <span className="preserve-lines">{note.note}</span>
                      <Typography.Text type="secondary">
                        来源修订 {note.sourceOpinionRevisionId.slice(0, 8)} →
                        本修订 {note.targetRevisionId.slice(0, 8)}；原意见{' '}
                        {note.opinionId.slice(0, 8)} 保留在原修订。
                      </Typography.Text>
                    </Space>
                  }
                />
              ))}
            {!data.opinions.length && (
              <Typography.Text type="secondary">
                此修订尚无评审意见。
              </Typography.Text>
            )}
          </Space>
          {tester && data.isCurrentRevision && (
            <>
              <Form
                form={opinionForm}
                layout="vertical"
                className="section-alert"
                onFinish={(values: { body: string }) => {
                  void write(
                    'opinions',
                    'POST',
                    {
                      commandId: crypto.randomUUID(),
                      targetRevisionId: revisionId,
                      body: values.body,
                    },
                    true,
                  ).then((saved) => {
                    if (saved) opinionForm.resetFields();
                  });
                }}
              >
                <Form.Item
                  name="body"
                  label="新增意见"
                  rules={[
                    {
                      required: true,
                      whitespace: true,
                      max: 10000,
                      message: '请输入具体评审意见',
                    },
                  ]}
                >
                  <Input.TextArea
                    rows={3}
                    maxLength={10000}
                    disabled={pending}
                  />
                </Form.Item>
                <Button
                  htmlType="submit"
                  icon={<PlusOutlined />}
                  loading={pending}
                >
                  保存意见
                </Button>
              </Form>
              {data.opinions.some((opinion) => !opinion.removedAt) && (
                <Form
                  form={noteForm}
                  layout="vertical"
                  onFinish={(values: { opinionId: string; note: string }) => {
                    void write('optimization-notes', 'POST', {
                      commandId: crypto.randomUUID(),
                      targetRevisionId: revisionId,
                      notes: [
                        { opinionId: values.opinionId, note: values.note },
                      ],
                    }).then((saved) => {
                      if (saved) noteForm.resetFields();
                    });
                  }}
                >
                  <Form.Item
                    name="opinionId"
                    label="对应的有效意见"
                    rules={[{ required: true, message: '请选择对应意见' }]}
                  >
                    <Select
                      disabled={pending}
                      options={data.opinions
                        .filter((opinion) => !opinion.removedAt)
                        .map((opinion) => ({
                          value: opinion.id,
                          label: opinion.body.slice(0, 100),
                        }))}
                    />
                  </Form.Item>
                  <Form.Item
                    name="note"
                    label="登记已有优化的处理说明"
                    rules={[
                      {
                        required: true,
                        whitespace: true,
                        max: 10000,
                        message: '请输入此意见的具体处理说明',
                      },
                    ]}
                  >
                    <Input.TextArea
                      rows={3}
                      disabled={pending}
                      maxLength={10000}
                    />
                  </Form.Item>
                  <Typography.Paragraph type="secondary">
                    此入口登记已有处理说明，不在此发起模型调用。登记后仍需人工批准，不会自动通过。
                  </Typography.Paragraph>
                  <Button htmlType="submit" loading={pending}>
                    登记处理说明
                  </Button>
                </Form>
              )}
            </>
          )}
        </>
      )}
    </Card>
  );
}
