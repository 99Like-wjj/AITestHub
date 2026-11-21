import { useEffect, useRef, useState } from 'react';
import { Alert, Input, Space } from 'antd';
import { api } from './api';
import type { Project } from './types';
import {
  reportProblemInputSchema,
  webReportProblemInputSchema,
  problemResponseSchema,
} from '../../../packages/contracts/src/issues';
import type { ReportProblemReviewScope } from '../../../packages/contracts/src/issues';
import { CommandDialog, useBusinessCommand } from './business-command';
import {
  ReportReceiptControl,
  useReportCommandRecovery,
} from './report-command-recovery';

export interface ArchiveFinding {
  runId: string;
  resultId: string;
  title: string;
  observations: string;
  requirementId: string;
  requirementVersionId: string | null;
  evidenceRefs: string[];
  reportReview?: ReportProblemReviewScope;
}
export function ArchiveFindingDialog({
  project,
  finding,
  onSaved,
  onClose,
}: {
  project: Project;
  finding: ArchiveFinding | undefined;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [saved, setSaved] = useState<string>();
  const session = useRef(crypto.randomUUID());
  const command = useBusinessCommand(finding ? session.current : null);
  const recovery = useReportCommandRecovery(
    project.id,
    'problems.report-extra',
    finding?.reportReview?.resultId ?? null,
  );
  useEffect(() => {
    setTitle(finding?.title ?? '');
    setBody(finding?.observations ?? '');
    setSaved(undefined);
  }, [finding]);
  function accept(response: { problem: { id: string } }) {
    setSaved(response.problem.id);
    onSaved();
  }
  async function save() {
    if (!finding || command.pending || recovery.commandId) return;
    if (saved) {
      onClose();
      return;
    }
    const response = await command.run((commandId) => {
      const input = (
        finding.reportReview
          ? webReportProblemInputSchema
          : reportProblemInputSchema
      ).parse({
        commandId,
        runId: finding.runId,
        requirementId: finding.requirementId,
        requirementVersionId: finding.requirementVersionId,
        title,
        description: body,
        suggestedSeverity: 'normal',
        resultIds: [finding.resultId],
        localEvidenceIds: finding.evidenceRefs,
        ...(finding.reportReview ? { reportReview: finding.reportReview } : {}),
      });
      const request = () =>
        api(
          `/projects/${project.id}/problems`,
          { method: 'POST', body: input },
          problemResponseSchema,
        );
      return finding.reportReview
        ? recovery.send(commandId, request)
        : request();
    });
    if (response) accept(response);
  }
  return (
    <CommandDialog
      open={Boolean(finding)}
      inline={!!finding?.reportReview}
      title="从独立归档登记待确认问题"
      command={command}
      dirty={
        !saved && (title !== finding?.title || body !== finding?.observations)
      }
      onClose={onClose}
      onSave={() => void save()}
      allowSave={
        !recovery.commandId &&
        (Boolean(saved) || (!!title.trim() && !!body.trim()))
      }
      saveLabel={saved ? '完成' : '登记问题'}
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        {finding?.reportReview && (
          <ReportReceiptControl
            recovery={recovery}
            onCheck={() => {
              const id = recovery.commandId;
              if (id)
                void recovery.check(
                  problemResponseSchema,
                  (result) => {
                    if (result.problem.sourceResultId !== finding.resultId)
                      throw new Error('原登记回执不属于当前执行项。');
                    command.confirmRecoveredReceipt();
                    accept(result);
                  },
                  () => command.closeRecoveredReceipt(id),
                );
            }}
          />
        )}
        {saved && <Alert type="success" title="已登记待确认问题" showIcon />}
        <Input
          aria-label="问题标题"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={Boolean(saved) || command.pending || !!recovery.commandId}
        />
        <Input.TextArea
          aria-label="实际观察"
          rows={5}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={Boolean(saved) || command.pending || !!recovery.commandId}
        />
      </Space>
    </CommandDialog>
  );
}
