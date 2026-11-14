import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Empty, Input, Select, Skeleton, Space } from 'antd';
import { z } from 'zod';
import {
  executionRecordListSchema,
  executionRecordSchema,
} from '../../../packages/contracts/src/ui-results';
import { runStateSchema } from '../../../packages/contracts/src/domain';
import { api, ApiError, describeError } from './api';
import type { Project } from './types';
import { ExecutionStopDialog, usePendingStops } from './execution-stop';
import type { StopTarget } from './execution-stop';
import {
  ProgressCloseDialog,
  usePendingProgressCloses,
} from './execution-progress-close';
import type { PendingProgressClose } from './execution-progress-close-state';

export type ExecutionRecord = z.infer<typeof executionRecordSchema>;
const states: Record<ExecutionRecord['state'], string> = {
  prepared: '已准备',
  queued: '排队中',
  running: '执行中',
  stopping: '终止中',
  completed: '已完成',
  terminated: '已终止',
  interrupted: '已中断',
  recoveryRequired: '需核对恢复',
};
const delivery: Record<ExecutionRecord['deliveryStatus'], string> = {
  notSubmitted: '尚未提交',
  receiving: '接收中',
  incomplete: '待补传',
  complete: '完整',
};
const source: Record<ExecutionRecord['source'], string> = {
  manual: '手工发起',
  scheduled: '定时回归',
  localUi: '本地 UI',
  retest: '直接复测',
};
const cleanup: Record<ExecutionRecord['cleanupState'], string> = {
  notConfigured: '未配置',
  pending: '待清理',
  running: '清理中',
  succeeded: '清理成功',
  failed: '清理失败',
  skipped: '已跳过',
  interrupted: '清理中断',
};
const counts = (value: string | number) =>
  BigInt(value).toLocaleString('zh-CN');
function progress(row: ExecutionRecord) {
  const denominator = BigInt(row.totalItems),
    done = BigInt(row.completedItems);
  return denominator === 0n
    ? 0
    : Number(
        ((done > denominator ? denominator : done) * 10000n) / denominator,
      ) / 100;
}

export function ExecutionRecords({
  project,
  userId,
  refreshKey,
  onReport,
  onRun,
}: {
  project: Project;
  userId: string;
  refreshKey: number;
  onReport: (id: string) => void;
  onRun: (id: string) => void;
}) {
  const [kind, setKind] = useState<'UI' | 'API'>(() =>
    new URLSearchParams(window.location.hash.split('?')[1]).get('kind') ===
    'API'
      ? 'API'
      : 'UI',
  );
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [composing, setComposing] = useState(false);
  const [state, setState] = useState<ExecutionRecord['state']>();
  const [mode, setMode] = useState<
    'original' | 'reported' | 'final' | 'effective'
  >('original');
  const [data, setData] = useState<z.infer<
    typeof executionRecordListSchema
  > | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const epoch = useRef(0);
  const queryScope = useRef('');
  const loadedScope = useRef('');
  const pendingStops = usePendingStops(userId, project.id);
  const [stopTarget, setStopTarget] = useState<StopTarget | null>(null);
  const pendingCloses = usePendingProgressCloses(userId, project.id);
  const [selected, setSelected] = useState<
    Map<string, { runId: string; rowVersion: number; name: string }>
  >(new Map());
  const [closeProgress, setCloseProgress] = useState<{
    session: string;
    targets: { runId: string; rowVersion: number; name?: string }[];
    recovery?: PendingProgressClose;
  } | null>(null);
  const blockedRuns = new Set(
    pendingCloses.flatMap((item) => item.items.map((target) => target.runId)),
  );
  useEffect(() => {
    setSelected(new Map());
    setCloseProgress(null);
  }, [project.id, userId, kind]);
  useEffect(() => {
    if (composing) return;
    const timer = window.setTimeout(() => {
      setPage(1);
      setQuery(search.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search, composing]);
  useEffect(() => {
    const controller = new AbortController(),
      generation = ++epoch.current;
    const scope = JSON.stringify([project.id, kind, page, query, state]);
    setLoading(true);
    if (queryScope.current !== scope) setData(null);
    queryScope.current = scope;
    setError(undefined);
    const params = new URLSearchParams({
      page: String(page),
      pageSize: '20',
      kind,
      search: query,
    });
    if (state) params.set('state', state);
    void api(
      `/projects/${project.id}/execution-records?${params}`,
      { signal: controller.signal },
      executionRecordListSchema,
    )
      .then((response) => {
        if (!controller.signal.aborted && generation === epoch.current) {
          setData(response);
          loadedScope.current = scope;
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted && generation === epoch.current) {
          const accessEnded =
            failure instanceof ApiError &&
            [401, 403, 404].includes(failure.status);
          if (accessEnded) {
            setData(null);
            loadedScope.current = '';
          }
          setError(
            `${describeError(failure)}${!accessEnded && loadedScope.current === scope ? '；下方保留上次读取结果，尚未取得最新进度。' : ''}`,
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && generation === epoch.current)
          setLoading(false);
      });
    return () => controller.abort();
  }, [project.id, kind, page, query, state, refresh, refreshKey]);
  useEffect(() => {
    if (
      loading ||
      !data?.records.some(
        (record) =>
          ![
            'completed',
            'terminated',
            'interrupted',
            'recoveryRequired',
          ].includes(record.state),
      )
    )
      return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible')
        setRefresh((value) => value + 1);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [data, loading]);
  return (
    <>
      <div className="between mb">
        <div className="segmented" aria-label="执行类型">
          {(['UI', 'API'] as const).map((value) => (
            <button
              type="button"
              className={`tab ${kind === value ? 'active' : ''}`}
              key={value}
              aria-pressed={kind === value}
              onClick={() => {
                setKind(value);
                setPage(1);
              }}
            >
              {value === 'UI' ? 'UI 自主测试' : '接口回归'}
            </button>
          ))}
        </div>
        <Button
          loading={loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          刷新
        </Button>
      </div>
      <div className="toolbar mb execution-filters">
        <Input
          className="searchbox"
          aria-label="搜索执行记录"
          placeholder="搜索计划、轮次或需求"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          allowClear
          maxLength={200}
        />
        <Select
          aria-label="执行状态筛选"
          placeholder="全部执行状态"
          value={state}
          allowClear
          onChange={(value: ExecutionRecord['state'] | undefined) => {
            setState(value);
            setPage(1);
          }}
          options={runStateSchema.options.map((value) => ({
            value,
            label: states[value],
          }))}
          style={{ minWidth: 150 }}
        />
        <span className="grow" />
        <span className="caption">结果口径</span>
        <Select
          aria-label="执行列表结果口径"
          value={mode}
          onChange={setMode}
          style={{ width: 160 }}
          options={[
            { value: 'original', label: '首次原始判断' },
            { value: 'reported', label: '当前采集判断' },
            { value: 'final', label: '人工最终结论' },
            { value: 'effective', label: '当前有效口径' },
          ]}
        />
      </div>
      {error && (
        <Alert type="error" title={error} showIcon className="section-alert" />
      )}
      {kind === 'UI' && project.roles.includes('tester') && (
        <div className="toolbar mb">
          <button
            type="button"
            className="btn small"
            disabled={
              loading ||
              !data?.records.some(
                (row) => row.kind === 'UI' && !blockedRuns.has(row.runId),
              )
            }
            onClick={() =>
              setSelected((previous) => {
                const next = new Map(previous);
                for (const row of data?.records ?? [])
                  if (
                    row.kind === 'UI' &&
                    !blockedRuns.has(row.runId) &&
                    next.size < 200
                  )
                    next.set(row.runId, {
                      runId: row.runId,
                      rowVersion: row.rowVersion,
                      name: row.name,
                    });
                return next;
              })
            }
          >
            选择本页 UI 轮次
          </button>
          <span className="caption">
            已选 {selected.size}/200 项；保留选择时的版本
          </span>
          <button
            type="button"
            className="btn small"
            disabled={!selected.size}
            onClick={() => setSelected(new Map())}
          >
            清空选择
          </button>
          <span className="grow" />
          <button
            type="button"
            className="btn small"
            disabled={
              !selected.size ||
              [...selected.keys()].some((id) => blockedRuns.has(id))
            }
            onClick={() =>
              setCloseProgress({
                session: crypto.randomUUID(),
                targets: [...selected.values()],
              })
            }
          >
            批量关闭平台进度
          </button>
        </div>
      )}
      {!!pendingCloses.length && (
        <div className="notice amber mb">
          {pendingCloses.map((record) => (
            <div className="row wrap" key={record.commandId}>
              <span className="grow caption">
                原平台进度关闭待核对 · {record.items.length} 项 ·{' '}
                {record.commandId}
              </span>
              <Button
                size="small"
                onClick={() =>
                  setCloseProgress({
                    session: crypto.randomUUID(),
                    targets: record.items,
                    recovery: record,
                  })
                }
              >
                查询原批次回执
              </Button>
            </div>
          ))}
        </div>
      )}
      {!!pendingStops.length && (
        <div className="notice amber mb">
          {pendingStops.map((record) => (
            <div className="row wrap" key={record.commandId}>
              <span className="grow caption">
                原接口停止操作待核对 · {record.commandId}
              </span>
              <Button
                size="small"
                onClick={() =>
                  setStopTarget({
                    runId: record.runId,
                    name: '原接口停止操作',
                    currentCase: null,
                    session: crypto.randomUUID(),
                    queryOnly: true,
                    commandId: record.commandId,
                  })
                }
              >
                查询原停止回执
              </Button>
            </div>
          ))}
        </div>
      )}
      {loading && !data && (
        <section className="card pad mb">
          <Skeleton active />
        </section>
      )}
      {data?.records.map((row) => {
        const statistics = row.statistics?.[mode];
        return (
          <section className="card pad mb" key={row.runId}>
            <div className="between">
              {kind === 'UI' &&
                row.kind === 'UI' &&
                project.roles.includes('tester') && (
                  <input
                    type="checkbox"
                    aria-label={`选择 UI 轮次 ${row.name}`}
                    checked={selected.has(row.runId)}
                    disabled={
                      blockedRuns.has(row.runId) ||
                      (!selected.has(row.runId) && selected.size >= 200)
                    }
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setSelected((previous) => {
                        const next = new Map(previous);
                        if (checked && next.size < 200)
                          next.set(row.runId, {
                            runId: row.runId,
                            rowVersion: row.rowVersion,
                            name: row.name,
                          });
                        else next.delete(row.runId);
                        return next;
                      });
                    }}
                  />
                )}
              <div className="grow">
                <h2>{row.name}</h2>
                <p className="caption">
                  {row.runId} · {source[row.source]} ·{' '}
                  {new Date(row.startedAt ?? row.createdAt).toLocaleString(
                    'zh-CN',
                  )}{' '}
                  · {row.environment.name}
                </p>
              </div>
              <div className="row wrap">
                <span
                  className={`badge ${row.state === 'completed' ? 'green' : row.state === 'running' || row.state === 'stopping' ? 'blue' : ''}`}
                >
                  {states[row.state]}
                </span>
                {row.kind === 'API' &&
                  (row.state === 'running' || row.state === 'stopping') && (
                    <Button
                      danger
                      disabled={
                        !project.roles.includes('tester') ||
                        row.state === 'stopping'
                      }
                      onClick={() =>
                        setStopTarget({
                          runId: row.runId,
                          name: row.name,
                          currentCase: row.currentCase?.title ?? null,
                          session: crypto.randomUUID(),
                        })
                      }
                    >
                      停止后续用例
                    </Button>
                  )}
                <Button
                  onClick={() =>
                    row.reportId ? onReport(row.reportId) : onRun(row.runId)
                  }
                >
                  {row.reportId ? '查看报告' : '查看进度'}
                </Button>
              </div>
            </div>
            <div className="row wrap mt">
              <span className="caption">
                已完成 {counts(row.completedItems)}/{counts(row.totalItems)}
              </span>
              {statistics ? (
                <>
                  <span className="badge green">
                    通过 {counts(statistics.passed)}
                  </span>
                  <span className="badge red">
                    失败 {counts(statistics.failed)}
                  </span>
                  <span className="badge amber">
                    未执行 {counts(statistics.notExecuted)}
                  </span>
                  {BigInt(statistics.blocked) > 0n && (
                    <span className="badge amber">
                      阻塞 {counts(statistics.blocked)}
                    </span>
                  )}
                  {BigInt(statistics.inconclusive) > 0n && (
                    <span className="badge">
                      无法判断 {counts(statistics.inconclusive)}
                    </span>
                  )}
                  {'notAssessed' in statistics &&
                    BigInt(statistics.notAssessed) > 0n && (
                      <span className="badge">
                        未人工评估 {counts(statistics.notAssessed)}
                      </span>
                    )}
                </>
              ) : (
                <span className="caption">尚未提交结果，进度不作为结论。</span>
              )}
              <span className="grow" />
              <span
                className={`badge ${row.deliveryStatus === 'complete' ? 'green' : row.deliveryStatus === 'incomplete' ? 'amber' : ''}`}
              >
                {delivery[row.deliveryStatus]}
              </span>
            </div>
            {row.kind === 'UI' && row.progressClosedAt ? (
              <p className="caption mt">
                平台进度展示已关闭 ·{' '}
                {new Date(row.progressClosedAt).toLocaleString('zh-CN')}。本地
                AI 未因此停止，结果与后续上报仍保留。
              </p>
            ) : (
              <div
                className="progress mt"
                role="progressbar"
                aria-label={`${row.name}执行进度`}
                aria-valuenow={progress(row)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <span style={{ width: `${progress(row)}%` }} />
              </div>
            )}
            <div className="row wrap mt">
              <span className="caption">
                创建人 {row.createdBy.name}
                {!row.createdBy.active ? '（当前账号已停用）' : ''}
              </span>
              {row.productBuild && (
                <span className="caption">被测版本 {row.productBuild}</span>
              )}
              <span className="caption">
                {row.requirementPreview
                  .map(
                    (requirement) =>
                      `${requirement.title} v${requirement.versionNo}`,
                  )
                  .join('、')}
                {BigInt(row.requirementCount) >
                BigInt(row.requirementPreview.length)
                  ? ` 等 ${counts(row.requirementCount)} 项需求`
                  : ''}
              </span>
              {row.kind === 'API' && (
                <span className="caption">
                  清理：{cleanup[row.cleanupState]}
                </span>
              )}
              {row.durationMs !== null && (
                <span className="caption">
                  耗时{' '}
                  {row.durationMs < 1000
                    ? `${row.durationMs} 毫秒`
                    : `${(row.durationMs / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} 秒`}
                </span>
              )}
            </div>
            {row.executionProvenance === 'protocol-synthetic' && (
              <p className="caption mt">
                合成协议结果，未代表真实 UI 目标执行。
              </p>
            )}
            {row.executionProvenance === 'unknown' && (
              <p className="caption mt">执行来源未核实，需结合实际证据判断。</p>
            )}
            {row.currentCase && (
              <p className="caption mt">
                当前用例：{row.currentCase.title}
                {row.state === 'stopping'
                  ? '；按原策略完成当前用例及清理后停止后续用例。'
                  : ''}
              </p>
            )}
            {row.deliveryStatus === 'incomplete' && (
              <div className="notice amber mt">
                业务结论保留；已提交结果 {counts(row.reportedItems)}/
                {counts(row.totalItems)}，缺失文件{' '}
                {counts(row.missingFileCount)}。
                {row.reportId && (
                  <Button size="small" onClick={() => onReport(row.reportId!)}>
                    查看补传与证据缺口
                  </Button>
                )}
              </div>
            )}
            {(BigInt(row.invalidResultCount) > 0n ||
              BigInt(row.assessmentBasisChangedCount) > 0n) && (
              <p className="caption mt">
                结果结构异常 {counts(row.invalidResultCount)} ·
                人工结论基准已变化 {counts(row.assessmentBasisChangedCount)}
                ，请核对逐项事实。
              </p>
            )}
          </section>
        );
      })}
      {!loading && data?.records.length === 0 && (
        <section className="card pad mb">
          <Empty description="此范围没有执行记录。UI 由本地 AI 发起，接口由平台按计划运行。" />
        </section>
      )}
      {data && (
        <div className="between mt">
          <span className="caption">
            第 {data.page} 页 · 共 {counts(data.total)} 条
          </span>
          <Space>
            <Button
              disabled={loading || page === 1}
              onClick={() => setPage((value) => value - 1)}
            >
              上一页
            </Button>
            <Button
              disabled={loading || !data.hasMore || page >= 1000000}
              onClick={() => setPage((value) => value + 1)}
            >
              下一页
            </Button>
          </Space>
        </div>
      )}
      {stopTarget && (
        <ExecutionStopDialog
          key={stopTarget.session}
          userId={userId}
          projectId={project.id}
          target={stopTarget}
          onClose={() => setStopTarget(null)}
          onAcknowledged={() => setRefresh((value) => value + 1)}
        />
      )}
      {closeProgress && (
        <ProgressCloseDialog
          key={closeProgress.session}
          userId={userId}
          projectId={project.id}
          targets={closeProgress.targets}
          {...(closeProgress.recovery
            ? { recovery: closeProgress.recovery }
            : {})}
          onClose={() => setCloseProgress(null)}
          onChanged={() => {
            setSelected(new Map());
            setRefresh((value) => value + 1);
          }}
        />
      )}
    </>
  );
}
