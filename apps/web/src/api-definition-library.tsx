import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Empty, Modal, Select, Space, Table } from 'antd';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import {
  basisRefSchema,
  httpMethodSchema,
  variableNameSchema,
} from '../../../packages/contracts/src/domain';
import { fileReceiptSchema } from '../../../packages/contracts/src/files';
import { requirementDetailSchema } from '../../../packages/contracts/src/requirements';
import { api, describeError } from './api';
import { newRequest, type DraftRequest } from './api-draft';
import { fetchPrivateFile } from './file-channel';
import { redactPreview } from './api-import';

type Basis = z.infer<typeof basisRefSchema>;
type Version = z.infer<typeof requirementDetailSchema>['versions'][number];
type Material = Version['materials'][number];
const sourceDocument = z.looseObject({
  openapi: z.string().regex(/^3\.\d+\.\d+(?:[-+].*)?$/u),
  paths: z.record(z.string(), z.record(z.string(), z.unknown())),
});
const operationFields = z.looseObject({
  operationId: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  parameters: z.array(z.unknown()).optional(),
  responses: z.record(z.string(), z.unknown()).optional(),
  requestBody: z.unknown().optional(),
});
const simpleParameter = z.looseObject({
  name: z.string().min(1).max(256),
  in: z.enum(['path', 'query', 'header', 'cookie']),
  required: z.boolean().optional(),
  description: z.string().optional(),
  schema: z
    .object({ type: z.string().optional(), format: z.string().optional() })
    .optional(),
});
const metadataBound = 1024n * 1024n;
const sensitiveParameter =
  /(?:password|passwd|authorization|cookie|secret|token|api[-_]?key|credential|signature)/iu;

interface Definition {
  key: string;
  method: z.infer<typeof httpMethodSchema>;
  path: string;
  pathTemplate: string;
  label: string;
  description: string;
  parameters: z.infer<typeof simpleParameter>[];
  unresolved: number;
  responseCodes: string[];
  requestExample?: { mediaType: string; text: string };
  responseExample?: { mediaType: string; text: string; code: string };
  material: Material;
}

const openApiMessage = z.object({
  content: z
    .record(
      z.string(),
      z.object({
        example: z.unknown().optional(),
        examples: z
          .record(z.string(), z.object({ value: z.unknown().optional() }))
          .optional(),
      }),
    )
    .optional(),
});

function inlineExample(raw: unknown) {
  const body = openApiMessage.safeParse(raw);
  if (!body.success) return undefined;
  for (const [mediaType, entry] of Object.entries(body.data.content ?? {})) {
    const rawValue =
      entry.example ??
      Object.values(entry.examples ?? {}).find(
        (example) => example.value !== undefined,
      )?.value;
    if (rawValue === undefined) continue;
    const value = z.json().safeParse(rawValue);
    if (!value.success) continue;
    const text = JSON.stringify(redactPreview(value.data), null, 2);
    if (text.length <= 16000) return { mediaType, text };
  }
  return undefined;
}

function parseDefinitions(text: string, material: Material): Definition[] {
  let raw: unknown;
  if (/\.json$/iu.test(material.originalName)) {
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      throw Error('当前材料的 OpenAPI JSON 格式无效。');
    }
  } else {
    const document = parseDocument(text, { strict: true, uniqueKeys: true });
    if (document.errors.length || document.warnings.length)
      throw Error('材料 YAML 含不支持的结构或标记。');
    raw = document.toJS({ maxAliasCount: 0 }) as unknown;
  }
  const doc = sourceDocument.safeParse(raw);
  if (!doc.success) throw Error('当前材料不是可读的 OpenAPI 3.x 文档。');
  const definitions: Definition[] = [];
  for (const [path, methods] of Object.entries(doc.data.paths)) {
    if (
      !path.startsWith('/') ||
      path.startsWith('//') ||
      path.length > 1200 ||
      /[?#\r\n\\]/u.test(path)
    )
      continue;
    const routeParameters = Array.isArray(methods.parameters)
      ? methods.parameters
      : [];
    for (const [verb, operation] of Object.entries(methods)) {
      const method = httpMethodSchema.safeParse(verb.toUpperCase());
      if (!method.success) continue;
      const spec = operationFields.safeParse(operation);
      if (!spec.success) continue;
      const listed = new Map<string, z.infer<typeof simpleParameter>>();
      let unresolved = 0;
      for (const parameter of [
        ...routeParameters,
        ...(spec.data.parameters ?? []),
      ]) {
        const next = simpleParameter.safeParse(parameter);
        if (!next.success) {
          unresolved += 1;
          continue;
        }
        listed.set(next.data.in + ':' + next.data.name, next.data);
      }
      const template = path.replace(
        /\{([^{}]+)\}/gu,
        (whole, variable: string) =>
          variableNameSchema.safeParse(variable).success
            ? '{{case.' + variable + '}}'
            : whole,
      );
      const requestExample = inlineExample(spec.data.requestBody);
      const responseExample = Object.entries(spec.data.responses ?? {}).flatMap(
        ([code, response]) => {
          const example = inlineExample(response);
          return example ? [{ code, ...example }] : [];
        },
      )[0];
      definitions.push({
        key: material.id + ':' + method.data + ':' + path,
        method: method.data,
        path,
        pathTemplate: template,
        label: (
          spec.data.summary ||
          spec.data.operationId ||
          method.data + ' ' + path
        ).slice(0, 200),
        description: (spec.data.description || '').slice(0, 2000),
        parameters: [...listed.values()].slice(0, 200),
        unresolved,
        responseCodes: Object.keys(spec.data.responses ?? {}).slice(0, 100),
        ...(requestExample ? { requestExample } : {}),
        ...(responseExample ? { responseExample } : {}),
        material,
      });
      if (definitions.length > 1500)
        throw Error('接口定义超过当前可浏览范围，请拆分并登记材料。');
    }
  }
  return definitions;
}

export function ApiDefinitionLibrary({
  projectId,
  requirementId,
  versionId,
  onAdopt,
}: {
  projectId: string;
  requirementId: string;
  versionId: string;
  onAdopt?: (step: DraftRequest, basis: Basis) => void;
}) {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [definitions, setDefinitions] = useState<Definition[]>([]);
  const [selected, setSelected] = useState<Definition>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const reading = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setMaterials([]);
    setDefinitions([]);
    setSelected(undefined);
    setError(undefined);
    setLoading(true);
    void api(
      '/projects/' + projectId + '/requirements/' + requirementId,
      { signal: controller.signal },
      requirementDetailSchema,
    )
      .then((reply) => {
        if (controller.signal.aborted) return;
        const version = reply.versions.find((entry) => entry.id === versionId);
        if (!version) throw Error('此需求没有选定版本。');
        setMaterials(
          version.materials.filter(
            (entry) =>
              entry.fileResourceId &&
              entry.readability !== 'unreadable' &&
              /\.(?:json|ya?ml)$/iu.test(entry.originalName),
          ),
        );
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(describeError(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      reading.current?.abort();
    };
  }, [projectId, requirementId, versionId]);

  async function loadMaterial(materialId: string) {
    const material = materials.find((entry) => entry.id === materialId);
    if (!material?.fileResourceId) return;
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    setLoading(true);
    setError(undefined);
    setDefinitions([]);
    setSelected(undefined);
    try {
      const receipt = await api(
        '/files/' + material.fileResourceId,
        { signal: controller.signal },
        fileReceiptSchema,
      );
      if (
        receipt.file.projectId !== projectId ||
        receipt.file.status !== 'verified' ||
        BigInt(receipt.file.bytes) > metadataBound
      )
        throw Error('请使用已验证、同项目且不超过 1 MiB 的 OpenAPI 材料。');
      const bytes = await fetchPrivateFile(
        material.fileResourceId,
        controller.signal,
      );
      if (
        bytes.size !== Number(receipt.file.bytes) ||
        BigInt(bytes.size) > metadataBound
      )
        throw Error('材料字节与登记不符，请重新核对原件。');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(
        await bytes.arrayBuffer(),
      );
      const result = parseDefinitions(text, material);
      if (!controller.signal.aborted) setDefinitions(result);
    } catch (failure) {
      if (!controller.signal.aborted) setError(describeError(failure));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  function adopt(definition: Definition) {
    if (!onAdopt) return;
    const emptyParameters = (kind: 'query' | 'header') =>
      definition.parameters
        .filter(
          (entry) => entry.in === kind && !sensitiveParameter.test(entry.name),
        )
        .map(({ name }) => ({ name, value: '' }));
    onAdopt(
      {
        ...newRequest(),
        name: definition.label,
        method: definition.method,
        url: definition.pathTemplate,
        query: emptyParameters('query'),
        headers: emptyParameters('header'),
      },
      basisRefSchema.parse({
        kind: 'material',
        objectId: definition.material.id,
        revisionId: versionId,
        locator: definition.method + ' ' + definition.path,
        description:
          definition.material.originalName +
          ' · ' +
          definition.method +
          ' ' +
          definition.path,
        readability: 'readable',
      }),
    );
    setSelected(undefined);
  }

  return (
    <div className="stack">
      <Select
        aria-label="接口定义材料"
        placeholder="选择此版本已登记的 OpenAPI JSON / YAML"
        showSearch
        optionFilterProp="label"
        options={materials.map((entry) => ({
          value: entry.id,
          label: entry.originalName,
        }))}
        onChange={(value) => void loadMaterial(value)}
        loading={loading}
      />
      {error && <Alert type="error" showIcon title={error} />}
      {!loading && !materials.length && !error && (
        <Empty description="此需求版本尚未登记可读取的接口定义文件。" />
      )}
      {definitions.length > 0 && (
        <Table
          size="small"
          rowKey="key"
          dataSource={definitions}
          pagination={{ pageSize: 10 }}
          columns={[
            { title: '方法', dataIndex: 'method' },
            { title: '相对路径', dataIndex: 'path' },
            { title: '接口', dataIndex: 'label' },
            {
              title: '操作',
              render: (_, entry) => (
                <Button type="link" onClick={() => setSelected(entry)}>
                  查看定义
                </Button>
              ),
            },
          ]}
        />
      )}
      <Modal
        width={760}
        title="接口定义与导入预览"
        open={Boolean(selected)}
        onCancel={() => setSelected(undefined)}
        footer={
          <Space wrap>
            <Button onClick={() => setSelected(undefined)}>关闭</Button>
            {selected && onAdopt && (
              <Button type="primary" onClick={() => adopt(selected)}>
                新增为请求草稿
              </Button>
            )}
          </Space>
        }
      >
        {selected && (
          <div className="stack">
            <strong>{selected.method + ' ' + selected.path}</strong>
            <p>{selected.description || selected.label}</p>
            <p className="caption">
              来源 {selected.material.originalName} · 当前需求版本
            </p>
            <Table
              size="small"
              rowKey={(parameter) => parameter.in + ':' + parameter.name}
              dataSource={selected.parameters}
              pagination={false}
              columns={[
                { title: '位置', dataIndex: 'in' },
                { title: '参数名称', dataIndex: 'name' },
                { title: '说明', dataIndex: 'description' },
                {
                  title: '类型',
                  render: (_, entry) =>
                    [entry.schema?.type, entry.schema?.format]
                      .filter(Boolean)
                      .join(' / ') || '—',
                },
                {
                  title: '必填',
                  render: (_, entry) => (entry.required ? '是' : '否'),
                },
              ]}
              locale={{ emptyText: '未登记内联参数。' }}
            />
            {selected.requestExample && (
              <details>
                <summary>
                  文档内联请求示例 · {selected.requestExample.mediaType}
                </summary>
                <pre className="message-code">
                  {selected.requestExample.text}
                </pre>
              </details>
            )}
            {selected.responseExample && (
              <details>
                <summary>
                  文档内联响应示例 · {selected.responseExample.code} ·{' '}
                  {selected.responseExample.mediaType}
                </summary>
                <pre className="message-code">
                  {selected.responseExample.text}
                </pre>
              </details>
            )}
            <p className="caption">
              文档的响应代码 {selected.responseCodes.join('、') || '未声明'}
            </p>
            <Alert
              type="info"
              showIcon
              title="采用方法、相对路径和普通字段名称"
              description={
                '字段值和业务断言由编辑者配置。路径参数映射为用例变量。原服务器、认证、Cookie、请求体样例和外部引用不带入。当前未展开引用或未知参数 ' +
                selected.unresolved +
                ' 个。'
              }
            />
          </div>
        )}
      </Modal>
    </div>
  );
}
