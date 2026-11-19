import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Select, Space, Table } from 'antd';
import type { z } from 'zod';
import type { Asset } from '../../../packages/contracts/src/assets';
import {
  executionRecordListSchema,
  reportDetailSchema,
} from '../../../packages/contracts/src/ui-results';
import { api, describeError } from './api';

type RecordRow = z.infer<typeof executionRecordListSchema>['records'][number];
type Report = z.infer<typeof reportDetailSchema>['report'];

export function ApiCoverage({
  projectId,
  cases,
  assets,
  readyCaseIds,
  openScenario,
}: {
  projectId: string;
  cases: readonly Asset[];
  assets: readonly Asset[];
  readyCaseIds: ReadonlySet<string>;
  openScenario: (id: string) => void;
}) {
  const [rounds, setRounds] = useState<RecordRow[]>([]);
  const [selected, setSelected] = useState<string>();
  const [report, setReport] = useState<Report>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void api(
      `/projects/${projectId}/execution-records?kind=API&source=formal&pageSize=50`,
      { signal: controller.signal },
      executionRecordListSchema,
    )
      .then((response) => {
        if (!controller.signal.aborted)
          setRounds(response.records.filter((row) => row.reportId));
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(describeError(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [projectId]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    setError(undefined);
    setReport(undefined);
    void api(
      `/projects/${projectId}/reports/${selected}`,
      { signal: controller.signal },
      reportDetailSchema,
    )
      .then((response) => {
        if (!controller.signal.aborted && response.report.facts.kind === 'API')
          setReport(response.report);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(describeError(failure));
      });
    return () => controller.abort();
  }, [projectId, selected]);
  const currentReport = report?.id === selected ? report : undefined;
  const resultIds = new Set(
    currentReport?.facts.items.flatMap(({ result, scopeItem }) =>
      result && result.reportedOutcome !== 'notExecuted' && scopeItem.caseId
        ? [scopeItem.caseId]
        : [],
    ),
  );
  const groups = useMemo(() => {
    const grouped = new Map<string, Asset[]>();
    for (const item of cases) {
      if (!item.parentId) continue;
      const list = grouped.get(item.parentId) ?? [];
      list.push(item);
      grouped.set(item.parentId, list);
    }
    return [...grouped].map(([scenarioId, items]) => ({
      scenarioId,
      scenario:
        assets.find((asset) => asset.id === scenarioId)?.title ?? '原接口场景',
      items,
    }));
  }, [assets, cases]);
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Space wrap>
        <Select
          aria-label="覆盖矩阵的正式执行轮次"
          placeholder="选择正式回归轮次"
          style={{ minWidth: 235, maxWidth: '100%' }}
          loading={loading}
          allowClear
          value={selected}
          onChange={setSelected}
          options={rounds.map((item) => ({
            value: item.reportId!,
            label: `${item.name} · ${item.environment.name} · ${item.createdAt.slice(0, 16).replace('T', ' ')}`,
          }))}
        />
        {currentReport && (
          <Button
            href={`/#reports?projectId=${projectId}&reportId=${currentReport.id}`}
          >
            查看选定轮次报告
          </Button>
        )}
      </Space>
      {error && <Alert type="error" title={error} showIcon />}
      <Table
        size="small"
        rowKey="scenarioId"
        dataSource={groups}
        loading={Boolean(selected && !currentReport && !error)}
        locale={{ emptyText: '当前筛选没有关联用例。' }}
        columns={[
          {
            title: '验收场景',
            render: (_, row) => (
              <Button type="link" onClick={() => openScenario(row.scenarioId)}>
                {row.scenario}
              </Button>
            ),
          },
          { title: '已有用例', render: (_, row) => row.items.length },
          {
            title: '可回归',
            render: (_, row) =>
              row.items.filter((item) => readyCaseIds.has(item.id)).length,
          },
          {
            title: '轮次证据',
            render: (_, row) =>
              currentReport
                ? `${row.items.filter((item) => resultIds.has(item.id)).length} 条有结果`
                : '未选择轮次',
          },
        ]}
      />
    </Space>
  );
}
