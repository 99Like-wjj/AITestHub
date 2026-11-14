import {
  defaultResourcePolicy,
  type ImmutableResourcePolicy,
} from '../../../contracts/src/resource-policy.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import type { ResourcePolicyAnchorReader } from '../resource-policy/anchor.js';
import { runtimeResourceCapabilities } from '../resource-policy/capabilities.js';
import { resourcePolicyInstallationState } from '../resource-policy/installation.js';
import { DomainError } from '../errors.js';

export type CapacityThresholds = ImmutableResourcePolicy['capacity'];
// OperationsService imports capacity. Resolve these existing adapters at call time
// so their canonical-JSON dependencies cannot form a module-initialization cycle.
const defaultReader = async () =>
  (
    await import('../resource-policy/environment.js')
  ).resourcePolicyReaderFromEnvironment();
export class CapacityPolicies {
  constructor(
    private readonly openReader: () => Promise<ResourcePolicyAnchorReader> = defaultReader,
  ) {}
  async read(transaction: SqlExecutor): Promise<CapacityThresholds> {
    const state = await resourcePolicyInstallationState(transaction);
    let reader: ResourcePolicyAnchorReader;
    try {
      reader = await this.openReader();
    } catch {
      throw new DomainError(
        'DEPENDENCY_UNAVAILABLE',
        '容量策略来源不可读；未采用默认阈值。',
        503,
      );
    }
    if (state === 'pre34') {
      try {
        if ((await reader.read()) === null)
          return defaultResourcePolicy.capacity;
      } catch {
        /* A bad/unreadable anchor is not absent. */
      }
      throw new DomainError(
        'DEPENDENCY_UNAVAILABLE',
        '旧数据库缺少最新容量策略，未接受新任务或新大文件。',
        503,
      );
    }
    const { loadAnchoredResourcePolicy } =
      await import('../resource-policy/operations.js');
    return (
      await loadAnchoredResourcePolicy(
        transaction,
        runtimeResourceCapabilities,
        reader,
      )
    ).policy.capacity;
  }
}
export const capacityPolicies = new CapacityPolicies();
