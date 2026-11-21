import {
  resourcePolicyCapabilitiesSchema,
  type ResourcePolicyCapabilities,
} from '../../../contracts/src/resource-policy.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import type { ResourcePolicyAnchorReader } from '../resource-policy/anchor.js';
import { resourcePolicyReaderFromEnvironment } from '../resource-policy/environment.js';
import { loadAnchoredResourcePolicy } from '../resource-policy/operations.js';
import { runtimeResourceCapabilities } from '../resource-policy/capabilities.js';
import { loadClaimPolicy } from './policy.js';
import {
  lockTaskSlot,
  type TaskSlotDecision,
  type TaskSlotKind,
} from './slots.js';

export interface AiTaskAdmissionPort {
  /** Caller must claim the accepted row in this same transaction. */
  checkInTransaction(transaction: SqlExecutor): Promise<TaskSlotDecision>;
}
export interface ApiRunAdmissionPort {
  /** The grant INSERT and prepared -> running transition use this transaction. */
  checkInTransaction(transaction: SqlExecutor): Promise<TaskSlotDecision>;
}

/** Trusted constructor dependencies only; no task/model/HTTP input selects these. */
class TrustedTaskAdmission {
  private reader: ResourcePolicyAnchorReader | undefined;
  private opening: Promise<ResourcePolicyAnchorReader> | undefined;
  readonly capabilities: ResourcePolicyCapabilities;
  constructor(
    private readonly kind: TaskSlotKind,
    private readonly openReader: () => Promise<ResourcePolicyAnchorReader> = resourcePolicyReaderFromEnvironment,
    capabilities: ResourcePolicyCapabilities = runtimeResourceCapabilities,
  ) {
    this.capabilities = Object.freeze(
      resourcePolicyCapabilitiesSchema.parse(capabilities),
    );
  }
  private async anchor(): Promise<ResourcePolicyAnchorReader> {
    if (this.reader) return this.reader;
    this.opening ??= this.openReader();
    try {
      this.reader = await this.opening;
      return this.reader;
    } finally {
      // Cache a successfully constructed read-only adapter, never policy/head or
      // a failed configuration read. Every claim re-verifies the actual anchor.
      this.opening = undefined;
    }
  }
  async checkInTransaction(
    transaction: SqlExecutor,
  ): Promise<TaskSlotDecision> {
    const anchor = await this.anchor();
    const policy = await loadClaimPolicy(transaction, (tx) =>
      loadAnchoredResourcePolicy(tx, this.capabilities, anchor),
    );
    return lockTaskSlot(transaction, this.kind, policy);
  }
}

export class AiTaskAdmission
  extends TrustedTaskAdmission
  implements AiTaskAdmissionPort
{
  constructor(
    openReader: () => Promise<ResourcePolicyAnchorReader> = resourcePolicyReaderFromEnvironment,
    capabilities: ResourcePolicyCapabilities = runtimeResourceCapabilities,
  ) {
    super('aiTask', openReader, capabilities);
  }
}

export class ApiRunAdmission
  extends TrustedTaskAdmission
  implements ApiRunAdmissionPort
{
  constructor(
    openReader: () => Promise<ResourcePolicyAnchorReader> = resourcePolicyReaderFromEnvironment,
    capabilities: ResourcePolicyCapabilities = runtimeResourceCapabilities,
  ) {
    super('apiRun', openReader, capabilities);
  }
}
