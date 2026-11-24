import type { z } from 'zod';
import {
  multipartMaxFileBytes,
  multipartMaxParts,
  multipartRequestBodySchema,
} from '../../../packages/contracts/src/api-multipart';
import { Alert, Button, Input, Select } from 'antd';
import { VariableField, type ApiVariableOption } from './api-variable-fields';
import { useApiFileSelection } from './api-file-fields';

type MultipartPartDraft = z.infer<
  typeof multipartRequestBodySchema
>['parts'][number];

export function ApiMultipartFields({
  projectId,
  parts,
  disabled,
  variableOptions,
  onChange,
}: {
  projectId: string;
  parts: MultipartPartDraft[];
  disabled: boolean;
  variableOptions: ApiVariableOption[];
  onChange: (parts: MultipartPartDraft[]) => void;
}) {
  const selection = useApiFileSelection({
    projectId,
    maximumBytes: multipartMaxFileBytes,
    active: parts.some((part) => part.kind === 'file'),
  });

  function replace(index: number, part: MultipartPartDraft) {
    onChange(parts.map((value, at) => (at === index ? part : value)));
  }
  const locked = disabled || selection.checking;
  return (
    <div className="stack">
      <p className="caption">
        文本支持变量引用。文件使用当前项目已登记、校验的稳定资源
        ID。运行前平台仍会核对原件和限额。
      </p>
      {parts.map((part, index) => {
        const fileOptions = selection.options(
          part.kind === 'file' ? part.fileResourceId : undefined,
        );
        return (
          <div className="card pad stack" key={index}>
            <div className="api-new-case-inputs">
              <label className="field-label">
                字段名称
                <Input
                  aria-label={'Multipart 字段名称 ' + (index + 1)}
                  value={part.name}
                  maxLength={120}
                  disabled={locked}
                  onChange={(event) =>
                    replace(index, { ...part, name: event.target.value })
                  }
                />
              </label>
              <label className="field-label">
                类型
                <Select<'text' | 'file'>
                  aria-label={'Multipart 字段类型 ' + (index + 1)}
                  value={part.kind}
                  disabled={locked}
                  options={[
                    { value: 'text', label: '文本' },
                    { value: 'file', label: '项目文件' },
                  ]}
                  onChange={(kind) => {
                    if (kind !== part.kind)
                      replace(
                        index,
                        kind === 'text'
                          ? { kind, name: part.name, value: '' }
                          : { kind, name: part.name, fileResourceId: '' },
                      );
                  }}
                />
              </label>
            </div>
            {part.kind === 'file' ? (
              <Select
                aria-label={'Multipart 项目文件 ' + (index + 1)}
                placeholder="搜索已登记的同项目文件"
                value={part.fileResourceId || undefined}
                showSearch
                filterOption={false}
                onSearch={selection.setQuery}
                loading={selection.loading || selection.checking}
                disabled={locked}
                options={fileOptions}
                onChange={(id) => {
                  if (id)
                    void selection.verify(id, (fileResourceId) =>
                      replace(index, {
                        kind: 'file',
                        name: part.name,
                        fileResourceId,
                      }),
                    );
                }}
                notFoundContent="没有可选择的文件，检查项目、文件名或登记状态。"
              />
            ) : (
              <VariableField
                label={'Multipart 文本值 ' + (index + 1)}
                value={part.value}
                options={variableOptions}
                disabled={locked}
                onChange={(value) => replace(index, { ...part, value })}
              />
            )}
            <div>
              <Button
                size="small"
                danger
                disabled={locked}
                onClick={() => onChange(parts.filter((_, at) => at !== index))}
              >
                移除字段
              </Button>
            </div>
          </div>
        );
      })}
      {selection.error && (
        <Alert type="error" showIcon title={selection.error} />
      )}
      <div>
        <Button
          disabled={locked || parts.length >= multipartMaxParts}
          onClick={() =>
            onChange([...parts, { kind: 'text', name: '', value: '' }])
          }
        >
          添加 form-data 字段
        </Button>
      </div>
    </div>
  );
}
