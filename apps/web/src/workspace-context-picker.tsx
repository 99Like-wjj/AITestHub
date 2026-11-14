import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  CheckOutlined,
  FolderOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { Input, Popover, Spin } from 'antd';
import { useWorkspaceEscapeFocus } from './workspace-escape-focus';
export interface ContextOption {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
}
export function WorkspaceContextPicker({
  children,
  open,
  onOpenChange,
  options,
  selectedId,
  onChoose,
  placeholder,
  loading = false,
  error,
  caption,
  emptyText = '没有匹配的选项',
}: {
  children: ReactElement;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: readonly ContextOption[];
  selectedId: string | null;
  onChoose: (id: string) => void;
  placeholder: string;
  loading?: boolean;
  error?: string | undefined;
  caption?: string;
  emptyText?: string;
}) {
  const [query, setQuery] = useState(''),
    [composing, setComposing] = useState(false),
    [filter, setFilter] = useState('');
  const search = useRef<import('antd').InputRef>(null);
  useWorkspaceEscapeFocus(open, () => onOpenChange(false));
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setFilter('');
    const frame = requestAnimationFrame(() => search.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);
  useEffect(() => {
    if (!composing) setFilter(query.trim().toLocaleLowerCase());
  }, [query, composing]);
  const visible = options.filter((option) =>
    (option.label + ' ' + (option.description ?? ''))
      .toLocaleLowerCase()
      .includes(filter),
  );
  return (
    <Popover
      trigger="click"
      placement="topLeft"
      open={open}
      onOpenChange={onOpenChange}
      classNames={{ root: 'workspace-context-picker' }}
      content={
        <div
          className="workspace-context-list"
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'Escape') {
              event.preventDefault();
              onOpenChange(false);
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              const buttons = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  'button[role="option"]:not(:disabled)',
                ),
              ];
              if (buttons.length) {
                event.preventDefault();
                const at = buttons.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                buttons[
                  (at +
                    (event.key === 'ArrowDown' ? 1 : buttons.length - 1) +
                    buttons.length) %
                    buttons.length
                ]?.focus();
              }
            }
          }}
        >
          <Input
            ref={search}
            aria-label={placeholder}
            placeholder={placeholder}
            value={query}
            prefix={<SearchOutlined />}
            variant="borderless"
            onChange={(event) => setQuery(event.target.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
          />
          <div
            className="workspace-context-options"
            role="listbox"
            aria-label={placeholder}
          >
            {loading ? (
              <div className="workspace-context-empty">
                <Spin size="small" />
              </div>
            ) : (
              visible.map((option) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={selectedId === option.id}
                  disabled={option.disabled}
                  key={option.id}
                  title={option.description ?? option.label}
                  onClick={() => {
                    onChoose(option.id);
                  }}
                >
                  <FolderOutlined />
                  <span>{option.label}</span>
                  {selectedId === option.id && <CheckOutlined />}
                </button>
              ))
            )}
            {!loading && !visible.length && (
              <p className="workspace-context-empty">{emptyText}</p>
            )}
          </div>
          {error && (
            <p className="workspace-context-error" role="alert">
              {error}
            </p>
          )}
          {caption && <p className="workspace-context-caption">{caption}</p>}
        </div>
      }
    >
      {children}
    </Popover>
  );
}
