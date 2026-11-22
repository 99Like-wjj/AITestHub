import { Input } from 'antd';
import type { ReactNode } from 'react';
import { ArchivedRequirementsToggle } from './archived-requirements-toggle';
import './requirement-directory.css';

export function RequirementDirectory({
  includeArchived,
  onIncludeArchivedChange,
  archiveDisabled,
  search,
  onSearchChange,
  searchPlaceholder,
  children,
}: {
  includeArchived: boolean;
  onIncludeArchivedChange: (value: boolean) => void;
  archiveDisabled?: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  children: ReactNode;
}) {
  return (
    <aside className="asset-tree requirement-directory" aria-label="需求目录">
      <div className="requirement-directory-header">
        <div className="requirement-directory-heading">
          <h2>需求目录</h2>
          <ArchivedRequirementsToggle
            checked={includeArchived}
            onChange={onIncludeArchivedChange}
            disabled={archiveDisabled ?? false}
          />
        </div>
        <Input
          allowClear
          aria-label="搜索需求目录"
          placeholder={searchPlaceholder}
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </div>
      <div className="requirement-directory-content">{children}</div>
    </aside>
  );
}

export function RequirementDirectoryLabel({
  title,
  count,
  archived,
  detail,
}: {
  title: string;
  count?: ReactNode;
  archived?: boolean;
  detail?: string;
}) {
  return (
    <span className="requirement-directory-label">
      <span className="requirement-directory-title">
        {title}
        {archived && (
          <span className="requirement-directory-archived">已归档</span>
        )}
        {detail && (
          <span className="requirement-directory-detail">{detail}</span>
        )}
      </span>
      {count !== undefined && (
        <span className="requirement-directory-count">{count}</span>
      )}
    </span>
  );
}
