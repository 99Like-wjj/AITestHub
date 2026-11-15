import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { z } from 'zod';
import {
  personalUsageSchema,
  platformUsageSchema,
  usageOriginScopeSchema,
} from '../../../packages/contracts/src/conversations';
import type { PersonalUsage } from '../../../packages/contracts/src/conversations';
import { api, describeError } from './api';
import {
  usageHeatmapLegend,
  usageHeatmapLevel,
  type UsageHeatmapScope,
} from './usage-heatmap';

type Origin = z.infer<typeof usageOriginScopeSchema>;
const originLabels = {
  liveProvider: '真实供应商通道',
  fixture: '隔离夹具',
  legacyUnknown: '历史来源未知',
  all: '全部来源（分别标识）',
};
const sourceLabels = {
  chat: '用户聊天',
  auxiliary: '用户触发辅助',
  background: '后台任务',
};
const count = (value: string | null | undefined) =>
  value === null || value === undefined
    ? '未记录'
    : BigInt(value).toLocaleString('zh-CN');

function Heatmap({
  days,
  scope,
}: {
  days: PersonalUsage['heatmap'];
  scope: UsageHeatmapScope;
}) {
  const calendar = useRef<HTMLDivElement>(null);
  const [focusedDate, setFocusedDate] = useState<string | null>(null);
  const afterCalendar = useRef<HTMLParagraphElement>(null);
  const first = days[0];
  const padding = first
    ? (new Date(`${first.date}T00:00:00Z`).getUTCDay() + 6) % 7
    : 0;
  const cells: (PersonalUsage['heatmap'][number] | null)[] = [
    ...Array.from({ length: padding }, () => null),
    ...days,
  ];
  while (cells.length % 7) cells.push(null);
  const weeks = Array.from({ length: cells.length / 7 }, (_, week) =>
    cells.slice(week * 7, week * 7 + 7),
  );
  return (
    <div className="usage-calendar-scroll">
      <Button
        size="small"
        type="link"
        onClick={() => afterCalendar.current?.focus()}
      >
        跳过日期区，查看用量表
      </Button>
      <div
        ref={calendar}
        className="usage-calendar"
        role="group"
        aria-label={`${scope === 'platform' ? '平台' : '个人'}最近365天Token年度热力图；上下键前后一天，左右键前后一周，Home/End到首末日期，Tab离开日期区`}
      >
        <div className="usage-day-labels">
          <span />
          <span>一</span>
          <span>二</span>
          <span>三</span>
          <span>四</span>
          <span>五</span>
          <span>六</span>
          <span>日</span>
        </div>
        {weeks.map((week, index) => (
          <div className="usage-week" key={index}>
            <span className="usage-month">
              {week
                .find((day) => day?.date.endsWith('-01'))
                ?.date.slice(5, 7)
                .replace(/^0/, '') ??
                (index === 0 ? first?.date.slice(5, 7).replace(/^0/, '') : '')}
            </span>
            {week.map((day, at) => {
              if (!day)
                return (
                  <span
                    className="usage-cell outside"
                    key={`outside-${at}`}
                    aria-hidden="true"
                  />
                );
              const level = usageHeatmapLevel(day.tokens, scope);
              const unknown =
                BigInt(day.unknown_calls) > 0n ||
                BigInt(day.unknown_request_intents) > 0n;
              const text = `${day.date}；${day.tokens === null ? (unknown ? 'Token未提供' : '无已记录模型Token') : `${count(day.tokens)} Token`}；确认请求 ${count(day.confirmed_requests)} 次；总用量未知记录 ${count(day.unknown_calls)}；发送结果未知意图 ${count(day.unknown_request_intents)}`;
              return (
                <Tooltip key={day.date} title={text}>
                  <span
                    className={`usage-cell level-${level}${unknown ? ' unknown' : ''}`}
                    tabIndex={
                      day.date ===
                      (focusedDate &&
                      days.some((item) => item.date === focusedDate)
                        ? focusedDate
                        : first?.date)
                        ? 0
                        : -1
                    }
                    onFocus={() => setFocusedDate(day.date)}
                    onKeyDown={(event) => {
                      const at = days.findIndex(
                        (item) => item.date === day.date,
                      );
                      const offset = {
                        ArrowUp: -1,
                        ArrowDown: 1,
                        ArrowLeft: -7,
                        ArrowRight: 7,
                      }[event.key];
                      const target =
                        event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? days.length - 1
                            : offset === undefined
                              ? null
                              : Math.max(
                                  0,
                                  Math.min(days.length - 1, at + offset),
                                );
                      if (target === null) return;
                      event.preventDefault();
                      const date = days[target]?.date;
                      if (date) {
                        setFocusedDate(date);
                        calendar.current
                          ?.querySelector<HTMLElement>(
                            `[data-usage-date="${date}"]`,
                          )
                          ?.focus();
                      }
                    }}
                    aria-label={text}
                    data-usage-date={day.date}
                  />
                </Tooltip>
              );
            })}
          </div>
        ))}
      </div>
      <Space wrap className="section-alert">
        <Typography.Text type="secondary">已记录 Token</Typography.Text>
        {usageHeatmapLegend(scope).map(({ level, label }) => (
          <Tooltip key={level} title={label} trigger={['hover', 'focus']}>
            <span
              className={`usage-cell level-${level}`}
              tabIndex={0}
              aria-label={label}
            />
          </Tooltip>
        ))}
        <Typography.Text type="secondary">
          灰格为零/无已记录Token；描边表示总量或发送意图未知。范围外留白不计日期。
        </Typography.Text>
      </Space>
      <p ref={afterCalendar} tabIndex={-1} className="caption">
        日期区结束。Tab 继续查看下方用量表。
      </p>
    </div>
  );
}

export function PersonalUsagePanel() {
  const [scope, setScope] = useState<Origin>('liveProvider');
  const [data, setData] = useState<PersonalUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  async function load(signal?: AbortSignal) {
    const epoch = ++generation.current;
    setLoading(true);
    try {
      const result = await api(
        `/me/usage?origin=${scope}`,
        signal ? { signal } : {},
        personalUsageSchema,
      );
      if (result.executionOriginScope !== scope)
        throw new Error('统计来源回执不匹配，请重新查询。');
      if (!signal?.aborted && epoch === generation.current) {
        setData(result);
        setError(undefined);
      }
    } catch (failure) {
      if (!signal?.aborted && epoch === generation.current) {
        setData(null);
        setError(describeError(failure));
      }
    } finally {
      if (!signal?.aborted && epoch === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    void load(controller.signal);
    return () => controller.abort();
  }, [scope]);
  const knownTotal =
    data?.models.reduce(
      (total, entry) =>
        total + (entry.tokens === null ? 0n : BigInt(entry.tokens)),
      0n,
    ) ?? 0n;
  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Space wrap>
        <Select
          aria-label="个人用量执行来源"
          value={scope}
          onChange={setScope}
          options={Object.entries(originLabels).map(([value, label]) => ({
            value,
            label,
          }))}
          style={{ minWidth: 220 }}
        />
        <Button
          icon={<ReloadOutlined />}
          loading={loading}
          onClick={() => void load()}
        >
          刷新本人用量
        </Button>
      </Space>
      <Typography.Paragraph type="secondary">
        最近 365 个自然日（含今天），北京时间。Token
        默认仅真实供应商通道，隔离夹具与历史未知来源单列。活跃天按本人主动发起的AI、辅助、UI领取、手动接口/调试/复测任务日期去重，不含浏览、普通资料编辑或定时自动运行；与Token筛选分开。请求数是确认调用原生
        HTTP 传输的次数，不代表供应商处理成功。
      </Typography.Paragraph>
      {error && <Alert type="error" showIcon title={error} />}
      {data && (
        <>
          <div className="usage-summary-grid">
            <Card size="small">
              <Typography.Text type="secondary">已记录总 Token</Typography.Text>
              <Typography.Title level={3}>
                {count(data.summary?.total_tokens)}
              </Typography.Title>
              <Typography.Text type="secondary">
                总用量未知 {count(data.summary?.unknown_calls)} 条；分项未知{' '}
                {count(data.summary?.component_unknown_calls)} 条
              </Typography.Text>
            </Card>
            <Card size="small">
              <Typography.Text type="secondary">确认请求次数</Typography.Text>
              <Typography.Title level={3}>
                {count(data.summary?.confirmed_requests)}
              </Typography.Title>
              <Typography.Text type="secondary">
                发送意图未知 {count(data.summary?.unknown_request_intents)}
                ；明确未发送 {count(data.summary?.not_dispatched_calls)}
              </Typography.Text>
            </Card>
            <Card size="small">
              <Typography.Text type="secondary">
                平台主动任务活跃天
              </Typography.Text>
              <Typography.Title level={3}>
                {count(data.summary?.active_days)}
              </Typography.Title>
              <Typography.Text type="secondary">
                已知最长平台AI/辅助任务{' '}
                {data.longestTaskPolicy ===
                  'worker-start-to-matching-terminal-event' &&
                data.summary?.longest_task_ms != null
                  ? `${count(data.summary.longest_task_ms)} 毫秒`
                  : data.longestTaskPolicy ===
                      'worker-start-to-matching-terminal-event'
                    ? '暂无可核时长'
                    : '统计口径尚未取得'}
              </Typography.Text>
              <Typography.Text type="secondary">
                {data.longestTaskPolicy ===
                'worker-start-to-matching-terminal-event'
                  ? `仅计算实际处理时长：${count(data.summary?.known_task_durations)}项已知、${count(data.summary?.unknown_task_durations)}项未知不计入最长、${count(data.summary?.not_started_tasks)}项未开始即已结束。排队和原任务结束后的人工等待不算入。`
                  : '当前服务未提供可核的开始/终态时长口径，请刷新至一致版本后查看；不推算未知时长。'}
              </Typography.Text>
            </Card>
          </div>
          <Card title="年度 Token 热力图" size="small">
            <Heatmap days={data.heatmap} scope="personal" />
          </Card>
          <Typography.Paragraph type="secondary">
            优先采用供应商 reported
            total；仅在缺总数且输入/输出均已知时回退相加。本范围回退{' '}
            {count(data.summary?.total_fallback_calls)} 条。输入已记录{' '}
            {count(data.summary?.input_tokens)}，输出已记录{' '}
            {count(data.summary?.output_tokens)}；未知不补零，套餐积分不是
            Token。
          </Typography.Paragraph>
          <Table
            size="small"
            rowKey={(entry) => `${entry.model_id}:${entry.source}`}
            dataSource={data.models}
            pagination={false}
            scroll={{ x: 720 }}
            locale={{ emptyText: '当前范围尚无模型调用记录。' }}
            columns={[
              { title: '模型', dataIndex: 'model_id' },
              {
                title: '来源',
                render: (_, entry) => sourceLabels[entry.source],
              },
              {
                title: '已记录 Token',
                dataIndex: 'tokens',
                render: (value: string | null) => count(value),
              },
              {
                title: '已知总额内占比',
                render: (_, entry) =>
                  entry.tokens === null || knownTotal === 0n
                    ? '—'
                    : `${(Number((BigInt(entry.tokens) * 10000n) / knownTotal) / 100).toFixed(2)}%`,
              },
              {
                title: '确认请求',
                dataIndex: 'calls',
                render: (value: string) => count(value),
              },
              {
                title: '总用量/分项未知',
                render: (_, entry) =>
                  `${count(entry.unknown_calls)} / ${count(entry.component_unknown_calls)}`,
              },
              {
                title: '发送意图未知',
                dataIndex: 'unknown_request_intents',
                render: (value: string) => count(value),
              },
            ]}
          />
          <Typography.Text type="secondary">
            模型与来源各行使用同一已记录总额作分母；未知 Token
            不被当作零参与份额。
          </Typography.Text>
          <Table
            size="small"
            rowKey="executionOrigin"
            dataSource={data.originBreakdown}
            pagination={false}
            columns={[
              {
                title: '执行来源',
                render: (_, entry) => originLabels[entry.executionOrigin],
              },
              {
                title: '账本记录',
                dataIndex: 'ledgerRows',
                render: (value: string) => count(value),
              },
              {
                title: '确认请求',
                dataIndex: 'confirmedRequests',
                render: (value: string) => count(value),
              },
              {
                title: '已记录Token',
                dataIndex: 'recordedTokens',
                render: (value: string | null) => count(value),
              },
            ]}
          />
        </>
      )}
    </Space>
  );
}

export function PlatformUsagePanel() {
  const [scope, setScope] = useState<Origin>('liveProvider');
  const [data, setData] = useState<z.infer<typeof platformUsageSchema> | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  async function load(signal?: AbortSignal) {
    const epoch = ++generation.current;
    setLoading(true);
    try {
      const result = await api(
        `/admin/usage?origin=${scope}`,
        signal ? { signal } : {},
        platformUsageSchema,
      );
      if (result.executionOriginScope !== scope)
        throw new Error('平台统计来源回执不匹配，请重新查询。');
      if (!signal?.aborted && epoch === generation.current) {
        setData(result);
        setError(undefined);
      }
    } catch (failure) {
      if (!signal?.aborted && epoch === generation.current) {
        setData(null);
        setError(describeError(failure));
      }
    } finally {
      if (!signal?.aborted && epoch === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    void load(controller.signal);
    return () => controller.abort();
  }, [scope]);
  const knownTotal =
    data?.byModel.reduce(
      (total, entry) =>
        total + (entry.tokens === null ? 0n : BigInt(entry.tokens)),
      0n,
    ) ?? 0n;
  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card
        title="平台 AI 使用监控"
        extra={
          <Button
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={() => void load()}
          >
            刷新统计
          </Button>
        }
      >
        <Select
          aria-label="平台用量执行来源"
          value={scope}
          onChange={setScope}
          options={Object.entries(originLabels).map(([value, label]) => ({
            value,
            label,
          }))}
          style={{ minWidth: 240 }}
        />
        <Typography.Paragraph type="secondary" className="section-alert">
          最近 365
          天，北京时间，按调用开始日期计量。管理员读取计量汇总，不读取用户私聊正文。默认不把隔离夹具/历史未知混为真实供应商调用。
        </Typography.Paragraph>
        {error && <Alert type="error" showIcon title={error} />}
        {data && (
          <>
            <Space wrap>
              <Tag>已记录 Token：{count(data.totals?.tokens)}</Tag>
              <Tag>确认请求：{count(data.totals?.calls)}</Tag>
              <Tag>总用量未知：{count(data.totals?.unknown_calls)}</Tag>
              <Tag>
                发送意图未知：{count(data.totals?.unknown_request_intents)}
              </Tag>
              <Tag>未发送：{count(data.totals?.not_dispatched_calls)}</Tag>
            </Space>
            <Card
              size="small"
              title="平台年度 Token 热力图"
              className="section-alert"
            >
              <Heatmap days={data.heatmap} scope="platform" />
            </Card>
            <Table
              size="small"
              rowKey={(entry) => `${entry.model_id}:${entry.source}`}
              dataSource={data.byModel}
              pagination={{ pageSize: 15 }}
              columns={[
                { title: '模型', dataIndex: 'model_id' },
                {
                  title: '归属来源',
                  render: (_, entry) => sourceLabels[entry.source],
                },
                {
                  title: '已记录Token',
                  dataIndex: 'tokens',
                  render: (value: string | null) => count(value),
                },
                {
                  title: '已知总额内占比',
                  render: (_, entry) =>
                    entry.tokens === null || knownTotal === 0n
                      ? '—'
                      : `${(Number((BigInt(entry.tokens) * 10000n) / knownTotal) / 100).toFixed(2)}%`,
                },
                {
                  title: '确认请求',
                  dataIndex: 'calls',
                  render: (value: string) => count(value),
                },
                {
                  title: '总量/分项未知',
                  render: (_, entry) =>
                    `${count(entry.unknown_calls)} / ${count(entry.component_unknown_calls)}`,
                },
              ]}
            />
            <Typography.Paragraph type="secondary">
              各模型与来源行按当前范围已记录总Token使用同一分母。供应商total优先，缺total且输入/输出均已知才回退；未知总量与分项分别记录。
            </Typography.Paragraph>
            <Table
              className="section-alert"
              rowKey="source"
              size="small"
              pagination={false}
              dataSource={data.bySource}
              columns={[
                {
                  title: '归属来源',
                  render: (_, entry) => sourceLabels[entry.source],
                },
                {
                  title: 'Token',
                  dataIndex: 'tokens',
                  render: (value: string | null) => count(value),
                },
                {
                  title: '确认请求',
                  dataIndex: 'calls',
                  render: (value: string) => count(value),
                },
                {
                  title: '未知总用量',
                  dataIndex: 'unknown_calls',
                  render: (value: string) => count(value),
                },
              ]}
            />
            <Table
              rowKey="user_id"
              size="small"
              dataSource={data.byUser}
              pagination={{ pageSize: 20 }}
              columns={[
                { title: '姓名', dataIndex: 'display_name' },
                { title: '账号', dataIndex: 'account' },
                {
                  title: '已记录 Token',
                  dataIndex: 'tokens',
                  render: (value: string | null) => count(value),
                },
                {
                  title: '确认请求',
                  dataIndex: 'calls',
                  render: (value: string) => count(value),
                },
                {
                  title: '未知总用量/发送意图',
                  render: (_, entry) =>
                    `${count(entry.unknown_calls)} / ${count(entry.unknown_request_intents)}`,
                },
              ]}
            />
          </>
        )}
      </Card>
    </Space>
  );
}
