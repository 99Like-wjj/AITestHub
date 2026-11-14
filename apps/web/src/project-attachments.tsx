import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Space, Typography, Upload } from 'antd';
import { uploadProjectFile } from './file-channel';
import { describeError } from './api';
import { EvidenceViewer } from './evidence-viewer';
interface UploadRow {
  localId: string;
  file: File;
  state: 'uploading' | 'verified' | 'failed';
  fileId?: string;
  error?: string | undefined;
}
export function ProjectAttachments({
  projectId,
  value = [],
  onChange,
  disabled = false,
  onBusy,
}: {
  projectId: string;
  value?: string[];
  onChange?: (ids: string[]) => void;
  disabled?: boolean;
  onBusy?: (busy: boolean) => void;
}) {
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const current = useRef(value);
  current.current = value;
  useEffect(() => {
    onBusy?.(rows.some((row) => row.state === 'uploading'));
  }, [rows, onBusy]);
  async function send(row: UploadRow) {
    setRows((previous) =>
      previous.map((entry) =>
        entry.localId === row.localId
          ? { ...entry, state: 'uploading', error: undefined }
          : entry,
      ),
    );
    try {
      const file = await uploadProjectFile(projectId, row.file, row.localId);
      setRows((previous) =>
        previous.map((entry) =>
          entry.localId === row.localId
            ? { ...entry, state: 'verified', fileId: file.id, error: undefined }
            : entry,
        ),
      );
      if (!current.current.includes(file.id)) {
        const next = [...current.current, file.id];
        current.current = next;
        onChange?.(next);
      }
    } catch (failure) {
      setRows((previous) =>
        previous.map((entry) =>
          entry.localId === row.localId
            ? { ...entry, state: 'failed', error: describeError(failure) }
            : entry,
        ),
      );
    }
  }
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Upload
        multiple
        showUploadList={false}
        disabled={disabled}
        beforeUpload={(file) => {
          const row: UploadRow = {
            localId: crypto.randomUUID(),
            file,
            state: 'uploading',
          };
          setRows((previous) => [...previous, row]);
          void send(row);
          return false;
        }}
      >
        <Button disabled={disabled}>选择附件并完整上传</Button>
      </Upload>
      <Typography.Text type="secondary">
        字节验证后才进入本次引用。移除引用不删除原文件，也不表示业务记录已保存。
      </Typography.Text>
      {rows.map((row) => (
        <div key={row.localId}>
          <Space wrap>
            <Typography.Text>
              {row.file.name} ·{' '}
              {row.state === 'verified'
                ? '字节已验证'
                : row.state === 'uploading'
                  ? '完整上传中'
                  : '上传未完成'}
            </Typography.Text>
            {row.fileId && value.includes(row.fileId) && (
              <>
                <Button size="small" onClick={() => setPreview(row.fileId!)}>
                  查看私有原件
                </Button>
                <Button
                  size="small"
                  disabled={disabled}
                  onClick={() =>
                    onChange?.(value.filter((id) => id !== row.fileId))
                  }
                >
                  从本次引用移除
                </Button>
              </>
            )}
            {row.fileId && !value.includes(row.fileId) && (
              <Button
                size="small"
                disabled={disabled}
                onClick={() => onChange?.([...value, row.fileId!])}
              >
                重新引用此文件
              </Button>
            )}
            {row.state === 'failed' && (
              <Button
                size="small"
                disabled={disabled}
                onClick={() => void send(row)}
              >
                完整重传同一文件
              </Button>
            )}
          </Space>
          {row.error && <Alert type="warning" title={row.error} showIcon />}
        </div>
      ))}
      {value
        .filter((id) => !rows.some((row) => row.fileId === id))
        .map((id) => (
          <Space key={id}>
            <Button type="link" onClick={() => setPreview(id)}>
              查看已有授权附件 {id}
            </Button>
            <Button
              size="small"
              disabled={disabled}
              onClick={() => onChange?.(value.filter((item) => item !== id))}
            >
              移除本次引用
            </Button>
          </Space>
        ))}
      <EvidenceViewer fileId={preview} onClose={() => setPreview(null)} />
    </Space>
  );
}
