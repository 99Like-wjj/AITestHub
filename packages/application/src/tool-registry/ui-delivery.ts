import { z } from 'zod';
import { commandIdSchema, idSchema } from '../../../contracts/src/base.js';
import {
  uiResultBatchResourceSchema as uiResultBatchSchema,
  uiDeclareEndInputSchema,
  uiDeclareResumeInputSchema,
  uiSealDeliveryInputSchema,
  uiDeliveryStatusQuerySchema,
} from '../../../contracts/src/ui-delivery.js';
import type { Database } from '../../../persistence/src/database.js';
import type { FilesService } from '../files/service.js';
import { UiDeliveryService } from '../results/delivery.js';
import type { BusinessToolRegistry } from './registry.js';
import { submissionCapabilityQuerySchema } from '../../../contracts/src/file-resources.js';

/** Original facts are supplied by a local actor; these handlers never drive a SUT. */
export function registerUiDeliveryTools(
  registry: BusinessToolRegistry,
  db: Database,
  files?: FilesService,
) {
  const delivery = new UiDeliveryService(db);
  const project = { projectId: idSchema };
  const shape = <S extends z.ZodType>(op: string, input: S) =>
    z.strictObject({ op: z.literal(op), ...project, input });
  const add = registry.add.bind(registry);
  const description =
    '本地UI v2累计数据交付；批次不结束执行，结束/恢复仅登记本人明确上报，封账不改执行事实。默认每批100证据/1GiB，实际按当前或原受理资源策略；文件仍完整重传。';
  if (files)
    add(
      'ath_results',
      description,
      'resource-capabilities',
      z.strictObject({
        op: z.literal('resource-capabilities'),
        input: submissionCapabilityQuerySchema,
      }),
      'read',
      (a, i) => files.capabilities(a, i.input),
    );
  add(
    'ath_results',
    description,
    'prepare-ui-batch',
    shape('prepare-ui-batch', uiResultBatchSchema),
    'read',
    (a, i) => delivery.prepareBatch(a, i.projectId, i.input),
  );
  add(
    'ath_results',
    description,
    'receive-ui-batch',
    shape('receive-ui-batch', uiResultBatchSchema),
    'write',
    (a, i) => delivery.receiveBatch(a, i.projectId, i.input),
  );
  if (files)
    add(
      'ath_results',
      description,
      'receive-ui-batch-file',
      z.strictObject({
        op: z.literal('receive-ui-batch-file'),
        ...project,
        fileId: idSchema,
      }),
      'write',
      (a, i) => delivery.receiveBatchFile(a, i.projectId, i.fileId, files),
    );
  add(
    'ath_results',
    description,
    'ui-batch-receipt',
    z.strictObject({
      op: z.literal('ui-batch-receipt'),
      ...project,
      batchId: commandIdSchema,
    }),
    'read',
    (a, i) => delivery.batchReceipt(a, i.projectId, i.batchId),
  );
  add(
    'ath_results',
    description,
    'ui-delivery-status',
    z.strictObject({
      op: z.literal('ui-delivery-status'),
      ...project,
      runId: idSchema,
      query: uiDeliveryStatusQuerySchema.default({
        pageKind: 'items',
        limit: 50,
      }),
    }),
    'read',
    (a, i) => delivery.status(a, i.projectId, i.runId, i.query),
  );
  add(
    'ath_results',
    description,
    'seal-ui-delivery',
    shape('seal-ui-delivery', uiSealDeliveryInputSchema),
    'write',
    (a, i) => delivery.seal(a, i.projectId, i.input),
  );
  add(
    'ath_ui_executions',
    description,
    'declare-end',
    shape('declare-end', uiDeclareEndInputSchema),
    'write',
    (a, i) => delivery.declareEnd(a, i.projectId, i.input),
  );
  add(
    'ath_ui_executions',
    description,
    'declare-resume',
    shape('declare-resume', uiDeclareResumeInputSchema),
    'write',
    (a, i) => delivery.declareResume(a, i.projectId, i.input),
  );
}
