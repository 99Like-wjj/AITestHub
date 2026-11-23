import { useRef, useState } from 'react';
import { Button } from 'antd';
import { z } from 'zod';
import { idSchema } from '../../../packages/contracts/src/base';
import { api, describeError, isUncertainMutationError } from './api';
import { currentIdentityOwner, identityContextEpoch } from './identity-context';
import { RecoveryBlock } from './recovery-block';

const receiptSchema = z.object({
  command: z.object({
    operation: z.string(),
    projectId: idSchema,
    status: z.enum(['pending', 'completed', 'failed', 'unknown']),
    response: z.unknown(),
  }),
});
export type ReportReviewOperation =
  | 'problems.confirm'
  | 'problems.dismiss'
  | 'problems.preview-confirm'
  | 'problems.confirm-batch'
  | 'problems.review-retest'
  | 'problems.report-extra'
  | 'results.assess'
  | 'results.human-retest'
  | 'issues.file-from-report';

/** Persist only a receipt locator. The notes and attachment selection stay in the form. */
export function useReportCommandRecovery(
  projectId: string,
  operation: ReportReviewOperation,
  scope: string | null,
) {
  const actor = currentIdentityOwner();
  const key =
    actor && scope
      ? [
          'aitesthub:report-command:v1',
          actor,
          projectId,
          operation,
          scope,
        ].join(':')
      : null;
  const currentKey = useRef(key);
  currentKey.current = key;
  const [record, setRecord] = useState<{
    storageKey: string;
    commandId: string;
  }>();
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string>();
  function stored() {
    if (!key) return null;
    if (record?.storageKey === key) return record.commandId;
    try {
      const id = idSchema.safeParse(sessionStorage.getItem(key));
      return id.success ? id.data : null;
    } catch {
      return null;
    }
  }
  const commandId = stored();
  function remember(id: string) {
    if (!key) return;
    try {
      sessionStorage.setItem(key, id);
    } catch {
      // A storage-restricted browser still keeps the locator in this view.
    }
    if (currentKey.current === key)
      setRecord({ storageKey: key, commandId: id });
  }
  function clear(id: string) {
    if (!key) return;
    try {
      if (sessionStorage.getItem(key) === id) sessionStorage.removeItem(key);
    } catch {
      // The in-memory locator is also cleared after a definitive receipt.
    }
    if (currentKey.current === key)
      setRecord((value) =>
        value?.storageKey === key && value.commandId === id ? undefined : value,
      );
  }
  async function send<T>(id: string, action: () => Promise<T>) {
    remember(id);
    try {
      const result = await action();
      clear(id);
      return result;
    } catch (error) {
      if (!isUncertainMutationError(error) && !(error instanceof z.ZodError))
        clear(id);
      throw error;
    }
  }
  async function check<T>(
    schema: z.ZodType<T>,
    accept: (value: T) => void | Promise<void>,
    allowNew: () => void,
  ) {
    if (!key || !commandId || checking) return;
    const epoch = identityContextEpoch();
    const active = () =>
      currentKey.current === key &&
      actor === currentIdentityOwner() &&
      epoch === identityContextEpoch();
    setChecking(true);
    setMessage(undefined);
    try {
      const params = new URLSearchParams({ operation, key: commandId });
      const { command } = await api(
        '/projects/' + projectId + '/problems/operation-status?' + params,
        {},
        receiptSchema,
      );
      if (!active()) return;
      if (command.operation !== operation || command.projectId !== projectId)
        throw new Error('原回执项目或操作不匹配。');
      if (command.status === 'completed') {
        await accept(schema.parse(command.response));
        clear(commandId);
        if (active()) setMessage('已核对原操作回执。');
      } else if (command.status === 'failed') {
        clear(commandId);
        allowNew();
        if (active())
          setMessage('原操作明确未完成，核对当前基准后可重新处理。');
      } else {
        setMessage('原操作结果尚未确认，仍保留原提交标识。');
      }
    } catch (error) {
      if (active()) setMessage('原回执未确认：' + describeError(error));
    } finally {
      if (active()) setChecking(false);
    }
  }
  return { commandId, checking, message, send, check };
}

export function ReportReceiptControl({
  recovery,
  onCheck,
}: {
  recovery: ReturnType<typeof useReportCommandRecovery>;
  onCheck: () => void;
}) {
  if (recovery.commandId) {
    return (
      <RecoveryBlock
        variant="pending"
        title="核对原操作回执"
        reference={recovery.commandId}
        actions={
          <Button size="small" loading={recovery.checking} onClick={onCheck}>
            查询原回执
          </Button>
        }
      >
        {recovery.message && <p role="status">{recovery.message}</p>}
      </RecoveryBlock>
    );
  }
  return recovery.message ? (
    <p className="caption" role="status">
      {recovery.message}
    </p>
  ) : null;
}
