import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Modal,
  Pagination,
  Select,
  Space,
  Spin,
  Typography,
} from 'antd';
import type { z } from 'zod';
import { api, describeError } from './api';
import {
  identityContextEpoch,
  subscribeIdentityChanges,
} from './identity-context';
import {
  fileCenterDetailSchema,
  fileCenterAssociationsSchema,
  workspaceHistorySchema,
  type FileCenterEntry,
  type WorkspaceEntry,
} from '../../../packages/contracts/src/agent-workspace';
import {
  filePreviewResultSchema,
  type FilePreviewResult,
} from '../../../packages/contracts/src/file-preview';
import {
  humanFileSize,
  previewKind,
  readPreviewBlob,
  isDelimitedFile,
  prepareFilePreview,
  type FilePreviewDocument,
} from './file-preview-data';
import { FilePreviewContent } from './file-preview-content';
import { uiLayers } from './ui-layers';
import { FileKindTag, FileStatusTag } from './file-display-status';
import { BeijingTime, formatBeijingTime } from './beijing-time';
import './file-center.css';

export type PreviewEntry = WorkspaceEntry & { conversationId: string };
const fileName = (entry: WorkspaceEntry) =>
  entry.originalName ?? entry.path.split('/').at(-1) ?? entry.path;
function columnName(index: number) {
  let value = index + 1,
    name = '';
  while (value) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}
export function FileWorkbookPreview({
  data,
  onQuery,
  pending,
}: {
  data: Extract<FilePreviewResult, { kind: 'workbook' }>;
  onQuery: (sheet: number, offset: number) => void;
  pending: boolean;
}) {
  const [selected, setSelected] = useState<{
    coordinate: string;
    text: string;
    formula: string | null;
    cacheState: string;
  }>();
  useEffect(
    () => setSelected(undefined),
    [data.sourceSha256, data.selectedSheet],
  );
  const sheet = data.sheets.find((item) => item.index === data.selectedSheet),
    columns = Math.min(200, sheet?.columnCount ?? 0);
  return (
    <div className="file-sheet-preview">
      <Space wrap className="file-preview-tools">
        <span>工作表</span>
        <Select
          aria-label="工作表"
          value={data.selectedSheet}
          options={data.sheets.map((item) => ({
            value: item.index,
            label: `${item.name} (${item.rowCount}×${item.columnCount})`,
          }))}
          onChange={(index) => onQuery(index, 0)}
          disabled={pending}
          style={{ minWidth: 200 }}
        />
        <Typography.Text type="secondary">
          单元格来自实际文件；不重新计算公式
        </Typography.Text>
      </Space>
      {data.notices.map((notice, index) => (
        <Alert key={index} type="info" title={notice} />
      ))}
      {data.columnsTruncated ? (
        <Alert type="warning" title="仅展示前200列，请下载原件查看剩余列。" />
      ) : null}
      <div className="file-cell-detail">
        {selected ? (
          <>
            <strong>{selected.coordinate}</strong>
            <span>{selected.text || '（空值）'}</span>
            {selected.formula ? (
              <>
                <code>公式：{selected.formula}</code>
                <span>
                  {selected.cacheState === 'missing'
                    ? '文件没有公式缓存值，未计算结果。'
                    : '显示文件原缓存，可能尚未重算。'}
                </span>
              </>
            ) : null}
          </>
        ) : (
          '点击单元格查看完整内容及公式'
        )}
      </div>
      <div className="file-grid-scroll">
        <table className="file-data-grid">
          <thead>
            <tr>
              <th>行</th>
              {Array.from({ length: columns }, (_, index) => (
                <th key={index}>{columnName(index)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.index}>
                <th>{row.index + 1}</th>
                {Array.from({ length: columns }, (_, column) => {
                  const cell = row.cells.find((item) => item.column === column);
                  return (
                    <td key={column}>
                      <button
                        type="button"
                        className={`file-cell ${cell?.formula ? 'has-formula' : ''}`}
                        onClick={() =>
                          setSelected({
                            coordinate: `${columnName(column)}${row.index + 1}`,
                            text: cell?.text ?? '',
                            formula: cell?.formula ?? null,
                            cacheState: cell?.cacheState ?? 'notFormula',
                          })
                        }
                      >
                        {cell?.text ?? ''}
                        {cell?.formula ? <sup>ƒ</sup> : null}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination
        current={Math.floor(data.rowOffset / 200) + 1}
        pageSize={200}
        total={sheet?.rowCount ?? 0}
        showSizeChanger={false}
        disabled={pending}
        onChange={(page) => onQuery(data.selectedSheet, (page - 1) * 200)}
      />
    </div>
  );
}
export async function downloadFileCenterEntry(
  entry: PreviewEntry,
  revision = entry.revision,
) {
  const epoch = identityContextEpoch();
  const fresh = (
    await api(`/me/file-center/entries/${entry.id}`, {}, fileCenterDetailSchema)
  ).entry;
  const history =
    revision !== fresh.revision
      ? (
          await api(
            `/me/file-center/entries/${entry.id}/versions`,
            {},
            workspaceHistorySchema,
          )
        ).versions
      : [];
  const version =
    revision === fresh.revision
      ? fresh
      : history.find((version) => version.revision === revision);
  if (!version?.available)
    throw new Error('所选版本当前不可读，未开始旧缓存下载。');
  const blob = await readPreviewBlob(
    `/api/v1/me/file-center/entries/${entry.id}/content?revision=${revision}`,
    `${version.resourceId}:${revision}:${version.sha256}`,
    new AbortController().signal,
  );
  if (epoch !== identityContextEpoch()) return;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName(fresh);
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function FilePreview({
  entry,
  entries,
  onSelect,
  onClose,
}: {
  entry: PreviewEntry | null;
  entries: readonly PreviewEntry[];
  onSelect: (entry: PreviewEntry) => void;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<FilePreviewDocument>(),
    [revision, setRevision] = useState<number>(),
    [versions, setVersions] = useState<
      z.infer<typeof workspaceHistorySchema>['versions']
    >([]),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string>(),
    [converted, setConverted] = useState<FilePreviewResult>(),
    [sheet, setSheet] = useState(0),
    [offset, setOffset] = useState(0),
    [full, setFull] = useState(true),
    [sourceEntry, setSourceEntry] = useState<FileCenterEntry>(),
    [loaded, setLoaded] = useState<string>(),
    [associations, setAssociations] = useState<
      z.infer<typeof fileCenterAssociationsSchema>
    >({ associations: [], nextCursor: null });
  useEffect(() => {
    setRevision(entry?.revision);
    setVersions([]);
    setSheet(0);
    setOffset(0);
    setSourceEntry(undefined);
    setAssociations({ associations: [], nextCursor: null });
  }, [entry?.id, entry?.revision]);
  useEffect(
    () =>
      subscribeIdentityChanges(() => {
        setPreview(undefined);
        setConverted(undefined);
        setVersions([]);
        setSourceEntry(undefined);
        onClose();
      }),
    [onClose],
  );
  useEffect(() => {
    if (!entry || entry.kind === 'original') return;
    const abort = new AbortController();
    void api(
      `/me/file-center/entries/${entry.id}/versions`,
      { signal: abort.signal },
      workspaceHistorySchema,
    )
      .then((result) => setVersions(result.versions))
      .catch((err) => {
        if (!abort.signal.aborted) setError(describeError(err));
      });
    return () => abort.abort();
  }, [entry?.id, entry?.kind]);
  useEffect(() => {
    if (!entry) return;
    const abort = new AbortController();
    void api(
      `/me/file-center/entries/${entry.id}/associations?limit=50`,
      { signal: abort.signal },
      fileCenterAssociationsSchema,
    )
      .then((result) => {
        if (!abort.signal.aborted) setAssociations(result);
      })
      .catch((err) => {
        if (!abort.signal.aborted) setError(describeError(err));
      });
    return () => abort.abort();
  }, [entry?.id]);
  useEffect(() => {
    if (!entry || revision === undefined) return;
    const abort = new AbortController();
    setPending(true);
    setError(undefined);
    setPreview(undefined);
    setConverted(undefined);
    setLoaded(undefined);
    void (async () => {
      const fresh = (
        await api(
          `/me/file-center/entries/${entry.id}`,
          { signal: abort.signal },
          fileCenterDetailSchema,
        )
      ).entry;
      if (abort.signal.aborted) return;
      const history =
        revision !== fresh.revision
          ? (
              await api(
                `/me/file-center/entries/${entry.id}/versions`,
                { signal: abort.signal },
                workspaceHistorySchema,
              )
            ).versions
          : [];
      const old = history.find((version) => version.revision === revision);
      if (revision !== fresh.revision && !old?.available)
        throw new Error('所选历史版本不可读。');
      const version = old
        ? { ...fresh, ...old, updatedAt: old.createdAt }
        : fresh;
      if (!version.available)
        throw new Error('所选文件当前不可读，未使用旧预览缓存。');
      setSourceEntry(version);
      const name = fileName(fresh),
        kind = previewKind(name, version.mediaType),
        query = `revision=${revision}&sheet=${sheet}&offset=${offset}&limit=200`;
      if (kind === 'audio' || kind === 'video') {
        setLoaded(`${entry.id}:${revision}`);
        setPreview({
          kind,
          url: `/api/v1/me/file-center/entries/${entry.id}/content?revision=${revision}`,
        });
        return;
      }
      if (
        kind === 'office' ||
        (kind === 'table' && !isDelimitedFile(name, version.mediaType))
      ) {
        const result = await api(
          `/me/file-center/entries/${entry.id}/preview?${query}`,
          { signal: abort.signal, timeoutMs: 180_000 },
          filePreviewResultSchema,
        );
        if (abort.signal.aborted) return;
        if (
          result.sourceSha256 !== version.sha256 ||
          String(result.sourceBytes) !== version.bytes
        )
          throw new Error(
            '预览回执与所选原件/版本摘要不一致，未展示其他版本内容。',
          );
        setConverted(result);
        setLoaded(`${entry.id}:${revision}`);
        if (result.kind === 'pdf') {
          const bytes = Uint8Array.from(atob(result.contentBase64), (char) =>
            char.charCodeAt(0),
          );
          setPreview({
            kind: 'pdf',
            blob: new Blob([bytes], { type: 'application/pdf' }),
          });
        }
        return;
      }
      if (kind === 'unsupported') {
        setLoaded(`${entry.id}:${revision}`);
        return;
      }
      const actual = await readPreviewBlob(
        `/api/v1/me/file-center/entries/${entry.id}/content?revision=${revision}`,
        `${version.resourceId}:${revision}:${version.sha256}`,
        abort.signal,
      );
      if (abort.signal.aborted) return;
      const content = await prepareFilePreview(name, version.mediaType, actual);
      if (abort.signal.aborted) return;
      setPreview(content);
      setLoaded(`${entry.id}:${revision}`);
    })()
      .catch((err) => {
        if (!abort.signal.aborted) setError(describeError(err));
      })
      .finally(() => {
        if (!abort.signal.aborted) setPending(false);
      });
    return () => {
      abort.abort();
    };
  }, [entry?.id, revision, sheet, offset]);
  const selected = sourceEntry ?? entry,
    kind = selected
      ? previewKind(fileName(selected), selected.mediaType)
      : 'unsupported',
    index = entry ? entries.findIndex((item) => item.id === entry.id) : -1;
  return (
    <Modal
      title={selected ? fileName(selected) : '文件预览'}
      open={Boolean(entry)}
      footer={null}
      width={full ? '100vw' : 1000}
      style={{ top: full ? 0 : 24, paddingBottom: 0 }}
      styles={{
        body: {
          height: full ? 'calc(100dvh - 72px)' : '75vh',
          overflow: 'hidden',
        },
      }}
      className="file-preview-modal"
      zIndex={uiLayers.nestedDialog}
      onCancel={onClose}
      destroyOnHidden
    >
      <div className="file-preview-layout">
        <Space wrap className="file-preview-tools">
          <Button
            disabled={index <= 0}
            onClick={() => {
              const previous = entries[index - 1];
              if (previous) onSelect(previous);
            }}
          >
            上一文件
          </Button>
          <Button
            disabled={index < 0 || index >= entries.length - 1}
            onClick={() => {
              const next = entries[index + 1];
              if (next) onSelect(next);
            }}
          >
            下一文件
          </Button>
          <Button onClick={() => setFull((value) => !value)}>
            {full ? '退出全屏' : '全屏'}
          </Button>
          {entry ? (
            <Button
              onClick={() => {
                void downloadFileCenterEntry(entry, revision).catch((err) =>
                  setError(describeError(err)),
                );
              }}
            >
              下载原件
            </Button>
          ) : null}
          {entry && entry.kind !== 'original' && versions.length ? (
            <Select
              aria-label="预览文件版本"
              value={revision}
              style={{ minWidth: 200 }}
              options={versions.map((version) => ({
                value: version.revision,
                label: `版本 ${version.revision} · ${formatBeijingTime(version.createdAt)}`,
                disabled: !version.available,
              }))}
              onChange={(value) => {
                setRevision(value);
                setSheet(0);
                setOffset(0);
              }}
            />
          ) : null}
          {selected && (
            <>
              <FileKindTag kind={selected.kind} />
              <FileStatusTag
                status={selected.available ? 'available' : 'unavailable'}
              />
              <Typography.Text type="secondary">
                {humanFileSize(selected.bytes)}
              </Typography.Text>
            </>
          )}
        </Space>
        {selected ? (
          <details className="file-provenance">
            <summary>文件信息与关联</summary>
            <p>
              {selected.path} · SHA-256 {selected.sha256}
            </p>
            <p>
              修改主体：{selected.provenance.createdByName ?? '历史未记录'} ·{' '}
              <BeijingTime value={selected.updatedAt} detail />
              {selected.provenance.baseRevision
                ? ` · 基于版本 ${selected.provenance.baseRevision}`
                : ''}
            </p>
            {selected.provenance.messageId ? (
              <p>AI消息：{selected.provenance.messageId}</p>
            ) : selected.originMessageId ? (
              <p>原始消息：{selected.originMessageId}</p>
            ) : null}
            {associations.associations.map((item, index) => (
              <p key={index}>
                <a href={`#workspace?conversationId=${item.conversationId}`}>
                  {item.projectName ?? '个人'} /{' '}
                  {item.requirementTitle ?? '未关联需求'} /{' '}
                  {item.conversationTitle}
                </a>
                {item.messageId ? ` · 消息 ${item.messageId}` : ''}
              </p>
            ))}
            {associations.nextCursor && entry ? (
              <Button
                size="small"
                onClick={() => {
                  void api(
                    `/me/file-center/entries/${entry.id}/associations?limit=50&cursor=${encodeURIComponent(associations.nextCursor ?? '')}`,
                    {},
                    fileCenterAssociationsSchema,
                  )
                    .then((result) =>
                      setAssociations((current) => ({
                        associations: [
                          ...current.associations,
                          ...result.associations,
                        ],
                        nextCursor: result.nextCursor,
                      })),
                    )
                    .catch((err) => setError(describeError(err)));
                }}
              >
                加载更多关联
              </Button>
            ) : null}
          </details>
        ) : null}
        {selected?.provenance.sources.length ? (
          <details className="file-provenance">
            <summary>实际来源（{selected.provenance.sources.length}）</summary>
            {selected.provenance.sources.map((source) => (
              <p key={`${source.entryId}:${source.revision}`}>
                <Button
                  type="link"
                  size="small"
                  onClick={() => {
                    void api(
                      `/me/file-center/entries/${source.entryId}`,
                      {},
                      fileCenterDetailSchema,
                    )
                      .then((result) =>
                        onSelect({
                          ...result.entry,
                          revision: source.revision,
                        }),
                      )
                      .catch((err) => setError(describeError(err)));
                  }}
                >
                  {source.path} · 版本{source.revision}
                </Button>{' '}
                · {source.resourceId}
              </p>
            ))}
          </details>
        ) : null}
        <div className="file-preview-content">
          {pending ||
          (entry && loaded !== `${entry.id}:${revision}` && !error) ? (
            <Spin
              tip={
                kind === 'office' ? '正在安全生成页面预览…' : '读取所选文件…'
              }
            >
              <div className="file-preview-loading" />
            </Spin>
          ) : error ? (
            <Alert
              type="error"
              showIcon
              title="文件未能预览"
              description={error}
            />
          ) : converted?.kind === 'workbook' ? (
            <FileWorkbookPreview
              data={converted}
              pending={pending}
              onQuery={(index, offset) => {
                setSheet(index);
                setOffset(offset);
              }}
            />
          ) : preview ? (
            <>
              {converted?.notices.map((notice, index) => (
                <Alert key={index} type="info" title={notice} />
              ))}
              <FilePreviewContent key={loaded} preview={preview} />
            </>
          ) : (
            <Alert
              type="info"
              title="此格式尚无在线预览"
              description="原文件保持不变，可下载后使用兼容程序查看。"
            />
          )}
        </div>
      </div>
    </Modal>
  );
}
