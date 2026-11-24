import { Input } from 'antd';
import type { ReactNode } from 'react';
import { FilterToggle } from './filter-toggle';
import './requirement-directory.css';

export function RequirementDirectory({
  title = '需求目录',
  archiveLabel = '显示已归档需求',
  action,
  filters,
  includeArchived,
  onIncludeArchivedChange,
  archiveDisabled,
  search,
  onSearchChange,
  searchPlaceholder,
  children,
}: {
  title?: string;
  archiveLabel?: string;
  action?: ReactNode;
  filters?: ReactNode;
  includeArchived?: boolean;
  onIncludeArchivedChange?: (value: boolean) => void;
  archiveDisabled?: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  children: ReactNode;
}) {
  return (
    <aside className="asset-tree requirement-directory" aria-label={title}>
      <div className="requirement-directory-header">
        <div className="requirement-directory-heading">
          <h2>{title}</h2>
          {action}
        </div>
        <Input
          allowClear
          aria-label={`搜索${title}`}
          placeholder={searchPlaceholder}
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
        />
        {(onIncludeArchivedChange || filters) && (
          <div className="requirement-directory-filters">
            {onIncludeArchivedChange && (
              <FilterToggle
                label={archiveLabel}
                checked={includeArchived ?? false}
                onChange={onIncludeArchivedChange}
                disabled={archiveDisabled ?? false}
              />
            )}
            {filters}
          </div>
        )}
      </div>
      <div className="requirement-directory-content">{children}</div>
    </aside>
  );
}
