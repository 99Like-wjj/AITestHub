import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import {
  multipartMaxFileBytes,
  multipartMaxParts,
  multipartRequestBodySchema,
} from '../../../packages/contracts/src/api-multipart';
import { Alert, Button, Input, Select } from 'antd';
import {
  fileCenterListSchema,
  type FileCenterEntry,
} from '../../../packages/contracts/src/agent-workspace';
import { fileReceiptSchema } from '../../../packages/contracts/src/files';
import { api, describeError } from './api';
import { VariableField, type ApiVariableOption } from './api-variable-fields';

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
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<FileCenterEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string>();
  const activeCheck = useRef<AbortController | null>(null);
  const hasFile = parts.some((part) => part.kind === 'file');

  useEffect(() => {
    if (!hasFile) return;
    const signal = new AbortController();
    const params = new URLSearchParams({
      projectId,
      query: query.trim(),
      limit: '50',
    });
    setLoading(true);
    const timer = window.setTimeout(() => {
      void api(
        '/me/file-center?' + params,
        { signal: signal.signal },
        fileCenterListSchema,
      )
        .then((response) => {
          if (signal.signal.aborted) return;
          const verified = new Map<string, FileCenterEntry>();
          for (const file of response.entries) {
            if (
              file.projectId === projectId &&
              file.available &&
              !file.deletedAt &&
              BigInt(file.bytes) <= BigInt(multipartMaxFileBytes)
            )
              verified.set(file.resourceId, file);
          }
          setFiles([...verified.values()]);
        })
        .catch((failure: unknown) => {
          if (!signal.signal.aborted) setError(describeError(failure));
        })
        .finally(() => {
          if (!signal.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      signal.abort();
    };
  }, [projectId, query, hasFile]);
  useEffect(() => () => activeCheck.current?.abort(), [projectId]);

  function replace(index: number, part: MultipartPartDraft) {
    onChange(parts.map((value, at) => (at === index ? part : value)));
  }
  async function chooseFile(index: number, name: string, id: string) {
    activeCheck.current?.abort();
    const controller = new AbortController();
    activeCheck.current = controller;
    setChecking(true);
    setError(undefined);
    try {
      const { file } = await api(
        '/files/' + id,
        { signal: controller.signal },
        fileReceiptSchema,
      );
      if (
        file.projectId !== projectId ||
        file.ownerScope !== 'project' ||
        file.status !== 'verified' ||
        BigInt(file.bytes) > BigInt(multipartMaxFileBytes)
      )
        throw Error('此文件不是当前项目中已验证的原件。');
      if (!controller.signal.aborted)
        replace(index, { kind: 'file', name, fileResourceId: file.id });
    } catch (failure) {
      if (!controller.signal.aborted) setError(describeError(failure));
    } finally {
      if (!controller.signal.aborted) setChecking(false);
    }
  }
  const locked = disabled || checking;
  return (
    <div className="stack">
      <p className="caption">
        文本支持变量引用。文件使用当前项目已登记、校验的稳定资源
        ID。运行前平台仍会核对原件和限额。
      </p>
      {parts.map((part, index) => {
        const fileOptions = files.map((file) => ({
          value: file.resourceId,
          label:
            (file.originalName ?? file.path) + ' · ' + file.bytes + ' 字节',
        }));
        if (
          part.kind === 'file' &&
          part.fileResourceId &&
          !fileOptions.some((item) => item.value === part.fileResourceId)
        )
          fileOptions.unshift({
            value: part.fileResourceId,
            label: '原文件引用 · ' + part.fileResourceId,
          });
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
                onSearch={setQuery}
                loading={loading || checking}
                disabled={locked}
                options={fileOptions}
                onChange={(id) => {
                  if (id) void chooseFile(index, part.name, id);
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
      {error && <Alert type="error" showIcon title={error} />}
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
