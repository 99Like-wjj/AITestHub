import { useEffect, useState } from 'react';
import { Alert, Button, Card, Empty, Select, Table, Tag } from 'antd';
import type { z } from 'zod';
import type { Asset } from '../../../packages/contracts/src/assets';
import {
  executionRecordListSchema,
  reportDetailSchema,
} from '../../../packages/contracts/src/ui-results';
import { api, describeError } from './api';

type Report = z.infer<typeof reportDetailSchema>['report'];
type Records = z.infer<typeof executionRecordListSchema>;
const outcomes: Record<string, string> = {
  passed: '通过',
  failed: '失败',
  blocked: '阻塞',
  inconclusive: '无法判断',
  notExecuted: '未执行',
};

export function AssetCoverage({
  projectId,
  versionId,
  kind,
  assets,
  scenarioTitles,
  onCase,
}: {
  projectId: string;
  versionId: string;
  kind: 'UI' | 'API';
  assets: Asset[];
  scenarioTitles: Map<string, string>;
  onCase: (asset: Asset) => void;
}) {
  const [recent, setRecent] = useState<Records>();
  const [reportId, setReportId] = useState<string>();
  const [report, setReport] = useState<Report>();
  const [listError, setListError] = useState<string>();
  const [reportError, setReportError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    const search = new URLSearchParams({
      kind,
      source: 'formal',
      pageSize: '50',
    });
    setRecent(undefined);
    setListError(undefined);
    setReport(undefined);
    setReportId(undefined);
    void api(
      '/projects/' + projectId + '/execution-records?' + search,
      { signal: controller.signal },
      executionRecordListSchema,
    )
      .then((items) => {
        if (!controller.signal.aborted) setRecent(items);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setListError(describeError(error));
      });
    return () => controller.abort();
  }, [projectId, versionId, kind]);
  useEffect(() => {
    setReport(undefined);
    setReportError(undefined);
    if (!reportId) return;
    const controller = new AbortController();
    void api(
      '/projects/' + projectId + '/reports/' + reportId,
      { signal: controller.signal },
      reportDetailSchema,
    )
      .then(({ report }) => {
        if (!controller.signal.aborted) setReport(report);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setReportError(describeError(error));
      });
    return () => controller.abort();
  }, [projectId, reportId]);
  const cases = assets.filter(
    (asset) =>
      !asset.removedAt &&
      asset.targetType === 'case' &&
      asset.kind === kind &&
      asset.requirementVersionId === versionId,
  );
  const planRows = new Map(
    (report?.facts.items ?? [])
      .filter(
        (row) =>
          'approvalSnapshotId' in row.scopeItem &&
          row.scopeItem.requirementVersionId === versionId,
      )
      .map((row) => [row.scopeItem.caseId, row]),
  );
  return (
    <Card
      title="覆盖矩阵"
      extra={
        report && (
          <Button
            onClick={() => {
              window.location.hash =
                'reports?projectId=' + projectId + '&reportId=' + report.id;
            }}
          >
            查看正式报告
          </Button>
        )
      }
    >
      <Select
        aria-label="选择正式执行轮次"
        placeholder="从最近 50 轮正式执行选择报告"
        allowClear
        value={reportId}
        loading={!recent && !listError}
        onChange={setReportId}
        style={{ width: 'min(440px, 100%)' }}
        className="mb"
        options={
          recent?.records.flatMap((run) =>
            run.reportId
              ? [
                  {
                    value: run.reportId,
                    label:
                      run.name +
                      ' · ' +
                      run.environment.name +
                      ' · ' +
                      new Date(run.createdAt).toLocaleString('zh-CN'),
                  },
                ]
              : [],
          ) ?? []
        }
      />
      {listError && <Alert title={listError} type="error" showIcon />}
      {reportError && <Alert title={reportError} type="error" showIcon />}
      {report && planRows.size === 0 && (
        <Alert
          className="mb"
          title="这份正式报告未包含当前需求版本的用例"
          type="info"
          showIcon
        />
      )}
      {!cases.length ? (
        <Empty description="此版本暂无用例" />
      ) : (
        <Table<Asset>
          rowKey="id"
          size="small"
          dataSource={cases}
          pagination={{ pageSize: 20 }}
          columns={[
            {
              title: '场景',
              key: 'scenario',
              render: (_value, asset) =>
                scenarioTitles.get(asset.parentId ?? '') ?? '—',
            },
            {
              title: '用例',
              key: 'case',
              render: (_value, asset) => (
                <Button type="link" onClick={() => onCase(asset)}>
                  {asset.title}
                </Button>
              ),
            },
            {
              title: '需求依据',
              key: 'basis',
              render: (_value, asset) =>
                asset.content.basisRefs
                  .map((ref) => ref.description)
                  .join(' / ') || '未关联明确条款',
            },
            {
              title: '当前修订',
              key: 'revision',
              render: (_value, asset) => 'r' + asset.revisionNo,
            },
            {
              title: '批准情况',
              key: 'approval',
              render: (_value, asset) =>
                asset.reviewState === 'approved' ? (
                  <Tag color="success">当前已批准</Tag>
                ) : (
                  <Tag>待批准</Tag>
                ),
            },
            {
              title: '本轮结果',
              key: 'result',
              render: (_value, asset) => {
                if (!report) return '—';
                const row = planRows.get(asset.id);
                if (!row) return '未纳入本轮';
                return row.result
                  ? (outcomes[row.result.effectiveOutcome] ??
                      row.result.effectiveOutcome)
                  : '待提交';
              },
            },
          ]}
        />
      )}
    </Card>
  );
}
