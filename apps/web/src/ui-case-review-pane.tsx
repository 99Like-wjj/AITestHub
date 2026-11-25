import { useRef, useState } from 'react';
import { Alert, Button, Input, Space, Typography } from 'antd';
import { z } from 'zod';
import {
  assetSchema,
  type Asset,
} from '../../../packages/contracts/src/assets';
import { idSchema } from '../../../packages/contracts/src/base';
import { uiCaseReviewDetailSchema } from '../../../packages/contracts/src/ui-reviews';
import { api, describeError } from './api';
import { formatBeijingTime } from './beijing-time';

type ReviewDetail = z.infer<typeof uiCaseReviewDetailSchema>;
const savedOpinionSchema = z.strictObject({
  opinionId: idSchema,
  asset: assetSchema,
});

export function UiCaseReviewPane({
  asset,
  review,
  draft,
  writable,
  approving,
  approvalReasons,
  onDraft,
  onBusy,
  onApprove,
  onChanged,
}: {
  asset: Asset;
  review: ReviewDetail;
  draft: string;
  writable: boolean;
  approving: boolean;
  approvalReasons: string[] | undefined;
  onDraft: (value: string) => void;
  onBusy: (busy: boolean) => void;
  onApprove: () => void;
  onChanged: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const savingRef = useRef(false);
  const command = useRef<{ id: string; body: string } | undefined>(undefined);
  const editing = writable && asset.reviewState !== 'approved';

  async function save() {
    const body = draft.trim();
    if (!body || !editing || savingRef.current || approving) return;
    savingRef.current = true;
    setSaving(true);
    onBusy(true);
    setError(undefined);
    setNotice(undefined);
    if (command.current?.body !== body)
      command.current = { id: crypto.randomUUID(), body };
    try {
      await api(
        `/projects/${asset.projectId}/assets/${asset.id}/opinions`,
        {
          method: 'POST',
          body: {
            commandId: command.current.id,
            body,
            targetRevisionId: asset.revisionId,
          },
        },
        savedOpinionSchema,
      );
      command.current = undefined;
      onDraft('');
      setNotice('评审建议已保存。');
      await onChanged();
    } catch (failure: unknown) {
      setError(describeError(failure));
    } finally {
      savingRef.current = false;
      setSaving(false);
      onBusy(false);
    }
  }

  return (
    <>
      {editing && (
        <div className="ui-case-opinion-editor">
          <label htmlFor="ui-case-suggestion">当前用例的修改建议</label>
          <Input.TextArea
            id="ui-case-suggestion"
            rows={4}
            value={draft}
            maxLength={10000}
            placeholder="填写需要更正的步骤、条件或预期结果"
            disabled={saving || approving}
            onChange={(event) => onDraft(event.target.value)}
          />
          <Space wrap size={8}>
            <Button
              size="small"
              disabled={!draft.trim() || approving}
              loading={saving}
              onClick={() => void save()}
            >
              保存建议
            </Button>
            <Button
              size="small"
              type="primary"
              loading={approving}
              disabled={
                saving || Boolean(draft.trim()) || approvalReasons?.length !== 0
              }
              onClick={onApprove}
            >
              审批通过
            </Button>
          </Space>
        </div>
      )}
      {notice && (
        <Typography.Text type="success" role="status">
          {notice}
        </Typography.Text>
      )}
      {error && <Alert type="error" showIcon title={error} />}
      {editing && Boolean(approvalReasons?.length) && (
        <Typography.Text type="secondary">
          {approvalReasons?.join(' ')}
        </Typography.Text>
      )}
      {asset.reviewState === 'approved' && review.latestApproval && (
        <Typography.Text>
          已审批通过 r{review.latestApproval.revisionNo}
        </Typography.Text>
      )}
      {review.suggestions.length > 0 && (
        <div className="ui-case-saved-opinions">
          <h3>已保存建议</h3>
          {review.suggestions.map((suggestion) => (
            <article key={suggestion.id}>
              <span className="caption">
                r{suggestion.sourceRevisionNo} ·{' '}
                {formatBeijingTime(suggestion.createdAt, true)}
              </span>
              <p className="preserve-lines">{suggestion.body}</p>
              {suggestion.response && (
                <>
                  <strong>处理说明</strong>
                  <p className="preserve-lines">{suggestion.response}</p>
                </>
              )}
            </article>
          ))}
        </div>
      )}
    </>
  );
}
