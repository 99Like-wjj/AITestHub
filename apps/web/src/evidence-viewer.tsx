import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Collapse, Descriptions, Space, Typography } from 'antd';
import { fileReceiptSchema } from '../../../packages/contracts/src/files';
import type { FileMetadata } from '../../../packages/contracts/src/files';
import { api, describeError } from './api';
import { uiLayers } from './ui-layers';
import {
  downloadPrivateFile,
  fetchPrivateFile,
  isolatedHtml,
} from './file-channel';
import { subscribeIdentityChanges } from './identity-context';
import { evidencePreviewBytes, isRasterEvidence } from './evidence-gallery';
import type { EvidenceType } from './evidence-gallery';
import { evidenceTypeLabels } from './evidence-gallery';
import { DetailDrawer } from './detail-drawer';
import {
  EvidenceSourceTag,
  FileStatusTag,
  type EvidenceSource,
} from './file-display-status';
import {
  EvidenceConversation,
  EvidenceDelimited,
  EvidenceJson,
} from './evidence-text';

export function EvidenceViewer({
  fileId,
  evidenceType,
  source,
  onClose,
}: {
  fileId: string | null;
  evidenceType?: EvidenceType | undefined;
  source?: EvidenceSource | undefined;
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
    setLoading(false);
    if (!fileId) return;
    const unsubscribe = subscribeIdentityChanges(() => {
      controller.abort();
      setMetadata(null);
      setText(undefined);
      setImage(undefined);
      setError(undefined);
      setLoading(false);
      if (imageUrl.current) {
        URL.revokeObjectURL(imageUrl.current);
        imageUrl.current = undefined;
      }
    });
    setLoading(true);
    void api(
      `/files/${encodeURIComponent(fileId)}`,
      { signal: controller.signal },
      fileReceiptSchema,
    )
      .then(async ({ file: result }) => {
        if (controller.signal.aborted || epoch !== generation.current) return;
        setMetadata(result);
        if (
          result.status !== 'verified' ||
          BigInt(result.bytes) > evidencePreviewBytes
        )
          return;
        const supported =
          isRasterEvidence(result.mediaType) ||
          [
            'text/html',
            'text/markdown',
            'text/plain',
            'text/csv',
            'application/json',
            'text/event-stream',
            'text/tab-separated-values',
            'application/x-ndjson',
          ].includes(result.mediaType);
        if (!supported) return;
        const blob = await fetchPrivateFile(fileId, controller.signal);
        if (controller.signal.aborted || epoch !== generation.current) return;
        if (isRasterEvidence(result.mediaType)) {
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
    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [fileId]);
  useEffect(
    () => () => {
      if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
    },
    [],
  );
  const type = metadata?.mediaType;
  return (
    <DetailDrawer
      wide
      zIndex={uiLayers.evidence}
      open={fileId !== null}
      title={metadata?.originalName ?? '证据私有预览'}
      meta={
        <Space wrap>
          {evidenceType && <span>{evidenceTypeLabels[evidenceType]}</span>}
          {source && <EvidenceSourceTag source={source} />}
          <FileStatusTag
            status={metadata?.status ?? (error ? 'unavailable' : undefined)}
          />
        </Space>
      }
      onClose={onClose}
      footer={
        <Space>
          <Button onClick={onClose}>关闭</Button>
          <Button
            disabled={metadata?.status !== 'verified'}
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
        {error && <Alert type="error" showIcon title={error} />}
        {loading && (
          <Typography.Text role="status">读取授权证据…</Typography.Text>
        )}
        {metadata && BigInt(metadata.bytes) > evidencePreviewBytes && (
          <Typography.Paragraph type="secondary">
            文件超过当前5 MiB预览上限，请下载原件核对。
          </Typography.Paragraph>
        )}
        {image && (
          <img
            src={image}
            alt={`证据原件：${metadata?.originalName ?? ''}`}
            className="result-evidence-original-image"
          />
        )}
        {text !== undefined &&
          (type === 'text/html' ? (
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
          ) : type === 'text/event-stream' ||
            (evidenceType === 'conversation' && type === 'application/json') ? (
            <EvidenceConversation
              key={fileId}
              text={text}
              mediaType={type ?? ''}
            />
          ) : type === 'text/csv' || type === 'text/tab-separated-values' ? (
            <EvidenceDelimited
              key={fileId}
              text={text}
              delimiter={type === 'text/tab-separated-values' ? '\t' : ','}
            />
          ) : type === 'application/json' ? (
            <EvidenceJson
              text={text}
              split={evidenceType === 'requestResponse'}
            />
          ) : (
            <pre className="message-code">{text}</pre>
          ))}
        {metadata &&
          !loading &&
          !image &&
          text === undefined &&
          BigInt(metadata.bytes) <= evidencePreviewBytes && (
            <Typography.Paragraph type="secondary">
              {metadata.status === 'verified'
                ? '可下载原件查看此文件格式。'
                : '文件字节尚未验证，等待上传或核对上传状态。'}
            </Typography.Paragraph>
          )}
        {metadata && (
          <Collapse
            items={[
              {
                key: 'metadata',
                label: '文件来源与校验信息',
                children: (
                  <Descriptions
                    size="small"
                    column={1}
                    bordered
                    items={[
                      { key: 'id', label: '文件 ID', children: metadata.id },
                      {
                        key: 'status',
                        label: '字节状态',
                        children: <FileStatusTag status={metadata.status} />,
                      },
                      {
                        key: 'bytes',
                        label: '字节数',
                        children: metadata.bytes,
                      },
                      {
                        key: 'hash',
                        label: 'SHA-256',
                        children: metadata.sha256,
                      },
                      {
                        key: 'type',
                        label: '媒体类型',
                        children: metadata.mediaType,
                      },
                    ]}
                  />
                ),
              },
            ]}
          />
        )}
      </Space>
    </DetailDrawer>
  );
}
