import { useState } from 'react';
import { Alert, Button, Checkbox, Input, Select, Tag } from 'antd';
import { z } from 'zod';
import {
  apiCatalogImportApplyInputSchema,
  apiCatalogImportPreviewInputSchema,
  apiCatalogImportPreviewResultSchema,
  apiCatalogListResultSchema,
  type ApiCatalogNode,
} from '../../../packages/contracts/src/api-catalog';
import { api, describeError } from './api';
import { CommandDialog, useBusinessCommand } from './business-command';
import {
  ApiCatalogMaterialSource,
  type ImportBasis,
} from './api-catalog-material-source';

type Format = z.output<typeof apiCatalogImportPreviewInputSchema>['format'];
type Preview = z.output<typeof apiCatalogImportPreviewResultSchema>;
type ImportSelection = z.output<
  typeof apiCatalogImportApplyInputSchema
>['selections'];

const formatLabels: Record<Format, string> = {
  openapi: 'OpenAPI 3.0／3.1',
  swagger: 'Swagger 2.0',
  postman: 'Postman Collection',
  har: 'HAR',
  curl: 'cURL',
};

export function ApiCatalogImportDialog({
  path,
  projectId,
  session,
  folders,
  parentId,
  onClose,
  onApplied,
}: {
  path: string;
  projectId: string;
  session: string;
  folders: readonly ApiCatalogNode[];
  parentId?: string | undefined;
  onClose: () => void;
  onApplied: (nodes: ApiCatalogNode[]) => void;
}) {
  const [format, setFormat] = useState<Format>('openapi');
  const [folderId, setFolderId] = useState(parentId);
  const [serviceKey, setServiceKey] = useState('default');
  const [document, setDocument] = useState('');
  const [preview, setPreview] = useState<Preview>();
  const [selection, setSelection] = useState<ImportSelection>([]);
  const [previewing, setPreviewing] = useState(false);
  const [fileError, setFileError] = useState<string>();
  const [materialOpen, setMaterialOpen] = useState(false);
  const [basis, setBasis] = useState<ImportBasis>();
  const command = useBusinessCommand(session);
  const busy = command.pending || previewing || command.uncertain;

  function resetPreview(change: () => void) {
    change();
    setPreview(undefined);
    setSelection([]);
    command.setError(undefined);
  }
  async function submit() {
    try {
      const input = apiCatalogImportPreviewInputSchema.parse({
        format,
        folderId,
        serviceKey,
        document,
        ...(basis && { basis }),
      });
      if (!preview) {
        setPreviewing(true);
        command.setError(undefined);
        const result = await api(
          path,
          { method: 'POST', body: { op: 'preview-import', input } },
          apiCatalogImportPreviewResultSchema,
        );
        setPreview(result);
        setSelection(
          result.candidates.flatMap((candidate, index) =>
            candidate.operation === 'create' ? [{ index }] : [],
          ),
        );
        return;
      }
      const result = await command.run((commandId) =>
        api(
          path,
          {
            method: 'POST',
            body: {
              op: 'apply-import',
              input: apiCatalogImportApplyInputSchema.parse({
                ...input,
                commandId,
                digest: preview.digest,
                selections: selection,
              }),
            },
          },
          apiCatalogListResultSchema,
        ),
      );
      if (result) onApplied(result.nodes);
    } catch (error) {
      command.setError(
        error instanceof z.ZodError
          ? error.issues
              .map((issue) => `${issue.path.join('.')} · ${issue.message}`)
              .join('；')
          : describeError(error),
      );
    } finally {
      setPreviewing(false);
    }
  }
  return (
    <CommandDialog
      open
      title="导入接口定义"
      command={command}
      busy={previewing}
      dirty={Boolean(document.trim())}
      onClose={onClose}
      onSave={() => void submit()}
      allowSave={
        preview ? selection.length > 0 : Boolean(folderId && document.trim())
      }
      saveLabel={preview ? '应用所选变更' : '预览导入差异'}
      width={850}
    >
      <div className="api-catalog-stack">
        <div className="api-catalog-form-grid">
          <label className="api-catalog-form-field">
            <span>目标功能目录</span>
            <Select
              showSearch
              optionFilterProp="label"
              disabled={busy}
              value={folderId ?? null}
              options={folders.map((folder) => ({
                value: folder.id,
                label: folder.title,
              }))}
              onChange={(value: string) =>
                resetPreview(() => setFolderId(value))
              }
            />
          </label>
          <label className="api-catalog-form-field">
            <span>来源格式</span>
            <Select
              disabled={busy}
              value={format}
              options={Object.entries(formatLabels).map(([value, label]) => ({
                value,
                label,
              }))}
              onChange={(value: Format) => resetPreview(() => setFormat(value))}
            />
          </label>
          <label className="api-catalog-form-field">
            <span>服务标识</span>
            <Input
              disabled={busy}
              value={serviceKey}
              onChange={(event) =>
                resetPreview(() => setServiceKey(event.target.value))
              }
            />
          </label>
        </div>
        <label className="api-catalog-form-field">
          <span>选择接口文档文件</span>
          <input
            type="file"
            accept=".json,.yaml,.yml,.har,.txt,.curl"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              if (file.size > 1_048_576) {
                setFileError('请选择 1 MiB 以内的文档。');
                return;
              }
              void file.text().then(
                (text) => {
                  setFileError(undefined);
                  resetPreview(() => {
                    setBasis(undefined);
                    setDocument(text);
                  });
                },
                () => setFileError('读取文档失败。'),
              );
            }}
          />
        </label>
        {fileError && <Alert type="error" title={fileError} showIcon />}
        <div>
          <Button
            disabled={busy}
            onClick={() => setMaterialOpen((before) => !before)}
          >
            {materialOpen ? '收起需求材料' : '从需求材料读取'}
          </Button>
        </div>
        {materialOpen && (
          <ApiCatalogMaterialSource
            projectId={projectId}
            disabled={busy}
            onRead={(text, source) =>
              resetPreview(() => {
                setDocument(text);
                setBasis(source);
              })
            }
          />
        )}
        {basis && <p className="caption">来源：{basis.description}</p>}
        <label className="api-catalog-form-field">
          <span>接口契约内容</span>
          <Input.TextArea
            className="api-catalog-code"
            disabled={busy}
            value={document}
            autoSize={{ minRows: 6, maxRows: 14 }}
            onChange={(event) =>
              resetPreview(() => {
                setBasis(undefined);
                setDocument(event.target.value);
              })
            }
          />
        </label>
        {preview && (
          <section className="api-catalog-stack">
            <h3>导入差异</h3>
            {preview.warnings.length > 0 && (
              <Alert
                type="warning"
                title={preview.warnings.join('；')}
                showIcon
              />
            )}
            {preview.candidates.length === 0 && (
              <p className="caption">没有可导入的定义。</p>
            )}
            {preview.candidates.map((candidate, index) => {
              const selected = selection.find((item) => item.index === index);
              return (
                <div className="api-catalog-definition-group" key={index}>
                  <div className="row wrap">
                    <Checkbox
                      checked={Boolean(selected)}
                      disabled={
                        busy ||
                        candidate.operation === 'conflict' ||
                        candidate.operation === 'skip'
                      }
                      onChange={(event) =>
                        setSelection((before) =>
                          event.target.checked
                            ? [...before, { index }]
                            : before.filter((item) => item.index !== index),
                        )
                      }
                    >
                      {candidate.title}
                    </Checkbox>
                    <Tag
                      color={
                        candidate.operation === 'conflict'
                          ? 'orange'
                          : 'default'
                      }
                    >
                      {candidate.operation === 'create'
                        ? '新增'
                        : candidate.operation === 'revise'
                          ? '生成新修订'
                          : candidate.operation === 'skip'
                            ? '无变化'
                            : '冲突'}
                    </Tag>
                    <code>
                      {candidate.definition.method} {candidate.definition.path}
                    </code>
                  </div>
                  {candidate.existing && (
                    <p className="caption">
                      已有接口：{candidate.existing.title} · r
                      {candidate.existing.revisionNumber}
                    </p>
                  )}
                  {selected &&
                    candidate.operation === 'revise' &&
                    candidate.changedFields.length > 0 && (
                      <Select
                        aria-label="应用字段"
                        className="api-catalog-wide-select"
                        disabled={busy}
                        mode="multiple"
                        options={candidate.changedFields.map((field) => ({
                          value: field,
                          label: field,
                        }))}
                        value={selected.fields ?? candidate.changedFields}
                        onChange={(
                          fields: NonNullable<
                            ImportSelection[number]['fields']
                          >,
                        ) => {
                          setSelection((before) =>
                            fields.length
                              ? before.map((item) =>
                                  item.index === index
                                    ? { index, fields }
                                    : item,
                                )
                              : before.filter((item) => item.index !== index),
                          );
                        }}
                      />
                    )}
                </div>
              );
            })}
            <Button disabled={busy} onClick={() => setSelection([])}>
              清空选择
            </Button>
          </section>
        )}
      </div>
    </CommandDialog>
  );
}
