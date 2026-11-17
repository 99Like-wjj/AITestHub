import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, InputNumber, Space, Spin } from 'antd';
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
  type RenderTask,
} from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  normalizePdfSearchText,
  pdfSearchPageText,
} from './file-preview-pdf-search';

GlobalWorkerOptions.workerSrc = pdfWorker;
function PdfCanvas({
  document,
  page,
  scale,
  thumbnail = false,
  onClick,
}: {
  document: PDFDocumentProxy;
  page: number;
  scale: number;
  thumbnail?: boolean;
  onClick?: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    [error, setError] = useState<string>();
  useEffect(() => {
    let current = true,
      render: RenderTask | undefined;
    setError(undefined);
    void document
      .getPage(page)
      .then(async (source) => {
        if (!current || !canvas.current) return;
        const initial = source.getViewport({ scale });
        const guard = Math.min(
          1,
          Math.sqrt(8_000_000 / (initial.width * initial.height)),
        );
        const viewport = source.getViewport({ scale: scale * guard }),
          context = canvas.current.getContext('2d');
        if (!context) throw new Error('无法创建PDF画布。');
        canvas.current.width = viewport.width;
        canvas.current.height = viewport.height;
        render = source.render({
          canvas: canvas.current,
          canvasContext: context,
          viewport,
        });
        await render.promise;
      })
      .catch((err) => {
        if (current)
          setError(err instanceof Error ? err.message : 'PDF页面渲染失败。');
      });
    return () => {
      current = false;
      render?.cancel();
    };
  }, [document, page, scale]);
  return (
    <div className={thumbnail ? 'file-pdf-thumbnail' : 'file-pdf-page'}>
      {error ? <Alert type="warning" title={error} /> : null}
      <canvas
        ref={canvas}
        aria-label={`PDF 第${page}页${thumbnail ? '缩略图' : ''}`}
        onClick={onClick}
      />
      {thumbnail ? <span>第 {page} 页</span> : null}
    </div>
  );
}
export default function FilePdfPreview({ blob }: { blob: Blob }) {
  const [document, setDocument] = useState<PDFDocumentProxy>(),
    [error, setError] = useState<string>(),
    [page, setPage] = useState(1),
    [scale, setScale] = useState(1),
    [query, setQuery] = useState(''),
    [searching, setSearching] = useState(false),
    [matches, setMatches] = useState<number[]>([]),
    [match, setMatch] = useState(0),
    [notice, setNotice] = useState<string>();
  const searchGeneration = useRef(0),
    textCache = useRef(new Map<number, string>());
  const viewportElement = useRef<HTMLDivElement>(null);
  const fit = () => {
    if (!document || !viewportElement.current) return;
    const width = viewportElement.current.clientWidth;
    void document
      .getPage(page)
      .then((source) =>
        setScale(
          Math.max(
            0.25,
            Math.min(3, (width - 40) / source.getViewport({ scale: 1 }).width),
          ),
        ),
      );
  };
  useEffect(() => {
    setDocument(undefined);
    setError(undefined);
    setNotice(undefined);
    setMatches([]);
    setQuery('');
    setScale(1);
    setSearching(false);
    let active = true;
    let document: PDFDocumentProxy | undefined;
    const loading = blob.arrayBuffer().then((bytes) => {
      if (!active) return;
      const task = getDocument({
        data: new Uint8Array(bytes),
        useSystemFonts: true,
        disableAutoFetch: true,
        disableStream: true,
      });
      void task.promise
        .then((value) => {
          document = value;
          if (active) {
            setDocument(value);
            setPage(1);
            setError(undefined);
          }
        })
        .catch((err) => {
          if (active)
            setError(
              err instanceof Error
                ? err.message
                : 'PDF加载失败，可能加密或损坏。',
            );
        });
      return task;
    });
    return () => {
      active = false;
      searchGeneration.current++;
      textCache.current.clear();
      void loading.then((task) => task?.destroy()).catch(() => undefined);
      void document?.cleanup().catch(() => undefined);
    };
  }, [blob]);
  async function search() {
    const needle = normalizePdfSearchText(query);
    if (!document || !needle) return;
    const generation = ++searchGeneration.current;
    setSearching(true);
    setNotice(undefined);
    const found: number[] = [];
    let textPages = 0;
    try {
      for (let index = 1; index <= Math.min(document.numPages, 500); index++) {
        if (generation !== searchGeneration.current) return;
        let text = textCache.current.get(index);
        if (text === undefined) {
          const content = await (
            await document.getPage(index)
          ).getTextContent();
          text = normalizePdfSearchText(pdfSearchPageText(content.items));
          textCache.current.set(index, text);
        }
        if (text.trim()) textPages++;
        if (text.includes(needle)) found.push(index);
      }
      if (generation !== searchGeneration.current) return;
      setMatches(found);
      setMatch(0);
      if (found[0]) setPage(found[0]);
      setNotice(
        !textPages
          ? '该读取范围没有文字层，可能是扫描页；文字搜索不可用，不表示图中没有相关内容。'
          : `${found.length} 页匹配${document.numPages > 500 ? '；仅搜索前500页' : ''}`,
      );
    } catch {
      if (generation === searchGeneration.current)
        setNotice('部分页面文本读取失败，搜索结果不完整。');
    } finally {
      if (generation === searchGeneration.current) setSearching(false);
    }
  }
  const next = (direction: number) => {
    if (!matches.length) return;
    const index = (match + direction + matches.length) % matches.length;
    setMatch(index);
    setPage(matches[index] ?? 1);
  };
  if (error)
    return (
      <Alert type="error" showIcon title="PDF未能预览" description={error} />
    );
  if (!document)
    return (
      <Spin tip="读取PDF页面…">
        <div className="file-preview-loading" />
      </Spin>
    );
  const nearby = Array.from(
    { length: Math.min(12, document.numPages) },
    (_, index) =>
      Math.max(1, Math.min(page - 4, document.numPages - 11)) + index,
  ).filter((value) => value <= document.numPages);
  return (
    <div className="file-pdf-preview">
      <Space wrap className="file-preview-tools">
        <Button
          disabled={page === 1}
          onClick={() => setPage((value) => value - 1)}
        >
          上一页
        </Button>
        <InputNumber
          aria-label="PDF页码"
          min={1}
          max={document.numPages}
          value={page}
          onChange={(value) => {
            if (value) setPage(value);
          }}
        />
        <span>/ {document.numPages} 页</span>
        <Button
          disabled={page === document.numPages}
          onClick={() => setPage((value) => value + 1)}
        >
          下一页
        </Button>
        <Button
          onClick={() => setScale((value) => Math.max(0.25, value - 0.25))}
        >
          缩小
        </Button>
        <span>{Math.round(scale * 100)}%</span>
        <Button onClick={() => setScale((value) => Math.min(3, value + 0.25))}>
          放大
        </Button>
        <Button onClick={fit}>适应窗口</Button>
        <Input.Search
          aria-label="搜索PDF文字"
          placeholder="搜索文字层"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onSearch={() => void search()}
          loading={searching}
          style={{ width: 220 }}
        />
        <Button disabled={!matches.length} onClick={() => next(-1)}>
          上一处
        </Button>
        <Button disabled={!matches.length} onClick={() => next(1)}>
          下一处
        </Button>
      </Space>
      {notice ? <Alert type="info" title={notice} /> : null}
      <div className="file-pdf-body">
        <aside className="file-pdf-thumbnails">
          {nearby.map((number) => (
            <PdfCanvas
              key={number}
              document={document}
              page={number}
              scale={0.16}
              thumbnail
              onClick={() => setPage(number)}
            />
          ))}
        </aside>
        <div className="file-pdf-viewport" ref={viewportElement}>
          <PdfCanvas document={document} page={page} scale={scale} />
        </div>
      </div>
    </div>
  );
}
