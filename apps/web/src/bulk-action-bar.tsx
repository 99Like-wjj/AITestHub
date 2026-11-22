import { Button } from 'antd';
import type { ReactNode } from 'react';
import './bulk-action-bar.css';

/** Only renders selection and actions. Callers retain their exact frozen scope. */
export function BulkActionBar({
  selected,
  onClear,
  scope,
  selectionActions,
  children,
}: {
  selected: number;
  onClear: () => void;
  scope?: ReactNode;
  selectionActions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="bulk-action-bar" aria-label="批量操作">
      {selectionActions && (
        <div className="bulk-action-choices row wrap">{selectionActions}</div>
      )}
      {selected > 0 && (
        <div className="bulk-action-selection row wrap">
          <span className="bulk-action-count" role="status">
            已选 {selected} 项
          </span>
          {scope && <span className="caption">{scope}</span>}
          <div className="bulk-action-buttons row wrap">
            <Button size="small" onClick={onClear}>
              清空选择
            </Button>
            {children}
          </div>
        </div>
      )}
    </section>
  );
}
