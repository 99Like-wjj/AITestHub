import { isValidElement, memo, useState } from 'react';
import type { ReactNode } from 'react';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';

function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement<{ children?: ReactNode }>(node))
    return nodeText(node.props.children);
  return '';
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div className="workspace-code-block">
      <button
        type="button"
        className="markdown-copy"
        onClick={() => {
          try {
            if (!navigator.clipboard) throw new Error('Clipboard unavailable');
            void navigator.clipboard
              .writeText(nodeText(children))
              .then(() => {
                setCopied(true);
                setFailed(false);
              })
              .catch(() => setFailed(true));
          } catch {
            setFailed(true);
          }
        }}
      >
        {failed ? '复制失败，请选择文本' : copied ? '已复制' : '复制代码'}
      </button>
      <pre>{children}</pre>
    </div>
  );
}

/** CommonMark + GFM, with raw HTML disabled and no automatic remote image requests. */
export const WorkspaceMarkdown = memo(function WorkspaceMarkdown({
  text,
}: {
  text: string;
}) {
  return (
    <div className="workspace-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={defaultUrlTransform}
        components={{
          pre: CodeBlock,
          a: ({ href, children }) =>
            href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: ({ src, alt }) =>
            src ? (
              <a href={src} target="_blank" rel="noopener noreferrer">
                图片：{alt || '查看图片'}
              </a>
            ) : (
              <span>{alt || '图片地址不可用'}</span>
            ),
          table: ({ children }) => (
            <div className="markdown-table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
});
