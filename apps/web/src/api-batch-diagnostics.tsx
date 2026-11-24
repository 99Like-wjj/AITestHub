import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Modal, Select, Space, Tag } from 'antd';
import type { ApiProjectCase } from '../../../packages/contracts/src/api-automation';
import {
  debugStartReceiptSchema,
  debugTraceSchema,
  startDebugInputSchema,
} from '../../../packages/contracts/src/api-execution';
import {
  testConfigurationListSchema,
  type TestConfigurationView,
} from '../../../packages/contracts/src/test-configuration';
import { api, ApiError, describeError, isUncertainMutationError } from './api';

interface BatchRow {
  title: string;
  revisionNo: number;
  commandId: string;
  runId?: string;
  state:
    'pending' | 'submitting' | 'running' | 'passed' | 'failed' | 'unconfirmed';
  detail?: string;
  dataRows?: { id: string; name: string; outcome: string }[];
}

const terminal = new Set([
  'completed',
  'partial',
  'failed',
  'cancelled',
  'stopped',
]);
const labels: Record<BatchRow['state'], string> = {
  pending: '等待发送',
  submitting: '正在提交',
  running: '正在诊断',
  passed: '通过',
  failed: '未通过',
  unconfirmed: '待核对原回执',
};

export function ApiBatchDiagnostics({
  projectId,
  cases,
}: {
  projectId: string;
  cases: readonly ApiProjectCase[];
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [environmentId, setEnvironmentId] = useState<string>();
  const [environments, setEnvironments] = useState<TestConfigurationView[]>([]);
  const [results, setResults] = useState<BatchRow[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const runningRef = useRef(false);
  const epoch = useRef(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void api(
      `/projects/${projectId}/test-configuration?kind=environment`,
      { signal: controller.signal },
      testConfigurationListSchema,
    )
      .then((result) => {
        if (!controller.signal.aborted)
          setEnvironments(
            result.configurations.filter(
              (item) =>
                item.content.kind === 'environment' &&
                'active' in item.content &&
                item.content.active,
            ),
          );
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(describeError(failure));
      });
    return () => controller.abort();
  }, [open, projectId]);
  useEffect(
    () => () => {
      epoch.current++;
    },
    [projectId],
  );

  const candidates = cases.filter((item) => !item.removedAt);

  async function launch() {
    if (runningRef.current || !environmentId) return;
    const generation = epoch.current;
    const chosen = candidates.filter((item) => selected.includes(item.id));
    if (
      !chosen.length ||
      chosen.length > 20 ||
      chosen.length !== selected.length
    )
      return;
    setError(undefined);
    runningRef.current = true;
    setRunning(true);
    const journal = chosen.map(({ title, revisionNo }): BatchRow => ({
      title,
      revisionNo,
      commandId: crypto.randomUUID(),
      state: 'pending',
    }));
    const persist = (show: readonly BatchRow[]) => {
      if (epoch.current === generation) setResults([...show]);
    };
    persist(journal);
    try {
      for (let index = 0; index < chosen.length; index++) {
        if (epoch.current !== generation) return;
        const item = chosen[index];
        const row = journal[index];
        if (!item || !row) break;
        try {
          row.state = 'submitting';
          persist(journal);
          const input = startDebugInputSchema.parse({
            commandId: row.commandId,
            environmentId,
            sourceCaseId: item.id,
            sourceCaseRevisionId: item.revisionId,
            productBuild: null,
            content: item.content,
          });
          const accepted = await api(
            `/projects/${projectId}/api-executions/debug`,
            { method: 'POST', body: input },
            debugStartReceiptSchema,
          );
          row.runId = accepted.runId;
          row.state = 'running';
          persist(journal);
          let complete = false;
          for (
            let poll = 0;
            poll < 45 && epoch.current === generation;
            poll++
          ) {
            const trace = await api(
              `/projects/${projectId}/api-executions/${accepted.runId}/debug-result`,
              {},
              debugTraceSchema,
            );
            if (terminal.has(trace.state)) {
              complete = true;
              const passed = trace.facts.filter(
                (fact) => fact.originalOutcome === 'passed',
              ).length;
              row.state =
                trace.state === 'completed' &&
                passed === trace.scope.items.length
                  ? 'passed'
                  : 'failed';
              row.detail = `${passed}/${trace.scope.items.length} 个执行项通过`;
              const outcomes = new Map(
                trace.facts.map((fact) => [
                  fact.runItemId,
                  fact.originalOutcome,
                ]),
              );
              row.dataRows = trace.scope.items.map((item) => {
                const outcome = outcomes.get(item.runItemId);
                return {
                  id: item.runItemId,
                  name: item.dataRow?.name ?? '默认数据',
                  outcome:
                    outcome === 'passed'
                      ? '通过'
                      : outcome === 'failed'
                        ? '未通过'
                        : '未执行',
                };
              });
              break;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 1200));
          }
          if (!complete) {
            row.state = 'unconfirmed';
            row.detail = '请按运行 ID 查看原轮次状态';
            persist(journal);
            return;
          }
          persist(journal);
        } catch (failure) {
          const definite =
            !row.runId &&
            failure instanceof ApiError &&
            failure.status >= 400 &&
            failure.status < 500 &&
            failure.status !== 408 &&
            !isUncertainMutationError(failure);
          row.state = definite ? 'failed' : 'unconfirmed';
          row.detail = describeError(failure);
          persist(journal);
          if (!definite) return;
        }
      }
    } finally {
      runningRef.current = false;
      if (epoch.current === generation) setRunning(false);
    }
  }
  return (
    <>
      <Button
        disabled={!candidates.length}
        onClick={() => {
          setOpen(true);
          setError(undefined);
        }}
      >
        批量诊断
      </Button>
      <Modal
        title="同一环境批量诊断"
        open={open}
        footer={null}
        width={740}
        closable={!running}
        keyboard={!running}
        maskClosable={!running}
        onCancel={() => {
          if (!running) setOpen(false);
        }}
      >
        <Space orientation="vertical" style={{ width: '100%' }} size="middle">
          {error && <Alert type="error" showIcon title={error} />}
          <Select
            aria-label="批量诊断环境"
            placeholder="选择本次共同测试环境"
            style={{ width: '100%' }}
            disabled={running}
            value={environmentId ?? null}
            onChange={setEnvironmentId}
            options={environments.map((item) => ({
              value: item.id,
              label: item.content.name,
            }))}
          />
          <div className="api-batch-case-list">
            <Checkbox.Group
              value={selected}
              onChange={(values) => setSelected(values)}
              disabled={running}
            >
              <Space orientation="vertical">
                {candidates.map((item) => (
                  <Checkbox key={item.id} value={item.id}>
                    {item.title} · r{item.revisionNo}
                  </Checkbox>
                ))}
              </Space>
            </Checkbox.Group>
          </div>
          <div className="caption">
            最多选 20 条。逐个按已选修订和有效数据行发送实际调试请求。
          </div>
          <Button
            type="primary"
            loading={running}
            disabled={
              !environmentId || !selected.length || selected.length > 20
            }
            onClick={() => void launch()}
          >
            确认所选范围并诊断
          </Button>
          {results.length > 0 && (
            <ul className="api-batch-result-list" aria-live="polite">
              {results.map((row) => (
                <li key={row.commandId}>
                  <strong>
                    {row.title} · r{row.revisionNo}
                  </strong>
                  <Tag
                    color={
                      row.state === 'passed'
                        ? 'success'
                        : row.state === 'failed'
                          ? 'error'
                          : 'default'
                    }
                  >
                    {labels[row.state]}
                  </Tag>
                  {row.detail && <span>{row.detail}</span>}
                  {row.dataRows?.map((dataRow) => (
                    <span key={dataRow.id}>
                      {dataRow.name} · {dataRow.outcome}
                    </span>
                  ))}
                  {row.runId || row.state === 'unconfirmed' ? (
                    <a
                      href={
                        '/#api-regression?' +
                        new URLSearchParams({
                          projectId,
                          ...(row.runId
                            ? { debugRunId: row.runId }
                            : { debugCommandId: row.commandId }),
                        })
                      }
                    >
                      查看原诊断
                    </a>
                  ) : (
                    <small>{row.commandId}</small>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Space>
      </Modal>
    </>
  );
}
