import { useState } from 'react';
import { Alert, Button, Input, Modal, Select, Space, Table } from 'antd';
import { z } from 'zod';
import {
  apiDataRowSchema,
  apiPreparationReferenceSchema,
  type ApiCaseContent,
} from '../../../packages/contracts/src/domain';
import type { Asset } from '../../../packages/contracts/src/assets';
import { describeError } from './api';
import { parseApiDataImport } from './api-import';

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
  cases: readonly Asset[];
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
  const resetImport = () => {
    setImportOpen(false);
    setImportText('');
    setImportPreview(undefined);
    setImportIssue(undefined);
  };
  const importRows = () => {
    if (disabled) return;
    try {
      const current = settings.shape.dataRows.parse(JSON.parse(rows));
      if (importPreview) {
        setRows(
          JSON.stringify(
            [
              ...current,
              ...importPreview.rows.map((row) => ({
                ...row,
                id: crypto.randomUUID(),
              })),
            ],
            null,
            2,
          ),
        );
        setDirty(true);
        resetImport();
      } else {
        setImportPreview(parseApiDataImport(importText, current));
        setImportIssue(undefined);
      }
    } catch (failure) {
      setImportIssue(describeError(failure));
    }
  };
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
        okText={importPreview ? '追加至数据草稿' : '预览数据'}
        destroyOnHidden
      >
        <div className="stack">
          {importPreview ? (
            <>
              <Alert
                showIcon
                title={
                  importPreview.format +
                  ' · 新增 ' +
                  importPreview.rows.length +
                  ' 行'
                }
                description="保留已有行。导入后仍可修改数据，应用到用例草稿后再显式保存。"
              />
              <Table
                size="small"
                rowKey="name"
                dataSource={importPreview.rows}
                pagination={{ pageSize: 8 }}
                columns={[
                  { title: '名称', dataIndex: 'name' },
                  {
                    title: '变量',
                    render: (_, row) => (
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
              <p className="caption">
                CSV 首列 name，其余列为变量名，字段按文本导入。JSON 每行含 name
                和 values。重名行、无效字段及凭据输入需修正后再预览。
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
