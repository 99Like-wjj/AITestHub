import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Segmented,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { z } from 'zod';
import { uiDeliveryStatusSchema } from '../../../packages/contracts/src/ui-delivery';
import { api, describeError } from './api';

type Status = z.infer<typeof uiDeliveryStatusSchema>;
type Kind = Status['page']['kind'];
type Row = {
  key: string;
  label: string;
  state: string;
  detail: string;
  fileId?: string;
};
const tabs: { label: string; value: Kind }[] = [
  { label: '用例明细', value: 'items' },
  { label: '文件', value: 'files' },
  { label: '接收批次', value: 'batches' },
  { label: '执行阶段', value: 'facts' },
  { label: '待组装记录', value: 'descriptors' },
];
const date = (value: string | null) =>
  value
    ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    : '尚未上报';
const deliveryLabels = {
  notSubmitted: '尚未提交',
  receiving: '接收中',
  incomplete: '待补齐',
  complete: '完整',
};
function rows(data: Status, titles: Map<string, string>): Row[] {
  const page = data.page;
  switch (page.kind) {
    case 'items':
      return page.items.map((item) => ({
        key: item.runItemId,
        label:
          titles.get(item.runItemId) ?? `范围项 ${item.runItemId.slice(0, 8)}`,
        state: (
          {
            reported: '已收到明细',
            notReported: '尚未上报',
            pendingAssembly: '证据引用组装中',
          } as const
        )[item.status],
        detail: item.originalOutcome
          ? `原始上报：${({ passed: '通过', failed: '失败', blocked: '阻塞', inconclusive: '无法判断', notExecuted: '未执行' } as const)[item.originalOutcome]}`
          : '没有完整原始结果，不构造业务结论',
      }));
    case 'files':
      return page.items.map((item) => ({
        key: item.fileId,
        label: `${item.source === 'sourceJson' ? '原JSON' : item.source === 'both' ? '证据及原JSON' : '证据文件'} · ${item.fileId.slice(0, 8)}`,
        state: (
          {
            pending: '待上传',
            uploading: '上传中',
            verified: '已校验',
            failed: '上传失败',
            unavailable: '当前不可用',
          } as const
        )[item.status],
        detail: '原件通过当前项目权限下载；上传状态与业务结论独立',
        ...(item.status === 'verified' ? { fileId: item.fileId } : {}),
      }));
    case 'batches':
      return page.items.map((item) => ({
        key: item.id,
        label: `接收批次 ${item.batchId.slice(0, 12)}`,
        state: '已有原回执',
        detail: date(item.receivedAt),
        ...(item.sourceFileId ? { fileId: item.sourceFileId } : {}),
      }));
    case 'facts':
      return page.items.map((item) => ({
        key: item.id,
        label: item.kind === 'resume' ? '本地明确恢复' : '本地明确结束',
        state:
          item.kind === 'resume'
            ? '恢复记录'
            : (
                {
                  normal: '正常结束',
                  terminated: '提前结束',
                  interrupted: '中断',
                  legacy: '原历史结束',
                } as const
              )[item.endKind!],
        detail: `${date(item.kind === 'resume' ? item.resumedAt : item.endedAt)}${item.reason ? ` · ${item.reason}` : ''} · ${item.provenance === 'protocol-synthetic' ? '合成协议来源' : '保留上报来源'}`,
      }));
    case 'descriptors':
      return page.items.map((item) => ({
        key: item.id,
        label:
          titles.get(item.runItemId) ?? `范围项 ${item.runItemId.slice(0, 8)}`,
        state: (
          {
            pending: '尚未完整组装',
            assembled: '已形成完整原结果',
            superseded: '已有明确后续修正',
          } as const
        )[item.state],
        detail: `证据引用 ${item.receivedRefCount}/${item.expectedRefCount} · 已收片段 ${item.receivedSegmentCount}/${item.segmentCount}`,
      }));
  }
}

/** Read-only current delivery view. No button starts/resumes local UI execution. */
export function UiDeliveryPanel({
  projectId,
  runId,
  scopeItems = [],
}: {
  projectId: string;
  runId: string;
  scopeItems?: readonly { runItemId: string; content: { title: string } }[];
}) {
  const [kind, setKind] = useState<Kind>('items'),
    [data, setData] = useState<Status>(),
    [items, setItems] = useState<Row[]>([]),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [refresh, setRefresh] = useState(0);
  const epoch = useRef(0),
    pending = useRef(false);
  const titles = useMemo(
    () =>
      new Map(scopeItems.map((item) => [item.runItemId, item.content.title])),
    [scopeItems],
  );
  const titlesRef = useRef(titles);
  titlesRef.current = titles;
  const path = `/projects/${projectId}/ui-executions/${runId}/delivery`;
  useEffect(() => {
    const generation = ++epoch.current,
      abort = new AbortController();
    pending.current = false;
    setData(undefined);
    setItems([]);
    setError('');
    setBusy(true);
    void api(
      `${path}?${new URLSearchParams({ pageKind: kind, limit: '50' })}`,
      { signal: abort.signal },
      uiDeliveryStatusSchema,
    )
      .then((value) => {
        if (abort.signal.aborted || generation !== epoch.current) return;
        if (
          value.runId !== runId ||
          value.projectId !== projectId ||
          value.page.kind !== kind
        )
          throw Error('接收记录与当前执行范围不一致。');
        setData(value);
        setItems(rows(value, titlesRef.current));
      })
      .catch((failure) => {
        if (!abort.signal.aborted && generation === epoch.current)
          setError(describeError(failure));
      })
      .finally(() => {
        if (!abort.signal.aborted && generation === epoch.current)
          setBusy(false);
      });
    return () => abort.abort();
  }, [path, kind, refresh, projectId, runId]);
  async function more() {
    if (!data?.page.hasMore || !data.page.nextCursor || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    const generation = epoch.current,
      base = data;
    try {
      const value = await api(
        `${path}?${new URLSearchParams({ pageKind: kind, limit: '50', afterId: base.page.nextCursor! })}`,
        {},
        uiDeliveryStatusSchema,
      );
      if (generation !== epoch.current) return;
      if (
        value.runId !== runId ||
        value.projectId !== projectId ||
        value.page.kind !== kind
      )
        throw Error('接收记录与当前执行范围不一致。');
      if (
        value.ledgerVersion !== base.ledgerVersion ||
        value.ledgerDigest !== base.ledgerDigest ||
        value.headRowVersion !== base.headRowVersion ||
        value.rowVersion !== base.rowVersion ||
        value.missingFileCount !== base.missingFileCount ||
        value.deliveryStatus !== base.deliveryStatus
      ) {
        setNotice('接收记录已更新，已重新读取当前范围。');
        setRefresh((value) => value + 1);
        return;
      }
      setData(value);
      setItems((previous) => {
        const known = new Set(previous.map((item) => item.key));
        return [
          ...previous,
          ...rows(value, titlesRef.current).filter(
            (item) => !known.has(item.key),
          ),
        ];
      });
    } catch (failure) {
      if (generation === epoch.current) setError(describeError(failure));
    } finally {
      if (generation === epoch.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  }
  // Pure v1 histories retain their established UI; a GET never adopts v2 or creates a report.
  if (!error && (!data || data.mode === null)) return null;
  return (
    <Card
      size="small"
      title="当前结果接收与交付"
      extra={
        <Button
          size="small"
          icon={<ReloadOutlined />}
          loading={busy}
          onClick={() => setRefresh((value) => value + 1)}
        >
          刷新接收记录
        </Button>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {error && <Alert type="error" showIcon title={error} />}
        {notice && (
          <Alert
            type="info"
            showIcon
            title={notice}
            closable
            onClose={() => setNotice('')}
          />
        )}
        {data && (
          <>
            <Space wrap>
              <Tag>
                已接收 {data.reportedItems}/{data.totalItems} 项
              </Tag>
              <Tag>待组装 {data.pendingDescriptors} 项</Tag>
              <Tag>缺文件 {data.missingFileCount}</Tag>
              <Tag
                color={
                  data.deliveryStatus === 'complete' ? 'success' : 'default'
                }
              >
                交付{deliveryLabels[data.deliveryStatus]}
              </Tag>
            </Space>
            <Descriptions
              size="small"
              column={2}
              items={[
                {
                  key: 'end',
                  label: '最近结束记录',
                  children: data.lastEndFact
                    ? `${data.lastEndFact.endKind === 'legacy' ? '原历史结束' : data.lastEndFact.endKind === 'normal' ? '本地上报正常结束' : data.lastEndFact.endKind === 'terminated' ? '本地上报提前结束' : '本地上报中断'} · ${date(data.lastEndFact.endedAt)}`
                    : '尚无明确结束记录',
                },
                {
                  key: 'seal',
                  label: '明细范围核对',
                  children: data.latestSeal ? '已按固定范围封账' : '尚未封账',
                },
                {
                  key: 'progress',
                  label: '最近本地进度',
                  children: `${data.completedItems}/${data.totalItems}；序号 ${data.progressSequence}`,
                },
                {
                  key: 'batch',
                  label: '接收批次',
                  children: `${data.batchCount} 批`,
                },
              ]}
            />
            <Typography.Text type="secondary">
              接收数据、执行结束和交付完整性分别记录。这里读取当前记录，历史报告保存时的状态保持原样。需要补传时在原本地
              AI 执行中继续；平台不会远程启动浏览器。
            </Typography.Text>
            <Segmented
              size="small"
              value={kind}
              options={tabs}
              onChange={(value) => {
                setKind(value);
                setNotice('');
              }}
            />
            <Table<Row>
              size="small"
              rowKey="key"
              dataSource={items}
              pagination={false}
              scroll={{ x: 650 }}
              columns={[
                { title: '条目', dataIndex: 'label', width: 230 },
                { title: '当前记录', dataIndex: 'state', width: 150 },
                {
                  title: '说明',
                  render: (_, row) => (
                    <Space direction="vertical" size={2}>
                      <span>{row.detail}</span>
                      {row.fileId && (
                        <a
                          href={`/api/v1/files/${row.fileId}/content`}
                          download
                        >
                          下载原件
                        </a>
                      )}
                    </Space>
                  ),
                },
              ]}
            />
            {data.page.hasMore && (
              <Button size="small" loading={busy} onClick={() => void more()}>
                读取更多{tabs.find((tab) => tab.value === kind)?.label}
              </Button>
            )}
          </>
        )}
      </Space>
    </Card>
  );
}
