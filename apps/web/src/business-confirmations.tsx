import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Collapse, Space, Tag, Typography } from 'antd';
import {
  businessConfirmationResponseSchema,
  listBusinessConfirmationsSchema,
  resolveBusinessConfirmationInputSchema,
} from '../../../packages/contracts/src/business-tools';
import type { BusinessConfirmation } from '../../../packages/contracts/src/business-tools';
import { api, ApiError, describeError } from './api';
import { idSchema } from '../../../packages/contracts/src/base';

const labels = {
  waitingConfirmation: '待本人决定',
  executing: '执行处理中',
  completed: '已返回处理结果',
  declined: '已拒绝',
  failed: '未完成',
  unknown: '结果未知，查原回执',
};
function sameOriginLink(value: string): string | null {
  try {
    const url = new URL(value, window.location.href);
    return ['http:', 'https:'].includes(url.protocol) &&
      url.origin === window.location.origin
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function BusinessConfirmationsPanel({
  taskId,
  confirmationId,
  refreshKey = 0,
  onResolved,
}: {
  taskId?: string;
  confirmationId?: string;
  refreshKey?: number;
  onResolved?: () => void;
}) {
  const [rows, setRows] = useState<BusinessConfirmation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [uncertainIds, setUncertainIds] = useState(new Set<string>());
  const generation = useRef(0);
  const scopeKey = `${taskId ?? ''}:${confirmationId ?? ''}`;
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  useEffect(() => setPendingId(null), [scopeKey]);
  async function load(signal?: AbortSignal) {
    const epoch = ++generation.current;
    setLoading(true);
    try {
      if (!taskId && !confirmationId) throw new Error('缺少原提案或任务标识。');
      const confirmations = confirmationId
        ? [
            (
              await api(
                `/me/business-confirmations/${confirmationId}`,
                signal ? { signal } : {},
                businessConfirmationResponseSchema,
              )
            ).confirmation,
          ]
        : (
            await api(
              `/me/business-confirmations?taskId=${taskId}`,
              signal ? { signal } : {},
              listBusinessConfirmationsSchema,
            )
          ).confirmations;
      if (!signal?.aborted && epoch === generation.current) {
        if (
          (taskId && confirmations.some((row) => row.taskId !== taskId)) ||
          (confirmationId &&
            confirmations.some((row) => row.id !== confirmationId))
        )
          throw new Error('提案关联任务不匹配，请保留原任务 ID 核对。');
        setRows(confirmations);
        setError(undefined);
        setUncertainIds(new Set());
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
    setUncertainIds(new Set());
    void load(controller.signal);
    return () => controller.abort();
  }, [taskId, confirmationId, refreshKey]);
  async function resolve(
    row: BusinessConfirmation,
    decision: 'accept' | 'decline',
  ) {
    const requestedScope = scopeKey;
    setPendingId(row.id);
    setError(undefined);
    try {
      const input = resolveBusinessConfirmationInputSchema.parse({
        scopeDigest: row.scopeDigest,
        decision,
      });
      const response = await api(
        `/me/business-confirmations/${row.id}/resolve`,
        { method: 'POST', body: input },
        businessConfirmationResponseSchema,
      );
      if (currentScope.current !== requestedScope) return;
      if (
        response.confirmation.id !== row.id ||
        response.confirmation.scopeDigest !== row.scopeDigest
      )
        throw new Error('提案回执范围不匹配，请只读查询原提案。');
      generation.current += 1;
      setLoading(false);
      setRows((previous) =>
        previous.map((entry) =>
          entry.id === row.id ? response.confirmation : entry,
        ),
      );
      onResolved?.();
    } catch (failure) {
      if (currentScope.current !== requestedScope) return;
      if (
        failure instanceof ApiError &&
        (failure.status === 0 || failure.status >= 500)
      )
        setUncertainIds((previous) => new Set([...previous, row.id]));
      setError(describeError(failure));
    } finally {
      if (currentScope.current === requestedScope) setPendingId(null);
    }
  }
  return (
    <Card
      size="small"
      title="本人业务提案与精确回执"
      loading={loading}
      extra={
        <Button onClick={() => void load()} disabled={pendingId !== null}>
          只读刷新提案
        </Button>
      }
    >
      {error && (
        <Alert
          type="warning"
          title={error}
          showIcon
          className="section-alert"
        />
      )}
      {!loading && !error && !rows.length && (
        <Typography.Text type="secondary">
          当前范围没有待确认或已保存的业务提案。
        </Typography.Text>
      )}
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {rows.map((row) => (
          <div className="business-proposal" key={row.id}>
            <Space wrap>
              <Tag>
                {row.toolName} / {row.op}
              </Tag>
              <Tag>{labels[row.status]}</Tag>
              <Typography.Text type="secondary">
                项目 {row.projectId ?? '无项目'} ·{' '}
                {new Date(row.createdAt).toLocaleString('zh-CN')}
              </Typography.Text>
            </Space>
            <Typography.Paragraph>{row.proposal.summary}</Typography.Paragraph>
            <Typography.Paragraph type="secondary">
              本提案 {row.id} · 精确摘要 {row.scopeDigest}
            </Typography.Paragraph>
            <Collapse
              items={[
                {
                  key: 'scope',
                  label: '核对精确对象、版本与影响',
                  children: (
                    <pre className="message-code">
                      {JSON.stringify(row.proposal.scope, null, 2)}
                    </pre>
                  ),
                },
                ...(row.response === null
                  ? []
                  : [
                      {
                        key: 'response',
                        label: '平台原处理回执（逐项状态以此为准）',
                        children: (
                          <pre className="message-code">
                            {JSON.stringify(row.response, null, 2)}
                          </pre>
                        ),
                      },
                    ]),
              ]}
            />
            {!!row.proposal.links.length && (
              <Space wrap className="section-alert">
                {row.proposal.links.map((link) => {
                  const safe = sameOriginLink(link);
                  return safe ? (
                    <a key={link} href={safe}>
                      查看本平台关联对象
                    </a>
                  ) : (
                    <Typography.Text key={link}>
                      关联链接当前不可打开
                    </Typography.Text>
                  );
                })}
              </Space>
            )}
            {uncertainIds.has(row.id) && (
              <Alert
                type="warning"
                showIcon
                title="本次决定的处理回执尚未确认，请刷新原提案；不要新建提案重放未知操作。"
                className="section-alert"
              />
            )}
            {row.status === 'waitingConfirmation' && (
              <Space className="section-alert">
                <Button
                  type="primary"
                  disabled={pendingId !== null || uncertainIds.has(row.id)}
                  loading={pendingId === row.id}
                  onClick={() => void resolve(row, 'accept')}
                >
                  本人确认此精确提案
                </Button>
                <Button
                  danger
                  disabled={pendingId !== null || uncertainIds.has(row.id)}
                  onClick={() => void resolve(row, 'decline')}
                >
                  拒绝此提案
                </Button>
              </Space>
            )}
            {(row.status === 'unknown' || row.status === 'failed') && (
              <Typography.Paragraph type="secondary">
                恢复指引：{row.recovery}
              </Typography.Paragraph>
            )}
          </div>
        ))}
      </Space>
    </Card>
  );
}

export function BusinessConfirmationPage() {
  const [confirmationId, setConfirmationId] = useState<string | null>(() => {
    const parsed = idSchema.safeParse(
      new URLSearchParams(window.location.hash.split('?')[1]).get(
        'confirmationId',
      ),
    );
    return parsed.success ? parsed.data : null;
  });
  useEffect(() => {
    function update() {
      const parsed = idSchema.safeParse(
        new URLSearchParams(window.location.hash.split('?')[1]).get(
          'confirmationId',
        ),
      );
      setConfirmationId(parsed.success ? parsed.data : null);
    }
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        title="以当前登录账号核对本人提案"
        description="请先核对服务端保存的精确对象、版本与影响。决定会按当前权限处理；模型和官方 MCP 的调用凭据不能代替本人的网页决定。"
      />
      {confirmationId ? (
        <BusinessConfirmationsPanel
          key={confirmationId}
          confirmationId={confirmationId}
        />
      ) : (
        <Alert type="warning" title="链接缺少有效的原提案标识。" showIcon />
      )}
    </Space>
  );
}
