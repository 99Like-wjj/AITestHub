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
export const officialSensenovaSamplingProfile = Object.freeze({
  id: 'sensenova-6.8-flash-lite.general.v1' as const,
  label: 'SenseNova 6.8 Flash Lite 官方推荐采样',
  parameters: Object.freeze({
    temperature: 1,
    top_p: 0.95,
    top_k: 20,
    min_p: 0,
    presence_penalty: 1.5,
    repetition_penalty: 1,
  }),
});
export const modelSamplingMetadataSchema = z.strictObject({
  profileId: z.literal(officialSensenovaSamplingProfile.id).nullable(),
  parameters: modelSamplingParametersSchema,
});
export type ModelSamplingMetadata = z.infer<
  typeof modelSamplingMetadataSchema
>;
const officialOrigins = new Set([
  'https://token.sensenova.cn',
  'https://token.sensetime.com',
]);
const parameterNames = [
  'temperature',
  'top_p',
  'top_k',
  'min_p',
  'presence_penalty',
  'repetition_penalty',
] as const;

/** Pure matching; callers gate ChatCompletions. Never changes an endpoint or model. */
export function resolveModelSampling(
  baseUrl: string,
  model: string,
  explicit: ModelSamplingParameters = {},
): ModelSamplingMetadata {
  const parsed = modelSamplingParametersSchema.parse(explicit);
  const parameters: ModelSamplingParameters = {};
  let matches = false;
  try {
    const url = new URL(baseUrl);
    matches =
      model === 'sensenova-6.8-flash-lite' &&
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      officialOrigins.has(url.origin);
  } catch {
    // A malformed configuration has no vendor defaults; the endpoint boundary
    // remains responsible for rejecting it before any network operation.
  }
  if (matches) Object.assign(parameters, officialSensenovaSamplingProfile.parameters);
  for (const name of parameterNames)
    if (parsed[name] !== undefined) parameters[name] = parsed[name];
  return {
    profileId: matches ? officialSensenovaSamplingProfile.id : null,
    parameters,
  };
}
