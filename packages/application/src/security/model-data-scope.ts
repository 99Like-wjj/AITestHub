import { DomainError } from '../errors.js';
import { modelDataScopeSchema } from '../../../contracts/src/configuration.js';

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
