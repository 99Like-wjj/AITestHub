import { useState } from 'react';
import {
  Alert,
  App,
  Button,
  Input,
  Modal,
  Select,
  Space,
  Tabs,
  Tag,
} from 'antd';
import { z } from 'zod';
import {
  apiAttemptDetailSchema,
  type JsonValue,
} from '../../../packages/contracts/src/api-execution';
import { variableNameSchema } from '../../../packages/contracts/src/domain';
import { isolatedHtml } from './file-channel';

type Attempt = z.infer<typeof apiAttemptDetailSchema>['attempt'];
export type ResponseRule =
  | { kind: 'assertion'; path: string; expected: JsonValue }
  | { kind: 'extractor'; path: string; name: string; sensitive: boolean };

const safeHttp = z.object({
  type: z.literal('http'),
  method: z.string(),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
  body: z.json(),
});

function responseFields(value: JsonValue) {
  const fields: { value: string; label: string; sample: JsonValue }[] = [];
  function visit(part: JsonValue, path: string, depth: number) {
    if (fields.length >= 100 || depth > 12) return;
    if (part !== null && typeof part === 'object') {
      const values = Object.entries(part);
      for (const [key, child] of values) {
        if (
          !/^[A-Za-z0-9_-]+$/u.test(key) ||
          ['constructor', 'prototype', '__proto__'].includes(key)
        )
          continue;
        visit(
          child,
          Array.isArray(part) ? path + '[' + key + ']' : path + '.' + key,
          depth + 1,
        );
      }
    } else if (typeof part !== 'string' || !part.includes('[REDACTED')) {
      fields.push({
        value: path,
        label: path + ' · ' + (part === null ? 'null' : typeof part),
        sample: part,
      });
    }
  }
  visit(value, '$', 0);
  return fields;
}

export function ApiAttemptEvidence({
  attempt,
  onRule,
}: {
  attempt: Attempt;
  onRule?: (rule: ResponseRule) => string | undefined;
}) {
  const { message } = App.useApp();
  const [raw, setRaw] = useState(false);
  const [previewHtml, setPreviewHtml] = useState<string>();
  const [copyFallback, setCopyFallback] = useState<string>();
  const [ruleKind, setRuleKind] = useState<ResponseRule['kind']>();
  const [path, setPath] = useState('');
  const [expected, setExpected] = useState('');
  const [name, setName] = useState('');
  const [sensitive, setSensitive] = useState(false);
  const [error, setError] = useState<string>();
  const response = attempt.response_safe;
  const responseType = Object.entries(response?.headers ?? {}).find(
    ([name]) => name.toLowerCase() === 'content-type',
  )?.[1];
  const htmlResponse =
    response &&
    typeof response.body === 'string' &&
    /^text\/html(?:;|$)/iu.test(responseType?.trim() ?? '') &&
    response.body.length <= 256 * 1024
      ? response.body
      : undefined;

  const request = safeHttp.safeParse(attempt.request_safe);
  const fields =
    response && onRule && attempt.phase === 'business' && response.status
      ? responseFields(response.body)
      : [];

  async function copyRequest() {
    if (!request.success) return;
    const { method, url, headers, body } = request.data;
    const text = [
      method + ' ' + url,
      ...Object.entries(headers).map(([key, value]) => key + ': ' + value),
      ...(body === null
        ? []
        : ['', typeof body === 'string' ? body : JSON.stringify(body)]),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      void message.success('已复制服务端脱敏的请求报文。');
    } catch {
      setCopyFallback(text);
    }
  }
  function openRule(kind: ResponseRule['kind']) {
    const first = fields[0];
    if (!first) return;
    setRuleKind(kind);
    setPath(first.value);
    setExpected(JSON.stringify(first.sample));
    setName('');
    setSensitive(false);
    setError(undefined);
  }
  function appendRule() {
    if (!ruleKind || !fields.some((field) => field.value === path)) return;
    let rule: ResponseRule;
    if (ruleKind === 'extractor') {
      const variable = variableNameSchema.safeParse(name.trim());
      if (!variable.success) {
        setError('变量名称须以字母或下划线开头。');
        return;
      }
      rule = { kind: ruleKind, path, name: variable.data, sensitive };
    } else {
      try {
        const value = z
          .union([z.string(), z.number(), z.boolean(), z.null()])
          .parse(JSON.parse(expected));
        rule = { kind: ruleKind, path, expected: value };
      } catch {
        setError('请输入可比较的 JSON 标量，例如 200、true 或 "open"。');
        return;
      }
    }
    const failure = onRule?.(rule);
    if (failure) {
      setError(failure);
      return;
    }
    setRuleKind(undefined);
    void message.success('已写入当前步骤的规则草稿。');
  }

  return (
    <>
      <Tabs
        size="small"
        items={[
          {
            key: 'response',
            label: '响应',
            children: response ? (
              <div className="stack">
                <Space wrap>
                  <Tag>
                    {response.status
                      ? 'HTTP ' + response.status
                      : '未取得 HTTP 状态'}
                  </Tag>
                  <span className="caption">{response.elapsedMs} ms</span>
                  {response.receivedBytes !== undefined && (
                    <span className="caption">
                      实际读取 {response.receivedBytes} 字节
                    </span>
                  )}
                  <Button size="small" onClick={() => setRaw(!raw)}>
                    {raw ? '格式化' : '查看原文'}
                  </Button>
                  {htmlResponse !== undefined && (
                    <Button
                      size="small"
                      onClick={() => setPreviewHtml(isolatedHtml(htmlResponse))}
                    >
                      隔离预览 HTML
                    </Button>
                  )}
                  {fields.length > 0 && (
                    <>
                      <Button
                        size="small"
                        onClick={() => openRule('assertion')}
                      >
                        生成断言草稿
                      </Button>
                      <Button
                        size="small"
                        onClick={() => openRule('extractor')}
                      >
                        生成提取草稿
                      </Button>
                    </>
                  )}
                </Space>
                {response.errorCode && (
                  <Alert type="info" showIcon title={response.errorCode} />
                )}
                <pre className="message-code">
                  {typeof response.body === 'string'
                    ? response.body
                    : JSON.stringify(response.body, null, raw ? 0 : 2)}
                </pre>
                <details>
                  <summary>安全响应头</summary>
                  <pre className="message-code">
                    {JSON.stringify(response.headers, null, 2)}
                  </pre>
                </details>
              </div>
            ) : (
              <p className="caption">此请求意图尚无安全响应。</p>
            ),
          },
          {
            key: 'request',
            label: '实际请求',
            children: (
              <div className="stack">
                {request.success && (
                  <Button size="small" onClick={() => void copyRequest()}>
                    复制脱敏请求
                  </Button>
                )}
                <pre className="message-code">
                  {JSON.stringify(attempt.request_safe, null, 2)}
                </pre>
              </div>
            ),
          },
          {
            key: 'assertions',
            label: '断言',
            children: attempt.assertions_safe.length ? (
              <ul className="api-evidence-rules">
                {attempt.assertions_safe.map((entry, index) => (
                  <li key={index}>
                    <Tag color={entry.passed ? 'success' : 'error'}>
                      {entry.passed ? '通过' : '失败'}
                    </Tag>
                    {entry.message}
                    {entry.comparison && (
                      <pre className="message-code">
                        {JSON.stringify(entry.comparison, null, 2)}
                      </pre>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="caption">此步骤尚无断言记录。</p>
            ),
          },
          {
            key: 'extractors',
            label: '提取',
            children: (
              <pre className="message-code">
                {JSON.stringify(attempt.extractions_safe, null, 2)}
              </pre>
            ),
          },
        ]}
      />
      <Modal
        width={760}
        title="响应 HTML 隔离预览"
        open={previewHtml !== undefined}
        onCancel={() => setPreviewHtml(undefined)}
        footer={<Button onClick={() => setPreviewHtml(undefined)}>关闭</Button>}
        destroyOnHidden
      >
        <iframe
          title="调试响应隔离预览"
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={previewHtml ?? ''}
          style={{
            width: '100%',
            height: 400,
            border: '1px solid var(--border)',
          }}
        />
      </Modal>
      <Modal
        title="复制脱敏请求"
        open={copyFallback !== undefined}
        onCancel={() => setCopyFallback(undefined)}
        footer={
          <Button onClick={() => setCopyFallback(undefined)}>关闭</Button>
        }
        afterOpenChange={(open) => {
          if (open)
            document
              .querySelector<HTMLTextAreaElement>('[data-api-request-copy]')
              ?.select();
        }}
      >
        <p className="caption mb">
          已选中服务端脱敏后的报文，可使用系统复制快捷键。
        </p>
        <Input.TextArea
          data-api-request-copy
          readOnly
          rows={8}
          value={copyFallback}
        />
      </Modal>
      <Modal
        title={ruleKind === 'assertion' ? '生成断言草稿' : '生成提取草稿'}
        open={ruleKind !== undefined}
        onCancel={() => setRuleKind(undefined)}
        onOk={appendRule}
        okText="添加到工作草稿"
      >
        <div className="stack">
          <p className="caption">
            根据已脱敏响应创建可编辑规则。原回执及断言结果保留。
          </p>
          <Select
            aria-label="响应字段"
            value={path}
            options={fields}
            onChange={(value) => {
              setPath(value);
              setExpected(
                JSON.stringify(
                  fields.find((field) => field.value === value)?.sample ?? null,
                ),
              );
            }}
          />
          {ruleKind === 'assertion' ? (
            <Input
              aria-label="JSON 期望值"
              value={expected}
              onChange={(event) => setExpected(event.target.value)}
            />
          ) : (
            <>
              <Input
                aria-label="提取变量名称"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <label>
                <input
                  type="checkbox"
                  checked={sensitive}
                  onChange={(event) => setSensitive(event.target.checked)}
                />{' '}
                敏感变量
              </label>
            </>
          )}
          {error && <Alert type="error" showIcon title={error} />}
        </div>
      </Modal>
    </>
  );
}
