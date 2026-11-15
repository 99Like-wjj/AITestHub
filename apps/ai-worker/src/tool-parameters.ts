import type { ModelTool } from '../../../packages/model-adapters/src/index.js';

/** Function-call arguments are objects. Zod unions can omit the redundant root
 * type, which some providers reject even though their branches are objects.
 * Keep every union, reference and nested constraint; the server's original Zod
 * schema remains the authority for validation and business authorization. */
export function normalizeFunctionParameters(
  parameters: ModelTool['parameters'],
): ModelTool['parameters'] {
  return parameters.type === undefined
    ? { ...parameters, type: 'object' }
    : parameters;
}
