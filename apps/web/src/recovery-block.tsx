import { useId, type ReactNode } from 'react';
import { Drawer, Form, type FormProps } from 'antd';
import { StatusTag } from './semantic-status';
import { uiLayers } from './ui-layers';
import './recovery-block.css';

export function RecoveryBlock({
  title,
  description,
  reference,
  actions,
  variant = 'lookup',
  className,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  reference?: string;
  actions?: ReactNode;
  variant?: 'lookup' | 'pending';
  className?: string;
  children?: ReactNode;
}) {
  const titleId = useId();
  return (
    <section
      className={`recovery-block recovery-block--${variant}${className ? ' ' + className : ''}`}
      aria-labelledby={titleId}
    >
      <header className="recovery-block-header">
        <div className="recovery-block-summary">
          <div className="recovery-block-heading">
            <h3 id={titleId}>{title}</h3>
            <StatusTag tone={variant === 'pending' ? 'warning' : 'neutral'}>
              {variant === 'pending' ? '待核对' : '只读查询'}
            </StatusTag>
          </div>
          {description && (
            <div className="recovery-block-description">{description}</div>
          )}
          {reference && (
            <code className="recovery-block-reference">{reference}</code>
          )}
        </div>
        {actions && <div className="recovery-block-actions">{actions}</div>}
      </header>
      {children && <div className="recovery-block-body">{children}</div>}
    </section>
  );
}

export function RecoveryQueryForm<Values>({
  className,
  ...props
}: Omit<FormProps<Values>, 'children'> & { children?: ReactNode }) {
  return (
    <Form<Values>
      {...props}
      className={
        className ? `recovery-query-form ${className}` : 'recovery-query-form'
      }
      layout="vertical"
    />
  );
}

export function RecoveryDrawer({
  open,
  onClose,
  forceRender,
  children,
}: {
  open: boolean;
  onClose: () => void;
  forceRender?: boolean;
  children: ReactNode;
}) {
  return (
    <Drawer
      open={open}
      onClose={onClose}
      forceRender={forceRender ?? false}
      width="min(100%, 760px)"
      title="异常排查"
      zIndex={uiLayers.drawer}
    >
      {children}
    </Drawer>
  );
}
