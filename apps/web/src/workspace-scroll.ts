import { useLayoutEffect, useRef, useState } from 'react';

const bottomMargin = 80;
const scrollIntentDuration = 1000;

/** Follow new content until the reader deliberately scrolls up through history. */
export function useWorkspaceScroll(conversationId: string | null) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const upwardIntentUntil = useRef(0);
  const scrollbarDragging = useRef(false);
  const [position, setPosition] = useState({ conversationId, away: false });
  const away = position.conversationId === conversationId && position.away;
  const jump = () => {
    upwardIntentUntil.current = 0;
    scrollbarDragging.current = false;
    following.current = true;
    setPosition({ conversationId, away: false });
    if (viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight;
  };
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    following.current = true;
    upwardIntentUntil.current = 0;
    scrollbarDragging.current = false;
    setPosition({ conversationId, away: false });
    element.scrollTop = element.scrollHeight;
    let previousTop = element.scrollTop;
    let touchY: number | null = null;
    let frame = 0;
    const nearBottom = () =>
      element.scrollHeight - element.scrollTop - element.clientHeight <
      bottomMargin;
    const updateAway = () => {
      const next = !following.current && !nearBottom();
      setPosition((current) =>
        current.conversationId === conversationId && current.away === next
          ? current
          : { conversationId, away: next },
      );
    };
    const resize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (
          following.current &&
          performance.now() >= upwardIntentUntil.current &&
          !scrollbarDragging.current
        ) {
          element.scrollTop = element.scrollHeight;
          previousTop = element.scrollTop;
        } else if (following.current) {
          // An input that did not actually scroll must not leave following
          // suspended after the gesture (for example a nested code block).
          resize();
        }
        updateAway();
      });
    };
    const upwardIntent = () => {
      if (element.scrollTop <= 0) return;
      upwardIntentUntil.current = performance.now() + scrollIntentDuration;
      cancelAnimationFrame(frame);
    };
    const onScroll = () => {
      const top = element.scrollTop;
      const movedUp = top < previousTop - 0.5;
      const movedDown = top > previousTop + 0.5;
      if (
        movedUp &&
        (performance.now() < upwardIntentUntil.current ||
          scrollbarDragging.current)
      )
        following.current = false;
      if (nearBottom() && !movedUp) {
        following.current = true;
        if (movedDown) upwardIntentUntil.current = 0;
      }
      previousTop = top;
      updateAway();
      // Layout and programmatic scroll events cannot make a following reader
      // look like they requested history, even before ResizeObserver catches up.
      if (
        following.current &&
        element.scrollHeight - top - element.clientHeight > 1
      )
        resize();
    };
    const onWheel = (event: WheelEvent) => {
      if (!event.defaultPrevented && event.deltaY < 0) upwardIntent();
    };
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches.item(0)?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const nextY = event.touches.item(0)?.clientY ?? null;
      if (touchY !== null && nextY !== null && nextY > touchY) upwardIntent();
      touchY = nextY;
    };
    const onTouchEnd = () => {
      touchY = null;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        (target instanceof HTMLElement &&
          (target.isContentEditable ||
            target.closest(
              'input, textarea, select, [contenteditable="true"]',
            )))
      )
        return;
      if (
        event.key === 'ArrowUp' ||
        event.key === 'PageUp' ||
        event.key === 'Home' ||
        (event.key === ' ' && event.shiftKey)
      )
        upwardIntent();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.target !== element) return;
      const bounds = element.getBoundingClientRect();
      const gutter = Math.max(16, element.offsetWidth - element.clientWidth);
      scrollbarDragging.current = event.clientX >= bounds.right - gutter;
      if (scrollbarDragging.current) cancelAnimationFrame(frame);
    };
    const onPointerUp = () => {
      scrollbarDragging.current = false;
      if (following.current) resize();
    };
    const observer = new ResizeObserver(resize);
    if (content.current) observer.observe(content.current);
    observer.observe(element);
    element.addEventListener('scroll', onScroll);
    element.addEventListener('wheel', onWheel, { passive: true });
    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchmove', onTouchMove, { passive: true });
    element.addEventListener('touchend', onTouchEnd);
    element.addEventListener('touchcancel', onTouchEnd);
    element.addEventListener('keydown', onKeyDown);
    element.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('blur', onPointerUp);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      element.removeEventListener('scroll', onScroll);
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchmove', onTouchMove);
      element.removeEventListener('touchend', onTouchEnd);
      element.removeEventListener('touchcancel', onTouchEnd);
      element.removeEventListener('keydown', onKeyDown);
      element.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('blur', onPointerUp);
    };
  }, [conversationId]);
  return { viewport, content, away, jump };
}
