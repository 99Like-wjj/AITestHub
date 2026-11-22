import { Drawer } from 'antd';
import type { ReactNode } from 'react';
import { uiLayers } from './ui-layers';
import './detail-drawer.css';

export function DetailDrawer({
  open,
  title,
  meta,
  wide = false,
  zIndex = uiLayers.detail,
  onClose,
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
  extra?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <Drawer
      open={open}
      zIndex={zIndex}
      size={wide ? 880 : 620}
      destroyOnHidden
      onClose={onClose}
      closable={{ placement: 'end', closeIcon: '关闭' }}
      focusable={{ trap: true, focusTriggerAfterClose: true }}
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
