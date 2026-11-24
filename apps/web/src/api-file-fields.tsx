import { useEffect, useRef, useState } from 'react';
import { Alert, Input, Select } from 'antd';
import {
  fileCenterListSchema,
  type FileCenterEntry,
} from '../../../packages/contracts/src/agent-workspace';
import { fileReceiptSchema } from '../../../packages/contracts/src/files';
import { api, describeError } from './api';

export function useApiFileSelection({
  projectId,
  maximumBytes,
  active,
}: {
  projectId: string;
  maximumBytes: number;
  active: boolean;
}) {
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<FileCenterEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string>();
  const activeCheck = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const params = new URLSearchParams({
      projectId,
      query: query.trim(),
      limit: '50',
    });
    setLoading(true);
    const timer = window.setTimeout(() => {
      void api(
        '/me/file-center?' + params,
        { signal: controller.signal },
        fileCenterListSchema,
      )
        .then(({ entries }) => {
          if (controller.signal.aborted) return;
          const visible = entries.filter(
            (entry) =>
              entry.projectId === projectId &&
              entry.available &&
              !entry.deletedAt &&
              BigInt(entry.bytes) <= BigInt(maximumBytes),
          );
          setFiles([
            ...new Map(
              visible.map((entry) => [entry.resourceId, entry]),
            ).values(),
          ]);
          setError(undefined);
        })
        .catch((failure: unknown) => {
          if (!controller.signal.aborted) setError(describeError(failure));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [projectId, query, maximumBytes, active]);
  useEffect(() => () => activeCheck.current?.abort(), [projectId]);

  async function verify(id: string, onSelected: (resourceId: string) => void) {
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
        BigInt(file.bytes) > BigInt(maximumBytes)
      )
        throw new Error('此文件不是当前项目中已验证且符合尺寸限制的原件。');
      if (!controller.signal.aborted) onSelected(file.id);
    } catch (failure) {
      if (!controller.signal.aborted) setError(describeError(failure));
    } finally {
      if (!controller.signal.aborted) setChecking(false);
    }
  }
  function options(resourceId?: string) {
    const result = files.map((file) => ({
      value: file.resourceId,
      label: (file.originalName ?? file.path) + ' · ' + file.bytes + ' 字节',
    }));
    if (resourceId && !result.some((item) => item.value === resourceId))
      result.unshift({
        value: resourceId,
        label: '原文件引用 · ' + resourceId,
      });
    return result;
  }
  return { setQuery, options, loading, checking, error, verify };
}

export function ApiBinaryFields({
  projectId,
  maximumBytes,
  fileResourceId,
  mediaType,
  disabled,
  onChange,
}: {
  projectId: string;
  maximumBytes: number;
  fileResourceId: string;
  mediaType: string;
  disabled: boolean;
  onChange: (body: {
    format: 'binary';
    fileResourceId: string;
    mediaType: string;
  }) => void;
}) {
  const selection = useApiFileSelection({
    projectId,
    maximumBytes,
    active: true,
  });
  const locked = disabled || selection.checking;
  return (
    <div className="stack">
      <label className="field-label">
        已验证的项目原文件
        <Select
          value={fileResourceId || null}
          loading={selection.loading || selection.checking}
          disabled={locked}
          showSearch
          filterOption={false}
          placeholder="搜索项目文件"
          options={selection.options(fileResourceId)}
          onSearch={selection.setQuery}
          onChange={(fileId: string) =>
            void selection.verify(fileId, (id) =>
              onChange({ format: 'binary', fileResourceId: id, mediaType }),
            )
          }
        />
      </label>
      <label className="field-label">
        请求体媒体类型
        <Input
          aria-label="Binary 媒体类型"
          value={mediaType}
          maxLength={128}
          disabled={locked}
          onChange={(event) =>
            onChange({
              format: 'binary',
              fileResourceId,
              mediaType: event.target.value,
            })
          }
        />
      </label>
      <p className="caption">文件上限 {maximumBytes / 1_048_576} MiB。</p>
      {selection.error && (
        <Alert type="error" title={selection.error} showIcon />
      )}
    </div>
  );
}
