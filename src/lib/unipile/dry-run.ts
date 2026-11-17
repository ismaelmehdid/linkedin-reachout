import type { UnipileClient } from './types';

export const DRY_RUN_ID_PREFIX = 'dry_';

/** Wraps a real client: reads pass through, writes call nothing and return fake ids. */
export function createDryRunClient(real: UnipileClient): UnipileClient {
  let counter = 0;
  const nextId = (kind: string) => `${DRY_RUN_ID_PREFIX}${kind}_${++counter}`;

  return {
    getProfile: (identifier) => real.getProfile(identifier),
    listSentInvitations: () => real.listSentInvitations(),
    listChatMessages: async (chatId, limit) =>
      chatId.startsWith(DRY_RUN_ID_PREFIX) ? [] : real.listChatMessages(chatId, limit),
    sendInvitation: async () => ({ invitationId: nextId('inv') }),
    cancelInvitation: async () => {},
    startChat: async () => ({ chatId: nextId('chat'), messageId: nextId('msg') }),
    sendMessage: async () => ({ messageId: nextId('msg') }),
  };
}
