import { Button, Space, Table } from 'antd';
import type { ReportHandling } from '../../../packages/contracts/src/report-handling';
import {
  IssueStateTag,
  IssueSeverityTag,
  ProblemStateTag,
} from './semantic-status';
import { ResultOutcomeTag } from './result-steps';
import { BeijingTime } from './beijing-time';

export function ReportHandlingPanel({
  projectId,
  handling,
  label,
  factsCapturedAt,
}: {
  projectId: string;
  handling: ReportHandling;
  label: string;
  factsCapturedAt: string;
}) {
  const open = (kind: 'issue' | 'problem', id: string) => {
    window.location.hash = `issues?projectId=${encodeURIComponent(projectId)}&${kind === 'issue' ? 'issueId' : 'problemId'}=${encodeURIComponent(id)}`;
  };
  return (
    <section className="card pad report-handling-panel">
      <div className="between">
        <h3>{label}</h3>
        <span className="badge">业务处理</span>
      </div>
      <p className="caption">
        测试事实截取于 <BeijingTime value={factsCapturedAt} detail />
        ；本区处理信息截至 <BeijingTime value={handling.capturedAt} detail />
        。处理状态、合并关系和最新复测不改写原始判断、人工最终结论或结果统计；复测通过不自动关闭。
      </p>
      <div className="row wrap mt">
        <span className="badge amber">
          待确认问题 {handling.statistics.pendingProblemCount}
        </span>
        <span className="badge">
          已确认问题 {handling.statistics.confirmedProblemCount}
        </span>
        <span className="badge">
          已判非缺陷 {handling.statistics.dismissedProblemCount}
        </span>
        <span className="badge">正式缺陷 {handling.statistics.issueCount}</span>
        <span className="badge amber">
          未关闭 {handling.statistics.openIssueCount}
        </span>
        <span className="badge">
          合并从项 {handling.statistics.mergedIssueCount}
        </span>
      </div>
      <h3 className="mt">关联问题</h3>
      <Table
        size="small"
        rowKey="id"
        dataSource={handling.problems}
        pagination={{ pageSize: 10, hideOnSinglePage: true }}
        locale={{ emptyText: '没有与本轮结果关联的问题记录。' }}
        columns={[
          {
            title: '问题',
            render: (_, row) => (
              <Button type="link" onClick={() => open('problem', row.id)}>
                {row.title}
              </Button>
            ),
          },
          {
            title: '人工决定',
            render: (_, row) => <ProblemStateTag state={row.state} />,
          },
          {
            title: '关联正式缺陷',
            render: (_, row) => (
              <Space wrap>
                {row.issueIds.map((id) => (
                  <Button
                    size="small"
                    key={id}
                    onClick={() => open('issue', id)}
                  >
                    {handling.issues.find((issue) => issue.id === id)?.number ??
                      id.slice(0, 8)}
                  </Button>
                ))}
              </Space>
            ),
          },
        ]}
      />
      <h3 className="mt">关联正式缺陷</h3>
      <Table
        size="small"
        rowKey="id"
        dataSource={handling.issues}
        pagination={{ pageSize: 10, hideOnSinglePage: true }}
        locale={{
          emptyText:
            '没有与本轮结果关联的正式缺陷。待确认问题不会自动计为正式缺陷。',
        }}
        columns={[
          {
            title: '缺陷',
            render: (_, row) => (
              <div>
                <Button type="link" onClick={() => open('issue', row.id)}>
                  {row.number} · {row.title}
                </Button>
                <p className="caption">
                  <IssueSeverityTag severity={row.severity} />
                  {row.mergedIntoId ? ' · 合并从项，原记录保留' : ''}
                </p>
              </div>
            ),
          },
          {
            title: '处理状态',
            render: (_, row) => <IssueStateTag state={row.state} />,
          },
          {
            title: '负责人',
            render: (_, row) =>
              row.assignee
                ? `${row.assignee.displayName}${row.assignee.active ? '' : '（权限失效）'}`
                : '待认领',
          },
          {
            title: '最近复测（独立）',
            render: (_, row) =>
              row.latestVerification ? (
                <div>
                  <span>
                    <ResultOutcomeTag
                      outcome={row.latestVerification.outcome}
                    />{' '}
                    ·{' '}
                    {row.latestVerification.method === 'manual'
                      ? '人工'
                      : row.latestVerification.method}
                  </span>
                  <p className="caption">
                    <BeijingTime value={row.latestVerification.createdAt} />
                  </p>
                </div>
              ) : (
                '尚无复测记录'
              ),
          },
          {
            title: '关系',
            render: (_, row) => (
              <Space wrap>
                {row.mergedIntoId && (
                  <Button
                    size="small"
                    onClick={() => open('issue', row.mergedIntoId!)}
                  >
                    当前主项
                  </Button>
                )}
                {row.problemIds.map((id, index) => (
                  <Button
                    size="small"
                    key={id}
                    onClick={() => open('problem', id)}
                  >
                    来源问题 {index + 1}
                  </Button>
                ))}
              </Space>
            ),
          },
        ]}
      />
    </section>
  );
}
