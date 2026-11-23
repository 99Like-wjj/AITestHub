import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MarkdownDiagramRenderer } from './markdown-mermaid';
import './markdown-document-preview.css';

type RenderDiagram = (source: string, dark: boolean) => Promise<string | null>;

function MarkdownDiagram({
  source,
  dark,
  render,
}: {
  source: string;
  dark: boolean;
  render: RenderDiagram;
}) {
  const [result, setResult] = useState<{
    source: string;
    dark: boolean;
    url: string | null;
  }>();
  useEffect(() => {
    let active = true;
    let url: string | null = null;
    void render(source, dark)
      .then((svg) => {
        if (!active) return;
        url = svg
          ? URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
          : null;
        setResult({ source, dark, url });
      })
      .catch(() => {
        if (active) setResult({ source, dark, url: null });
      });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [source, dark, render]);

  const current =
    result?.source === source && result.dark === dark ? result : null;
  if (!current) return <p role="status">正在渲染图表…</p>;
  if (!current.url)
    return (
      <details className="markdown-diagram-error">
        <summary>这段 Mermaid 图表无法显示，查看源码</summary>
        <pre>{source}</pre>
      </details>
    );
  // SVG in image mode has no interactive content or external resource loads.
  return (
    <img
      className="markdown-rendered-diagram"
      src={current.url}
      alt="Mermaid 图表"
    />
  );
}

export function MarkdownDocumentPreview({ text }: { text: string }) {
  const renderer = useRef<MarkdownDiagramRenderer | null>(null);
  const [dark, setDark] = useState(
    () => document.documentElement.dataset.theme === 'dark',
  );
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() =>
      setDark(root.dataset.theme === 'dark'),
    );
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => {
      observer.disconnect();
      renderer.current?.close();
      renderer.current = null;
    };
  }, []);

  const render = useCallback<RenderDiagram>((source, darkMode) => {
    renderer.current ??= new MarkdownDiagramRenderer();
    return renderer.current.render(source, darkMode);
  }, []);
  const components = useMemo<Components>(
    () => ({
      pre: ({ node, children }) => {
        const body = node?.children[0];
        if (
          body?.type === 'element' &&
          body.tagName === 'code' &&
          Array.isArray(body.properties.className) &&
          body.properties.className.includes('language-mermaid')
        ) {
          const source = body.children
            .map((part) => (part.type === 'text' ? part.value : ''))
            .join('');
          return (
            <MarkdownDiagram source={source} dark={dark} render={render} />
          );
        }
        return <pre>{children}</pre>;
      },
      a: ({ children }) => (
        <span className="markdown-document-link">{children}</span>
      ),
      img: ({ alt }) => (
        <span className="markdown-document-link">
          [图片：{alt || '外链图片不自动载入'}]
        </span>
      ),
      table: ({ children }) => (
        <div className="markdown-document-table">
          <table>{children}</table>
        </div>
      ),
    }),
    [dark, render],
  );
  return (
    <article className="markdown-document-preview">
      <Markdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
        {text}
      </Markdown>
    </article>
  );
}
