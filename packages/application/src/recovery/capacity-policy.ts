import type { ImmutableResourcePolicy } from '../../../contracts/src/resource-policy.js';
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
    if ((await resourcePolicyInstallationState(transaction)) !== 'ready')
      throw new DomainError(
        'DEPENDENCY_UNAVAILABLE',
        '运行数据库尚未升级到资源策略版本。',
        503,
      );
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
