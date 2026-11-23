import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Empty, Skeleton } from 'antd';
import { z } from 'zod';
import { projectOverviewSchema } from '../../../packages/contracts/src/overview';
import { api, describeError } from './api';
import { PageHeading } from './page-heading';
import { AppIcon } from './app-icon';
import type { Project } from './types';

export function OverviewLayout({
  project,
  stats,
  work,
  requirements,
  recent,
  onReview,
  onRequirements,
  onExecutions,
}: {
  project: Project;
  stats: ReactNode;
  work: ReactNode;
  requirements: ReactNode;
  recent: ReactNode;
  onReview: () => void;
  onRequirements: () => void;
  onExecutions: () => void;
}) {
  return (
    <div className="overview-page">
      <PageHeading
        eyebrow="PROJECT OVERVIEW"
        title="每次交付，都更有把握"
        description={`${project.name} · 从需求、评审到结果和缺陷，保持同一份业务依据。`}
        actions={
          <Button icon={<AppIcon name="check" />} onClick={onReview}>
            查看待评审
          </Button>
        }
      />
      <div className="stats mb">{stats}</div>
      <div className="two">
        <section className="card pad">
          <div className="between">
            <h2>我的工作台</h2>
            <span className="badge">当前账号</span>
          </div>
          {work}
        </section>
        <section className="card pad">
          <div className="between">
            <h2>我参与的需求</h2>
            <Button size="small" onClick={onRequirements}>
              全部需求
            </Button>
          </div>
          {requirements}
        </section>
      </div>
      <section className="card pad mt">
        <div className="between">
          <h2>最近执行</h2>
          <Button size="small" onClick={onExecutions}>
            查看执行与报告
          </Button>
        </div>
        {recent}
      </section>
    </div>
  );
}

export function OverviewLoadingStats() {
  return (
    <>
      {[
        ['进行中需求', '包含长期未活跃需求'],
        ['待评审用例', '按独立 UI / 接口资产统计'],
        ['尚需处理缺陷', '不含 AI 待确认问题'],
        ['执行记录', 'UI 与接口分别保留历史'],
      ].map(([label, caption]) => (
        <section className="card stat" aria-busy="true" key={label}>
          <label>{label}</label>
          <Skeleton.Input
            active
            size="small"
            style={{ width: 72, minWidth: 72, marginBlock: 9 }}
          />
          <p>{caption}</p>
        </section>
      ))}
    </>
  );
}

export function OverviewPage({ project }: { project: Project | null }) {
  const [data, setData] = useState<z.infer<
    typeof projectOverviewSchema
  > | null>(null);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const epoch = useRef(0);
  useEffect(() => {
    const controller = new AbortController(),
      generation = ++epoch.current;
    setData(null);
    setError(undefined);
    if (!project) return;
    setLoading(true);
    void api(
      `/projects/${project.id}/overview`,
      { signal: controller.signal },
      projectOverviewSchema,
    )
      .then((response) => {
        if (!controller.signal.aborted && generation === epoch.current) {
          if (response.projectId !== project.id)
            throw Error('概览项目范围不符。');
          setData(response);
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted && generation === epoch.current)
          setError(describeError(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted && generation === epoch.current)
          setLoading(false);
      });
    return () => controller.abort();
  }, [project?.id, refresh]);
  if (!project) return <Empty description="请先选择当前有效项目。" />;
  const go = (
    page: string,
    params: Record<string, string | undefined> = {},
  ) => {
    const query = new URLSearchParams({ projectId: project.id });
    for (const [key, value] of Object.entries(params))
      if (value !== undefined) query.set(key, value);
    window.location.hash = `${page}?${query}`;
  };
  const count = (value: number) => value.toLocaleString('zh-CN');
  const labels = { inProgress: '进行中', archived: '已归档' };
  const runLabels = {
    prepared: '已准备',
    queued: '排队中',
    running: '执行中',
    stopping: '终止中',
    completed: '已完成',
    terminated: '已终止',
    interrupted: '已中断',
    recoveryRequired: '需核对恢复',
  };
  const empty = loading ? (
    <Skeleton active paragraph={{ rows: 3 }} title={false} />
  ) : (
    <p className="caption mt">未取得概览资料。</p>
  );
  return (
    <>
      {error && (
        <Alert
          className="section-alert"
          type="error"
          title={error}
          showIcon
          action={
            <Button onClick={() => setRefresh((value) => value + 1)}>
              重新读取概览
            </Button>
          }
        />
      )}
      <OverviewLayout
        project={project}
        onReview={() =>
          go('cases', {
            review: 'unapproved',
            kind:
              data &&
              data.stats.pendingUiCases === 0 &&
              data.stats.pendingApiCases > 0
                ? 'API'
                : 'UI',
          })
        }
        onRequirements={() => go('requirements')}
        onExecutions={() => go('reports')}
        stats={
          data ? (
            [
              [
                '进行中需求',
                data.stats.ongoingRequirements,
                `含长期未活跃需求 ${count(data.stats.inactiveOngoingRequirements)}`,
              ],
              [
                '待评审用例',
                data.stats.pendingCases,
                `UI ${count(data.stats.pendingUiCases)} / 接口 ${count(data.stats.pendingApiCases)} · 独立资产`,
              ],
              ['尚需处理缺陷', data.stats.openIssues, '不含 AI 待确认问题'],
              [
                '执行记录',
                data.stats.executionRecords,
                'UI 与接口分别保留历史',
              ],
            ].map(([label, value, caption]) => (
              <section className="card stat" key={label}>
                <label>{label}</label>
                <strong>
                  {typeof value === 'number' ? count(value) : value}
                </strong>
                <p>{caption}</p>
                {label === '待评审用例' && (
                  <div className="row wrap">
                    <Button
                      size="small"
                      onClick={() =>
                        go('cases', { review: 'unapproved', kind: 'UI' })
                      }
                    >
                      UI {count(data.stats.pendingUiCases)}
                    </Button>
                    <Button
                      size="small"
                      onClick={() =>
                        go('cases', { review: 'unapproved', kind: 'API' })
                      }
                    >
                      接口 {count(data.stats.pendingApiCases)}
                    </Button>
                  </div>
                )}
              </section>
            ))
          ) : loading ? (
            <OverviewLoadingStats />
          ) : (
            ['进行中需求', '待评审用例', '尚需处理缺陷', '执行记录'].map(
              (label) => (
                <section className="card stat" key={label}>
                  <label>{label}</label>
                  <strong aria-label="尚未取得">—</strong>
                  <p>统计尚未取得</p>
                </section>
              ),
            )
          )
        }
        work={
          data
            ? [
                {
                  label: '待评审用例',
                  value: data.myWork.pendingCases,
                  page: 'cases',
                  params: { review: 'unapproved' },
                },
                {
                  label: 'AI 待确认问题',
                  value: data.myWork.pendingProblems,
                  page: 'issues',
                  params: { tab: 'problems', scope: 'all' },
                },
                {
                  label: '我负责的缺陷',
                  value: data.myWork.ownedOpenIssues,
                  page: 'issues',
                  params: { scope: 'mine', tab: 'formal' },
                },
                {
                  label: '结果待补传',
                  value: data.myWork.incompleteDeliveries,
                  page: 'reports',
                  params: {},
                },
              ].map((item) => (
                <div className="listrow" key={item.label}>
                  <span className="grow">{item.label}</span>
                  <b>{count(item.value)}</b>
                  <Button
                    className="iconbtn"
                    type="text"
                    aria-label={`查看${item.label}`}
                    icon={<AppIcon name="arrow" />}
                    onClick={() => go(item.page, item.params)}
                  />
                </div>
              ))
            : empty
        }
        requirements={
          data ? (
            <>
              {data.participatingRequirements.map((requirement) => (
                <div className="listrow" key={requirement.id}>
                  <div className="grow">
                    <b>{requirement.title}</b>
                    <p>
                      {requirement.businessNumber ?? requirement.id} · v
                      {requirement.latestVersionNo}
                      {requirement.archivedAt ? ' · 已归档' : ''}
                    </p>
                  </div>
                  <span
                    className={`badge ${requirement.lifecycle === 'archived' ? '' : requirement.inactive ? 'amber' : 'green'}`}
                  >
                    {requirement.lifecycle === 'inProgress' &&
                    requirement.inactive
                      ? '长期未活跃'
                      : labels[requirement.lifecycle]}
                  </span>
                  <Button
                    className="iconbtn"
                    type="text"
                    aria-label={`查看需求${requirement.title}`}
                    icon={<AppIcon name="arrow" />}
                    onClick={() =>
                      go('requirements', { requirementId: requirement.id })
                    }
                  />
                </div>
              ))}
              {data.participatingRequirementsTotal === 0 && (
                <p className="caption mt">
                  暂未参与需求，可由项目成员维护参与名单。
                </p>
              )}
              {data.participatingRequirementsTotal >
                data.participatingRequirements.length && (
                <p className="caption mt">
                  显示 {data.participatingRequirements.length} /{' '}
                  {count(data.participatingRequirementsTotal)}{' '}
                  项；完整名单见需求管理。
                </p>
              )}
            </>
          ) : (
            empty
          )
        }
        recent={
          data ? (
            <>
              {data.recentExecutions.map((run) => (
                <div className="listrow" key={run.runId}>
                  <span className="method">{run.kind}</span>
                  <div className="grow">
                    <b>{run.name}</b>
                    <p>
                      {run.runId} · {run.startedAt ? '开始于' : '创建于'}{' '}
                      {new Date(run.startedAt ?? run.createdAt).toLocaleString(
                        'zh-CN',
                      )}{' '}
                      · {run.environment.name}
                      {run.executionProvenance === 'protocol-synthetic'
                        ? ' · 合成协议结果，非真实 UI 执行'
                        : ''}
                    </p>
                  </div>
                  <span
                    className={`badge ${run.state === 'completed' ? 'green' : run.state === 'running' || run.state === 'stopping' ? 'blue' : ''}`}
                  >
                    {runLabels[run.state]}
                  </span>
                  <Button
                    size="small"
                    onClick={() =>
                      go(
                        'reports',
                        run.reportId
                          ? { reportId: run.reportId, kind: run.kind }
                          : { runId: run.runId, kind: run.kind },
                      )
                    }
                  >
                    {run.reportId ? '查看报告' : '查看进度'}
                  </Button>
                </div>
              ))}
              {data.recentExecutions.length === 0 && (
                <p className="caption mt">
                  尚无执行记录。UI 由本地 AI 发起，接口由平台按计划运行。
                </p>
              )}
            </>
          ) : (
            empty
          )
        }
      />
      {data && (
        <p className="caption mt">
          概览读取于 {new Date(data.capturedAt).toLocaleString('zh-CN')}
        </p>
      )}
    </>
  );
}
