import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { DomainError } from '../errors.js';

/** Only the pure task-status snapshot uses this boundary; writes and dispatches never do. */
export async function readTaskStatusSnapshot<T>(
  database: Database,
  read: (transaction: SqlExecutor) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await database.transaction(read);
    } catch (error: unknown) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        error.code !== '40001'
      )
        throw error;
      if (attempt === 2)
        throw new DomainError(
          'DEPENDENCY_UNAVAILABLE',
          '状态正在并发更新，请按原任务重试读取。',
          503,
        );
    }
  }
  throw new Error('Task status snapshot attempts exhausted.');
}
