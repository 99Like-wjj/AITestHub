import { Input, Popover, Spin } from 'antd';
import type { InputRef } from 'antd';
import { FolderOpenOutlined, UndoOutlined } from '@ant-design/icons';
import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useWorkspaceEscapeFocus } from './workspace-escape-focus';
import type { RequirementGroupCandidates } from '../../../packages/contracts/src/conversations';

export type RequirementRestoreCandidate =
  RequirementGroupCandidates['groups'][number];
export interface RequirementRestorePickerProps {
  children: ReactElement;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidates: RequirementGroupCandidates['groups'];
  loading: boolean;
  error?: string;
  pending: boolean;
  projectName: string | null;
  onRestore: (candidate: RequirementRestoreCandidate) => void;
}

export function RequirementRestorePicker({
  children,
  open,
  onOpenChange,
  candidates,
  loading,
  error,
  pending,
  projectName,
  onRestore,
}: RequirementRestorePickerProps) {
  const [query, setQuery] = useState('');
  const [filterQuery, setFilterQuery] = useState('');
  const composing = useRef(false);
  const search = useRef<InputRef>(null);
  useWorkspaceEscapeFocus(open, () => onOpenChange(false));
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setFilterQuery('');
    composing.current = false;
    const frame = requestAnimationFrame(() => search.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, projectName]);
  const needle = filterQuery.trim().toLocaleLowerCase();
  const matches = candidates.filter((candidate) =>
    [candidate.alias, candidate.generatedName, candidate.formalTitle].some(
      (value) => value?.toLocaleLowerCase().includes(needle),
    ),
  );
  return (
    <Popover
      trigger="click"
      open={open}
      onOpenChange={onOpenChange}
      placement="rightTop"
      arrow={false}
      autoAdjustOverflow
      classNames={{ root: 'user-workspace-requirement-picker' }}
      content={
        <section
          className="workspace-requirement-picker-content"
          role="dialog"
          aria-label="找回本人参与的需求分组"
          aria-busy={loading || pending}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !composing.current) {
              event.preventDefault();
              event.stopPropagation();
              onOpenChange(false);
            }
          }}
        >
          <div className="workspace-picker-caption">
            <b>找回需求</b>
            <span title={projectName ?? undefined}>
              {projectName ?? '请先选择项目'}
            </span>
          </div>
          <Input
            ref={search}
            value={query}
            maxLength={200}
            placeholder="搜索本人参与的需求"
            aria-label="搜索可找回的需求分组"
            disabled={pending}
            onChange={(event) => {
              setQuery(event.target.value);
              if (!composing.current) setFilterQuery(event.target.value);
            }}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={(event) => {
              composing.current = false;
              setQuery(event.currentTarget.value);
              setFilterQuery(event.currentTarget.value);
            }}
          />
          {error && (
            <p className="workspace-picker-error" role="alert">
              {error}
            </p>
          )}
          {loading ? (
            <div className="workspace-picker-empty" role="status">
              <Spin size="small" /> 正在读取本人参与需求…
            </div>
          ) : (
            <div className="workspace-picker-list">
              {matches.map((candidate) => {
                const displayed =
                  candidate.groupExists &&
                  !candidate.hidden &&
                  !candidate.archivedAt;
                const name =
                  candidate.alias ??
                  candidate.generatedName ??
                  candidate.formalTitle;
                const state =
                  [
                    candidate.hidden ? '已移除' : null,
                    candidate.archivedAt ? '已归档' : null,
                  ]
                    .filter(Boolean)
                    .join(' · ') || (displayed ? '已显示' : '尚未显示');
                return (
                  <button
                    type="button"
                    className="workspace-picker-option"
                    key={`${candidate.projectId}:${candidate.requirementId}`}
                    disabled={pending || displayed}
                    title={candidate.formalTitle}
                    aria-label={`${displayed ? '已显示' : '显示此分组'}：${name}`}
                    onClick={() => onRestore(candidate)}
                  >
                    <FolderOpenOutlined aria-hidden="true" />
                    <span className="workspace-picker-option-text">
                      <b>{name}</b>
                      <small>{state}</small>
                    </span>
                    {!displayed && <UndoOutlined aria-hidden="true" />}
                  </button>
                );
              })}
              {!matches.length && !error && (
                <p className="workspace-picker-empty" role="status">
                  {needle
                    ? '没有匹配的本人参与需求'
                    : '当前没有可找回的本人参与需求分组'}
                </p>
              )}
            </div>
          )}
        </section>
      }
    >
      {children}
    </Popover>
  );
}
