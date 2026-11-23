import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Input,
  Pagination,
  Segmented,
  Space,
  Typography,
} from 'antd';
import hljs from 'highlight.js/lib/core';
import python from 'highlight.js/lib/languages/python';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import bash from 'highlight.js/lib/languages/bash';
import powershell from 'highlight.js/lib/languages/powershell';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import ini from 'highlight.js/lib/languages/ini';
import markdown from 'highlight.js/lib/languages/markdown';
import { parseDocument } from 'yaml';
import { parse as parseToml } from 'smol-toml';
import { parseDelimited } from './file-preview-data';
import 'highlight.js/styles/github.css';
for (const [name, language] of Object.entries({
  python,
  java,
  javascript,
  typescript,
  cpp,
  csharp,
  go,
  rust,
  sql,
  bash,
  powershell,
  css,
  xml,
  json,
  yaml,
  ini,
  markdown,
}))
  hljs.registerLanguage(name, language);

function JsonNode({
  value,
  label,
  depth = 0,
}: {
  value: unknown;
  label: string;
  depth?: number;
}) {
  if (value === null || typeof value !== 'object' || value instanceof Date)
    return (
      <div className="file-json-leaf">
        <span>{label}</span>:{' '}
        <code>
          {value instanceof Date
            ? value.toISOString()
            : typeof value === 'number' && !Number.isFinite(value)
              ? String(value)
              : typeof value === 'bigint'
                ? `${value.toString()} (整数原值)`
                : JSON.stringify(value)}
        </code>
      </div>
    );
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value);
  if (depth > 16) return <div>{label}: [嵌套超过16层，请查看源码]</div>;
  return (
    <details open={depth < 2} className="file-json-node">
      <summary>
        {label}{' '}
        {Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}
      </summary>
      {entries.slice(0, 1000).map(([name, item]) => (
        <JsonNode key={name} value={item} label={name} depth={depth + 1} />
      ))}
      {entries.length > 1000 ? (
        <span>本层仅展示前1000项，完整内容可查看源码。</span>
      ) : null}
    </details>
  );
}
const rejectUnsafeNumbers = (value: unknown): void => {
  const remaining = [value];
  let nodes = 0;
  while (remaining.length) {
    if (++nodes > 100000)
      throw new Error('结构超过100000节点，请查看实际源码。');
    const item = remaining.pop();
    if (
      typeof item === 'number' &&
      Number.isInteger(item) &&
      !Number.isSafeInteger(item)
    )
      throw new Error(
        '文件包含超出安全整数范围的数值，折叠可能丢精度，已保留实际源码。',
      );
    if (item && typeof item === 'object')
      remaining.push(...Object.values(item));
  }
};
export function FileTextPreview({
  text,
  extension,
  preferStructure = false,
}: {
  text: string;
  extension: string;
  preferStructure?: boolean;
}) {
  const [query, setQuery] = useState(''),
    [active, setActive] = useState(0),
    [page, setPage] = useState(1),
    [copied, setCopied] = useState(false),
    [error, setError] = useState<string>(),
    [mode, setMode] = useState(preferStructure ? 'structure' : 'source');
  const structure = useMemo(() => {
    try {
      if (extension === 'json') {
        const value: unknown = JSON.parse(text);
        rejectUnsafeNumbers(value);
        return { value, error: null };
      }
      if (extension === 'jsonl') {
        const lines = text.split(/\r?\n/).filter((line) => line.trim());
        return {
          value: lines.map((line, index) => {
            try {
              const value: unknown = JSON.parse(line);
              rejectUnsafeNumbers(value);
              return value;
            } catch {
              throw new Error(`第${index + 1}行不是有效JSON。`);
            }
          }),
          error: null,
        };
      }
      if (['yaml', 'yml'].includes(extension)) {
        const doc = parseDocument(text, { uniqueKeys: true });
        if (doc.errors.length) throw new Error(doc.errors[0]?.message);
        return {
          value: doc.toJS({ maxAliasCount: 0 }) as unknown,
          error: null,
        };
      }
      if (extension === 'xml') {
        if (/<!DOCTYPE|<!ENTITY/i.test(text))
          throw new Error('含DTD或实体声明，仅显示源码，不展开外部实体。');
        const document = new DOMParser().parseFromString(
          text,
          'application/xml',
        );
        if (document.querySelector('parsererror'))
          throw new Error('XML格式无效，以下仍是实际源码。');
        let nodes = 0;
        const convert = (element: Element, depth = 0): unknown => {
          if (++nodes > 10000 || depth > 16)
            return '[结构预览达到10000节点/16层范围，请查看源码]';
          const attributes = Object.fromEntries(
            [...element.attributes].map((attribute) => [
              `@${attribute.name}`,
              attribute.value,
            ]),
          );
          return {
            ...attributes,
            ...(element.children.length
              ? {
                  children: [...element.children].map((child) => ({
                    [child.tagName]: convert(child, depth + 1),
                  })),
                }
              : { text: element.textContent ?? '' }),
          };
        };
        return {
          value: {
            [document.documentElement.tagName]: convert(
              document.documentElement,
            ),
          },
          error: null,
        };
      }
      if (extension === 'toml')
        return {
          value: parseToml(text, {
            integersAsBigInt: 'asNeeded',
            maxDepth: 32,
          }),
          error: null,
        };
      if (extension === 'ini') {
        const sections: Record<string, string[]> = Object.create(null);
        let section = '默认段';
        for (const [index, line] of text.split(/\r?\n/).entries()) {
          const trim = line.trim();
          if (
            trim &&
            !/^[#;]/.test(trim) &&
            !/^\[[^\]]+\]\s*(?:[#;].*)?$/.test(trim) &&
            !/^([^=:#;\s][^=:]*?)\s*[=:].*$/.test(trim)
          )
            throw new Error(
              `INI第${index + 1}行不是有效的段落或键值行，显示实际源码。`,
            );
          if (/^\s*\[.+\]\s*(?:[#;].*)?$/.test(line)) section = line.trim();
          (sections[section] ??= []).push(line);
        }
        return { value: sections, error: null };
      }
      return null;
    } catch (err) {
      return {
        value: undefined,
        error:
          err instanceof Error
            ? err.message
            : '结构解析失败，仍可查看实际源码。',
      };
    }
  }, [text, extension]);
  const lines = useMemo(() => text.split(/\r?\n/).slice(0, 100000), [text]);
  const matches = useMemo(
    () =>
      query
        ? lines.flatMap((line, index) =>
            line.toLocaleLowerCase().includes(query.toLocaleLowerCase())
              ? [index]
              : [],
          )
        : [],
    [lines, query],
  );
  const jump = (next: number) => {
    if (!matches.length) return;
    const index = (next + matches.length) % matches.length;
    setActive(index);
    setPage(Math.floor((matches[index] ?? 0) / 500) + 1);
    setMode('source');
  };
  const rendered = useMemo(() => {
    const selected = lines.slice((page - 1) * 500, page * 500).join('\n');
    const language: Record<string, string> = {
      py: 'python',
      js: 'javascript',
      ts: 'typescript',
      tsx: 'typescript',
      jsx: 'javascript',
      sh: 'bash',
      ps1: 'powershell',
      cs: 'csharp',
      rs: 'rust',
      yml: 'yaml',
      md: 'markdown',
      vue: 'xml',
      c: 'cpp',
      h: 'cpp',
      hpp: 'cpp',
      toml: 'ini',
      jsonl: 'json',
      html: 'xml',
      htm: 'xml',
    };
    const chosen = language[extension] ?? extension;
    if (selected.length > 200000 || !hljs.getLanguage(chosen)) return null;
    return hljs
      .highlight(selected, { language: chosen, ignoreIllegals: true })
      .value.split('\n');
  }, [lines, page, extension]);
  return (
    <div className="file-text-preview">
      {extension === 'ini' && !structure?.error ? (
        <Alert
          type="info"
          title="INI按段落与键值语法只读分组；保留原始行，不执行配置。"
        />
      ) : null}
      {lines.length === 100000 ? (
        <Alert
          type="warning"
          title="文本行预览达到100000行范围；原件下载保留全部内容。"
        />
      ) : null}
      <Space wrap className="file-preview-tools">
        <Input.Search
          aria-label="搜索文件文本"
          placeholder="搜索正文"
          allowClear
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onSearch={() => jump(0)}
          style={{ width: 240 }}
        />
        <span>{query ? `${matches.length} 行匹配` : `${lines.length} 行`}</span>
        <Button disabled={!matches.length} onClick={() => jump(active - 1)}>
          上一处
        </Button>
        <Button disabled={!matches.length} onClick={() => jump(active + 1)}>
          下一处
        </Button>
        <Button
          onClick={() => {
            void navigator.clipboard
              .writeText(text)
              .then(() => setCopied(true))
              .catch(() => setError('复制失败，请选择源码复制。'));
          }}
        >
          {copied ? '已复制' : '复制源码'}
        </Button>
        {structure && !structure.error ? (
          <Segmented
            value={mode}
            onChange={(value) => setMode(String(value))}
            options={[
              { value: 'source', label: '源码' },
              { value: 'structure', label: '折叠结构' },
            ]}
          />
        ) : null}
      </Space>
      {structure?.error ? (
        <Alert
          type="warning"
          showIcon
          title="结构格式未通过校验"
          description={structure.error}
        />
      ) : null}
      {error ? <Alert type="warning" title={error} /> : null}
      {mode === 'structure' && structure && !structure.error ? (
        <div className="file-json-tree">
          <JsonNode value={structure.value} label="根" />
        </div>
      ) : (
        <div className="file-source-scroll">
          <table className="file-source">
            <tbody>
              {lines.slice((page - 1) * 500, page * 500).map((line, index) => {
                const number = (page - 1) * 500 + index;
                return (
                  <tr
                    key={number}
                    className={
                      matches[active] === number
                        ? 'current-match'
                        : matches.includes(number)
                          ? 'matched'
                          : ''
                    }
                  >
                    <td className="line-number">{number + 1}</td>
                    <td>
                      {rendered?.[index] !== undefined ? (
                        <code
                          dangerouslySetInnerHTML={{
                            __html: rendered[index] ?? '',
                          }}
                        />
                      ) : (
                        <code>{line || ' '}</code>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {lines.length > 500 &&
      (mode === 'source' || !structure || structure.error) ? (
        <Pagination
          current={page}
          pageSize={500}
          total={lines.length}
          showSizeChanger={false}
          onChange={setPage}
        />
      ) : null}
    </div>
  );
}
export interface TablePreviewOptions {
  firstRowHeader?: boolean;
  maxDataRows?: number;
  maxColumns?: number;
}

export function DelimitedPreview({
  text,
  extension,
  options,
}: {
  text: string;
  extension: string;
  options?: TablePreviewOptions | undefined;
}) {
  const [selected, setSelected] = useState<{
      row: number;
      column: number;
      value: string;
    }>(),
    [page, setPage] = useState(1);
  const {
    firstRowHeader = false,
    maxDataRows = 5000,
    maxColumns = 256,
  } = options ?? {};
  const parsed = useMemo(() => {
    try {
      return {
        ...parseDelimited(
          text,
          extension === 'tsv' ? '\t' : ',',
          maxDataRows + Number(firstRowHeader),
          maxColumns,
        ),
        error: null,
      };
    } catch (err) {
      return {
        rows: [],
        truncated: false,
        error: err instanceof Error ? err.message : '表格解析失败。',
      };
    }
  }, [text, extension, firstRowHeader, maxDataRows, maxColumns]);
  if (parsed.error)
    return (
      <>
        <Alert type="warning" title={parsed.error} />
        <FileTextPreview text={text} extension={extension} />
      </>
    );
  const columns = Math.max(0, ...parsed.rows.map((row) => row.length));
  const header = firstRowHeader ? parsed.rows[0] : undefined;
  const rows = firstRowHeader ? parsed.rows.slice(1) : parsed.rows;
  return (
    <div className="file-sheet-preview">
      <Alert
        type="info"
        title="实际分隔文本；以 = 开头的内容保持原文，不执行或心算公式。"
      />
      {parsed.truncated ? (
        <Alert
          type="warning"
          title={`表格仅预览前 ${maxDataRows} 行数据、${maxColumns} 列，剩余内容可下载原件查看。`}
        />
      ) : null}
      <div className="file-cell-detail">
        {selected
          ? `行 ${selected.row + 1} · 列 ${selected.column + 1}：${selected.value}`
          : '点击单元格查看完整内容'}
      </div>
      <div className="file-grid-scroll">
        <table className="file-data-grid">
          <thead>
            <tr>
              <th>行</th>
              {Array.from({ length: columns }, (_, index) => (
                <th key={index} scope="col">
                  {header?.[index] || index + 1}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice((page - 1) * 200, page * 200).map((row, index) => (
              <tr key={index}>
                <th>{(page - 1) * 200 + index + 1}</th>
                {Array.from({ length: columns }, (_, column) => (
                  <td key={column}>
                    <button
                      type="button"
                      className="file-cell"
                      onClick={() =>
                        setSelected({
                          row: (page - 1) * 200 + index,
                          column,
                          value: row[column] ?? '',
                        })
                      }
                    >
                      {row[column] ?? ''}
                    </button>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Space>
        <Typography.Text>
          {rows.length} 行 · {columns} 列
        </Typography.Text>
        <Pagination
          current={page}
          pageSize={200}
          total={rows.length}
          showSizeChanger={false}
          onChange={setPage}
        />
      </Space>
    </div>
  );
}
