import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Select } from 'antd';
import { z } from 'zod';
import { apiCatalogBasisSchema } from '../../../packages/contracts/src/api-catalog';
import { assetNavigationSchema } from '../../../packages/contracts/src/assets';
import { requirementDetailSchema } from '../../../packages/contracts/src/requirements';
import { fileReceiptSchema } from '../../../packages/contracts/src/files';
import { api, describeError } from './api';
import { fetchPrivateFile } from './file-channel';

export type ImportBasis = z.output<typeof apiCatalogBasisSchema>;
type Requirement = z.output<
  typeof assetNavigationSchema
>['requirements'][number];
type Version = z.output<typeof requirementDetailSchema>['currentVersion'];
const bound = 1_048_576;

export function ApiCatalogMaterialSource({
  projectId,
  disabled,
  onRead,
}: {
  projectId: string;
  disabled: boolean;
  onRead: (text: string, basis: ImportBasis) => void;
}) {
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [requirementId, setRequirementId] = useState<string>();
  const [version, setVersion] = useState<Version>();
  const versionId = version?.id;
  const [materialId, setMaterialId] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const read = useRef<AbortController | null>(null);
  const materials =
    version?.materials.filter(
      (item) =>
        item.fileResourceId &&
        item.readability !== 'unreadable' &&
        /\.(?:json|ya?ml|har|txt)$/i.test(item.originalName),
    ) ?? [];
  useEffect(() => {
    const controller = new AbortController();
    void api(
      `/projects/${projectId}/assets/navigation?kind=UI&includeArchivedRequirements=false`,
      {
        signal: controller.signal,
      },
      assetNavigationSchema,
    ).then(
      ({ requirements }) => {
        if (!controller.signal.aborted) setRequirements(requirements);
      },
      (failure: unknown) => {
        if (!controller.signal.aborted) setError(describeError(failure));
      },
    );
    return () => controller.abort();
  }, [projectId]);
  useEffect(() => {
    setVersion(undefined);
    setMaterialId(undefined);
    if (!requirementId) return;
    const controller = new AbortController();
    void api(
      `/projects/${projectId}/requirements/${requirementId}`,
      {
        signal: controller.signal,
      },
      requirementDetailSchema,
    ).then(
      (data) => {
        if (!controller.signal.aborted) {
          setVersion(data.currentVersion);
        }
      },
      (failure: unknown) => {
        if (!controller.signal.aborted) setError(describeError(failure));
      },
    );
    return () => controller.abort();
  }, [projectId, requirementId]);
  useEffect(() => () => read.current?.abort(), [projectId]);
  async function readSource() {
    if (!versionId || loading) return;
    const material = materials.find((item) => item.id === materialId);
    if (!material?.fileResourceId) return;
    const controller = new AbortController();
    read.current?.abort();
    read.current = controller;
    setLoading(true);
    setError(undefined);
    try {
      const { file } = await api(
        '/files/' + material.fileResourceId,
        { signal: controller.signal },
        fileReceiptSchema,
      );
      if (
        file.projectId !== projectId ||
        file.ownerScope !== 'project' ||
        file.status !== 'verified' ||
        BigInt(file.bytes) > BigInt(bound)
      )
        throw new Error('请选择已验证、同项目且不超过 1 MiB 的原文件。');
      const original = await fetchPrivateFile(file.id, controller.signal);
      if (original.size > bound || String(original.size) !== file.bytes)
        throw new Error('原文件内容与当前登记不符。');
      const bytes = await original.arrayBuffer();
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      )
        .map((part) => part.toString(16).padStart(2, '0'))
        .join('');
      if (hash !== file.sha256) throw new Error('当前原件校验摘要不匹配。');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (!controller.signal.aborted)
        onRead(text, {
          kind: 'material',
          requirementVersionId: versionId,
          materialId: material.id,
          description: material.originalName,
          contentSha256: file.sha256,
        });
    } catch (failure) {
      if (!controller.signal.aborted) setError(describeError(failure));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  const locked = disabled || loading;
  return (
    <div className="api-catalog-definition-group">
      <h3>读取同项目的需求材料</h3>
      <div className="api-catalog-form-grid">
        <label className="api-catalog-form-field">
          <span>需求</span>
          <Select
            showSearch
            optionFilterProp="label"
            disabled={locked}
            value={requirementId ?? null}
            onChange={setRequirementId}
            options={requirements.map((item) => ({
              value: item.id,
              label: item.title,
            }))}
          />
        </label>
        <label className="api-catalog-form-field">
          <span>接口契约材料</span>
          <Select
            disabled={locked}
            value={materialId ?? null}
            onChange={setMaterialId}
            options={materials.map((material) => ({
              value: material.id,
              label: material.originalName,
            }))}
          />
        </label>
        <div>
          <Button
            disabled={locked || !materialId}
            loading={loading}
            onClick={() => void readSource()}
          >
            读取原件
          </Button>
        </div>
      </div>
      {error && <Alert type="error" title={error} showIcon />}
    </div>
  );
}
