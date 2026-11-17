import { z } from 'zod';

export const modelImageMediaTypeSchema = z.enum([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);
export const modelImageBlockSchema = z.strictObject({
  type: z.literal('image'),
  mediaType: modelImageMediaTypeSchema,
  data: z
    .string()
    .min(4)
    .max(5_592_408)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
});
export const modelContentBlockSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: z.string().max(1_000_000) }),
  modelImageBlockSchema,
]);
export const modelContentSchema = z.union([
  z.string().max(1_000_000),
  z.array(modelContentBlockSchema).min(1).max(100),
]);
export type ModelImageBlock = z.infer<typeof modelImageBlockSchema>;
export type ModelContentBlock = z.infer<typeof modelContentBlockSchema>;
export type ModelContent = z.infer<typeof modelContentSchema>;
