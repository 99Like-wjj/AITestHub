import { DomainError } from '../errors.js';
import { modelDataScopeSchema } from '../../../contracts/src/configuration.js';
import {
  workspaceDataScope,
  type WorkspaceAccessMode,
} from '../../../contracts/src/workspace-access.js';

/** Workspace users choose their access mode explicitly. Legacy callers and
 * auxiliary disclosure retain their original model data-scope policy. */
export function assertConversationDataScope(
  selection: { allowedDataScopes?: readonly string[] },
  rawScope: string,
  accessMode?: WorkspaceAccessMode,
) {
  if (!accessMode) return assertModelDataScope(selection, rawScope);
  const scope = modelDataScopeSchema.parse(rawScope);
  if (scope !== workspaceDataScope(accessMode))
    throw new DomainError('FORBIDDEN', '消息资料范围与访问模式不一致。', 403);
  return scope;
}

/** A model grant never grants permission to transmit credentials or unrelated source code. */
export function assertModelDataScope(
  selection: { allowedDataScopes?: readonly string[] },
  rawScope: string,
) {
  const scope = modelDataScopeSchema.parse(rawScope);
  if (!(selection.allowedDataScopes ?? ['syntheticPublicOnly']).includes(scope))
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '当前模型未允许此资料范围，请核对模型配置和本次资料声明。',
      422,
    );
  return scope;
}
