import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Alert, Button, Input, Segmented, Space, Spin, Typography } from 'antd';
import { isolatedHtml } from './file-channel';
import {
  humanFileSize,
  zipDirectory,
  type FilePreviewDocument,
} from './file-preview-data';
import {
  FileTextPreview,
  DelimitedPreview,
  type TablePreviewOptions,
} from './file-preview-text';
import { MarkdownDocumentPreview } from './markdown-document-preview';
import './file-preview-content.css';

const PdfPreview = lazy(() => import('./file-preview-pdf'));

function ImagePreview({ url, name }: { url: string; name: string }) {
  const [scale, setScale] = useState(1),
    [error, setError] = useState(false);
  return (
    <>
      <Space className="file-preview-tools">
        <Button
          onClick={() => setScale((value) => Math.max(0.25, value - 0.25))}
        >
          缩小
        </Button>
        <span>{Math.round(scale * 100)}%</span>
        <Button onClick={() => setScale((value) => Math.min(4, value + 0.25))}>
          放大
        </Button>
        <Button onClick={() => setScale(1)}>适应窗口</Button>
      </Space>
      {error ? (
        <Alert
          type="error"
          title="图片字节无法解码，格式可能损坏或当前浏览器不支持。"
        />
      ) : null}
      <div className="file-image-viewport">
        <img
          alt={name}
          src={url}
          style={{
            maxWidth: scale === 1 ? '100%' : 'none',
            width: scale === 1 ? 'auto' : `${scale * 100}%`,
          }}
          onError={() => setError(true)}
        />
      </div>
    </>
  );
}
function MediaPreview({ url, video }: { url: string; video: boolean }) {
  const [duration, setDuration] = useState<number>(),
    [error, setError] = useState(false);
  return (
    <div className="file-media-preview">
      {error ? (
        <Alert
          type="error"
          title="媒体无法播放"
          description="实际编码可能不受当前浏览器支持，或文件已损坏。请下载原件用兼容播放器打开。"
        />
      ) : null}
      {video ? (
        <video
          src={url}
          controls
          preload="metadata"
          onLoadedMetadata={(event) =>
            setDuration(event.currentTarget.duration)
          }
          onError={() => setError(true)}
        />
      ) : (
        <audio
          src={url}
          controls
          preload="metadata"
          onLoadedMetadata={(event) =>
            setDuration(event.currentTarget.duration)
          }
          onError={() => setError(true)}
        />
      )}
      <Typography.Text type="secondary">
        {duration && Number.isFinite(duration)
          ? `时长 ${Math.floor(duration / 60)}分${Math.floor(duration % 60)}秒`
          : '等待实际媒体元数据'}{' '}
        · 不自动播放或转写
      </Typography.Text>
    </div>
  );
}
function ZipPreview({ bytes }: { bytes: ArrayBuffer }) {
  const [query, setQuery] = useState('');
  const result = useMemo(() => {
    try {
      return { entries: zipDirectory(bytes), error: null };
    } catch (err) {
      return {
        entries: [],
        error: err instanceof Error ? err.message : '压缩包目录读取失败。',
      };
    }
  }, [bytes]);
  if (result.error) return <Alert type="error" title={result.error} />;
  return (
    <div className="file-zip-preview">
      <Alert type="info" title="只读ZIP目录，不解压、不执行内部文件。" />
      <Input.Search
        aria-label="搜索压缩包目录"
        placeholder="搜索目录"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="file-grid-scroll">
        <table className="file-data-grid">
          <thead>
            <tr>
              <th>文件路径</th>
              <th>原始大小</th>
              <th>压缩大小</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {result.entries
              .filter((item) =>
                item.name
                  .toLocaleLowerCase()
                  .includes(query.toLocaleLowerCase()),
              )
              .map((item, index) => (
                <tr key={index}>
                  <td>
                    {item.directory ? '📁 ' : '▤ '}
                    {item.name}
                  </td>
                  <td>{humanFileSize(item.bytes)}</td>
                  <td>{humanFileSize(item.compressedBytes)}</td>
                  <td>
                    {item.encrypted
                      ? '加密'
                      : item.unsafePath
                        ? '含不安全路径，仅展示'
                        : '只读'}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TextualPreview({
  preview,
  tableOptions,
}: {
  preview: Extract<FilePreviewDocument, { kind: 'text' }>;
  tableOptions?: TablePreviewOptions | undefined;
}) {
  const { format, text, extension } = preview;
  const [mode, setMode] = useState('view');
  const isolated = format === 'html' || format === 'svg';
  const html = useMemo(
    () => (isolated ? isolatedHtml(text) : ''),
    [isolated, text],
  );
  if (format === 'code' || format === 'structured') {
    return (
      <FileTextPreview
        text={text}
        extension={extension}
        preferStructure={format === 'structured'}
      />
    );
  }
  const viewLabel =
    format === 'markdown'
      ? '渲染效果'
      : format === 'table'
        ? '表格'
        : '静态预览';
  return (
    <div className="file-textual-preview">
      <Space wrap className="file-preview-tools">
        <Segmented
          value={mode}
          onChange={(value) => setMode(String(value))}
          options={[
            { value: 'view', label: viewLabel },
            { value: 'source', label: '源码' },
          ]}
        />
        {isolated && (
          <Typography.Text type="secondary">
            静态隔离展示，脚本、外链及页面动作均已禁用
          </Typography.Text>
        )}
      </Space>
      {mode === 'source' ? (
        <FileTextPreview text={text} extension={extension} />
      ) : format === 'markdown' ? (
        <MarkdownDocumentPreview text={text} />
      ) : format === 'table' ? (
        <DelimitedPreview
          text={text}
          extension={extension}
          options={tableOptions}
        />
      ) : (
        <iframe
          title="静态文件预览"
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={html}
          className="file-static-frame"
        />
      )}
    </div>
  );
}

function useObjectUrl(blob: Blob | undefined) {
  const [current, setCurrent] = useState<{ blob: Blob; url: string }>();
  useEffect(() => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    setCurrent({ blob, url });
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  return current?.blob === blob ? current?.url : undefined;
}

export function FilePreviewContent({
  preview,
  renderText,
  tableOptions,
}: {
  preview: FilePreviewDocument;
  renderText?: ((text: string) => ReactNode) | undefined;
  tableOptions?: TablePreviewOptions | undefined;
}) {
  const blob =
    preview.kind === 'image' ||
    ((preview.kind === 'audio' || preview.kind === 'video') &&
      'blob' in preview)
      ? preview.blob
      : undefined;
  const objectUrl = useObjectUrl(blob);
  switch (preview.kind) {
    case 'text':
      return renderText ? (
        renderText(preview.text)
      ) : (
        <TextualPreview preview={preview} tableOptions={tableOptions} />
      );
    case 'pdf':
      return (
        <Suspense fallback={<Spin />}>
          <PdfPreview blob={preview.blob} />
        </Suspense>
      );
    case 'image':
      return objectUrl && <ImagePreview url={objectUrl} name={preview.name} />;
    case 'video':
    case 'audio': {
      const url = 'url' in preview ? preview.url : objectUrl;
      return url && <MediaPreview url={url} video={preview.kind === 'video'} />;
    }
    case 'zip':
      return <ZipPreview bytes={preview.bytes} />;
  }
}
