import { useEffect, useState } from 'react';
import {
  Alert,
  Descriptions,
  Empty,
  Skeleton,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { z } from 'zod';
import {
  apiAttemptDetailSchema,
  apiResultTraceSchema,
} from '../../../packages/contracts/src/api-execution';
import { api, describeError } from './api';
import { ResultOutcomeTag } from './result-steps';

type Trace = z.infer<typeof apiResultTraceSchema>['attempts'];
type Attempt = z.infer<typeof apiAttemptDetailSchema>['attempt'];
const phases: Record<Trace[number]['phase'], string> = {
  auth: '鉴权准备',
  business: '业务请求',
  cleanupHttp: 'HTTP 清理',
  cleanupSql: 'SQL 清理',
};
const certainty = { known: '已知', unknown: '未知', notApplicable: '不适用' };
const stateLabel = {
  intent: '已记录发送意图',
  completed: '已完成',
  unknown: '结果未知',
  failed: '请求失败',
  skipped: '已跳过',
};
const labels: Record<string, string> = {
  status: 'HTTP 状态',
  response: '响应内容',
};
const renderValue = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2);

function attemptName(entry: Trace[number]) {
  if (entry.phase === 'auth') return '登录并获取 Token';
  return (
    entry.step_name ??
    (entry.phase === 'cleanupSql' ? '执行清理语句' : '已记录请求')
  );
}

function AssertionEvidence({ attempt }: { attempt: Attempt }) {
  const comparisons = attempt.assertions_safe.flatMap(
    ({ comparison, passed }) => (comparison ? [{ ...comparison, passed }] : []),
  );
  const statements = attempt.assertions_safe.filter(
    (assertion) => !assertion.comparison,
  );
  return (
    <div className="result-review-content">
      {comparisons.length ? (
        <Table
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={comparisons}
          scroll={{ x: 550 }}
          columns={[
            {
              title: '断言项',
              render: (_, row) => (
                <>
                  <code>{labels[row.field] ?? row.field}</code>{' '}
                  <span className="result-review-muted">{row.operator}</span>
                </>
              ),
            },
            {
              title: '预期',
              render: (_, row) => (
                <span className="result-review-lines">
                  {renderValue(row.expected)}
                </span>
              ),
            },
            {
              title: '实际',
              render: (_, row) => (
                <span className="result-review-lines">
                  {renderValue(row.actual)}
                </span>
              ),
            },
            {
              title: '结论',
              render: (_, row) => (
                <ResultOutcomeTag outcome={row.passed ? 'passed' : 'failed'} />
              ),
            },
          ]}
        />
      ) : null}
      {statements.length > 0 ? (
        <>
          {comparisons.length ? (
            <Typography.Text strong>原断言记录</Typography.Text>
          ) : null}
          <ul>
            {statements.map((check, index) => (
              <li key={index} className="result-review-lines">
                <ResultOutcomeTag
                  outcome={check.passed ? 'passed' : 'failed'}
                />
                {check.message}
              </li>
            ))}
          </ul>
        </>
      ) : comparisons.length === 0 ? (
        <Typography.Text type="secondary">本步骤没有存档断言。</Typography.Text>
      ) : null}
      {Object.keys(attempt.extractions_safe).length > 0 && (
        <div>
          <Typography.Text strong>提取结果</Typography.Text>
          <pre className="message-code">
            {JSON.stringify(attempt.extractions_safe, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

export function ApiResultTrace({
  projectId,
  runId,
  runItemId,
  initialStep,
}: {
  projectId: string;
  runId: string;
  runItemId: string;
  initialStep?: number | undefined;
}) {
  const [trace, setTrace] = useState<Trace | null>(null);
  const [error, setError] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<Attempt | null>(null);
  const [detailError, setDetailError] = useState<string>();
  const base = `/projects/${projectId}/api-executions/${runId}`;
  useEffect(() => {
    const controller = new AbortController();
    void api(
      `${base}/trace?runItemId=${encodeURIComponent(runItemId)}`,
      { signal: controller.signal },
      apiResultTraceSchema,
    )
      .then(({ attempts }) => {
        if (controller.signal.aborted) return;
        setTrace(attempts);
        setSelectedId(
          initialStep
            ? attempts[initialStep - 1]?.id
            : (attempts.find((item) => item.outcome === 'failed')?.id ??
                attempts[0]?.id),
        );
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(describeError(failure));
      });
    return () => controller.abort();
  }, [base, runItemId, initialStep]);
  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    setDetailError(undefined);
    if (!selectedId) return;
    void api(
      `${base}/attempts/${selectedId}`,
      { signal: controller.signal },
      apiAttemptDetailSchema,
    )
      .then(({ attempt }) => {
        if (!controller.signal.aborted) setDetail(attempt);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setDetailError(describeError(failure));
      });
    return () => controller.abort();
  }, [base, selectedId]);
  if (error)
    return (
      <Alert
        type="error"
        showIcon
        title="接口轨迹暂不可读"
        description={error}
      />
    );
  if (!trace) return <Skeleton active />;
  if (!trace.length)
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="没有已保存的请求或清理轨迹"
      />
    );
  const selected = trace.find((entry) => entry.id === selectedId);
  const attempt = detail?.id === selectedId ? detail : null;
  const request = attempt?.request_safe;
  const endpoint =
    request &&
    typeof request === 'object' &&
    !Array.isArray(request) &&
    typeof request.method === 'string' &&
    typeof request.url === 'string'
      ? `${request.method} ${request.url}`
      : selected?.phase === 'auth'
        ? undefined
        : selected?.step_id;
  return (
    <div className="result-review-layout">
      <aside className="result-review-panel" aria-label="接口执行顺序">
        <div className="result-review-header">
          <h3>接口执行顺序</h3>
          <small className="result-review-muted">{trace.length} 项</small>
        </div>
        <ol className="result-review-ordered">
          {trace.map((entry, index) => (
            <li key={entry.id}>
              <button
                type="button"
                className="result-review-step-button"
                aria-current={entry.id === selectedId ? 'step' : undefined}
                title={entry.step_id}
                onClick={() => setSelectedId(entry.id)}
              >
                <span className="result-review-step-number">{index + 1}</span>
                <span>
                  <strong>
                    {phases[entry.phase]} · {attemptName(entry)}
                  </strong>
                  <small className="result-review-muted">
                    {entry.status === null ? '' : `HTTP ${entry.status}`}
                    {entry.elapsed_ms === null
                      ? ''
                      : ` · ${entry.elapsed_ms} ms`}
                  </small>
                </span>
                {entry.outcome ? (
                  <ResultOutcomeTag outcome={entry.outcome} />
                ) : (
                  <Tag>{stateLabel[entry.state]}</Tag>
                )}
              </button>
            </li>
          ))}
        </ol>
      </aside>
      <section
        className="result-review-panel result-review-content"
        aria-label="接口请求响应和断言"
      >
        {!selected ? (
          <Alert
            type="warning"
            showIcon
            title="原链接指向的接口步骤没有留档"
            description="可从侧栏浏览已记录的接口轨迹。"
          />
        ) : (
          <>
            <div className="result-review-header">
              <div>
                <small className="result-review-muted">
                  {selected.phase.startsWith('cleanup')
                    ? '清理轨迹'
                    : phases[selected.phase]}
                </small>
                <h3 title={selected.step_id}>{attemptName(selected)}</h3>
              </div>
              {selected.outcome && (
                <ResultOutcomeTag outcome={selected.outcome} />
              )}
            </div>
            <div className="result-review-api-summary">
              <code>{endpoint}</code>
              <span>
                {selected.status === null
                  ? stateLabel[selected.state]
                  : `HTTP ${selected.status}`}
                {selected.elapsed_ms === null
                  ? ''
                  : ` · ${selected.elapsed_ms} ms`}
              </span>
            </div>
            {selected.reason && (
              <Alert
                type={
                  selected.outcome === 'failed' || selected.state === 'unknown'
                    ? 'warning'
                    : 'info'
                }
                title={selected.reason}
                showIcon
              />
            )}
            {detailError && <Alert type="error" showIcon title={detailError} />}
            {!attempt && !detailError && <Skeleton active />}
            {attempt && (
              <Tabs
                key={attempt.id}
                defaultActiveKey={
                  attempt.outcome === 'failed' ? 'assertions' : 'request'
                }
                items={[
                  {
                    key: 'request',
                    label: '请求',
                    children: (
                      <pre className="message-code">
                        {JSON.stringify(attempt.request_safe, null, 2)}
                      </pre>
                    ),
                  },
                  {
                    key: 'response',
                    label: '响应',
                    children: attempt.response_safe ? (
                      <div className="result-review-content">
                        <Descriptions
                          size="small"
                          column={2}
                          items={[
                            {
                              key: 'status',
                              label: 'HTTP 状态',
                              children:
                                attempt.response_safe.status ??
                                '没有 HTTP 状态',
                            },
                            {
                              key: 'elapsed',
                              label: '耗时',
                              children: `${attempt.response_safe.elapsedMs} ms`,
                            },
                            {
                              key: 'certainty',
                              label: '副作用确定性',
                              children:
                                certainty[attempt.side_effect_certainty],
                            },
                            {
                              key: 'error',
                              label: '错误码',
                              children: attempt.response_safe.errorCode ?? '—',
                            },
                          ]}
                        />
                        <div>
                          <Typography.Text strong>响应头</Typography.Text>
                          <pre className="message-code">
                            {JSON.stringify(
                              attempt.response_safe.headers,
                              null,
                              2,
                            )}
                          </pre>
                        </div>
                        <div>
                          <Typography.Text strong>响应正文</Typography.Text>
                          <pre className="message-code">
                            {JSON.stringify(
                              attempt.response_safe.body,
                              null,
                              2,
                            )}
                          </pre>
                        </div>
                      </div>
                    ) : (
                      <Typography.Text type="secondary">
                        未取得响应，副作用确定性：
                        {certainty[attempt.side_effect_certainty]}。
                      </Typography.Text>
                    ),
                  },
                  {
                    key: 'assertions',
                    label: '断言',
                    children: <AssertionEvidence attempt={attempt} />,
                  },
                ]}
              />
            )}
          </>
        )}
      </section>
    </div>
  );
}
