import { z } from 'zod';
import {
commandIdSchema,
decimalCountSchema,
idSchema,
persistedRowVersionSchema,
sha256Schema,
timestampSchema,
} from './base.js';
import {
deliveryStatusSchema,
evidenceManifestItemSchema,
localIdSchema,
resultItemSchema,
runStateSchema,
uiOutcomeSchema,
} from './domain.js';

export const UI_DELIVERY_VERSION = 'ath.ui-delivery.v2' as const;
export const EMPTY_UI_EVIDENCE_REFS_DIGEST =
  '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945' as const;
export const uiDeliveryLimits = Object.freeze({
  manifestItemsPerBatch: 100,
  involvedEvidencePerBatch: 100,
  fileBytes: 104_857_600n,
  batchFileBytes: 1_073_741_824n,
  completeItemFileBytes: 1_073_741_824n,
  evidenceRefsPerItem: 1000,
  sourceJsonBytes: 16_777_216n,
});
/** Structural/binary envelope, not the deployment's active budget. Old named v2 input retains legacy defaults. */
export const uiDeliverySupportedLimits = Object.freeze({
  ...uiDeliveryLimits,
  manifestItemsPerBatch: 200,
  involvedEvidencePerBatch: 200,
  fileBytes: 268_435_456n,
  batchFileBytes: 2_147_483_648n,
  completeItemFileBytes: 2_147_483_648n,
});
export const uiDeliveryModeSchema = z.enum([
  'nativeV2',
  'legacyDeliveryOnly',
  'legacyResumed',
]);
const ledgerVersionSchema = decimalCountSchema
  .max(19)
  .refine(
    (value) =>
      /^(0|[1-9][0-9]*)$/.test(value) &&
      value.length <= 19 &&
      BigInt(value) <= 9_223_372_036_854_775_807n,
    '账本版本超出持久范围',
  );
const count = z.number().int().nonnegative();
const resultCoreSchema = resultItemSchema.omit({ evidenceRefs: true });

export const uiResultDescriptorSchema = z
  .strictObject({
    descriptorId: commandIdSchema,
    core: resultCoreSchema,
    expectedRefCount: z.number().int().min(0).max(1000),
    segmentCount: z.number().int().min(0).max(1000),
    fullRefsDigest: sha256Schema,
    itemDigest: sha256Schema,
    supersedes: z
      .strictObject({
        descriptorId: commandIdSchema,
        semanticDigest: sha256Schema,
        rowVersion: persistedRowVersionSchema,
        reason: z.string().trim().min(1).max(4000),
      })
      .optional(),
  })
  .superRefine((descriptor, context) => {
    if (descriptor.segmentCount > descriptor.expectedRefCount)
      context.addIssue({
        code: 'custom',
        path: ['segmentCount'],
        message: '非空片段数不能超过引用总条目数',
      });
    if ((descriptor.expectedRefCount === 0) !== (descriptor.segmentCount === 0))
      context.addIssue({
        code: 'custom',
        path: ['segmentCount'],
        message: '零引用必须且仅能声明零片段',
      });
    if (
      descriptor.expectedRefCount === 0 &&
      descriptor.fullRefsDigest !== EMPTY_UI_EVIDENCE_REFS_DIGEST
    )
      context.addIssue({
        code: 'custom',
        path: ['fullRefsDigest'],
        message: '零引用必须绑定真实空数组摘要',
      });
    if (descriptor.supersedes?.descriptorId === descriptor.descriptorId)
      context.addIssue({
        code: 'custom',
        path: ['supersedes'],
        message: '新描述不能取代自身',
      });
  });
export const uiEvidenceRefSegmentSchema = z
  .strictObject({
    descriptorId: commandIdSchema,
    segmentIndex: z.number().int().min(0).max(999),
    startIndex: z.number().int().min(0).max(999),
    evidenceRefs: z.array(localIdSchema).min(1).max(100),
  })
  .superRefine((segment, context) => {
    if (segment.startIndex + segment.evidenceRefs.length > 1000)
      context.addIssue({
        code: 'custom',
        path: ['evidenceRefs'],
        message: '片段位置超出单结果1000引用范围',
      });
    if (new Set(segment.evidenceRefs).size !== segment.evidenceRefs.length)
      context.addIssue({
        code: 'custom',
        path: ['evidenceRefs'],
        message: '同片段引用不可重复',
      });
  });
export const uiExplicitNotExecutedItemSchema = z.strictObject({
  runItemId: idSchema,
  localResultId: localIdSchema,
  reason: z.string().trim().min(1).max(10000),
  endedAt: timestampSchema.optional(),
});

export function createUiResultBatchSchema(limits: {
  manifestItemsPerBatch: number;
  involvedEvidencePerBatch: number;
  fileBytes: bigint;
  batchFileBytes: bigint;
}) {
  return z
    .strictObject({
      schemaVersion: z.literal('ath.result-batch.v2'),
      runId: idSchema,
      batchId: commandIdSchema,
      snapshotDigest: sha256Schema,
      items: z.array(resultItemSchema).max(10000),
      evidenceManifest: z
        .array(
          evidenceManifestItemSchema.safeExtend({
            bytes: decimalCountSchema.max(9),
          }),
        )
        .max(limits.manifestItemsPerBatch),
      explicitNotExecutedItems: z
        .array(uiExplicitNotExecutedItemSchema)
        .max(10000),
      descriptors: z.array(uiResultDescriptorSchema).max(10000).default([]),
      evidenceSegments: z
        .array(
          uiEvidenceRefSegmentSchema.safeExtend({
            evidenceRefs: z
              .array(localIdSchema)
              .min(1)
              .max(limits.involvedEvidencePerBatch),
          }),
        )
        .max(10000)
        .default([]),
    })
    .superRefine((batch, context) => {
      const unique = (values: string[], path: string, message: string) => {
        if (new Set(values).size !== values.length)
          context.addIssue({ code: 'custom', path: [path], message });
      };
      unique(
        [
          ...batch.items.map((item) => item.runItemId.toLowerCase()),
          ...batch.explicitNotExecutedItems.map((item) =>
            item.runItemId.toLowerCase(),
          ),
          ...batch.descriptors.map((item) => item.core.runItemId.toLowerCase()),
        ],
        'items',
        '同批完整结果、未执行项和描述不能重复/交叠Case',
      );
      if (
        batch.items.length +
          batch.explicitNotExecutedItems.length +
          batch.descriptors.length >
        10000
      )
        context.addIssue({
          code: 'custom',
          path: ['items'],
          message: '同批固定范围对象合计不得超过10000',
        });
      unique(
        [
          ...batch.items.map((item) => item.localResultId),
          ...batch.explicitNotExecutedItems.map((item) => item.localResultId),
          ...batch.descriptors.map((item) => item.core.localResultId),
        ],
        'items',
        '同批本地结果身份不可重复',
      );
      unique(
        batch.descriptors.map((item) => item.descriptorId),
        'descriptors',
        '描述身份不可重复',
      );
      unique(
        batch.evidenceManifest.map((item) => item.localEvidenceId),
        'evidenceManifest',
        '证据本地身份不可重复',
      );
      unique(
        batch.evidenceSegments.map((item) =>
          JSON.stringify([item.descriptorId, item.segmentIndex]),
        ),
        'evidenceSegments',
        '同批片段序号不可重复',
      );
      const involved = new Set([
        ...batch.evidenceManifest.map((item) => item.localEvidenceId),
        ...batch.items.flatMap((item) => item.evidenceRefs),
        ...batch.evidenceSegments.flatMap((item) => item.evidenceRefs),
      ]);
      if (involved.size > limits.involvedEvidencePerBatch)
        context.addIssue({
          code: 'custom',
          path: ['evidenceManifest'],
          message: `本批清单与旧引用并集不得超过${limits.involvedEvidencePerBatch}个证据身份`,
        });
      for (const [index, item] of batch.items.entries())
        if (new Set(item.evidenceRefs).size !== item.evidenceRefs.length)
          context.addIssue({
            code: 'custom',
            path: ['items', index, 'evidenceRefs'],
            message: '完整结果引用不可重复',
          });
      const groups = new Map<string, typeof batch.evidenceSegments>();
      const descriptors = new Map(
        batch.descriptors.map((descriptor) => [
          descriptor.descriptorId,
          descriptor,
        ]),
      );
      for (const segment of batch.evidenceSegments) {
        const group = groups.get(segment.descriptorId);
        if (group) group.push(segment);
        else groups.set(segment.descriptorId, [segment]);
      }
      for (const [descriptorId, segments] of groups) {
        const descriptor = descriptors.get(descriptorId),
          ordered = [...segments].sort(
            (left, right) => left.segmentIndex - right.segmentIndex,
          );
        for (const [index, segment] of ordered.entries()) {
          const previous = ordered[index - 1];
          if (
            previous &&
            previous.startIndex + previous.evidenceRefs.length >
              segment.startIndex
          )
            context.addIssue({
              code: 'custom',
              path: ['evidenceSegments'],
              message: '已知片段位置不得重叠或逆序',
            });
          if (
            descriptor &&
            (segment.segmentIndex >= descriptor.segmentCount ||
              segment.startIndex + segment.evidenceRefs.length >
                descriptor.expectedRefCount)
          )
            context.addIssue({
              code: 'custom',
              path: ['evidenceSegments'],
              message: '片段序号/范围超出本批明确描述',
            });
        }
        unique(
          segments.flatMap((segment) => segment.evidenceRefs),
          'evidenceSegments',
          '同一描述的证据引用不可跨片段重复',
        );
      }
      const resources = new Map<string, { bytes: string; sha256: string }>();
      for (const [index, file] of batch.evidenceManifest.entries()) {
        if (!/^(0|[1-9][0-9]*)$/.test(file.bytes) || file.bytes.length > 9)
          continue;
        const previous = resources.get(file.fileId.toLowerCase());
        if (BigInt(file.bytes) > limits.fileBytes)
          context.addIssue({
            code: 'custom',
            path: ['evidenceManifest', index, 'bytes'],
            message: '单文件超过结构支持范围',
          });
        if (
          previous &&
          (previous.bytes !== file.bytes || previous.sha256 !== file.sha256)
        )
          context.addIssue({
            code: 'custom',
            path: ['evidenceManifest', index],
            message: '同资源UUID不得声明不同长度/摘要',
          });
        resources.set(file.fileId.toLowerCase(), {
          bytes: file.bytes,
          sha256: file.sha256,
        });
      }
      if (
        [...resources.values()].reduce(
          (sum, file) => sum + BigInt(file.bytes),
          0n,
        ) > limits.batchFileBytes
      )
        context.addIssue({
          code: 'custom',
          path: ['evidenceManifest'],
          message: '本批唯一资源超过结构支持范围',
        });
      // Existing refs and the optional original JSON are resolved and counted again by the authorized service.
    });
}
export const uiResultBatchSchema = createUiResultBatchSchema(uiDeliveryLimits);
export const uiResultBatchResourceSchema = createUiResultBatchSchema(
  uiDeliverySupportedLimits,
);
export const receiveUiBatchFileInputSchema = z.strictObject({
  fileId: idSchema,
});
export const uiDeclareEndInputSchema = z.strictObject({
  commandId: commandIdSchema,
  runId: idSchema,
  snapshotDigest: sha256Schema,
  rowVersion: persistedRowVersionSchema,
  resumeFactId: idSchema.nullable(),
  endKind: z.enum(['normal', 'terminated', 'interrupted']),
  endedAt: timestampSchema,
  reason: z.string().max(4000).default(''),
});
export const uiDeclareResumeInputSchema = z.strictObject({
  commandId: commandIdSchema,
  runId: idSchema,
  snapshotDigest: sha256Schema,
  rowVersion: persistedRowVersionSchema,
  endFactId: idSchema,
  resumedAt: timestampSchema,
  reason: z.string().trim().min(1).max(4000),
});
export const uiSealDeliveryInputSchema = z.strictObject({
  commandId: commandIdSchema,
  runId: idSchema,
  snapshotDigest: sha256Schema,
  expectedLedgerVersion: ledgerVersionSchema,
  expectedLedgerDigest: sha256Schema,
  endFactId: idSchema,
});
export const uiDeliveryPageKindSchema = z.enum([
  'items',
  'files',
  'batches',
  'descriptors',
  'facts',
]);
export const uiDeliveryStatusQuerySchema = z.strictObject({
  pageKind: uiDeliveryPageKindSchema.default('items'),
  afterId: idSchema.optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export const uiBatchItemReceiptSchema = z.strictObject({
  objectId: z.string().min(1).max(400),
  kind: z.enum(['result', 'notExecuted', 'descriptor', 'segment']),
  runItemId: idSchema.nullable(),
  status: z.enum([
    'accepted',
    'skipped',
    'conflict',
    'rejected',
    'pendingAssembly',
  ]),
  resultId: idSchema.nullable(),
  revisionId: idSchema.nullable(),
  descriptorId: commandIdSchema.nullable(),
  code: z.string().max(100).nullable(),
});
export const uiBatchReceiptSchema = z.strictObject({
  batchId: commandIdSchema,
  runId: idSchema,
  snapshotDigest: sha256Schema,
  semanticDigest: sha256Schema,
  resultsAccepted: count,
  ledgerVersion: ledgerVersionSchema,
  ledgerDigest: sha256Schema,
  deliveryStatus: deliveryStatusSchema,
  missingFilesScope: z.literal('batch'),
  missingFileIds: z
    .array(idSchema)
    .max(uiDeliverySupportedLimits.involvedEvidencePerBatch),
  reportId: idSchema.nullable(),
  perItemResults: z.array(uiBatchItemReceiptSchema).max(40000),
  executionStateChanged: z.literal(false),
});
export const uiBatchPreparationSchema = z.strictObject({
  runId: idSchema,
  batchId: commandIdSchema,
  snapshotDigest: sha256Schema,
  semanticDigest: sha256Schema,
  mode: uiDeliveryModeSchema,
  rowVersion: persistedRowVersionSchema,
  headRowVersion: persistedRowVersionSchema.nullable(),
  ledgerVersion: ledgerVersionSchema,
  ledgerDigest: sha256Schema,
  involvedEvidence: count,
  uniqueFiles: count,
  declaredBytes: decimalCountSchema,
  sourceJsonIncluded: z.boolean(),
  executionStateChanged: z.literal(false),
  persisted: z.literal(false),
});

export const uiExecutionFactSchema = z
  .strictObject({
    id: idSchema,
    runId: idSchema,
    sequence: ledgerVersionSchema.refine(
      (value) => value !== '0',
      '事实序号从1开始',
    ),
    kind: z.enum(['end', 'resume']),
    commandId: commandIdSchema.nullable(),
    previousFactId: idSchema.nullable(),
    endFactId: idSchema.nullable(),
    resumeFactId: idSchema.nullable(),
    endKind: z
      .enum(['normal', 'terminated', 'interrupted', 'legacy'])
      .nullable(),
    endedAt: timestampSchema.nullable(),
    resumedAt: timestampSchema.nullable(),
    reason: z.string().max(4000),
    provenance: z.enum([
      'local-ai',
      'protocol-synthetic',
      'unknown',
      'legacy-v1',
    ]),
    legacyState: runStateSchema.nullable(),
    receivedAt: timestampSchema,
  })
  .superRefine((fact, context) => {
    const same = (left: string | null, right: string | null) =>
      left?.toLowerCase() === right?.toLowerCase();
    const legacy =
      fact.kind === 'end' &&
      fact.endKind === 'legacy' &&
      fact.commandId === null &&
      fact.provenance === 'legacy-v1' &&
      fact.legacyState !== null &&
      fact.resumedAt === null &&
      fact.previousFactId === null &&
      fact.endFactId === null &&
      fact.resumeFactId === null;
    const end =
      fact.kind === 'end' &&
      fact.endKind !== null &&
      fact.endKind !== 'legacy' &&
      fact.commandId !== null &&
      fact.endedAt !== null &&
      fact.resumedAt === null &&
      fact.endFactId === null &&
      fact.provenance !== 'legacy-v1' &&
      fact.legacyState === null &&
      same(fact.previousFactId, fact.resumeFactId);
    const resume =
      fact.kind === 'resume' &&
      fact.commandId !== null &&
      fact.endKind === null &&
      fact.endedAt === null &&
      fact.resumedAt !== null &&
      fact.endFactId !== null &&
      same(fact.previousFactId, fact.endFactId) &&
      fact.resumeFactId === null &&
      fact.provenance !== 'legacy-v1' &&
      fact.legacyState === null;
    if (!legacy && !end && !resume)
      context.addIssue({
        code: 'custom',
        message: '结束、恢复和legacy事实字段必须与精确链类型一致',
      });
    if (
      [fact.previousFactId, fact.endFactId, fact.resumeFactId].some(
        (value) => value !== null && same(value, fact.id),
      )
    )
      context.addIssue({ code: 'custom', message: '事实不能引用自身' });
  });
export const uiExecutionFactReceiptSchema = z.strictObject({
  runId: idSchema,
  snapshotDigest: sha256Schema,
  mode: uiDeliveryModeSchema,
  rowVersion: persistedRowVersionSchema,
  headRowVersion: persistedRowVersionSchema,
  state: runStateSchema,
  fact: uiExecutionFactSchema,
  localExecutionStartedRemotely: z.literal(false),
});
export const uiDeliverySealSchema = z.strictObject({
  id: idSchema,
  runId: idSchema,
  commandId: commandIdSchema,
  ledgerVersion: ledgerVersionSchema,
  ledgerDigest: sha256Schema,
  coverageDigest: sha256Schema,
  coverageCount: count,
  endFactId: idSchema,
  createdAt: timestampSchema,
});
export const uiDeliverySealReceiptSchema = z.strictObject({
  runId: idSchema,
  snapshotDigest: sha256Schema,
  seal: uiDeliverySealSchema,
  deliveryStatus: deliveryStatusSchema,
  missingFileCount: count,
  reportId: idSchema.nullable(),
  executionStateChanged: z.literal(false),
});
const page = { hasMore: z.boolean(), nextCursor: idSchema.nullable() };
export const uiDeliveryCoverageItemSchema = z.strictObject({
  runItemId: idSchema,
  status: z.enum(['reported', 'notReported', 'pendingAssembly']),
  resultId: idSchema.nullable(),
  originalRevisionId: idSchema.nullable(),
  currentRevisionId: idSchema.nullable(),
  originalOutcome: uiOutcomeSchema.nullable(),
});
export const uiDeliveryFileItemSchema = z.strictObject({
  fileId: idSchema,
  source: z.enum(['evidence', 'sourceJson', 'both']),
  status: z.enum(['pending', 'uploading', 'verified', 'failed', 'unavailable']),
});
export const uiDeliveryDescriptorStatusSchema = z.strictObject({
  id: idSchema,
  descriptorId: commandIdSchema,
  runItemId: idSchema,
  localResultId: localIdSchema,
  expectedRefCount: count,
  receivedRefCount: count,
  segmentCount: count,
  receivedSegmentCount: count,
  semanticDigest: sha256Schema,
  fullRefsDigest: sha256Schema,
  itemDigest: sha256Schema,
  state: z.enum(['pending', 'assembled', 'superseded']),
  supersedesDescriptorId: commandIdSchema.nullable(),
  supersededByDescriptorId: commandIdSchema.nullable(),
});
export const uiDeliveryBatchIndexItemSchema = z.strictObject({
  id: idSchema,
  batchId: commandIdSchema,
  semanticDigest: sha256Schema,
  ledgerVersion: ledgerVersionSchema,
  receivedAt: timestampSchema,
  sourceFileId: idSchema.nullable(),
});
export const uiDeliveryPageSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('items'),
      items: z.array(uiDeliveryCoverageItemSchema).max(200),
      ...page,
    }),
    z.strictObject({
      kind: z.literal('files'),
      items: z.array(uiDeliveryFileItemSchema).max(200),
      ...page,
    }),
    z.strictObject({
      kind: z.literal('batches'),
      items: z.array(uiDeliveryBatchIndexItemSchema).max(200),
      ...page,
    }),
    z.strictObject({
      kind: z.literal('descriptors'),
      items: z.array(uiDeliveryDescriptorStatusSchema).max(200),
      ...page,
    }),
    z.strictObject({
      kind: z.literal('facts'),
      items: z.array(uiExecutionFactSchema).max(200),
      ...page,
    }),
  ])
  .superRefine((value, context) => {
    if (
      value.hasMore
        ? value.nextCursor === null || value.items.length === 0
        : value.nextCursor !== null
    )
      context.addIssue({
        code: 'custom',
        path: ['nextCursor'],
        message: '分页游标必须明确对应是否还有后页，不伪称当前页为全部',
      });
  });
export const uiDeliveryStatusSchema = z.strictObject({
  protocolVersion: z.literal(UI_DELIVERY_VERSION),
  runId: idSchema,
  reportId: idSchema.nullable(),
  progressSequence: z.string().regex(/^(0|[1-9][0-9]*)$/),
  completedItems: z.number().int().nonnegative(),
  progressClosedAt: timestampSchema.nullable(),
  lastProgressAt: timestampSchema.nullable(),
  projectId: idSchema,
  snapshotDigest: sha256Schema,
  mode: uiDeliveryModeSchema.nullable(),
  rowVersion: persistedRowVersionSchema,
  headRowVersion: persistedRowVersionSchema.nullable(),
  executionState: runStateSchema,
  executionProvenance: z.enum(['local-ai', 'protocol-synthetic', 'unknown']),
  endedAt: timestampSchema.nullable(),
  ledgerVersion: ledgerVersionSchema,
  ledgerDigest: sha256Schema,
  batchCount: count,
  totalItems: count,
  reportedItems: count,
  notReportedItems: count,
  pendingDescriptors: count,
  missingFileCount: count,
  lastFact: uiExecutionFactSchema.nullable(),
  lastEndFact: uiExecutionFactSchema.nullable(),
  lastResumeFact: uiExecutionFactSchema.nullable(),
  latestSeal: uiDeliverySealSchema.nullable(),
  deliveryStatus: deliveryStatusSchema,
  page: uiDeliveryPageSchema,
});

export type UiResultBatch = z.infer<typeof uiResultBatchSchema>;
export type UiResultDescriptor = z.infer<typeof uiResultDescriptorSchema>;
export type UiEvidenceRefSegment = z.infer<typeof uiEvidenceRefSegmentSchema>;
export type UiBatchReceipt = z.infer<typeof uiBatchReceiptSchema>;
export type UiExecutionFact = z.infer<typeof uiExecutionFactSchema>;
export type UiDeliveryStatus = z.infer<typeof uiDeliveryStatusSchema>;
