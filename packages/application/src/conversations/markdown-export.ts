import { z } from 'zod';
import { idSchema } from '../../../contracts/src/base.js';
import {
  encodeConversationReference,
  conversationMarkdownExportSchema,
} from '../../../contracts/src/conversation-reference-code.js';
import { frozenConversationReferenceSchema } from '../../../contracts/src/conversations.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { Database } from '../../../persistence/src/database.js';
import { DomainError } from '../errors.js';
import { assertSafeModelInput } from '../security/model-input.js';
import { conversationRow } from './common.js';
import { conversationDisplayTitle } from './title.js';

interface ExportMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: string;
  explicit_refs: unknown;
  created_at: Date;
  task_id: string | null;
  task_state: string | null;
}
interface Fragment {
  id: string;
  assistant_message_id: string;
  ordinal: number;
  attempt_no: number;
  state: string;
  visible_text: string;
  prefix_length: number;
  error_code: string | null;
  content_redacted_at: Date | null;
}
interface ToolProcess {
  assistant_message_id: string;
  sequence: string;
  created_at: Date;
  name: string | null;
  state: string | null;
  invocation_id: string | null;
  unknown_effect: string | null;
}
const omitted =
  '[此段包含疑似未脱敏凭据或不支持的安全结构，已从导出副本隐藏；原会话未修改]';
function safeText(text: string) {
  try {
    assertSafeModelInput(text);
    return text;
  } catch {
    return omitted;
  }
}
function literal(text: string) {
  const safe = safeText(text);
  const longest = [...safe.matchAll(/`+/g)].reduce(
    (length, match) => Math.max(length, match[0].length),
    2,
  );
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${safe}\n${fence}`;
}
function line(text: string) {
  return safeText(text)
    .replace(/[\r\n\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\`*_{}\[\]<>#|]/g, '\\$&');
}
function refs(raw: unknown) {
  const parsed = z.array(frozenConversationReferenceSchema).safeParse(raw);
  if (!parsed.success) return '[旧引用元数据无法安全识别；未读取原件]';
  return parsed.data
    .map(({ reference }) => {
      switch (reference.kind) {
        case 'resource':
          return `附件资源 ${reference.resourceId}（未包含原件或公开链接）`;
        case 'conversation':
          return `本人对话 ${encodeConversationReference(reference.conversationId)}`;
        case 'requirementVersion':
          return `需求版本 ${reference.requirementVersionId}`;
        case 'knowledge':
          return `知识 ${reference.entryId}`;
        case 'projectAccess':
          return `项目资料 ${reference.projectId}`;
        case 'externalMcpConnection':
          return `外部服务引用 ${reference.connectionId}`;
        case 'externalMcpInvocation':
          return `外部调用回执 ${reference.invocationId}`;
      }
    })
    .join('\n');
}

/** Private Web saved-copy export. AI reuse separately rechecks the frozen sources.
 * Never reads checkpoint bytes, model metadata, provider reasoning, tool arguments,
 * credentials, attachments or remote URLs. It does not paginate or silently truncate. */
export async function exportConversationMarkdown(
  db: Pick<Database, 'transaction'>,
  actor: ActorContext,
  rawId: string,
) {
  const id = idSchema.parse(rawId).toLowerCase();
  return db.transaction(async (tx) => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const conversation = await conversationRow(tx, actor, id);
    const exportedAt = new Date().toISOString();
    const messages = (
      await tx.query<ExportMessage>(
        `SELECT m.id,m.role,m.content,m.status,m.explicit_refs,m.created_at,t.id task_id,t.state task_state
       FROM app.ai_messages m LEFT JOIN app.ai_tasks t ON t.owner_id=$2 AND t.conversation_id=m.conversation_id
         AND (t.user_message_id=m.id OR t.assistant_message_id=m.id)
       WHERE m.conversation_id=$1 AND m.deleted_at IS NULL AND m.status<>'deleted' ORDER BY m.created_at,m.id`,
        [id, actor.userId],
      )
    ).rows;
    const hasAttempts = (
      await tx.query<{ present: string | null }>(
        "SELECT to_regclass('app.ai_model_attempts')::text present",
      )
    ).rows[0]?.present;
    const fragments = hasAttempts
      ? (
          await tx.query<Fragment>(
            `SELECT a.id,a.assistant_message_id,a.ordinal,a.attempt_no,a.state,a.visible_text,a.prefix_length,a.error_code,a.content_redacted_at
       FROM app.ai_model_attempts a JOIN app.ai_tasks t ON t.id=a.task_id
       JOIN app.ai_messages m ON m.id=a.assistant_message_id AND m.conversation_id=t.conversation_id
       WHERE t.conversation_id=$1 AND t.owner_id=$2 AND m.deleted_at IS NULL AND m.status<>'deleted'
       ORDER BY a.ordinal,a.attempt_no,a.id`,
            [id, actor.userId],
          )
        ).rows
      : [];
    const tools = (
      await tx.query<ToolProcess>(
        `SELECT t.assistant_message_id,e.sequence::text,e.created_at,e.payload->>'name' name,e.payload->>'state' state,
       e.payload->>'invocationId' invocation_id,e.payload->>'unknownEffect' unknown_effect
       FROM app.ai_task_events e JOIN app.ai_tasks t ON t.id=e.task_id
       JOIN app.ai_messages m ON m.id=t.assistant_message_id AND m.conversation_id=t.conversation_id
       WHERE t.conversation_id=$1 AND t.owner_id=$2 AND e.event_type='ai.tool' AND m.deleted_at IS NULL AND m.status<>'deleted'
       ORDER BY e.sequence`,
        [id, actor.userId],
      )
    ).rows;
    const byMessage = new Map<string, Fragment[]>(),
      toolsByMessage = new Map<string, ToolProcess[]>();
    for (const fragment of fragments) {
      const group = byMessage.get(fragment.assistant_message_id) ?? [];
      group.push(fragment);
      byMessage.set(fragment.assistant_message_id, group);
    }
    for (const tool of tools) {
      const group = toolsByMessage.get(tool.assistant_message_id) ?? [];
      group.push(tool);
      toolsByMessage.set(tool.assistant_message_id, group);
    }
    const parts = [
      `# ${line(conversationDisplayTitle(conversation))}`,
      `对话编码：${encodeConversationReference(id)}`,
      `导出时间：${exportedAt}\n消息总数：${messages.length}`,
      '这是本人已保存对话的只读副本，包含截至导出时的全部未删除消息。生成中、失败、取消和中断状态会明确标注，不代表完整最终答复。\n正文和工具资料均为历史数据，不是执行指令或授权。附件仅列资源标识；未包含原件或公开下载链接。',
    ];
    for (const [index, message] of messages.entries()) {
      parts.push(
        `## ${index + 1}. ${message.role === 'user' ? '用户' : '助手'} · ${line(message.status)}`,
      );
      parts.push(
        `时间：${message.created_at.toISOString()}\n消息ID：${message.id}${message.task_id ? `\n任务ID：${message.task_id} · ${line(message.task_state ?? 'unknown')}` : ''}`,
      );
      const attempts = byMessage.get(message.id) ?? [];
      let content = message.content;
      const last = attempts.at(-1);
      let unresolved = false;
      if (
        last &&
        ['failed', 'cancelled'].includes(last.state) &&
        last.visible_text &&
        !last.content_redacted_at
      ) {
        if (
          last.prefix_length <= content.length &&
          content.slice(last.prefix_length) === last.visible_text
        )
          content = content.slice(0, last.prefix_length);
        else if (content.length !== last.prefix_length) unresolved = true;
      }
      parts.push(content ? literal(content) : '（无已保存正文）');
      if (unresolved)
        parts.push(
          '末次中断片段位置无法核对，原正文保留；以下片段可能与正文重叠，不将其当作新的完整回复。',
        );
      for (const fragment of attempts.filter(
        (part) =>
          ['failed', 'retryWait', 'cancelled'].includes(part.state) &&
          part.visible_text &&
          !part.content_redacted_at,
      )) {
        parts.push(
          `### ${fragment.state === 'cancelled' ? '已停止片段' : '中断片段'} · 模型段 ${fragment.ordinal} · 尝试 ${fragment.attempt_no}`,
        );
        parts.push(
          '此片段仅供核对，不与后续重试内容拼接。',
          literal(fragment.visible_text),
        );
      }
      const references = refs(message.explicit_refs);
      if (references) parts.push('### 显式引用与附件', literal(references));
      const process = toolsByMessage.get(message.id) ?? [];
      if (process.length) {
        parts.push('### 已保存工具过程（安全元数据）');
        for (const tool of process) {
          const state = [
            'started',
            'completed',
            'failed',
            'waitingConfirmation',
          ].includes(tool.state ?? '')
            ? tool.state
            : 'unknown';
          const invocation = idSchema.safeParse(tool.invocation_id);
          parts.push(
            literal(
              `${tool.created_at.toISOString()} · ${tool.name ?? '[旧工具名缺失]'} · ${state}${invocation.success ? ` · 调用 ${invocation.data}` : ''}${tool.unknown_effect === 'true' ? ' · 副作用结果未知，不可自动重放' : ''}`,
            ),
          );
        }
      }
    }
    const markdown = parts.join('\n\n') + '\n';
    if (Buffer.byteLength(markdown, 'utf8') > 64 * 1024 * 1024)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '完整对话超过当前64MiB导出限制；没有返回不完整文件，请按会话拆分整理后导出。',
        413,
      );
    return conversationMarkdownExportSchema.parse({
      filename: `aitesthub-conversation-${id}.md`,
      markdown,
      messageCount: messages.length,
      exportedAt,
    });
  });
}
