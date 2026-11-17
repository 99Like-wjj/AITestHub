import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from 'react';
import type {
  ClipboardEvent,
  CompositionEvent,
  FocusEvent,
  KeyboardEvent,
  ReactNode,
} from 'react';
import {
  atomicComposerDeletion,
  atomicComposerSelection,
  parseInlineComposerTokens,
} from './workspace-inline-tokens';
import { workspaceSkillLabel } from './workspace-composer-skills';
import './inline-composer.css';

export interface InlineComposerHandle {
  focus: () => void;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  setSelectionRange: (start: number, end: number) => void;
}
interface Selection {
  start: number;
  end: number;
}
const rawNode = (node: Node): string =>
  node instanceof HTMLElement && node.dataset.inlineSentinel !== undefined
    ? ''
    : node instanceof HTMLElement && node.dataset.inlineRaw !== undefined
      ? node.dataset.inlineRaw
      : node.nodeType === Node.TEXT_NODE
        ? (node.textContent ?? '')
        : node instanceof HTMLBRElement
          ? '\n'
          : Array.from(node.childNodes).map(rawNode).join('');
export function readInlineComposer(root: HTMLElement) {
  return Array.from(root.childNodes).map(rawNode).join('');
}
function appendTrailingLinePlaceholder(root: HTMLElement, value: string) {
  if (!value.endsWith('\n')) return;
  const placeholder = document.createElement('br');
  placeholder.dataset.inlineSentinel = '';
  placeholder.setAttribute('aria-hidden', 'true');
  root.append(placeholder);
}
function caretOffset(
  root: HTMLElement,
  node: Node,
  offset: number,
  edge: 'start' | 'end',
) {
  let result = 0,
    done = false;
  const visit = (current: Node) => {
    if (done) return;
    if (current === node) {
      result +=
        current.nodeType === Node.TEXT_NODE
          ? offset
          : Array.from(current.childNodes)
              .slice(0, offset)
              .reduce((sum, child) => sum + rawNode(child).length, 0);
      done = true;
      return;
    }
    if (
      current instanceof HTMLElement &&
      current.dataset.inlineRaw !== undefined
    ) {
      if (current.contains(node)) {
        if (edge === 'end') result += current.dataset.inlineRaw.length;
        done = true;
        return;
      }
      result += current.dataset.inlineRaw.length;
      return;
    }
    if (
      current.nodeType === Node.TEXT_NODE ||
      current instanceof HTMLBRElement
    ) {
      result += rawNode(current).length;
      return;
    }
    for (const child of current.childNodes) visit(child);
  };
  visit(root);
  return result;
}
function selected(root: HTMLElement): Selection | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  )
    return null;
  return {
    start: caretOffset(
      root,
      range.startContainer,
      range.startOffset,
      range.collapsed && range.startOffset > 0 ? 'end' : 'start',
    ),
    end: caretOffset(
      root,
      range.endContainer,
      range.endOffset,
      range.collapsed && range.endOffset === 0 ? 'start' : 'end',
    ),
  };
}
function place(root: HTMLElement, start: number, end: number) {
  const range = document.createRange();
  const point = (value: number): [Node, number] => {
    let remaining = value;
    const find = (node: Node): [Node, number] | null => {
      if (node instanceof HTMLElement && node.dataset.inlineRaw !== undefined) {
        const length = node.dataset.inlineRaw.length;
        if (remaining <= length) {
          const parent = node.parentNode;
          if (!parent) return null;
          return [
            parent,
            Array.from(parent.childNodes).indexOf(node) +
              (remaining === 0 ? 0 : 1),
          ];
        }
        remaining -= length;
        return null;
      }
      if (node.nodeType === Node.TEXT_NODE) {
        const length = node.textContent?.length ?? 0;
        if (remaining <= length) {
          const next = node.nextSibling;
          if (
            remaining === length &&
            next instanceof HTMLBRElement &&
            next.dataset.inlineSentinel !== undefined &&
            node.parentNode
          )
            return [
              node.parentNode,
              Array.from(node.parentNode.childNodes).findIndex(
                (child) => child === node,
              ) + 1,
            ];
          return [node, remaining];
        }
        remaining -= length;
        return null;
      }
      if (node instanceof HTMLBRElement) {
        if (remaining === 0)
          return [
            node.parentNode ?? root,
            Array.from(node.parentNode?.childNodes ?? []).indexOf(node),
          ];
        if (node.dataset.inlineSentinel === undefined) remaining--;
        return null;
      }
      for (const child of node.childNodes) {
        const found = find(child);
        if (found) return found;
      }
      return null;
    };
    return find(root) ?? [root, root.childNodes.length];
  };
  const a = point(start),
    b = point(end);
  range.setStart(a[0], a[1]);
  range.setEnd(b[0], b[1]);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
export interface InlineComposerProps {
  value: string;
  allowedReferences: ReadonlySet<string>;
  disabled: boolean;
  placeholder: string;
  maxLength: number;
  onChange: (value: string, selection: Selection) => void;
  onSelect: (selection: Selection) => void;
  onFocus: () => void;
  onBlur: (event: FocusEvent<HTMLDivElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  'aria-controls'?: string | undefined;
  'aria-expanded'?: boolean;
  'aria-activedescendant'?: string | undefined;
}
export const InlineComposer = forwardRef<
  InlineComposerHandle,
  InlineComposerProps
>(function InlineComposer(props, ref) {
  const element = useRef<HTMLDivElement>(null),
    selection = useRef<Selection>({ start: 0, end: 0 }),
    composing = useRef(false),
    lastRendered = useRef(''),
    lastReferences = useRef(props.allowedReferences),
    pendingSelection = useRef<Selection | null>(null),
    history = useRef([{ value: props.value, position: { start: 0, end: 0 } }]),
    historyIndex = useRef(0),
    restoring = useRef(false);
  const render = () => {
    const root = element.current;
    if (!root || composing.current) return;
    const focused = document.activeElement === root,
      position =
        pendingSelection.current ?? selected(root) ?? selection.current;
    pendingSelection.current = null;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const token of parseInlineComposerTokens(
      props.value,
      props.allowedReferences,
    )) {
      fragment.append(
        document.createTextNode(props.value.slice(offset, token.start)),
      );
      const span = document.createElement('span');
      span.contentEditable = 'false';
      span.className = 'inline-composer-token';
      span.dataset.inlineRaw = token.raw;
      span.dataset.inlineKind = token.kind;
      span.setAttribute(
        'aria-label',
        token.kind === 'skill'
          ? `Skill：${workspaceSkillLabel(token.skillId ?? token.label)}`
          : `引用：${token.label}`,
      );
      const icon = document.createElement('span');
      icon.className =
        token.kind === 'skill' ? 'inline-cube-icon' : 'inline-book-icon';
      icon.setAttribute('aria-hidden', 'true');
      span.append(
        icon,
        document.createTextNode(
          token.kind === 'skill'
            ? workspaceSkillLabel(token.skillId ?? token.label)
            : token.label,
        ),
      );
      fragment.append(span);
      offset = token.end;
    }
    fragment.append(document.createTextNode(props.value.slice(offset)));
    root.replaceChildren(fragment);
    appendTrailingLinePlaceholder(root, props.value);
    lastRendered.current = props.value;
    if (focused)
      place(
        root,
        Math.min(position.start, props.value.length),
        Math.min(position.end, props.value.length),
      );
  };
  useLayoutEffect(() => {
    const saved = history.current[historyIndex.current];
    if (saved?.value !== props.value) {
      if (!restoring.current) {
        history.current = history.current.slice(0, historyIndex.current + 1);
        history.current.push({
          value: props.value,
          position: pendingSelection.current ?? selection.current,
        });
        if (history.current.length > 200) history.current.shift();
        historyIndex.current = history.current.length - 1;
      }
      restoring.current = false;
    }
    if (
      !composing.current &&
      (lastReferences.current !== props.allowedReferences ||
        lastRendered.current !== props.value ||
        readInlineComposer(element.current ?? document.createElement('div')) !==
          props.value)
    )
      render();
    lastReferences.current = props.allowedReferences;
  }, [props.value, props.allowedReferences]);
  useImperativeHandle(ref, () => ({
    focus: () => element.current?.focus(),
    get selectionStart() {
      const root = element.current;
      return ((root && selected(root)) || selection.current).start;
    },
    get selectionEnd() {
      const root = element.current;
      return ((root && selected(root)) || selection.current).end;
    },
    setSelectionRange: (start, end) => {
      selection.current = { start, end };
      if (element.current) place(element.current, start, end);
    },
  }));
  const emit = () => {
    const root = element.current;
    if (!root) return;
    const position = selected(root) ?? selection.current;
    selection.current = position;
    pendingSelection.current = position;
    props.onChange(readInlineComposer(root), position);
  };
  const replace = (text: string) => {
    const root = element.current;
    if (!root) return;
    const at = selected(root) ?? selection.current;
    const value = readInlineComposer(root),
      next = value.slice(0, at.start) + text + value.slice(at.end);
    if (next.length > props.maxLength) return;
    root.replaceChildren(document.createTextNode(next));
    appendTrailingLinePlaceholder(root, next);
    selection.current = {
      start: at.start + text.length,
      end: at.start + text.length,
    };
    pendingSelection.current = selection.current;
    place(root, selection.current.start, selection.current.end);
    props.onChange(next, selection.current);
  };
  const compositionEnd = (_event: CompositionEvent<HTMLDivElement>) => {
    composing.current = false;
    props.onCompositionEnd();
    emit();
  };
  return (
    <div
      ref={element}
      role="textbox"
      aria-label="聊天消息"
      aria-multiline="true"
      aria-autocomplete="list"
      aria-controls={props['aria-controls']}
      aria-expanded={props['aria-expanded']}
      aria-activedescendant={props['aria-activedescendant']}
      aria-disabled={props.disabled}
      contentEditable={!props.disabled}
      suppressContentEditableWarning
      className="inline-composer"
      data-placeholder={props.placeholder}
      onInput={() => {
        if (!composing.current) emit();
      }}
      onSelect={() => {
        const current = element.current && selected(element.current);
        if (current) {
          selection.current = current;
          const saved = history.current[historyIndex.current];
          if (saved?.value === props.value) saved.position = current;
          props.onSelect(current);
        }
      }}
      onFocus={props.onFocus}
      onBlur={props.onBlur}
      onCompositionStart={() => {
        composing.current = true;
        props.onCompositionStart();
      }}
      onCompositionEnd={compositionEnd}
      onPaste={(event) => {
        props.onPaste(event);
        if (event.defaultPrevented) return;
        event.preventDefault();
        replace(
          event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n'),
        );
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (!event.dataTransfer.files.length)
          replace(
            event.dataTransfer.getData('text/plain').replace(/\r\n?/g, '\n'),
          );
      }}
      onCopy={(event) => {
        const root = element.current;
        if (!root) return;
        const range = selected(root);
        const current =
          range &&
          atomicComposerSelection(
            range.start,
            range.end,
            parseInlineComposerTokens(props.value, props.allowedReferences),
          );
        if (!current) return;
        event.clipboardData.setData(
          'text/plain',
          props.value.slice(current.start, current.end),
        );
        event.preventDefault();
      }}
      onCut={(event) => {
        const root = element.current;
        if (!root) return;
        const range = selected(root);
        const current =
          range &&
          atomicComposerSelection(
            range.start,
            range.end,
            parseInlineComposerTokens(props.value, props.allowedReferences),
          );
        if (!current || current.start === current.end) return;
        event.clipboardData.setData(
          'text/plain',
          props.value.slice(current.start, current.end),
        );
        event.preventDefault();
        const deletion = atomicComposerDeletion(
          props.value,
          current.start,
          current.end,
          'backward',
          parseInlineComposerTokens(props.value, props.allowedReferences),
        );
        if (deletion) {
          selection.current = { start: deletion.caret, end: deletion.caret };
          pendingSelection.current = selection.current;
          props.onChange(deletion.text, selection.current);
        }
      }}
      onKeyDown={(event) => {
        if (
          composing.current ||
          event.nativeEvent.isComposing ||
          event.keyCode === 229
        )
          return;
        props.onKeyDown(event);
        if (event.defaultPrevented) return;
        const current = element.current && selected(element.current);
        if (!current) return;
        if (
          (event.ctrlKey || event.metaKey) &&
          !event.altKey &&
          (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')
        ) {
          event.preventDefault();
          const direction =
            event.shiftKey || event.key.toLowerCase() === 'y' ? 1 : -1;
          const nextIndex = historyIndex.current + direction;
          const saved = history.current[nextIndex];
          if (saved) {
            historyIndex.current = nextIndex;
            restoring.current = true;
            selection.current = saved.position;
            pendingSelection.current = saved.position;
            props.onChange(saved.value, saved.position);
          }
          return;
        }
        if (event.key === 'Backspace' || event.key === 'Delete') {
          const deletion = atomicComposerDeletion(
            props.value,
            current.start,
            current.end,
            event.key === 'Backspace' ? 'backward' : 'forward',
            parseInlineComposerTokens(props.value, props.allowedReferences),
          );
          if (deletion) {
            event.preventDefault();
            selection.current = { start: deletion.caret, end: deletion.caret };
            pendingSelection.current = selection.current;
            props.onChange(deletion.text, selection.current);
          }
        } else if (event.key === 'Enter') {
          event.preventDefault();
          replace('\n');
        }
      }}
      onBeforeInput={(event) => {
        const input = event.nativeEvent;
        if (
          input instanceof InputEvent &&
          input.inputType === 'insertText' &&
          input.data &&
          props.value.length -
            (selection.current.end - selection.current.start) +
            input.data.length >
            props.maxLength
        )
          event.preventDefault();
      }}
    />
  );
});

export function InlineMessageContent({
  text,
  allowedReferences,
  renderText,
}: {
  text: string;
  allowedReferences: ReadonlySet<string>;
  renderText: (value: string) => ReactNode;
}) {
  let offset = 0;
  const nodes: ReactNode[] = [];
  for (const token of parseInlineComposerTokens(text, allowedReferences)) {
    if (token.start > offset)
      nodes.push(
        <span key={`text:${offset}`}>
          {renderText(text.slice(offset, token.start))}
        </span>,
      );
    nodes.push(
      <span className="inline-composer-token" key={`token:${token.start}`}>
        <span
          aria-hidden="true"
          className={
            token.kind === 'skill' ? 'inline-cube-icon' : 'inline-book-icon'
          }
        />
        {token.kind === 'skill'
          ? workspaceSkillLabel(token.skillId ?? token.label)
          : token.label}
      </span>,
    );
    offset = token.end;
  }
  if (offset < text.length || !nodes.length)
    nodes.push(
      <span key={`text:${offset}`}>{renderText(text.slice(offset))}</span>,
    );
  return <span className="inline-message-content">{nodes}</span>;
}
