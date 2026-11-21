import { useState } from 'react';
import { Alert, Button, Collapse, Input, Select, Space } from 'antd';
import { z } from 'zod';
import {
  apiDataRowSchema,
  apiPreparationReferenceSchema,
  type ApiCaseContent,
} from '../../../packages/contracts/src/domain';
import type { Asset } from '../../../packages/contracts/src/assets';

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
    <Collapse
      items={[
        {
          key: 'composition',
          label: `数据行 ${value.dataRows?.length ?? 0} · 固定准备 ${value.preparations?.length ?? 0}`,
          children: (
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
                <span className="caption">
                  每行独立执行，values 按名称覆盖用例变量。
                </span>
              </Space>
              <label className="field-label">
                插入准备用例的当前修订
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
                引用保存时固定修订，parameters
                可补充准备变量。本用例维护最终清理。
              </span>
              {issue && <Alert type="error" showIcon title={issue} />}
              <div>
                <Button disabled={disabled || !dirty} onClick={apply}>
                  应用到本用例草稿
                </Button>
              </div>
            </div>
          ),
        },
      ]}
    />
  );
}
