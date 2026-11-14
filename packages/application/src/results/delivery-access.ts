import type { ActorContext } from '../../../contracts/src/identity.js';
import { DomainError } from '../errors.js';

/** UI original facts come from an explicit local actor, never an internal model/worker. */
export function assertLocalUiActor(actor: ActorContext): void {
  if (actor.entrypoint !== 'web' && actor.entrypoint !== 'official-mcp') {
    throw new DomainError(
      'FORBIDDEN',
      'UI原始执行、结果及结束/恢复事实仅接受本人本地客户端明确上报。',
      403,
    );
  }
}
