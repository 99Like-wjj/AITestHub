import { useEffect, useRef, type RefObject } from 'react';

/** Only keyboard dismissal restores focus. Pointer dismissal keeps the user's new target. */
export function useWorkspaceEscapeFocus(
  open: boolean,
  close: () => void,
  trigger?: RefObject<HTMLElement | null>,
) {
  const latestClose = useRef(close);
  latestClose.current = close;
  useEffect(() => {
    if (!open) return;
    const anchor =
      trigger?.current ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229)
        return;
      event.preventDefault();
      event.stopPropagation();
      latestClose.current();
      requestAnimationFrame(() => {
        if (anchor?.isConnected && anchor !== document.body) anchor.focus();
      });
    };
    document.addEventListener('keydown', dismiss, true);
    return () => document.removeEventListener('keydown', dismiss, true);
  }, [open, trigger]);
}
