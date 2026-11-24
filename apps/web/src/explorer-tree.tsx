import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import {
  ApiOutlined,
  BugOutlined,
  FileOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  ProfileOutlined,
} from '@ant-design/icons';

export type ExplorerNode = {
  id: string;
  title: string;
  kind?: 'all' | 'endpoint' | 'issue' | 'requirement' | 'ui-case';
  detail?: string;
  count?: ReactNode;
  archived?: boolean;
  searchText?: string;
  children?: ExplorerNode[];
};

export function storedExplorerSetting(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
export function storeExplorerSetting(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Directory preferences are optional.
  }
}
export function useExplorerSearch(key: string) {
  const [search, setSearch] = useState(() => storedExplorerSetting(key) ?? '');
  useEffect(() => {
    storeExplorerSetting(key, search);
  }, [key, search]);
  return [search, setSearch] as const;
}

type VisibleNode = {
  node: ExplorerNode;
  parent: ExplorerNode | null;
};

export function findExplorerPath(
  nodes: readonly ExplorerNode[],
  selected: string | null,
): ExplorerNode[] {
  for (const node of nodes) {
    if (node.id === selected) return [node];
    if (node.children) {
      const path = findExplorerPath(node.children, selected);
      if (path.length) return [node, ...path];
    }
  }
  return [];
}

function searchNodes(nodes: readonly ExplorerNode[], keyword: string) {
  return nodes.flatMap((node): ExplorerNode[] => {
    const text = [node.title, node.id, node.detail, node.searchText]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase();
    if (node.kind === 'all' || text.includes(keyword)) return [node];
    const children = node.children && searchNodes(node.children, keyword);
    return children?.length ? [{ ...node, children }] : [];
  });
}

function readExpanded(storageKey?: string) {
  if (!storageKey) return [];
  try {
    const value: unknown = JSON.parse(
      storedExplorerSetting(storageKey) ?? '[]',
    );
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

export function ExplorerTree({
  nodes,
  selected,
  onSelect,
  search = '',
  label,
  renderAction,
  storageKey,
  emptyText = '没有匹配的结果',
}: {
  nodes: readonly ExplorerNode[];
  selected: string | null;
  onSelect: (id: string) => void;
  search?: string;
  label: string;
  renderAction?: (node: ExplorerNode) => ReactNode;
  storageKey?: string;
  emptyText?: string;
}) {
  const [expansion, setExpansion] = useState(() => ({
    storageKey,
    openIds: readExpanded(storageKey),
    closedIds: new Set<string>(),
  }));
  const [focused, setFocused] = useState<string | null>(null);
  const items = useRef(new Map<string, HTMLLIElement>());
  const tree = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const scroll = tree.current?.closest('.requirement-directory-content');
    if (!storageKey || !scroll) return;
    const key = storageKey + ':scroll';
    const offset = Number(storedExplorerSetting(key) ?? '0');
    if (Number.isFinite(offset) && offset >= 0) scroll.scrollTop = offset;
    const onScroll = () => storeExplorerSetting(key, String(scroll.scrollTop));
    scroll.addEventListener('scroll', onScroll, { passive: true });
    return () => scroll.removeEventListener('scroll', onScroll);
  }, [storageKey]);
  const keyword = search.trim().toLocaleLowerCase();
  const roots = keyword ? searchNodes(nodes, keyword) : nodes;
  const openIds =
    expansion.storageKey === storageKey
      ? expansion.openIds
      : readExpanded(storageKey);
  const closedIds =
    expansion.storageKey === storageKey
      ? expansion.closedIds
      : new Set<string>();
  const selectedPath = findExplorerPath(roots, selected);
  const isExpanded = (node: ExplorerNode) =>
    Boolean(node.children?.length) &&
    (Boolean(keyword) ||
      (selectedPath.some((item) => item.id === node.id) &&
        !closedIds.has(node.id)) ||
      openIds.includes(node.id));
  const visible: VisibleNode[] = [];
  function appendRows(
    branch: readonly ExplorerNode[],
    parent: ExplorerNode | null,
  ) {
    for (const node of branch) {
      visible.push({ node, parent });
      if (isExpanded(node) && node.children) appendRows(node.children, node);
    }
  }
  appendRows(roots, null);
  const focusable =
    (visible.some((item) => item.node.id === focused) && focused) ||
    (visible.some((item) => item.node.id === selected) && selected) ||
    visible[0]?.node.id;

  function setOpen(node: ExplorerNode, open: boolean) {
    if (keyword) return;
    const nextOpen = new Set(openIds);
    const nextClosed = new Set(closedIds);
    if (open) {
      nextOpen.add(node.id);
      nextClosed.delete(node.id);
    } else {
      nextOpen.delete(node.id);
      nextClosed.add(node.id);
    }
    const next = [...nextOpen];
    setExpansion({ storageKey, openIds: next, closedIds: nextClosed });
    if (storageKey) {
      storeExplorerSetting(storageKey, JSON.stringify(next));
    }
  }

  function focus(id: string) {
    setFocused(id);
    items.current.get(id)?.focus();
  }

  function select(node: ExplorerNode) {
    if (node.children?.length) setOpen(node, true);
    onSelect(node.id);
  }

  function onKey(event: KeyboardEvent<HTMLLIElement>, node: ExplorerNode) {
    if (event.target !== event.currentTarget) return;
    const index = visible.findIndex((item) => item.node.id === node.id);
    let target: ExplorerNode | null | undefined;
    switch (event.key) {
      case 'ArrowDown':
        target = visible[index + 1]?.node;
        break;
      case 'ArrowUp':
        target = visible[index - 1]?.node;
        break;
      case 'Home':
        target = visible[0]?.node;
        break;
      case 'End':
        target = visible.at(-1)?.node;
        break;
      case 'ArrowRight':
        if (isExpanded(node)) target = node.children?.[0];
        else if (node.children?.length) setOpen(node, true);
        break;
      case 'ArrowLeft':
        if (isExpanded(node) && !keyword) setOpen(node, false);
        else target = visible[index]?.parent;
        break;
      case 'Enter':
      case ' ':
        select(node);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (target) focus(target.id);
  }

  function renderBranch(branch: readonly ExplorerNode[], path: string[]) {
    return branch.map((node) => {
      const expanded = isExpanded(node);
      const label = [...path, node.title];
      const hasChildren = Boolean(node.children?.length);
      const action = renderAction?.(node);
      const Icon = node.children
        ? expanded
          ? FolderOpenOutlined
          : FolderOutlined
        : node.kind === 'endpoint'
          ? ApiOutlined
          : node.kind === 'issue'
            ? BugOutlined
            : node.kind === 'all'
              ? ProfileOutlined
              : node.kind === 'requirement'
                ? FileOutlined
                : FileTextOutlined;
      return (
        <li
          aria-expanded={hasChildren ? expanded : undefined}
          aria-label={label.join(' / ')}
          aria-selected={selected === node.id}
          data-kind={node.kind}
          key={node.id}
          onKeyDown={(event) => onKey(event, node)}
          ref={(element) => {
            if (element) items.current.set(node.id, element);
            else items.current.delete(node.id);
          }}
          role="treeitem"
          tabIndex={focusable === node.id ? 0 : -1}
        >
          <div
            className={'explorer-row' + (action ? ' has-action' : '')}
            title={label.join(' / ')}
            onClick={() => {
              focus(node.id);
              select(node);
            }}
          >
            {hasChildren ? (
              <button
                aria-label={`${expanded ? '收起' : '展开'}${node.title}`}
                className="explorer-chevron"
                onClick={(event) => {
                  event.stopPropagation();
                  focus(node.id);
                  setOpen(node, !expanded);
                }}
                tabIndex={-1}
                type="button"
              />
            ) : (
              <span className="explorer-chevron" aria-hidden />
            )}
            <Icon
              aria-hidden
              className={`explorer-icon${node.children ? ' explorer-folder' : ''}`}
            />
            <span className="explorer-title">{node.title}</span>
            {(node.count !== undefined || node.detail || node.archived) && (
              <small className="explorer-meta">
                {node.archived ? '已归档' : (node.count ?? node.detail)}
              </small>
            )}
            {action && (
              <div
                className="explorer-node-action"
                onClick={(event) => event.stopPropagation()}
              >
                {action}
              </div>
            )}
          </div>
          {expanded && node.children && (
            <ul role="group">{renderBranch(node.children, label)}</ul>
          )}
        </li>
      );
    });
  }

  return (
    <>
      <ul aria-label={label} className="explorer-tree" role="tree" ref={tree}>
        {renderBranch(roots, [])}
      </ul>
      {!roots.some((item) => item.kind !== 'all') && (
        <p className="explorer-empty">{emptyText}</p>
      )}
    </>
  );
}
