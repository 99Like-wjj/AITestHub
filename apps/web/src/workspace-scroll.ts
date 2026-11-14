import { useEffect, useRef, useState } from 'react';

/** Follow only while the reader stays near the bottom; never scroll on every token unconditionally. */
export function useWorkspaceScroll(conversationId: string | null) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [away, setAway] = useState(false);
  const jump = () => {
    following.current = true;
    setAway(false);
    if (viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight;
  };
  useEffect(() => {
    following.current = true;
    setAway(false);
    let frame = 0;
    const resize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (following.current && viewport.current)
          viewport.current.scrollTop = viewport.current.scrollHeight;
      });
    };
    const observer = new ResizeObserver(resize);
    if (content.current) observer.observe(content.current);
    resize();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [conversationId]);
  const onScroll = () => {
    const element = viewport.current;
    if (!element) return;
    const near =
      element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    following.current = near;
    setAway(!near);
  };
  return { viewport, content, away, onScroll, jump };
}
