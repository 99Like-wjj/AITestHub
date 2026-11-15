import { useEffect, useState, type ReactNode } from 'react';
import { Tooltip } from 'antd';
import { FileOutlined, LoadingOutlined } from '@ant-design/icons';
import { fileReceiptSchema } from '../../../packages/contracts/src/files';
import type { FileMetadata } from '../../../packages/contracts/src/files';
import { api, describeError } from './api';
import { fetchPrivateFile } from './file-channel';
import { currentIdentityOwner, identityContextEpoch } from './identity-context';
import './workspace-composer-references.css';

const previewImageTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);
export const workspaceReferencePreviewMaximumBytes = 5n * 1024n * 1024n;

export function workspaceReferencePreviewAllowed(
  file: Pick<FileMetadata, 'ownerScope' | 'status' | 'mediaType' | 'bytes'>,
) {
  return (
    file.ownerScope === 'personal' &&
    file.status === 'verified' &&
    previewImageTypes.has(file.mediaType) &&
    BigInt(file.bytes) > 0n &&
    BigInt(file.bytes) <= workspaceReferencePreviewMaximumBytes
  );
}

interface PreviewState {
  fileId: string;
  ownerId: string;
  epoch: number;
  image: string | null;
  loading: boolean;
  error: string | null;
}

/** Private attachment pixels stay in memory and are fenced by the same identity
 * epoch as their metadata and bytes. No preview URL becomes draft metadata. */
export function WorkspaceReferencePreview({
  fileId,
  label,
  description,
  className = '',
  fallback,
  enabled = true,
}: {
  fileId: string | null;
  label: string;
  description?: string;
  className?: string;
  fallback?: ReactNode;
  enabled?: boolean;
}) {
  const ownerId = currentIdentityOwner();
  const epoch = identityContextEpoch();
  const [preview, setPreview] = useState<PreviewState>();
  const visible =
    enabled &&
    preview &&
    preview.fileId === fileId &&
    preview.ownerId === ownerId &&
    preview.epoch === epoch
      ? preview
      : undefined;
  useEffect(() => {
    setPreview(undefined);
    if (!enabled || !fileId || !ownerId) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    const scope = { fileId, ownerId, epoch };
    const current = () =>
      !controller.signal.aborted &&
      epoch === identityContextEpoch() &&
      ownerId === currentIdentityOwner();
    setPreview({ ...scope, image: null, loading: true, error: null });
    void api(
      `/files/${encodeURIComponent(fileId)}`,
      { signal: controller.signal },
      fileReceiptSchema,
    )
      .then(async ({ file }) => {
        if (!current()) return;
        if (!workspaceReferencePreviewAllowed(file)) {
          setPreview({ ...scope, image: null, loading: false, error: null });
          return;
        }
        const blob = await fetchPrivateFile(fileId);
        if (!current()) return;
        if (
          !previewImageTypes.has(blob.type) ||
          BigInt(blob.size) !== BigInt(file.bytes) ||
          BigInt(blob.size) > workspaceReferencePreviewMaximumBytes
        )
          throw new Error('附件不是可显示的已验证小型图片。');
        objectUrl = URL.createObjectURL(blob);
        setPreview({ ...scope, image: objectUrl, loading: false, error: null });
      })
      .catch((failure: unknown) => {
        if (current())
          setPreview({
            ...scope,
            image: null,
            loading: false,
            error: describeError(failure),
          });
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fileId, ownerId, epoch, enabled]);
  return (
    <Tooltip
      title={
        visible?.error
          ? `${label}${description ? `；${description}` : ''}；缩略图未显示：${visible.error}`
          : `${label}${description ? `；${description}` : ''}`
      }
    >
      <span
        className={`workspace-reference-preview ${className}`}
        aria-busy={visible?.loading || undefined}
      >
        {visible?.image ? (
          <img
            src={visible.image}
            alt={label}
            onError={() => {
              if (
                !fileId ||
                !ownerId ||
                ownerId !== currentIdentityOwner() ||
                epoch !== identityContextEpoch()
              )
                return;
              setPreview({
                fileId,
                ownerId,
                epoch,
                image: null,
                loading: false,
                error: '图片无法解码，原引用仍保留。',
              });
            }}
          />
        ) : visible?.loading ? (
          <LoadingOutlined aria-label="读取附件缩略图" />
        ) : (
          (fallback ?? <FileOutlined aria-label={label} />)
        )}
      </span>
    </Tooltip>
  );
}
