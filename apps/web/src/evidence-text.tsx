import { useMemo, useRef } from 'react';
import { Alert, Button, Space, Tabs, Tag } from 'antd';
import { parseDelimited } from './file-preview-data';

const readJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const object = (value: unknown) => (isRecord(value) ? value : undefined);
const pickText = (...values: unknown[]) =>
  values.find((value): value is string => typeof value === 'string' && !!value);
function printable(value: unknown, fallback = '正文请切换至原始流读取。') {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return fallback;
  }
}
const maxEvents = 300;
type EvidenceEvent = {
  name: string;
  time?: string | undefined;
  summary?: string | undefined;
  detail: string;
  body?: string | undefined;
};
function structuredEvent(
  value: unknown,
  name: string,
  time?: string,
): EvidenceEvent {
  const fields = object(value);
  return {
    name,
    time: time ?? pickText(fields?.timestamp),
    summary: pickText(
      fields?.summary,
      fields?.delta,
      fields?.text,
      fields?.tool,
    ),
    detail: printable(value),
    body:
      name === 'message.delta'
        ? pickText(fields?.delta)
        : name === 'input.message' || name === 'ai.text'
          ? pickText(fields?.text)
          : undefined,
  };
}

function conversationEvidence(
  text: string,
  mediaType: string,
): { events: EvidenceEvent[]; truncated: boolean; invalid?: boolean } {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (mediaType === 'application/json') {
    const body = object(readJson(normalized));
    const invalid = { events: [], truncated: false, invalid: true };
    if (
      body?.schemaVersion !== 'ath.conversation-evidence.v1' ||
      !Array.isArray(body.events)
    )
      return invalid;
    const events: EvidenceEvent[] = [];
    for (const item of body.events.slice(0, maxEvents)) {
      const event = object(item),
        name = event?.event;
      if (!event || typeof name !== 'string' || !name || !('data' in event))
        return invalid;
      events.push(structuredEvent(event.data, name, pickText(event.timestamp)));
    }
    return { events, truncated: body.events.length > maxEvents };
  }
  if (mediaType !== 'text/event-stream')
    return { events: [], truncated: false };
  const events: EvidenceEvent[] = [];
  let name: string | undefined;
  let data: string[] = [];
  for (const line of [...normalized.split('\n'), '']) {
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:'))
      data.push(line.slice(5).replace(/^ /, ''));
    else if (!line) {
      if (name || data.length) {
        if (events.length >= maxEvents) return { events, truncated: true };
        const raw = data.join('\n');
        events.push(structuredEvent(readJson(raw) ?? raw, name || 'message'));
      }
      name = undefined;
      data = [];
    }
  }
  return { events, truncated: false };
}

const eventRoles = new Map([
  ['input.message', '用户'],
  ['ai.text', '模型'],
  ['message.delta', '模型'],
  ['ai.tool', '工具'],
  ['tool.start', '工具'],
  ['tool.result', '工具'],
  ['task.finished', '结束'],
  ['done', '结束'],
]);
const eventRole = (name: string) => eventRoles.get(name) ?? '事件';

type TranscriptEntry =
  | {
      kind: 'message';
      role: 'user' | 'assistant';
      time: string | undefined;
      text: string;
    }
  | { kind: 'tools'; events: EvidenceEvent[] };

function transcriptEntries(events: readonly EvidenceEvent[]) {
  const entries: TranscriptEntry[] = [];
  for (const event of events) {
    const previous = entries.at(-1);
    if (
      event.name === 'ai.tool' ||
      event.name === 'tool.start' ||
      event.name === 'tool.result'
    ) {
      if (previous?.kind === 'tools') previous.events.push(event);
      else entries.push({ kind: 'tools', events: [event] });
      continue;
    }
    if (!event.body) continue;
    const role = event.name === 'input.message' ? 'user' : 'assistant';
    if (
      role === 'assistant' &&
      previous?.kind === 'message' &&
      previous.role === role
    )
      previous.text += event.body;
    else
      entries.push({
        kind: 'message',
        role,
        time: event.time,
        text: event.body,
      });
  }
  return entries;
}

function EvidenceEventDetails({
  event,
  index,
}: {
  event: EvidenceEvent;
  index: number;
}) {
  return (
    <details className="result-evidence-event">
      <summary>
        <time>{event.time ?? `#${index + 1}`}</time>
        <Tag color="cyan">{eventRole(event.name)}</Tag>
        <code>{event.name}</code>
        {event.summary && <span>{event.summary}</span>}
      </summary>
      <pre className="message-code">{event.detail}</pre>
    </details>
  );
}

function EvidenceTranscript({
  entries,
  truncated,
}: {
  entries: readonly TranscriptEntry[];
  truncated: boolean;
}) {
  const transcript = useRef<HTMLDivElement>(null);
  const jump = (role: 'user' | 'assistant') =>
    transcript.current
      ?.querySelector(`[data-message-role="${role}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  return (
    <div className="result-evidence-transcript" ref={transcript}>
      <Space wrap size="small" className="result-evidence-transcript-toolbar">
        <Button
          size="small"
          disabled={
            !entries.some(
              (entry) => entry.kind === 'message' && entry.role === 'user',
            )
          }
          onClick={() => jump('user')}
        >
          定位测试输入
        </Button>
        <Button
          size="small"
          disabled={
            !entries.some(
              (entry) => entry.kind === 'message' && entry.role === 'assistant',
            )
          }
          onClick={() => jump('assistant')}
        >
          定位 AI 回复
        </Button>
      </Space>
      {truncated && (
        <Alert
          type="info"
          showIcon
          title={`对话由前 ${maxEvents} 个已采集事件整理，完整留存内容见原始流。`}
        />
      )}
      {entries.map((entry, index) =>
        entry.kind === 'tools' ? (
          <details className="result-evidence-tool-group" key={index}>
            <summary>工具调用 · {entry.events.length} 条记录</summary>
            {entry.events.map((event, eventIndex) => (
              <EvidenceEventDetails
                key={eventIndex}
                event={event}
                index={eventIndex}
              />
            ))}
          </details>
        ) : (
          <article
            className={`result-evidence-dialogue-message role-${entry.role}`}
            data-message-role={entry.role}
            key={index}
          >
            <div>
              <strong>{entry.role === 'user' ? '测试输入' : 'AI 回复'}</strong>
              {entry.time && <time>{entry.time}</time>}
            </div>
            <p>{entry.text}</p>
          </article>
        ),
      )}
    </div>
  );
}

export function EvidenceConversation({
  text,
  mediaType,
}: {
  text: string;
  mediaType: string;
}) {
  const { events, truncated, invalid } = useMemo(
    () => conversationEvidence(text, mediaType),
    [text, mediaType],
  );
  const entries = useMemo(() => transcriptEntries(events), [events]);
  const hasDialogue = entries.some((entry) => entry.kind === 'message');
  return (
    <>
      {invalid && (
        <Alert
          type="warning"
          showIcon
          title="证据文件不符合当前对话格式，原始内容仍可查看。"
        />
      )}
      <Tabs
        defaultActiveKey={
          hasDialogue ? 'dialogue' : events.length ? 'timeline' : 'raw'
        }
        items={[
          ...(hasDialogue
            ? [
                {
                  key: 'dialogue',
                  label: '对话',
                  children: (
                    <EvidenceTranscript
                      entries={entries}
                      truncated={truncated}
                    />
                  ),
                },
              ]
            : []),
          {
            key: 'timeline',
            label: '事件时间线',
            children: events.length ? (
              <div className="result-evidence-timeline">
                {truncated && (
                  <Alert
                    type="info"
                    showIcon
                    title={`显示前 ${maxEvents} 个事件，原始流可继续查看。`}
                  />
                )}
                {events.map((event, index) => (
                  <EvidenceEventDetails
                    key={index}
                    event={event}
                    index={index}
                  />
                ))}
              </div>
            ) : (
              <Alert
                type="info"
                showIcon
                title="文件中没有可识别的事件序列"
                description="可切换到原始流查看已保存的字节内容。"
              />
            ),
          },
          {
            key: 'raw',
            label: '原始流',
            children: <pre className="message-code">{text}</pre>,
          },
        ]}
      />
    </>
  );
}

export function EvidenceDelimited({
  text,
  delimiter,
}: {
  text: string;
  delimiter: ',' | '\t';
}) {
  const parsed = useMemo(() => {
    try {
      return parseDelimited(text, delimiter, 101, 40);
    } catch {
      return null;
    }
  }, [text, delimiter]);
  if (!parsed?.rows.length) return <pre className="message-code">{text}</pre>;
  const [header, ...data] = parsed.rows;
  const width = parsed.rows.reduce((max, row) => Math.max(max, row.length), 0);
  return (
    <Tabs
      items={[
        {
          key: 'table',
          label: '表格预览',
          children: (
            <div className="result-evidence-csv">
              {parsed.truncated && (
                <Alert
                  type="info"
                  showIcon
                  title="表格预览最多 100 行数据、40 列"
                />
              )}
              <div className="result-evidence-table-scroll">
                <table>
                  <thead>
                    <tr>
                      {Array.from({ length: width }, (_, index) => (
                        <th key={index} scope="col">
                          {header?.[index] || `列 ${index + 1}`}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.map((row, index) => (
                      <tr key={index}>
                        {Array.from({ length: width }, (_, column) => (
                          <td key={column}>{row[column] ?? ''}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ),
        },
        {
          key: 'raw',
          label: '原文',
          children: <pre className="message-code">{text}</pre>,
        },
      ]}
    />
  );
}

export function EvidenceJson({
  text,
  split,
}: {
  text: string;
  split: boolean;
}) {
  const value = useMemo(() => readJson(text), [text]);
  const record = object(value);
  if (split && record && ('request' in record || 'response' in record)) {
    return (
      <Tabs
        items={[
          ...[
            ['request', '请求'],
            ['response', '响应'],
            ['assertions', '断言'],
          ].flatMap(([key, label]) =>
            key && key in record
              ? [
                  {
                    key,
                    label,
                    children: (
                      <pre className="message-code">
                        {printable(record[key])}
                      </pre>
                    ),
                  },
                ]
              : [],
          ),
          {
            key: 'raw',
            label: '原文',
            children: <pre className="message-code">{text}</pre>,
          },
        ]}
      />
    );
  }
  return (
    <pre className="message-code">
      {value === undefined ? text : printable(value, text)}
    </pre>
  );
}
