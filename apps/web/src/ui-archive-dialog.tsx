import { useRef, useState } from 'react';
import { Alert, Button, Input, Modal, Space, Table, Typography } from 'antd';
import { z } from 'zod';
import {
  evidenceManifestItemSchema,
  resultItemSchema,
  resultSubmissionReceiptSchema,
} from '../../../packages/contracts/src/domain';
import {
  uiArchiveInputSchema,
  uiArchivePreviewSchema,
  uiArchiveReceiptSchema,
  uiArchiveResultReceiptSchema,
  uiArchiveResultSubmissionSchema,
} from '../../../packages/contracts/src/ui-archives';
import { api, describeError, isUncertainMutationError } from './api';
import { previewUploadMediaType } from '../../../packages/contracts/src/file-preview';
import { fileReceiptSchema } from '../../../packages/contracts/src/files';
import type { Project } from './types';
import { uploadProjectFile } from './file-channel';
import { identityContextEpoch, currentIdentityOwner } from './identity-context';

const importedResult = resultItemSchema.omit({ runItemId: true }).extend({
  localItemId: z.string().min(1).max(200),
});
const importedManifest = evidenceManifestItemSchema
  .omit({ fileId: true })
  .extend({ filename: z.string().min(1).max(512) });
const importSchema = z.strictObject({
  execution: uiArchiveInputSchema,
  results: z.array(importedResult).min(1).max(10000),
  evidence: z.array(importedManifest).max(100).default([]),
});
type Preview = {
  digest: string;
  input: z.infer<typeof importSchema>;
  reply: z.infer<typeof uiArchivePreviewSchema>;
  registrationId: string;
  submissionId: string;
  owner: string | null;
  epoch: number;
};
export function UiArchiveDialog({
  project,
  open,
  onClose,
  onSaved,
}: {
  project: Project;
  open: boolean;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);
  const [uncertain, setUncertain] = useState<'archive' | 'submission'>();
  const fileStatus = useRef<Record<string, string>>({});
  const registration = useRef<
    z.infer<typeof uiArchiveReceiptSchema> | undefined
  >(undefined);
  const busy = useRef(false);

  async function chooseJson(file: File | undefined) {
    if (!file || busy.current) return;
    if (file.size > 16 * 1024 * 1024) {
      setError('单份归档 JSON 最大 16 MiB。');
      return;
    }
    try {
      setText(await file.text());
      setPreview(undefined);
      setError(undefined);
    } catch (failure) {
      setError(describeError(failure));
    }
  }
  async function prepare() {
    if (busy.current) return;
    busy.current = true;
    setWorking(true);
    setError(undefined);
    try {
      const owner = currentIdentityOwner(),
        epoch = identityContextEpoch();
      const input = importSchema.parse(JSON.parse(text));
      const valid = new Map(
        input.execution.items.map((i) => [i.localItemId, i.originalOutcome]),
      );
      if (
        new Set(input.results.map((i) => i.localItemId)).size !== valid.size ||
        input.results.length !== valid.size ||
        input.results.some(
          (i) => i.originalOutcome !== valid.get(i.localItemId),
        )
      )
        throw new Error('每个归档项须有一条实际明细，且原始结论与归档项一致。');
      const reply = await api(
        `/projects/${project.id}/ui-archives/preview`,
        { method: 'POST', body: input.execution },
        uiArchivePreviewSchema,
      );
      if (owner !== currentIdentityOwner() || epoch !== identityContextEpoch())
        throw new Error('账号已切换，请重新选择归档范围。');
      setPreview({
        digest: reply.previewDigest,
        input,
        reply,
        registrationId: crypto.randomUUID(),
        submissionId: crypto.randomUUID(),
        owner,
        epoch,
      });
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      busy.current = false;
      setWorking(false);
    }
  }
  async function confirm() {
    if (!preview || busy.current) return;
    const p = preview;
    busy.current = true;
    setWorking(true);
    setError(undefined);
    const checkIdentity = () => {
      if (
        p.owner !== currentIdentityOwner() ||
        p.epoch !== identityContextEpoch()
      )
        throw new Error('当前账号已变化，请核对原归档及交付回执。');
    };
    let dispatched: 'archive' | 'submission' | undefined;
    try {
      checkIdentity();
      if (uncertain === 'submission') {
        const runId = registration.current?.runId;
        if (!runId) throw new Error('缺少原归档轮次，请核对原登记回执。');
        const { receipt } = await api(
          `/projects/${project.id}/ui-archives/${runId}/result-receipts/${p.submissionId}`,
          {},
          uiArchiveResultReceiptSchema,
        );
        checkIdentity();
        if (receipt.submissionId !== p.submissionId)
          throw new Error('提交回执与原归档提交不一致。');
        if (
          receipt.reportId &&
          receipt.perItemResults.every((row) => row.status === 'accepted')
        ) {
          setUncertain(undefined);
          setPreview(undefined);
          setText('');
          setFiles([]);
          fileStatus.current = {};
          registration.current = undefined;
          onSaved(receipt.reportId);
          return;
        }
        throw new Error('原提交已取得，但尚无正式归档报告。');
      }
      if (!registration.current && uncertain === 'archive') {
        registration.current = await api(
          `/projects/${project.id}/ui-archives/receipts/${p.registrationId}`,
          {},
          uiArchiveReceiptSchema,
        );
        setUncertain(undefined);
      }
      if (!registration.current) dispatched = 'archive';
      const archived =
        registration.current ??
        (await api(
          `/projects/${project.id}/ui-archives`,
          {
            method: 'POST',
            body: {
              commandId: p.registrationId,
              input: p.input.execution,
              previewDigest: p.digest,
            },
          },
          uiArchiveReceiptSchema,
        ));
      registration.current = archived;
      dispatched = undefined;
      const evidenceManifest = [];
      for (const { filename, ...item } of p.input.evidence) {
        checkIdentity();
        const file = files.find((candidate) => candidate.name === filename);
        const key = item.localEvidenceId;
        const stored = fileStatus.current[key];
        const pending =
          !file && !stored
            ? await api(
                '/files/register',
                {
                  method: 'POST',
                  body: {
                    projectId: project.id,
                    ownerScope: 'project',
                    runId: archived.runId,
                    localFileId: key,
                    sha256: item.sha256,
                    bytes: item.bytes,
                    originalName: filename,
                    mediaType: previewUploadMediaType(filename, ''),
                  },
                },
                fileReceiptSchema,
              )
            : null;
        const fileId = file
          ? (await uploadProjectFile(project.id, file, key, archived.runId)).id
          : (stored ?? pending?.file.id);
        if (!fileId) throw new Error('原证据登记回执缺失，请核对原件。');
        fileStatus.current[key] = fileId;
        evidenceManifest.push({ ...item, fileId });
      }
      const ids = new Map(
        archived.scope.items.map((item) => [item.localItemId, item.runItemId]),
      );
      const input = uiArchiveResultSubmissionSchema.parse({
        schemaVersion: 'ath.ui-archive-results.v1',
        runId: archived.runId,
        submissionId: p.submissionId,
        snapshotDigest: archived.scope.snapshotDigest,
        endedAt: p.input.execution.endedAt,
        items: p.input.results.map(({ localItemId, ...item }) => ({
          ...item,
          runItemId: ids.get(localItemId),
        })),
        evidenceManifest,
      });
      checkIdentity();
      dispatched = 'submission';
      const receipt = await api(
        `/projects/${project.id}/ui-archives/results`,
        { method: 'POST', body: input },
        resultSubmissionReceiptSchema,
      );
      checkIdentity();
      if (
        receipt.submissionId !== p.submissionId ||
        !receipt.reportId ||
        receipt.perItemResults.some((row) => row.status !== 'accepted')
      )
        throw new Error('归档未全部接收，请查看执行记录和原提交回执。');
      setText('');
      setPreview(undefined);
      setFiles([]);
      fileStatus.current = {};
      registration.current = undefined;
      onSaved(receipt.reportId);
    } catch (failure) {
      if (dispatched && isUncertainMutationError(failure))
        setUncertain(dispatched);
      setError(describeError(failure));
    } finally {
      busy.current = false;
      setWorking(false);
    }
  }
  function close() {
    if (working) return;
    onClose();
  }
  return (
    <Modal
      open={open}
      title="上传本地 UI 独立归档"
      width={820}
      onCancel={close}
      confirmLoading={working}
      onOk={() => void (preview ? confirm() : prepare())}
      okText={uncertain ? '核对原回执' : preview ? '确认并上传' : '核对归档'}
      cancelText="返回"
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        {error && <Alert type="error" title={error} showIcon />}
        {!preview && (
          <>
            <Typography.Text>
              导入本地 Skill 导出的归档 JSON，原始结果和证据将单独归档。
            </Typography.Text>
            <label>
              选择 JSON 文件{' '}
              <input
                type="file"
                accept=".json,application/json"
                onChange={(event) => void chooseJson(event.target.files?.[0])}
              />
            </label>
            <Input.TextArea
              rows={5}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="也可粘贴本地归档 JSON"
            />
          </>
        )}
        {preview && (
          <>
            <Typography.Text strong>
              {preview.input.execution.title} · {preview.reply.environment.name}
            </Typography.Text>
            <Table
              rowKey="localItemId"
              pagination={{ pageSize: 8 }}
              size="small"
              dataSource={preview.reply.items}
              columns={[
                { title: '本地条目', dataIndex: 'title' },
                { title: '需求', dataIndex: 'requirementTitle' },
                { title: '原始判断', dataIndex: 'originalOutcome' },
                {
                  title: '用例引用',
                  render: (_, r) =>
                    r.matched ? '已匹配' : (r.matchReason ?? '本地条目'),
                },
              ]}
            />
            {preview.input.evidence.length > 0 && (
              <div>
                <label>
                  选择清单中的证据文件{' '}
                  <input
                    type="file"
                    multiple
                    disabled={working}
                    onChange={(event) =>
                      setFiles(Array.from(event.target.files ?? []))
                    }
                  />
                </label>
                <ul>
                  {preview.input.evidence.map((item) => (
                    <li key={item.localEvidenceId}>
                      {item.filename}
                      {fileStatus.current[item.localEvidenceId] ||
                      files.some((f) => f.name === item.filename)
                        ? ' · 已选择'
                        : ' · 待选择'}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!registration.current && !working && !uncertain && (
              <Button onClick={() => setPreview(undefined)}>
                返回调整范围
              </Button>
            )}
          </>
        )}
      </Space>
    </Modal>
  );
}
