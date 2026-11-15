import { api, ApiError } from './api';
import { currentIdentityOwner, identityContextEpoch } from './identity-context';
import {
  pendingIdentityCommands,
  resolveIdentityCommand,
} from './identity-commands';
import { sendReceiptSchema } from '../../../packages/contracts/src/conversations';
import {
  idSchema,
  commandIdSchema,
} from '../../../packages/contracts/src/base';

/** An authenticated original receipt clears only its exact owner/target/command
 * fence. A missing/unknown receipt never authorizes another POST. */
export async function readWorkspaceSendReceipt(
  ownerId: string,
  conversationId: string,
  commandId: string,
) {
  idSchema.parse(ownerId);
  idSchema.parse(conversationId);
  commandIdSchema.parse(commandId);
  const epoch = identityContextEpoch();
  const assertOwner = () => {
    if (currentIdentityOwner() !== ownerId || identityContextEpoch() !== epoch)
      throw new ApiError(
        '当前身份已变化，请切回原账号核对消息回执。',
        409,
        'IDENTITY_CONTEXT_CHANGED',
      );
  };
  assertOwner();
  const result = await api(
    `/me/conversations/${conversationId}/send-receipts/${commandId}`,
    {},
    sendReceiptSchema,
  );
  assertOwner();
  const record = pendingIdentityCommands(ownerId).find(
    (entry) =>
      entry.operation === 'conversations.send' &&
      entry.targetId === conversationId &&
      entry.commandId === commandId,
  );
  if (record) resolveIdentityCommand(record);
  return result;
}
