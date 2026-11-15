import type { ReactNode } from 'react';

export function WorkspaceContextDrawer({
  expanded,
  children,
}: {
  expanded: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`composer-context-drawer${expanded ? ' is-expanded' : ' is-collapsed'}`}
    >
      <div
        className="composer-context-fold"
        inert={!expanded}
        aria-hidden={!expanded}
      >
        <div className="composer-context-fold-inner">{children}</div>
      </div>
    </div>
  );
}
