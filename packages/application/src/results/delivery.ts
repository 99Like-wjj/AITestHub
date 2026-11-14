import type { ActorContext } from '../../../contracts/src/identity.js';
import type { Database } from '../../../persistence/src/database.js';
import type { FilesService } from '../files/service.js';
import { UiDeliveryBatches } from './delivery-batches.js';
import { UiDeliveryLifecycle } from './delivery-lifecycle.js';
import { UiDeliveryStatus } from './delivery-status.js';
import {
  fileResourcePolicies,
  type FileResourcePolicies,
} from '../files/resource-policy.js';

/** Shared Web/official-MCP v2 application port. No remote browser or SUT transport exists here. */
export class UiDeliveryService {
  private readonly batches: UiDeliveryBatches;
  private readonly lifecycle: UiDeliveryLifecycle;
  private readonly reads: UiDeliveryStatus;
  constructor(
    readonly db: Database,
    policies: FileResourcePolicies = fileResourcePolicies,
  ) {
    this.batches = new UiDeliveryBatches(db, policies);
    this.lifecycle = new UiDeliveryLifecycle(db);
    this.reads = new UiDeliveryStatus(db);
  }
  prepareBatch(actor: ActorContext, projectId: string, input: unknown) {
    return this.batches.prepareBatch(actor, projectId, input);
  }
  receiveBatch(actor: ActorContext, projectId: string, input: unknown) {
    return this.batches.receiveBatch(actor, projectId, input);
  }
  receiveBatchFile(
    actor: ActorContext,
    projectId: string,
    fileId: string,
    files: FilesService,
  ) {
    return this.batches.receiveBatchFile(actor, projectId, fileId, files);
  }
  declareEnd(actor: ActorContext, projectId: string, input: unknown) {
    return this.lifecycle.declareEnd(actor, projectId, input);
  }
  declareResume(actor: ActorContext, projectId: string, input: unknown) {
    return this.lifecycle.declareResume(actor, projectId, input);
  }
  seal(actor: ActorContext, projectId: string, input: unknown) {
    return this.lifecycle.seal(actor, projectId, input);
  }
  status(
    actor: ActorContext,
    projectId: string,
    runId: string,
    input: unknown = {},
  ) {
    return this.reads.status(actor, projectId, runId, input);
  }
  batchReceipt(actor: ActorContext, projectId: string, batchId: string) {
    return this.reads.batchReceipt(actor, projectId, batchId);
  }
}
