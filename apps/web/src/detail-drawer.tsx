import { Drawer } from 'antd';
import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { uiLayers } from './ui-layers';
import './detail-drawer.css';

export function DetailDrawer({
  open,
  title,
  meta,
  wide = false,
  zIndex = uiLayers.detail,
  onClose,
  returnFocusRef,
  extra,
  children,
  footer,
  className,
}: {
  open: boolean;
  title: ReactNode;
  meta?: ReactNode;
  wide?: boolean;
  zIndex?: number;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  extra?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const previouslyOpen = useRef(false);
  function focusAfterClose(target: HTMLElement | null | undefined) {
    return requestAnimationFrame(() => {
      if (target?.isConnected) target.focus({ preventScroll: true });
    });
  }
  useEffect(() => {
    const closing = previouslyOpen.current && !open;
    previouslyOpen.current = open;
    if (!closing || !returnFocusRef) return;
    // Closing before the opening animation finishes can skip afterOpenChange.
    const frame = focusAfterClose(returnFocusRef.current);
    return () => cancelAnimationFrame(frame);
  }, [open, returnFocusRef]);
  return (
    <Drawer
      open={open}
      zIndex={zIndex}
      size={wide ? 880 : 620}
      destroyOnHidden
      onClose={onClose}
      closable={{ placement: 'end', closeIcon: '关闭' }}
      focusable={{ trap: true, focusTriggerAfterClose: !returnFocusRef }}
      afterOpenChange={(visible) => {
        if (!visible && returnFocusRef) focusAfterClose(returnFocusRef.current);
      }}
      classNames={{
        section: ['ath-detail-drawer', className].filter(Boolean).join(' '),
      }}
      title={
        <div className="detail-drawer-heading">
          <h2>{title}</h2>
          {meta && <div className="detail-drawer-meta">{meta}</div>}
        </div>
      }
      extra={extra}
      footer={footer}
    >
      {children}
    </Drawer>
  );
}
