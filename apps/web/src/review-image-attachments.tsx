import { useEffect, useRef, useState } from 'react';
import type { ClipboardEvent, ReactNode } from 'react';
import { Alert, Button, Modal, Space, Typography } from 'antd';
import { CloseOutlined, PictureOutlined } from '@ant-design/icons';
import { previewUploadMediaType } from '../../../packages/contracts/src/file-preview';
import {
  problemReviewImageMediaTypeSchema,
  reviewEvidenceMaxImages,
} from '../../../packages/contracts/src/issues';
import { describeError } from './api';
import { fetchPrivateFile, uploadProjectFile } from './file-channel';
import { subscribeIdentityChanges } from './identity-context';
import './review-image-attachments.css';

const imageTypes = problemReviewImageMediaTypeSchema.options;
const isReviewImage = (mediaType: string) =>
  problemReviewImageMediaTypeSchema.safeParse(mediaType).success;

interface ReviewImageAttachmentsProps {
  projectId: string;
  runId: string;
  disabled?: boolean;
  value: readonly string[];
  onChange: (ids: string[]) => void;
  onBusyChange: (busy: boolean) => void;
  children?: ReactNode;
}

interface ImageDraft {
  key: string;
  file: File;
  url: string;
  status: 'queued' | 'uploading' | 'verified' | 'failed';
  fileId?: string | undefined;
  error?: string | undefined;
}

function ReviewThumbnail({ url, alt }: { url: string; alt: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="review-image-preview"
        aria-label={`查看原件 ${alt}`}
        type="button"
        onClick={() => setOpen(true)}
      >
        <img src={url} alt="" />
      </button>
      {open && (
        <Modal
          open
          centered
          width={960}
          title={alt}
          footer={null}
          onCancel={() => setOpen(false)}
        >
          <img className="review-image-original" src={url} alt={alt} />
        </Modal>
      )}
    </>
  );
}

function StoredThumbnail({ fileId }: { fileId: string }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    const invalidate = () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = undefined;
    };
    const unsubscribe = subscribeIdentityChanges(() => {
      invalidate();
      setUrl(undefined);
    });
    setUrl(undefined);
    void fetchPrivateFile(fileId, controller.signal).then(
      (blob) => {
        if (controller.signal.aborted || !isReviewImage(blob.type)) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      },
      () => {
        if (!controller.signal.aborted) setUrl(undefined);
      },
    );
    return () => {
      invalidate();
      unsubscribe();
    };
  }, [fileId]);
  return url ? (
    <ReviewThumbnail url={url} alt="已上传的复核截图" />
  ) : (
    <PictureOutlined aria-label="缩略图暂不可查看" />
  );
}

function AttachmentsEditor(props: ReviewImageAttachmentsProps) {
  const { projectId, disabled = false, value, children } = props;
  const [drafts, setDrafts] = useState<ImageDraft[]>([]);
  const [inputError, setInputError] = useState<string>();
  const filesInput = useRef<HTMLInputElement>(null);
  const liveDrafts = useRef<ImageDraft[]>([]);
  const uploads = useRef(new Map<string, AbortController>());
  const draining = useRef(false);
  const currentValue = useRef(value);
  const propsRef = useRef(props);
  useEffect(() => {
    propsRef.current = props;
    currentValue.current = props.value;
  }, [props]);

  function releaseDrafts() {
    for (const controller of uploads.current.values()) controller.abort();
    uploads.current.clear();
    for (const draft of liveDrafts.current) URL.revokeObjectURL(draft.url);
    liveDrafts.current = [];
  }

  useEffect(() => {
    const unsubscribe = subscribeIdentityChanges(() => {
      releaseDrafts();
      setDrafts([]);
      setInputError(undefined);
      currentValue.current = [];
      propsRef.current.onChange([]);
      propsRef.current.onBusyChange(false);
    });
    return () => {
      releaseDrafts();
      unsubscribe();
    };
  }, []);

  const inherited = value.filter(
    (id) => !drafts.some((draft) => draft.fileId === id),
  );

  function update(next: ImageDraft[], removeId?: string) {
    const carried = currentValue.current.filter(
      (id) =>
        id !== removeId && !liveDrafts.current.some((d) => d.fileId === id),
    );
    liveDrafts.current = next;
    setDrafts(next);
    const ids = [
      ...new Set([
        ...carried,
        ...next.flatMap((entry) => (entry.fileId ? [entry.fileId] : [])),
      ]),
    ];
    currentValue.current = ids;
    propsRef.current.onChange(ids);
    propsRef.current.onBusyChange(
      next.some((entry) => entry.status !== 'verified'),
    );
  }

  async function upload(draft: ImageDraft) {
    const controller = new AbortController();
    const { signal } = controller;
    uploads.current.set(draft.key, controller);
    const current = () => uploads.current.get(draft.key) === controller;
    const change = (fields: Partial<ImageDraft>) => {
      if (!current()) return;
      update(
        liveDrafts.current.map((entry) =>
          entry.key === draft.key ? { ...entry, ...fields } : entry,
        ),
      );
    };
    try {
      const receipt = await uploadProjectFile(
        projectId,
        draft.file,
        draft.key,
        undefined,
        { signal, isCurrent: current },
      );
      change({ status: 'verified', fileId: receipt.id, error: undefined });
    } catch (err) {
      if (!signal.aborted)
        change({ status: 'failed', error: describeError(err) });
    } finally {
      if (current()) uploads.current.delete(draft.key);
    }
  }

  async function drain() {
    if (draining.current) return;
    draining.current = true;
    try {
      for (
        let next = liveDrafts.current.find(
          (entry) => entry.status === 'queued',
        );
        next;
        next = liveDrafts.current.find((entry) => entry.status === 'queued')
      ) {
        update(
          liveDrafts.current.map((entry) =>
            entry.key === next?.key ? { ...entry, status: 'uploading' } : entry,
          ),
        );
        await upload(next);
      }
    } finally {
      draining.current = false;
    }
  }

  function add(files: readonly File[]) {
    if (disabled) return;
    const available =
      reviewEvidenceMaxImages - inherited.length - liveDrafts.current.length;
    const supported = files.filter(
      (file) =>
        file.size > 0 &&
        isReviewImage(previewUploadMediaType(file.name, file.type)),
    );
    if (supported.length !== files.length)
      setInputError('复核截图支持 PNG、JPEG 和 WebP 图片。');
    else if (supported.length > available)
      setInputError(`一次复核最多附 ${reviewEvidenceMaxImages} 张截图。`);
    else setInputError(undefined);
    const next = supported.slice(0, Math.max(available, 0)).map((file) => ({
      key: crypto.randomUUID(),
      file,
      url: URL.createObjectURL(file),
      status: 'queued' as const,
    }));
    if (next.length === 0) return;
    update([...liveDrafts.current, ...next]);
    void drain();
  }

  function onPaste(event: ClipboardEvent<HTMLDivElement>) {
    const files = Array.from(event.clipboardData.items).flatMap((item) => {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) return [];
      const file = item.getAsFile();
      return file ? [file] : [];
    });
    if (disabled || !files.length) return;
    if (!event.clipboardData.getData('text/plain')) event.preventDefault();
    add(files);
  }

  function remove(draft: ImageDraft) {
    uploads.current.get(draft.key)?.abort();
    uploads.current.delete(draft.key);
    URL.revokeObjectURL(draft.url);
    update(liveDrafts.current.filter((entry) => entry.key !== draft.key));
    setInputError(undefined);
  }

  return (
    <div className="review-image-composer" onPaste={onPaste}>
      {children}
      <Space size={8} wrap>
        <Button
          size="small"
          icon={<PictureOutlined />}
          onClick={() => filesInput.current?.click()}
          disabled={
            disabled ||
            drafts.length + inherited.length >= reviewEvidenceMaxImages
          }
        >
          添加复核截图
        </Button>
        <Typography.Text type="secondary" className="review-image-hint">
          可在说明框内粘贴截图
        </Typography.Text>
      </Space>
      <input
        ref={filesInput}
        className="review-image-file-input"
        type="file"
        accept={imageTypes.join(',')}
        aria-label="选择复核截图"
        multiple
        disabled={disabled}
        onChange={(event) => {
          add(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = '';
        }}
      />
      {inputError && <Alert type="warning" showIcon title={inputError} />}
      {(drafts.length > 0 || inherited.length > 0) && (
        <ul className="review-image-list" aria-label="复核截图附件">
          {inherited.map((id) => (
            <li className="review-image-tile" key={id}>
              <div className="review-image-thumb">
                <StoredThumbnail fileId={id} />
              </div>
              <Button
                type="text"
                size="small"
                className="review-image-remove"
                icon={<CloseOutlined />}
                aria-label="移除复核截图"
                disabled={disabled}
                onClick={() => update(liveDrafts.current, id)}
              />
              <span className="review-image-state">已上传</span>
            </li>
          ))}
          {drafts.map((draft) => (
            <li className="review-image-tile" key={draft.key}>
              <div className="review-image-thumb">
                <ReviewThumbnail url={draft.url} alt={draft.file.name} />
              </div>
              <Button
                type="text"
                size="small"
                className="review-image-remove"
                icon={<CloseOutlined />}
                aria-label={`移除 ${draft.file.name}`}
                disabled={disabled}
                onClick={() => remove(draft)}
              />
              {draft.status === 'failed' ? (
                <Button
                  size="small"
                  type="link"
                  danger
                  className="review-image-retry"
                  title={draft.error ?? ''}
                  disabled={disabled}
                  onClick={() => {
                    update(
                      liveDrafts.current.map((entry) =>
                        entry.key === draft.key
                          ? { ...entry, error: undefined, status: 'queued' }
                          : entry,
                      ),
                    );
                    void drain();
                  }}
                >
                  上传失败 · 重试
                </Button>
              ) : (
                <span className="review-image-state" role="status">
                  {draft.status === 'verified'
                    ? '已上传'
                    : draft.status === 'queued'
                      ? '待上传'
                      : '上传校验中'}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {drafts.some((draft) => draft.status === 'failed') && (
        <Alert type="warning" showIcon title="请重试失败截图或移除后提交。" />
      )}
    </div>
  );
}

export function ReviewImageAttachments(props: ReviewImageAttachmentsProps) {
  return (
    <AttachmentsEditor key={`${props.projectId}:${props.runId}`} {...props} />
  );
}
