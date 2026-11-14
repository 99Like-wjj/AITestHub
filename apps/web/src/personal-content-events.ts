import { z } from 'zod';
import { idSchema } from '../../../packages/contracts/src/base';
const changedSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('requirementGroupRestored'),
    projectId: idSchema,
    requirementId: idSchema,
  }),
  z.strictObject({
    type: z.literal('conversationRestored'),
    conversationId: idSchema,
  }),
  z.strictObject({
    type: z.literal('conversationDeleted'),
    conversationId: idSchema,
  }),
  z.strictObject({ type: z.literal('resourceDeleted'), resourceId: idSchema }),
]);
type Change = z.infer<typeof changedSchema>;
const name = 'aitesthub:personal-content-changed';
export function personalContentChanged(change: Change) {
  window.dispatchEvent(
    new CustomEvent(name, { detail: changedSchema.parse(change) }),
  );
}
export function onPersonalContentChanged(listener: (change: Change) => void) {
  const receive = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    const parsed = changedSchema.safeParse(event.detail);
    if (parsed.success) listener(parsed.data);
  };
  window.addEventListener(name, receive);
  return () => window.removeEventListener(name, receive);
}
