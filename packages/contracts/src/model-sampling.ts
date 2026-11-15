import { z } from 'zod';

/** Bounded protocol parameters only; not an arbitrary provider JSON extension. */
export const modelSamplingParametersSchema = z.strictObject({
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.number().int().min(0).max(2147483647).optional(),
  min_p: z.number().min(0).max(1).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  repetition_penalty: z.number().positive().optional(),
});
export type ModelSamplingParameters = z.infer<
  typeof modelSamplingParametersSchema
>;
export const modelSamplingMetadataSchema = z.strictObject({
  // Keep the identifier readable in immutable historical observations only.
  // New requests never infer a profile from a model name or endpoint.
  profileId: z.literal('sensenova-6.8-flash-lite.general.v1').nullable(),
  parameters: modelSamplingParametersSchema,
});
export type ModelSamplingMetadata = z.infer<
  typeof modelSamplingMetadataSchema
>;
const parameterNames = [
  'temperature',
  'top_p',
  'top_k',
  'min_p',
  'presence_penalty',
  'repetition_penalty',
] as const;

/** Only explicitly supplied values enter the wire. Omitted fields stay omitted;
 * endpoint identity and model names do not authorize parameter injection. */
export function resolveModelSampling(
  explicit: ModelSamplingParameters = {},
): ModelSamplingMetadata {
  const parsed = modelSamplingParametersSchema.parse(explicit);
  const parameters: ModelSamplingParameters = {};
  for (const name of parameterNames)
    if (parsed[name] !== undefined) parameters[name] = parsed[name];
  return {
    profileId: null,
    parameters,
  };
}
