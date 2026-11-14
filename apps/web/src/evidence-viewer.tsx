import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Descriptions, Modal, Space, Typography } from 'antd';
import { fileReceiptSchema } from '../../../packages/contracts/src/files';
import type { FileMetadata } from '../../../packages/contracts/src/files';
import { api, describeError } from './api';
import { uiLayers } from './ui-layers';
import {
  downloadPrivateFile,
  fetchPrivateFile,
  isolatedHtml,
} from './file-channel';

export function EvidenceViewer({
  fileId,
  onClose,
}: {
  fileId: string | null;
  onClose: () => void;
}) {
  const [metadata, setMetadata] = useState<FileMetadata | null>(null);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState<string>();
  const [image, setImage] = useState<string>();
  const generation = useRef(0);
  const imageUrl = useRef<string | undefined>(undefined);
  useEffect(() => {
    const epoch = ++generation.current;
    const controller = new AbortController();
    if (imageUrl.current) {
      URL.revokeObjectURL(imageUrl.current);
      imageUrl.current = undefined;
    }
    setText(undefined);
    setImage(undefined);
    setMetadata(null);
    setError(undefined);
    if (!fileId) return;
    setLoading(true);
    void api(
      `/files/${fileId}`,
      { signal: controller.signal },
      fileReceiptSchema,
    )
      .then(async ({ file: result }) => {
        if (controller.signal.aborted || epoch !== generation.current) return;
        setMetadata(result);
        if (
          result.status !== 'verified' ||
          BigInt(result.bytes) > 5n * 1024n * 1024n
        )
          return;
        const supported =
          result.mediaType.startsWith('image/') ||
          [
            'text/html',
            'text/markdown',
            'text/plain',
            'text/csv',
            'application/json',
          ].includes(result.mediaType);
        if (!supported) return;
        const blob = await fetchPrivateFile(fileId);
        if (controller.signal.aborted || epoch !== generation.current) return;
        if (result.mediaType.startsWith('image/')) {
          imageUrl.current = URL.createObjectURL(blob);
          setImage(imageUrl.current);
        } else {
          const value = await blob.text();
          if (!controller.signal.aborted && epoch === generation.current)
            setText(value);
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted && epoch === generation.current)
          setError(describeError(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted && epoch === generation.current)
          setLoading(false);
      });
    return () => controller.abort();
  }, [fileId]);
  useEffect(
    () => () => {
      if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
    },
    [],
  );
  return (
    <Modal
      zIndex={uiLayers.evidence}
      open={fileId !== null}
      title={metadata?.originalName ?? '证据私有预览'}
      onCancel={onClose}
      width={1000}
      destroyOnHidden
      footer={
        <Space>
          <Button onClick={onClose}>关闭</Button>
          <Button
            disabled={!metadata}
            onClick={() => {
              if (metadata)
                void downloadPrivateFile(
                  metadata.id,
                  metadata.originalName,
                ).catch((failure: unknown) => setError(describeError(failure)));
            }}
          >
            下载完整原件
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          title="证据原件、采集完整性和业务结论分别核对"
          description="查看/下载都按当前权限校验。静态HTML预览受限隔离；字节 verified 不表示截图完整、内容可信或测试已通过。"
        />
        {error && <Alert type="error" showIcon title={error} />}
        {loading && (
          <Typography.Text role="status">读取授权证据…</Typography.Text>
        )}
        {metadata && (
          <Descriptions
            size="small"
            column={1}
            bordered
            items={[
              { key: 'id', label: '文件ID', children: metadata.id },
              { key: 'status', label: '字节状态', children: metadata.status },
              { key: 'bytes', label: '字节数', children: metadata.bytes },
              { key: 'hash', label: 'SHA-256', children: metadata.sha256 },
              { key: 'type', label: '类型声明', children: metadata.mediaType },
            ]}
          />
        )}
        {metadata && BigInt(metadata.bytes) > 5n * 1024n * 1024n && (
          <Typography.Paragraph type="secondary">
            文件超过当前5 MiB预览上限，请下载原件核对。
          </Typography.Paragraph>
        )}
        {image && (
          <img
            src={image}
            alt={`证据原件：${metadata?.originalName ?? ''}`}
            style={{ maxWidth: '100%', height: 'auto' }}
          />
        )}
        {text !== undefined &&
          (metadata?.mediaType === 'text/html' ? (
            <iframe
              title="证据HTML隔离静态预览"
              sandbox=""
              referrerPolicy="no-referrer"
              srcDoc={isolatedHtml(text)}
              style={{
                width: '100%',
                height: 480,
                border: '1px solid var(--border)',
              }}
            />
          ) : (
            <pre className="message-code">{text}</pre>
          ))}
        {metadata && !loading && !image && text === undefined && (
          <Typography.Paragraph type="secondary">
            此文件当前不提供正文预览。可下载可用原件，不将未解析内容标为已读取。
          </Typography.Paragraph>
        )}
      </Space>
    </Modal>
  );
}
