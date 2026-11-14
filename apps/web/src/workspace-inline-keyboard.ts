export type InlineCandidateKeyAction =
  | { kind: 'ignore' | 'block' | 'close' }
  | { kind: 'move' | 'choose'; index: number };
export function moveInlineCandidate(
  disabled: readonly boolean[],
  selected: number,
  direction: 1 | -1,
) {
  if (!disabled.length) return -1;
  let index =
    selected >= 0 && selected < disabled.length
      ? selected
      : direction === 1
        ? -1
        : 0;
  for (let visited = 0; visited < disabled.length; visited++) {
    index = (index + direction + disabled.length) % disabled.length;
    if (!disabled[index]) return index;
  }
  return -1;
}
export function inlineCandidateKeyAction(input: {
  key: string;
  composing?: boolean;
  keyCode?: number;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  disabled: readonly boolean[];
  selected: number;
}): InlineCandidateKeyAction {
  if (
    input.composing ||
    input.keyCode === 229 ||
    input.shiftKey ||
    input.ctrlKey ||
    input.altKey ||
    input.metaKey
  )
    return { kind: 'ignore' };
  if (input.key === 'Escape') return { kind: 'close' };
  if (input.key === 'ArrowDown' || input.key === 'ArrowUp') {
    const index = moveInlineCandidate(
      input.disabled,
      input.selected,
      input.key === 'ArrowDown' ? 1 : -1,
    );
    return index < 0 ? { kind: 'block' } : { kind: 'move', index };
  }
  if (input.key === 'Enter')
    return input.selected >= 0 &&
      input.selected < input.disabled.length &&
      !input.disabled[input.selected]
      ? { kind: 'choose', index: input.selected }
      : { kind: 'block' };
  return { kind: 'ignore' };
}
