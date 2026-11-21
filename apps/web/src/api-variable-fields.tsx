import { Input, Select, Space } from 'antd';
import { useRef } from 'react';
import type { TestConfigurationView } from '../../../packages/contracts/src/test-configuration';
import { apiAuthoringVariableIssues } from '../../../packages/contracts/src/api-variable-refs';
import { variableNameSchema } from '../../../packages/contracts/src/domain';
import { apiDraftContent } from './api-draft';
import type { ApiCase, ApiDraft, Request } from './api-draft';

export interface ApiVariableOption {
  value: string;
  label: string;
}

export type ApiPreparationVariables = Pick<ApiCase, 'steps' | 'variables'>;

export function configuredEnvironment(view: TestConfigurationView | undefined) {
  const item = view?.content;
  return item?.kind === 'environment' && 'variables' in item
    ? { ...item.variables, baseUrls: item.baseUrls }
    : undefined;
}

export function variableOptions(
  draft: ApiDraft,
  upstream: readonly Pick<Request, 'name' | 'extractors'>[],
  selected: TestConfigurationView | undefined,
  preparations?: ApiPreparationVariables,
): ApiVariableOption[] {
  const options = new Map<string, ApiVariableOption>();
  const add = (value: string, context: string) =>
    options.set(value, { value, label: `${value} · ${context}` });
  const environment = selected?.content;
  if (environment?.kind === 'environment' && 'variables' in environment) {
    for (const name of Object.keys(environment.variables))
      if (name !== 'baseUrls') add(`env.${name}`, environment.name);
    for (const name of Object.keys(environment.baseUrls))
      add(`env.baseUrls.${name}`, environment.name);
  }
  for (const name of Object.keys(preparations?.variables ?? {}))
    add(`case.${name}`, '准备步骤变量');
  for (const reference of draft.base.preparations ?? [])
    for (const name of Object.keys(reference.parameters))
      add(`case.${name}`, '准备步骤参数');
  for (const entry of draft.variableEntries)
    if (variableNameSchema.safeParse(entry.name).success)
      add(`case.${entry.name}`, '用例变量');
  const rows = draft.base.dataRows ?? [];
  for (const name of Object.keys(rows[0]?.values ?? {}))
    if (
      rows.every((row) =>
        Object.prototype.hasOwnProperty.call(row.values, name),
      ) &&
      !options.has(`case.${name}`)
    )
      add(`case.${name}`, '所有数据行均提供');
  for (const step of preparations?.steps ?? [])
    for (const extraction of step.extractors)
      add(
        `extract.${extraction.name}`,
        `${step.name}${extraction.sensitive ? ' · 敏感' : ''}`,
      );
  for (const [position, step] of upstream.entries())
    for (const extraction of step.extractors)
      if (variableNameSchema.safeParse(extraction.name).success)
        add(
          `extract.${extraction.name}`,
          `步骤 ${position + 1} ${step.name}${extraction.sensitive ? ' · 敏感' : ''}`,
        );
  return [...options.values()];
}

export function draftVariableIssues(
  draft: ApiDraft,
  selected: TestConfigurationView | undefined,
  preparations?: ApiPreparationVariables,
) {
  try {
    return apiAuthoringVariableIssues(
      apiDraftContent(draft),
      configuredEnvironment(selected),
      preparations,
    );
  } catch {
    // The editor still lets users finish ordinary required fields and JSON drafts.
    // Those syntax/shape errors are reported by the save operation.
    return [];
  }
}

function insideString(value: string, position: number) {
  let quoted = false;
  for (let offset = 0; offset < position; offset++) {
    if (value[offset] === '\\' && quoted) offset++;
    else if (value[offset] === '"') quoted = !quoted;
  }
  return quoted;
}

export function VariableField({
  label,
  value,
  options,
  disabled,
  onChange,
  format,
  placeholder,
}: {
  label: string;
  value: string;
  options: ApiVariableOption[];
  disabled: boolean;
  onChange: (value: string) => void;
  format?: 'json' | 'text';
  placeholder?: string;
}) {
  const caret = useRef<{ start: number; end: number } | undefined>(undefined);
  const observe = (element: HTMLInputElement | HTMLTextAreaElement) => {
    caret.current = {
      start: element.selectionStart ?? value.length,
      end: element.selectionEnd ?? value.length,
    };
  };
  const picker = (
    <Select
      aria-label={`${label} 插入变量`}
      options={options}
      value={null}
      disabled={disabled || !options.length}
      placeholder={options.length ? '插入变量' : '暂无可选变量'}
      showSearch
      optionFilterProp="label"
      style={{ minWidth: 122 }}
      popupMatchSelectWidth={false}
      onChange={(reference: string) => {
        const start = Math.min(
          caret.current?.start ?? value.length,
          value.length,
        );
        const end = Math.min(caret.current?.end ?? start, value.length);
        const marker = `{{${reference}}}`;
        const token =
          format === 'json' && !insideString(value, start)
            ? JSON.stringify(marker)
            : marker;
        onChange(value.slice(0, start) + token + value.slice(end));
        caret.current = {
          start: start + token.length,
          end: start + token.length,
        };
      }}
    />
  );
  if (format)
    return (
      <Space direction="vertical" style={{ width: '100%' }}>
        <Input.TextArea
          aria-label={label}
          rows={5}
          value={value}
          disabled={disabled}
          onSelect={(event) => observe(event.currentTarget)}
          onBlur={(event) => observe(event.currentTarget)}
          onChange={(event) => {
            observe(event.target);
            onChange(event.target.value);
          }}
        />
        {picker}
      </Space>
    );
  return (
    <Space.Compact block>
      <Input
        aria-label={label}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onSelect={(event) => observe(event.currentTarget)}
        onBlur={(event) => observe(event.currentTarget)}
        onChange={(event) => {
          observe(event.target);
          onChange(event.target.value);
        }}
      />
      {picker}
    </Space.Compact>
  );
}
