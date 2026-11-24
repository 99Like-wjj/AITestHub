import { z } from 'zod';
import { idSchema, sha256Schema } from './base.js';

export const multipartMaxParts = 20;
export const multipartMaxTextLength = 100_000;
export const multipartMaxFileBytes = 2 * 1024 * 1024;
export const multipartMaxPayloadBytes = 4 * 1024 * 1024;

const partName = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[^\x00-\x1F\x7F]+$/);
const textPart = z.strictObject({
  kind: z.literal('text'),
  name: partName,
  value: z.string().max(multipartMaxTextLength),
});

export const multipartRequestBodySchema = z.strictObject({
  format: z.literal('multipart'),
  parts: z
    .array(
      z.discriminatedUnion('kind', [
        textPart,
        z.strictObject({
          kind: z.literal('file'),
          name: partName,
          fileResourceId: idSchema,
        }),
      ]),
    )
    .min(1)
    .max(multipartMaxParts),
});

export const apiBinaryRequestBodySchema = z.strictObject({
  format: z.literal('binary'),
  fileResourceId: idSchema,
  mediaType: z.string().regex(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/).max(128),
});

export const multipartAttachmentSchema = z.strictObject({
  fileResourceId: idSchema,
  filename: z.string().min(1).max(240).regex(/^[^\x00-\x1F\x7F]+$/),
  mediaType: z.string().regex(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/).max(128),
  bytes: z.number().int().min(0).max(multipartMaxFileBytes),
  sha256: sha256Schema,
});

export const multipartTransportSchema = z.strictObject({
  parts: z
    .array(
      z.discriminatedUnion('kind', [
        textPart.extend({ value: z.string().max(multipartMaxPayloadBytes) }),
        multipartAttachmentSchema.extend({ kind: z.literal('file'), name: partName }),
      ]),
    )
    .min(1)
    .max(multipartMaxParts),
});

export type MultipartAttachment = z.infer<typeof multipartAttachmentSchema>;
export type MultipartTransport = z.infer<typeof multipartTransportSchema>;

export const multipartFileInputSchema = z.strictObject({
  intentId: idSchema,
  fileResourceId: idSchema,
});
