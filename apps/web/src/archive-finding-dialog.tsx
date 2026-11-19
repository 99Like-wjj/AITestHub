import { useEffect, useRef, useState } from 'react';
import { Alert, Input, Modal, Space } from 'antd';
import { api, describeError } from './api';
import type { Project } from './types';
import {
  reportProblemInputSchema,
  problemResponseSchema,
} from '../../../packages/contracts/src/issues';

export interface ArchiveFinding {
  runId: string;
  resultId: string;
  title: string;
  observations: string;
  requirementId: string;
  requirementVersionId: string | null;
  evidenceRefs: string[];
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
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<string>();
  const [working, setWorking] = useState(false);
  const command = useRef<string>('');
  useEffect(() => {
    setTitle(finding?.title ?? '');
    setBody(finding?.observations ?? '');
    setError(undefined);
    setSaved(undefined);
    command.current = crypto.randomUUID();
  }, [finding]);
  async function save() {
    if (!finding || working) return;
    if (saved) {
      onClose();
      return;
    }
    setWorking(true);
    setError(undefined);
    try {
      const input = reportProblemInputSchema.parse({
        commandId: command.current,
        runId: finding.runId,
        requirementId: finding.requirementId,
        requirementVersionId: finding.requirementVersionId,
        title,
        description: body,
        suggestedSeverity: 'normal',
        resultIds: [finding.resultId],
        localEvidenceIds: finding.evidenceRefs,
      });
      const response = await api(
        `/projects/${project.id}/problems`,
        { method: 'POST', body: input },
        problemResponseSchema,
      );
      setSaved(response.problem.id);
      onSaved();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setWorking(false);
    }
  }
  return (
    <Modal
      open={Boolean(finding)}
      title="从独立归档登记待确认问题"
      confirmLoading={working}
      onCancel={() => {
        if (!working) onClose();
      }}
      onOk={() => void save()}
      okText={saved ? '完成' : '登记问题'}
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        {error && <Alert type="error" title={error} showIcon />}
        {saved && <Alert type="success" title="已登记待确认问题" showIcon />}
        <Input
          aria-label="问题标题"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={Boolean(saved) || working}
        />
        <Input.TextArea
          aria-label="实际观察"
          rows={5}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={Boolean(saved) || working}
        />
      </Space>
    </Modal>
  );
}
