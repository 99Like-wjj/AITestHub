import { Button, Collapse, Descriptions, Space } from 'antd';
import { uiLayers } from './ui-layers';
import type { EvidenceType } from './evidence-gallery';
import { evidenceTypeLabels } from './evidence-gallery';
import { DetailDrawer } from './detail-drawer';
import {
  PrivateFilePreviewContent,
  PrivateFilePreviewDownload,
  usePrivateFilePreview,
} from './private-file-preview';
import { previewMediaType } from './file-preview-data';
import {
  EvidenceSourceTag,
  FileStatusTag,
  type EvidenceSource,
} from './file-display-status';
import { EvidenceConversation, EvidenceRequestResponse } from './evidence-text';

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
  const state = usePrivateFilePreview(fileId);
  const metadata = state.file;
  const mediaType = previewMediaType(metadata?.mediaType ?? '');
  const renderText =
    mediaType === 'text/event-stream' ||
    (evidenceType === 'conversation' && mediaType === 'application/json')
      ? (text: string) => (
          <EvidenceConversation
            key={fileId}
            text={text}
            mediaType={mediaType}
          />
        )
      : evidenceType === 'requestResponse' && mediaType === 'application/json'
        ? (text: string) => <EvidenceRequestResponse text={text} />
        : undefined;
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
            status={
              metadata?.status ?? (state.error ? 'unavailable' : undefined)
            }
          />
        </Space>
      }
      onClose={onClose}
      footer={
        <Space>
          <Button onClick={onClose}>关闭</Button>
          <PrivateFilePreviewDownload state={state} />
        </Space>
      }
    >
      <div className="private-file-preview-layout">
        <PrivateFilePreviewContent
          state={state}
          renderText={renderText}
          tableOptions={{
            firstRowHeader: true,
            maxDataRows: 100,
            maxColumns: 40,
          }}
        />
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
      </div>
    </DetailDrawer>
  );
}
