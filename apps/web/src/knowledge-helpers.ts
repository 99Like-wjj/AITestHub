import { z } from 'zod';
import {
  knowledgeContentSchema,
  knowledgeLocalManifestItemSchema,
  type KnowledgeComparisonItem,
  knowledgeComparisonSchema,
  knowledgeSelectionReceiptSchema,
  type KnowledgeContent,
} from '../../../packages/contracts/src/knowledge';

export type KnowledgeDraft = {
  title: string;
  summary: string;
  tags: string;
  body: string;
  configurationRefs: string;
  sourceRefs: string;
};
export const emptyKnowledgeDraft = (): KnowledgeDraft => ({
  title: '',
  summary: '',
  tags: '',
  body: '',
  configurationRefs: '[]',
  sourceRefs: '[]',
});
export const draftFromKnowledge = (
  content: KnowledgeContent,
): KnowledgeDraft => ({
  title: content.title,
  summary: content.summary,
  tags: content.tags.join('\n'),
  body: content.body,
  configurationRefs: JSON.stringify(content.configurationRefs, null, 2),
  sourceRefs: JSON.stringify(content.sourceRefs, null, 2),
});
function json(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}须为合法JSON；本地输入尚未提交。`);
  }
}
export function parseKnowledgeDraft(draft: KnowledgeDraft): KnowledgeContent {
  const parsed = knowledgeContentSchema.safeParse({
    title: draft.title,
    summary:
      draft.summary ||
      Array.from(draft.body.replace(/\s+/g, ' ')).slice(0, 100).join(''),
    tags: draft.tags
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean),
    body: draft.body,
    configurationRefs: json(draft.configurationRefs, '配置引用'),
    sourceRefs: json(draft.sourceRefs, '来源引用'),
  });
  if (!parsed.success) {
    const labels: Record<string, string> = {
      title: '标题',
      summary: '索引摘要',
      tags: '标签',
      body: '正文',
      configurationRefs: '配置引用',
      sourceRefs: '来源引用',
    };
    const field = labels[String(parsed.error.issues[0]?.path[0])] ?? '知识内容';
    throw new Error(
      `${field}的格式或长度不符合要求。请检查必填项、UUID及条目限制。`,
    );
  }
  return parsed.data;
}
const localManifestSchema = z.array(knowledgeLocalManifestItemSchema).max(100);
const exportedSchema = z.object({
  schemaVersion: z.literal('ath.knowledge-export.v1'),
  projectId: z.uuid(),
  entries: z
    .array(
      z.object({
        entryId: z.uuid().optional(),
        entry: z.object({ id: z.uuid() }).optional(),
        revision: z.object({ id: z.uuid(), content: knowledgeContentSchema }),
      }),
    )
    .max(100),
});
export function parseKnowledgeManifest(
  text: string,
  targetProjectId: string,
  asNew = false,
) {
  if (new TextEncoder().encode(text).byteLength > 512 * 1024)
    throw new Error(
      '单次比较输入最多512KiB，请明确拆分范围；不会截断后假装已全部导入。',
    );
  const raw = json(text, '本地知识清单');
  let items;
  if (Array.isArray(raw)) {
    const parsed = localManifestSchema.safeParse(raw);
    if (!parsed.success)
      throw new Error(
        '本地清单须为受支持的知识条目数组，最多100项；请保留localId并明确entryId/baseRevisionId。',
      );
    items = parsed.data;
  } else {
    const exported = exportedSchema.safeParse(raw);
    if (!exported.success)
      throw new Error(
        '请选择知识导出包或明确的知识变更清单，不上传源码或本地目录。',
      );
    if (exported.data.projectId !== targetProjectId && !asNew)
      throw new Error(
        '此知识包来自其他项目。若要复制，请明确选择“作为新条目”，并核对当前项目的配置/来源引用。',
      );
    items = exported.data.entries.map((entry) => {
      const id = entry.entryId ?? entry.entry?.id;
      if (!id) throw new Error('导出包缺少稳定条目UUID，不能按名称推断身份。');
      return {
        operation: 'upsert' as const,
        localId: id,
        entryId: id,
        baseRevisionId: entry.revision.id,
        content: entry.revision.content,
      };
    });
  }
  if (new Set(items.map((item) => item.localId)).size !== items.length)
    throw new Error('本地标识不可重复。');
  if (asNew)
    return items.map((item) => {
      if (item.operation === 'explicitDelete')
        throw new Error('删除项不能作为新条目复制，请明确拆分清单。');
      return { ...item, entryId: null, baseRevisionId: null };
    });
  return items;
}
export function applyKnowledgeSelectionReceipt(
  manifest: z.infer<typeof knowledgeLocalManifestItemSchema>[],
  comparison: z.infer<typeof knowledgeComparisonSchema>,
  receipt: z.infer<typeof knowledgeSelectionReceiptSchema>,
) {
  if (
    receipt.comparisonId !== comparison.id ||
    receipt.scopeDigest !== comparison.scopeDigest
  )
    throw new Error('回执与原比较范围不一致；本地清单保留。');
  const changes = new Map<string, KnowledgeComparisonItem>(
    comparison.items.flatMap((item) =>
      item.localId === null ? [] : [[item.localId, item]],
    ),
  );
  const results = new Map(receipt.results.map((item) => [item.changeId, item]));
  return manifest.map((local) => {
    const compared = changes.get(local.localId);
    const result = compared ? results.get(compared.changeId) : undefined;
    if (
      !compared ||
      !result ||
      !result.entryId ||
      !result.revisionId ||
      local.entryId !== compared.entryId ||
      local.baseRevisionId !== compared.localBaseRevisionId ||
      local.operation !== compared.localOperation ||
      (local.operation === 'upsert' &&
        JSON.stringify(local.content) !== JSON.stringify(compared.localContent))
    )
      return local;
    if (
      local.operation === 'upsert' &&
      result.localContent &&
      (result.status === 'created' ||
        result.status === 'updated' ||
        result.status === 'unchanged')
    )
      return {
        ...local,
        entryId: result.entryId,
        baseRevisionId: result.revisionId,
        content: result.localContent,
      };
    if (local.operation === 'explicitDelete' && result.status === 'deleted')
      return { ...local, baseRevisionId: result.revisionId };
    // A conflict or a choice to keep the remote side does not accept the local
    // proposal as a shared baseline. Unselected and later-edited drafts stay intact.
    return local;
  });
}
export function pinKnowledgeReference(
  entry: { id: string; title: string; revisionId: string; revisionNo: number },
  projectName: string,
) {
  return {
    id: `knowledge:${entry.id}:${entry.revisionId}`,
    label: `${entry.title} · r${entry.revisionNo}`,
    reference: {
      kind: 'knowledge' as const,
      entryId: entry.id,
      revisionId: entry.revisionId,
      dataScope: 'syntheticPublicOnly' as const,
    },
    note: `${projectName} · 已选择轻索引与固定修订；尚未读取正文，发送时重新检查权限。`,
  };
}
