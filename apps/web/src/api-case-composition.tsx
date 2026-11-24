import { useState, type Key } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Input,
  Modal,
  Select,
  Space,
  Table,
} from 'antd';
import { z } from 'zod';
import {
  apiDataRowSchema,
  apiPreparationReferenceSchema,
  type ApiCaseContent,
} from '../../../packages/contracts/src/domain';
import type { ApiProjectCase } from '../../../packages/contracts/src/api-automation';
import { describeError } from './api';
import {
  apiImportMatches,
  applyApiDataImport,
  defaultApiImportChoices,
  exportApiDataRows,
  parseApiDataImport,
  type ApiImportChoice,
  type ApiImportMapping,
} from './api-import';

const settings = z.strictObject({
  dataRows: z
    .array(apiDataRowSchema)
    .max(100)
    .refine(
      (rows) => new Set(rows.map((row) => row.id)).size === rows.length,
      '数据行标识不可重复',
    ),
  preparations: z.array(apiPreparationReferenceSchema).max(20),
});

export function ApiCaseComposition({
  value,
  cases,
  disabled,
  onApply,
}: {
  value: ApiCaseContent;
  cases: readonly Pick<
    ApiProjectCase,
    'id' | 'title' | 'revisionId' | 'revisionNo'
  >[];
  disabled: boolean;
  onApply: (data: Pick<ApiCaseContent, 'dataRows' | 'preparations'>) => void;
}) {
  const [rows, setRows] = useState(
    JSON.stringify(value.dataRows ?? [], null, 2),
  );
  const [preparations, setPreparations] = useState(
    JSON.stringify(value.preparations ?? [], null, 2),
  );
  const [issue, setIssue] = useState<string>();
  const [dirty, setDirty] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importPreview, setImportPreview] =
    useState<ReturnType<typeof parseApiDataImport>>();
  const [importIssue, setImportIssue] = useState<string>();
  const [importMapping, setImportMapping] = useState<ApiImportMapping>({});
  const [importChoices, setImportChoices] = useState<ApiImportChoice[]>([]);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  let rowPreview: z.output<typeof settings.shape.dataRows> = [];
  try {
    const result = settings.shape.dataRows.safeParse(JSON.parse(rows));
    if (result.success) rowPreview = result.data;
  } catch {
    // The raw JSON draft remains editable and is validated on Apply.
  }
  const selectedCount = rowPreview.filter((row) =>
    selectedRows.includes(row.id),
  ).length;
  function bulk(action: 'enable' | 'disable' | 'remove') {
    if (disabled || selectedCount === 0) return;
    const selection = new Set(selectedRows);
    const next =
      action === 'remove'
        ? rowPreview.filter((row) => !selection.has(row.id))
        : rowPreview.map((row) =>
            selection.has(row.id)
              ? { ...row, enabled: action === 'enable' }
              : row,
          );
    setRows(JSON.stringify(next, null, 2));
    setSelectedRows([]);
    setDirty(true);
    setIssue(undefined);
  }
  function exportRows(format: 'JSON' | 'CSV') {
    if (!rowPreview.length) return;
    const type = format === 'JSON' ? 'application/json' : 'text/csv';
    const url = URL.createObjectURL(
      new Blob([exportApiDataRows(rowPreview, format)], { type }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'api-data-rows.' + format.toLowerCase();
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const resetImport = () => {
    setImportOpen(false);
    setImportText('');
    setImportPreview(undefined);
    setImportIssue(undefined);
    setImportMapping({});
    setImportChoices([]);
  };
  const importRows = () => {
    if (disabled) return;
    try {
      const current = settings.shape.dataRows.parse(JSON.parse(rows));
      if (importPreview) {
        const next = applyApiDataImport(
          current,
          importPreview.rows,
          importMapping,
          importChoices,
        );
        setRows(JSON.stringify(next, null, 2));
        setDirty(true);
        resetImport();
      } else {
        const parsed = parseApiDataImport(importText);
        setImportPreview(parsed);
        setImportMapping(
          Object.fromEntries(parsed.sourceKeys.map((key) => [key, key])),
        );
        setImportChoices(defaultApiImportChoices(parsed.rows, current));
        setImportIssue(undefined);
      }
    } catch (failure) {
      setImportIssue(describeError(failure));
    }
  };
  const reviseChoice = (index: number, choice: ApiImportChoice) =>
    setImportChoices((prior) =>
      prior.map((item, at) => (at === index ? choice : item)),
    );
  const appendPreparation = (caseId: string) => {
    try {
      const selected = cases.find((asset) => asset.id === caseId);
      if (!selected) return;
      const list = z
        .array(apiPreparationReferenceSchema)
        .parse(JSON.parse(preparations));
      setPreparations(
        JSON.stringify(
          [
            ...list,
            {
              caseId: selected.id,
              revisionId: selected.revisionId,
              parameters: {},
            },
          ],
          null,
          2,
        ),
      );
      setDirty(true);
      setIssue(undefined);
    } catch {
      setIssue('请先修正准备步骤 JSON，再插入固定修订。');
    }
  };
  const apply = () => {
    try {
      const data = settings.parse({
        dataRows: JSON.parse(rows),
        preparations: JSON.parse(preparations),
      });
      onApply({
        dataRows: data.dataRows.length ? data.dataRows : undefined,
        preparations: data.preparations.length ? data.preparations : undefined,
      });
      setDirty(false);
      setIssue(undefined);
    } catch (error) {
      setIssue(
        error instanceof z.ZodError
          ? error.issues
              .map((item) => `${item.path.join('/')} · ${item.message}`)
              .join('；')
          : '数据行与准备步骤都需要使用合法 JSON 数组。',
      );
    }
  };
  return (
    <div className="stack">
      {rowPreview.length > 0 && (
        <>
          <Space wrap>
            <span className="caption">已选择 {selectedCount} 行</span>
            <Button
              size="small"
              disabled={disabled || !selectedCount}
              onClick={() => bulk('enable')}
            >
              批量启用
            </Button>
            <Button
              size="small"
              disabled={disabled || !selectedCount}
              onClick={() => bulk('disable')}
            >
              批量停用
            </Button>
            <Button
              size="small"
              danger
              disabled={disabled || !selectedCount}
              onClick={() => bulk('remove')}
            >
              批量移除
            </Button>
          </Space>
          <Table
            size="small"
            rowKey="id"
            dataSource={rowPreview}
            {...(!disabled && {
              rowSelection: {
                selectedRowKeys: selectedRows,
                onChange: (keys: Key[]) => setSelectedRows(keys.map(String)),
              },
            })}
            pagination={{ pageSize: 8 }}
            columns={[
              { title: '名称', dataIndex: 'name' },
              {
                title: '变量数',
                render: (_value, row) => Object.keys(row.values).length,
              },
              {
                title: '参与运行',
                render: (_value, row) => (
                  <Checkbox
                    aria-label={row.name + ' 参与运行'}
                    checked={row.enabled !== false}
                    disabled={disabled}
                    onChange={(event) => {
                      const enabled = event.target.checked;
                      setRows(
                        JSON.stringify(
                          rowPreview.map((item) =>
                            item.id === row.id ? { ...item, enabled } : item,
                          ),
                          null,
                          2,
                        ),
                      );
                      setDirty(true);
                    }}
                  />
                ),
              },
            ]}
          />
        </>
      )}
      <label className="field-label">
        数据行参数
        <Input.TextArea
          rows={4}
          aria-label="数据行参数"
          spellCheck={false}
          disabled={disabled}
          value={rows}
          onChange={(event) => {
            setRows(event.target.value);
            setDirty(true);
          }}
        />
      </label>
      <Space wrap>
        <Button
          size="small"
          disabled={disabled || rows.trim() !== '[]'}
          onClick={() => {
            setRows(
              JSON.stringify(
                [{ id: 'normal', name: '正常数据', values: {} }],
                null,
                2,
              ),
            );
            setDirty(true);
          }}
        >
          填入数据行示例
        </Button>
        <Button
          size="small"
          disabled={disabled}
          onClick={() => setImportOpen(true)}
        >
          导入 CSV / JSON
        </Button>
        <Button
          size="small"
          disabled={!rowPreview.length}
          onClick={() => exportRows('CSV')}
        >
          导出 CSV
        </Button>
        <Button
          size="small"
          disabled={!rowPreview.length}
          onClick={() => exportRows('JSON')}
        >
          导出 JSON
        </Button>
        <span className="caption">
          每行独立执行，values 按名称覆盖用例变量。
        </span>
      </Space>
      <label className="field-label">
        插入准备用例的可用固定修订
        <Select<string>
          aria-label="插入准备用例固定修订"
          showSearch
          optionFilterProp="label"
          disabled={disabled}
          onSelect={appendPreparation}
          options={cases.map((asset) => ({
            value: asset.id,
            label: `${asset.title} · r${asset.revisionNo}`,
          }))}
        />
      </label>
      <label className="field-label">
        准备步骤及固定参数
        <Input.TextArea
          rows={4}
          aria-label="准备步骤及固定参数"
          spellCheck={false}
          disabled={disabled}
          value={preparations}
          onChange={(event) => {
            setPreparations(event.target.value);
            setDirty(true);
          }}
        />
      </label>
      <span className="caption">
        引用保存时固定修订，parameters 可补充准备变量。本用例维护最终清理。
      </span>
      {issue && <Alert type="error" showIcon title={issue} />}
      <Modal
        title={importPreview ? '预览测试数据行' : '导入测试数据行'}
        open={importOpen}
        onCancel={resetImport}
        onOk={importRows}
        okText={importPreview ? '应用所选变更' : '预览数据'}
        okButtonProps={{
          disabled:
            disabled ||
            Boolean(
              importPreview &&
              importChoices.every((item) => item.action === 'keep'),
            ),
        }}
        width={820}
        destroyOnHidden
      >
        <div className="stack">
          {importPreview ? (
            <>
              <Alert
                showIcon
                title={
                  importPreview.format +
                  ' · ' +
                  importPreview.rows.length +
                  ' 行待核对'
                }
                description="先确认变量映射和每行处理方式。变更先进入数据草稿，随后应用并保存用例。"
              />
              {importPreview.sourceKeys.length > 0 && (
                <section className="api-catalog-stack">
                  <h3>变量映射</h3>
                  <p className="caption">填写目标变量名，清空可跳过该列。</p>
                  <div className="api-catalog-form-grid">
                    {importPreview.sourceKeys.map((source) => (
                      <label className="api-catalog-form-field" key={source}>
                        <span>{source} → 目标变量</span>
                        <Input
                          aria-label={source + ' 的目标变量'}
                          allowClear
                          value={importMapping[source] ?? ''}
                          onChange={(event) =>
                            setImportMapping((before) => ({
                              ...before,
                              [source]: event.target.value,
                            }))
                          }
                        />
                      </label>
                    ))}
                  </div>
                </section>
              )}
              <h3>数据行与冲突</h3>
              <Table
                size="small"
                rowKey="index"
                dataSource={importPreview.rows.flatMap((row, index) => {
                  const choice = importChoices[index];
                  return choice
                    ? [
                        {
                          row,
                          index,
                          choice,
                          matches: apiImportMatches(row, rowPreview),
                        },
                      ]
                    : [];
                })}
                pagination={{ pageSize: 8 }}
                columns={[
                  {
                    title: '导入行',
                    render: (_value, { row }) => (
                      <div>
                        <strong>{row.name}</strong>
                        {row.id && (
                          <p className="caption">
                            <code>{row.id}</code>
                          </p>
                        )}
                      </div>
                    ),
                  },
                  {
                    title: '参与运行',
                    render: (_value, { row }) =>
                      row.enabled === undefined
                        ? '随目标行'
                        : row.enabled
                          ? '启用'
                          : '停用',
                  },
                  {
                    title: '冲突处理',
                    render: (_value, { choice, matches, index, row }) => (
                      <div className="api-catalog-stack">
                        {matches.length > 0 && (
                          <span className="caption">
                            匹配 {matches.length} 个现有数据行
                          </span>
                        )}
                        <Select<ApiImportChoice['action']>
                          aria-label={row.name + ' 的导入处理方式'}
                          value={choice.action}
                          options={[
                            { value: 'keep', label: '保留原行 / 跳过' },
                            {
                              value: 'replace',
                              label: '替换映射字段（保留原 ID）',
                              disabled: matches.length === 0,
                            },
                            { value: 'add', label: '新增一行（新 ID）' },
                          ]}
                          onChange={(action) =>
                            reviseChoice(index, { ...choice, action })
                          }
                        />
                        {matches.length > 0 && choice.action !== 'add' && (
                          <Select
                            aria-label={row.name + ' 的目标原数据行'}
                            value={choice.existingId ?? null}
                            placeholder="选择原数据行"
                            options={matches.map((match) => ({
                              value: match.id,
                              label: match.name + ' · ' + match.id,
                            }))}
                            onChange={(existingId: string) =>
                              reviseChoice(index, { ...choice, existingId })
                            }
                          />
                        )}
                        {choice.action === 'add' && (
                          <Input
                            aria-label={row.name + ' 的新增行名称'}
                            value={choice.name}
                            onChange={(event) =>
                              reviseChoice(index, {
                                ...choice,
                                name: event.target.value,
                              })
                            }
                          />
                        )}
                      </div>
                    ),
                  },
                  {
                    title: '源变量',
                    render: (_, { row }) => (
                      <pre className="message-code">
                        {JSON.stringify(row.values, null, 2)}
                      </pre>
                    ),
                  },
                ]}
              />
              <Button onClick={() => setImportPreview(undefined)}>
                返回修改
              </Button>
            </>
          ) : (
            <>
              <Input.TextArea
                aria-label="CSV 或 JSON 数据行文本"
                rows={8}
                maxLength={30000}
                value={importText}
                onChange={(event) => setImportText(event.target.value)}
                spellCheck={false}
              />
              <label className="api-catalog-form-field">
                <span>选择 CSV 或 JSON 文档</span>
                <input
                  type="file"
                  accept=".csv,.json"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    if (file.size > 120000) {
                      setImportIssue('请选择 120 KB 以内的数据文件。');
                      return;
                    }
                    void file.text().then(
                      (text) => {
                        setImportText(text);
                        setImportIssue(undefined);
                      },
                      () => setImportIssue('读取数据文件失败。'),
                    );
                  }}
                />
              </label>
              <p className="caption">
                CSV 首列 name，支持 @id 与
                @enabled，其他列为按文本导入的变量。JSON 支持按类型保留
                values，可指定 id 与 enabled。
              </p>
            </>
          )}
          {importIssue && <Alert type="error" showIcon title={importIssue} />}
        </div>
      </Modal>

      <div>
        <Button disabled={disabled || !dirty} onClick={apply}>
          应用到本用例草稿
        </Button>
      </div>
    </div>
  );
}
