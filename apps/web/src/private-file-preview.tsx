import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Button, Spin } from 'antd';
import {
  fileReceiptSchema,
  type FileMetadata,
} from '../../../packages/contracts/src/files';
import { api, describeError } from './api';
import { downloadPrivateFile, fetchPrivateFile } from './file-channel';
import { FilePreviewContent } from './file-preview-content';
import type { TablePreviewOptions } from './file-preview-text';
import {
  canPreviewOriginalFile,
  prepareFilePreview,
  type FilePreviewDocument,
} from './file-preview-data';
import {
  identityContextEpoch,
  subscribeIdentityChanges,
} from './identity-context';

const maximumPreviewBytes = 5 * 1024 * 1024;
const tooLarge = '文件超过 5 MiB 预览上限，可下载原件查看。';

interface PrivatePreviewState {
  fileId: string;
  loading: boolean;
  file?: FileMetadata;
  preview?: FilePreviewDocument;
  notice?: string;
  error?: string;
}

export function usePrivateFilePreview(fileId: string | null) {
  const [state, setState] = useState<PrivatePreviewState>();
  useEffect(() => {
    if (!fileId) {
      setState(undefined);
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    const unsubscribe = subscribeIdentityChanges(() => {
      controller.abort();
      setState({ fileId, loading: false });
    });
    const update = (fields: Partial<PrivatePreviewState>) => {
      if (!signal.aborted)
        setState((current) =>
          current?.fileId === fileId
            ? { ...current, ...fields }
            : { fileId, loading: true, ...fields },
        );
    };
    setState({ fileId, loading: true });
    void (async () => {
      try {
        const { file } = await api(
          `/files/${encodeURIComponent(fileId)}`,
          { signal },
          fileReceiptSchema,
        );
        if (signal.aborted) return;
        update({ file });
        if (file.status !== 'verified') {
          update({ notice: '文件尚未通过校验，暂不可预览或下载。' });
          return;
        }
        if (BigInt(file.bytes) > maximumPreviewBytes) {
          update({ notice: tooLarge });
          return;
        }
        if (!canPreviewOriginalFile(file.originalName, file.mediaType)) {
          update({ notice: '此处可下载原件查看该格式。' });
          return;
        }
        const blob = await fetchPrivateFile(fileId, signal);
        if (signal.aborted) return;
        if (blob.size > maximumPreviewBytes) {
          update({ notice: tooLarge });
          return;
        }
        const preview = await prepareFilePreview(
          file.originalName,
          file.mediaType,
          blob,
          maximumPreviewBytes,
        );
        if (preview) update({ preview });
      } catch (error) {
        update({ error: describeError(error) });
      } finally {
        update({ loading: false });
      }
    })();
    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [fileId]);

  const current = state?.fileId === fileId ? state : undefined;
  return {
    file: current?.file,
    preview: current?.preview,
    notice: current?.notice,
    error: current?.error,
    loading: Boolean(fileId) && (current?.loading ?? true),
    download: () => {
      if (current?.file?.status !== 'verified') return;
      const file = current.file;
      const epoch = identityContextEpoch();
      void downloadPrivateFile(file.id, file.originalName).catch((error) => {
        if (epoch !== identityContextEpoch()) return;
        setState((previous) =>
          previous?.fileId === file.id
            ? { ...previous, error: describeError(error) }
            : previous,
        );
      });
    },
  };
}

type PrivateFilePreview = ReturnType<typeof usePrivateFilePreview>;

export function PrivateFilePreviewDownload({
  state,
}: {
  state: PrivateFilePreview;
}) {
  return (
    <Button
      disabled={state.file?.status !== 'verified'}
      onClick={state.download}
    >
      下载原件
    </Button>
  );
}

export function PrivateFilePreviewContent({
  state,
  renderText,
  tableOptions,
}: {
  state: PrivateFilePreview;
  renderText?: ((text: string) => ReactNode) | undefined;
  tableOptions?: TablePreviewOptions | undefined;
}) {
  if (state.loading)
    return (
      <Spin tip="读取所选文件…">
        <div className="file-preview-loading" />
      </Spin>
    );
  if (state.error)
    return (
      <Alert
        type="error"
        showIcon
        title="文件未能预览"
        description={state.error}
      />
    );
  if (state.preview) {
    return (
      <div className="private-file-preview-content">
        <FilePreviewContent
          key={state.file?.id}
          preview={state.preview}
          renderText={renderText}
          tableOptions={tableOptions}
        />
      </div>
    );
  }
  return state.notice ? (
    <Alert type="info" showIcon title={state.notice} />
  ) : null;
}
