import { Button, Input, Skeleton } from 'antd';
import type { ReactNode } from 'react';
import './result-list.css';

interface ResultSearch {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onCompositionChange?: (composing: boolean) => void;
  placeholder?: string;
  maxLength?: number;
}

export function ResultFilters({
  search,
  onReset,
  children,
  summary,
}: {
  search: ResultSearch;
  onReset: () => void;
  children?: ReactNode;
  summary?: ReactNode;
}) {
  return (
    <div className="result-filters" role="group" aria-label="结果筛选">
      <Input
        className="result-filter-search"
        aria-label={search.label}
        placeholder={search.placeholder ?? search.label}
        value={search.value}
        allowClear
        maxLength={search.maxLength ?? 200}
        onChange={(event) => search.onChange(event.target.value)}
        onCompositionStart={() => search.onCompositionChange?.(true)}
        onCompositionEnd={() => search.onCompositionChange?.(false)}
      />
      {children}
      <Button onClick={onReset}>清空结果筛选</Button>
      {summary !== undefined && (
        <span className="caption result-filter-summary" role="status">
          {summary}
        </span>
      )}
    </div>
  );
}

export function ResultListState({
  state,
  title,
  description,
  action,
}: {
  state: 'loading' | 'empty' | 'no-match' | 'error';
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  if (state === 'loading')
    return (
      <div className="result-list-loading" aria-busy="true">
        <p className="caption" role="status">
          {title}
        </p>
        <Skeleton active title={false} paragraph={{ rows: 3 }} />
      </div>
    );
  return (
    <div
      className={`result-list-state result-list-state--${state}`}
      role={state === 'error' ? 'alert' : 'status'}
    >
      <strong>{title}</strong>
      {description && <div className="caption">{description}</div>}
      {action}
    </div>
  );
}

export function ResultPagination({
  summary,
  children,
}: {
  summary: ReactNode;
  children?: ReactNode;
}) {
  return (
    <nav className="result-pagination" aria-label="列表分页">
      <span className="caption">{summary}</span>
      {children && <div className="result-pagination-actions">{children}</div>}
    </nav>
  );
}
