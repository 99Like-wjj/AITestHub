import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, SetStateAction } from 'react';
import { Alert, Button, Modal, Space, Typography } from 'antd';
import { z } from 'zod';
import { ApiError, isUncertainMutationError, describeError } from './api';
import { uiLayers } from './ui-layers';

export function useBusinessCommand(session: string | null) {
  // The displayed key and the dispatched key come from the same render intent.
  // A→B→A creates a fresh identity, so a late A receipt cannot affect the new A.
  const intent = useMemo(
    () => ({ key: crypto.randomUUID(), busy: false, uncertain: false }),
    [session],
  );
  const current = useRef(intent);
  current.current = intent;
  const alive = useRef(true);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const initial = {
    pending: false,
    error: undefined as string | undefined,
    errorCode: undefined as string | undefined,
    uncertain: false,
  };
  const [state, setState] = useState(() => ({ intent, ...initial }));
  const view = state.intent === intent ? state : initial;
  function patch(change: Partial<typeof initial>) {
    if (!alive.current || current.current !== intent) return;
    setState((previous) =>
      !alive.current || current.current !== intent
        ? previous
        : {
            ...(previous.intent === intent ? previous : { intent, ...initial }),
            ...change,
          },
    );
  }
  function setError(value: SetStateAction<string | undefined>) {
    if (!alive.current || current.current !== intent) return;
    setState((previous) => {
      if (!alive.current || current.current !== intent) return previous;
      const before =
        previous.intent === intent ? previous : { intent, ...initial };
      return {
        ...before,
        error: typeof value === 'function' ? value(before.error) : value,
        errorCode: undefined,
      };
    });
  }
  async function run<T>(
    action: (commandId: string) => Promise<T>,
  ): Promise<T | null> {
    if (
      !session ||
      !alive.current ||
      current.current !== intent ||
      intent.busy ||
      intent.uncertain
    )
      return null;
    intent.busy = true;
    patch({ pending: true, error: undefined, errorCode: undefined });
    try {
      const result = await action(intent.key);
      return alive.current && current.current === intent ? result : null;
    } catch (failure) {
      if (alive.current && current.current === intent) {
        if (isUncertainMutationError(failure)) {
          intent.uncertain = true;
          patch({ uncertain: true });
        }
        patch({
          error:
            failure instanceof z.ZodError
              ? failure.issues
                  .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
                  .join('；')
              : describeError(failure),
          errorCode: failure instanceof ApiError ? failure.code : undefined,
        });
      }
      return null;
    } finally {
      intent.busy = false;
      patch({ pending: false });
    }
  }
  return {
    commandId: intent.key,
    pending: view.pending,
    error: view.error,
    errorCode: view.errorCode,
    uncertain: view.uncertain,
    run,
    setError,
    confirmRecoveredReceipt: () => {
      if (!alive.current || current.current !== intent) return;
      intent.uncertain = false;
      patch({ uncertain: false });
    },
    closeRecoveredReceipt: (commandId: string) => {
      if (
        !alive.current ||
        current.current !== intent ||
        intent.busy ||
        intent.key !== commandId
      )
        return;
      intent.key = crypto.randomUUID();
      intent.uncertain = false;
      patch({ uncertain: false, error: undefined, errorCode: undefined });
    },
  };
}
type CommandState = ReturnType<typeof useBusinessCommand>;
export function CommandDialog({
  open,
  title,
  command,
  dirty,
  onClose,
  onSave,
  children,
  width = 750,
  saveLabel = '保存',
  allowSave = true,
  busy = false,
  zIndex = uiLayers.dialog,
}: {
  open: boolean;
  title: ReactNode;
  command: CommandState;
  dirty: boolean;
  onClose: () => void;
  onSave: () => void;
  children: ReactNode;
  width?: number;
  saveLabel?: string;
  allowSave?: boolean;
  busy?: boolean;
  zIndex?: number;
}) {
  const [discard, setDiscard] = useState(false);
  useEffect(() => {
    if (!open) setDiscard(false);
  }, [open]);
  function close() {
    if (command.pending || busy) return;
    if (dirty) setDiscard(true);
    else onClose();
  }
  return (
    <>
      <Modal
        open={open}
        zIndex={zIndex}
        title={title}
        width={width}
        onCancel={close}
        closable={!command.pending && !busy}
        maskClosable={!command.pending && !busy}
        keyboard={!command.pending && !busy}
        destroyOnHidden
        footer={
          <Space>
            <Button disabled={command.pending || busy} onClick={close}>
              取消
            </Button>
            <Button
              type="primary"
              loading={command.pending}
              disabled={command.uncertain || !allowSave || busy}
              onClick={onSave}
            >
              {saveLabel}
            </Button>
          </Space>
        }
      >
        {command.error && (
          <Alert
            className="section-alert"
            type="error"
            showIcon
            title={command.error}
          />
        )}
        {command.uncertain && (
          <Alert
            className="section-alert"
            type="warning"
            showIcon
            title={`本次操作回执未知：${command.commandId}`}
            description="已禁重发，请先只读核对原对象/回执。不要通过更换提交标识推断原操作未发生。"
          />
        )}
        {children}
      </Modal>
      <Modal
        open={discard}
        zIndex={Math.max(uiLayers.confirmation, zIndex + 100)}
        title="有未保存修改"
        onCancel={() => setDiscard(false)}
        footer={
          <Space>
            <Button onClick={() => setDiscard(false)}>继续编辑</Button>
            <Button
              danger
              onClick={() => {
                setDiscard(false);
                onClose();
              }}
            >
              放弃修改
            </Button>
            <Button
              type="primary"
              disabled={command.uncertain || !allowSave}
              onClick={() => {
                setDiscard(false);
                onSave();
              }}
            >
              保存
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph>
          保存按当前固定基准提交；放弃只丢弃尚未保存的输入。
        </Typography.Paragraph>
      </Modal>
    </>
  );
}
