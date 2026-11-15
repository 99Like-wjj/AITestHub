import { z } from 'zod';
import { idSchema, sha256Schema, timestampSchema } from './base.js';

/** Web-only session timing and opaque context; no cookie/token is returned. */
export const webSessionInfoSchema = z.strictObject({
  userId: idSchema,
  scopeId: sha256Schema,
  expiresAt: timestampSchema,
  absoluteExpiresAt: timestampSchema,
  cookieExpiresAt: timestampSchema,
  renewAfter: timestampSchema,
  serverTime: timestampSchema,
});
export const webSessionStatusSchema = z.strictObject({
  session: webSessionInfoSchema,
});
export const renewWebSessionInputSchema = z.strictObject({
  userId: idSchema,
  scopeId: sha256Schema,
});
export const renewWebSessionResultSchema = webSessionStatusSchema.safeExtend({
  renewed: z.boolean(),
});
export type WebSessionInfo = z.infer<typeof webSessionInfoSchema>;
