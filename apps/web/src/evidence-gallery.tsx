import { useEffect, useState } from 'react';
import { Button, Empty, Tag } from 'antd';
import { FileTextOutlined, PictureOutlined } from '@ant-design/icons';
import type { z } from 'zod';
import type { evidenceManifestItemSchema } from '../../../packages/contracts/src/domain';
import { fileReceiptSchema } from '../../../packages/contracts/src/files';
import type { FileMetadata } from '../../../packages/contracts/src/files';
import { api, describeError } from './api';
import { fetchPrivateFile } from './file-channel';
import { subscribeIdentityChanges } from './identity-context';
import './result-evidence.css';

type EvidenceManifest = z.infer<typeof evidenceManifestItemSchema>;
export type EvidenceType = EvidenceManifest['type'];
export type EvidenceGalleryItem = {
  fileId: string;
  manifest: Pick<
    EvidenceManifest,
    'localEvidenceId' | 'type' | 'captureCompleteness' | 'capturedAt'
  >;
  originalName?: string;
  fileStatus?: string;
  fileAvailable?: boolean;
  source?: EvidenceManifest['source'];
};

export const evidenceTypeLabels: Record<EvidenceType, string> = {
  screenshot: '截图',
  conversation: '对话流',
  requestResponse: '接口证据',
  log: '日志',
  attachment: '附件',
  other: '其它证据',
};
const byteStatus: Record<string, string> = {
  verified: '可查看',
  pending: '已登记待上传',
  uploading: '上传中',
  failed: '上传失败',
  deleted: '已删除',
  unavailable: '暂不可查看',
};
const completenessLabels: Record<string, string> = {
  full: '完整采集',
  viewport: '视口截图',
  partial: '部分采集',
  summary: '摘要',
  interrupted: '采集中断',
  missing: '采集缺失',
};
export const evidencePreviewBytes = 5n * 1024n * 1024n;
export const isRasterEvidence = (mediaType: string) =>
  mediaType.startsWith('image/') && mediaType !== 'image/svg+xml';
const pageSize = 12;

function EvidenceCard({
  item,
  onOpen,
}: {
  item: EvidenceGalleryItem;
  onOpen: (item: EvidenceGalleryItem) => void;
}) {
  const [metadata, setMetadata] = useState<FileMetadata | null>(null);
  const [image, setImage] = useState<string>();
  const [error, setError] = useState<string>();
  const { fileId, fileAvailable } = item;
  useEffect(() => {
    const controller = new AbortController();
    let thumbnailUrl: string | undefined;
    const release = () => {
      controller.abort();
      if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
    };
    const unsubscribe = subscribeIdentityChanges(() => {
      release();
      setMetadata(null);
      setImage(undefined);
      setError(undefined);
    });
    setMetadata(null);
    setImage(undefined);
    setError(undefined);
    if (fileAvailable !== false)
      void api(
        `/files/${encodeURIComponent(fileId)}`,
        { signal: controller.signal },
        fileReceiptSchema,
      )
        .then(async ({ file }) => {
          if (controller.signal.aborted) return;
          setMetadata(file);
          if (
            file.status !== 'verified' ||
            !isRasterEvidence(file.mediaType) ||
            BigInt(file.bytes) > evidencePreviewBytes
          )
            return;
          const blob = await fetchPrivateFile(fileId, controller.signal);
          if (controller.signal.aborted) return;
          thumbnailUrl = URL.createObjectURL(blob);
          setImage(thumbnailUrl);
        })
        .catch((failure: unknown) => {
          if (!controller.signal.aborted) setError(describeError(failure));
        });
    return () => {
      release();
      unsubscribe();
    };
  }, [fileId, fileAvailable]);
  const title =
    metadata?.originalName ??
    item.originalName ??
    item.manifest.localEvidenceId;
  const status =
    fileAvailable === false
      ? item.fileStatus && item.fileStatus !== 'verified'
        ? item.fileStatus
        : 'unavailable'
      : (metadata?.status ?? (error ? 'unavailable' : item.fileStatus));
  return (
    <article className="result-evidence-card">
      <button
        type="button"
        className="result-evidence-trigger"
        onClick={() => onOpen(item)}
        disabled={fileAvailable === false}
        aria-label={`预览${evidenceTypeLabels[item.manifest.type]} ${title}`}
      >
        <span className="result-evidence-thumbnail">
          {image ? (
            <img src={image} alt={title} />
          ) : (
            <span className="result-evidence-type">
              {item.manifest.type === 'screenshot' ? (
                <PictureOutlined />
              ) : (
                <FileTextOutlined />
              )}
              {evidenceTypeLabels[item.manifest.type]}
            </span>
          )}
        </span>
        <span className="result-evidence-title" title={title}>
          {title}
        </span>
      </button>
      <div className="result-evidence-card-meta">
        <Tag
          color={
            status === 'verified'
              ? 'success'
              : status === 'failed'
                ? 'error'
                : 'default'
          }
        >
          {status ? (byteStatus[status] ?? status) : '查询状态中'}
        </Tag>
        <span>
          {completenessLabels[item.manifest.captureCompleteness] ??
            item.manifest.captureCompleteness}
        </span>
        {item.source === 'manualAddition' && <span>人工补证</span>}
        {item.source === 'derived' && <span>派生证据</span>}
        {item.manifest.capturedAt && (
          <time
            dateTime={item.manifest.capturedAt}
            title={item.manifest.capturedAt}
          >
            {new Date(item.manifest.capturedAt).toLocaleTimeString('zh-CN')}
          </time>
        )}
      </div>
      {error && !metadata && (
        <small className="result-evidence-file-error" title={error}>
          {error}
        </small>
      )}
    </article>
  );
}

export function EvidenceGallery({
  items,
  onOpen,
  emptyText = '没有已登记的证据',
}: {
  items: readonly EvidenceGalleryItem[];
  onOpen: (item: EvidenceGalleryItem) => void;
  emptyText?: string;
}) {
  const [limit, setLimit] = useState(pageSize);
  if (!items.length)
    return (
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} />
    );
  return (
    <div className="result-evidence-gallery-section">
      <div className="result-evidence-gallery">
        {items.slice(0, limit).map((item) => (
          <EvidenceCard
            key={`${item.fileId}:${item.manifest.localEvidenceId}`}
            item={item}
            onOpen={onOpen}
          />
        ))}
      </div>
      {items.length > limit && (
        <Button onClick={() => setLimit((count) => count + pageSize)}>
          加载更多证据（已展示 {limit}/{items.length}）
        </Button>
      )}
    </div>
  );
}
