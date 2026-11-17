import { UnipileError } from '@/lib/unipile/errors';
import type { ChatMessage, SentInvitation, UnipileClient, UnipileProfile } from '@/lib/unipile/types';

type Method = keyof UnipileClient;

export type FakeUnipile = UnipileClient & {
  calls: { method: Method; args: unknown[] }[];
  profiles: Map<string, UnipileProfile>;
  sentInvitations: SentInvitation[];
  /** Every message of each chat. `listChatMessages` returns them all: `after` is recorded, not applied. */
  chatMessages: Map<string, ChatMessage[]>;
  /** The chat `findChatWithAttendee` finds for a provider id. */
  chatByAttendee: Map<string, string>;
  failNext(method: Method, error: unknown): void;
  onCall(method: Method, hook: () => Promise<void>): void;
};

export function makeProfile(patch: Partial<UnipileProfile> = {}): UnipileProfile {
  return {
    providerId: 'ACoJane',
    publicIdentifier: 'jane-doe',
    firstName: 'Jane',
    lastName: 'Doe',
    headline: 'CTO at Acme',
    location: 'Paris',
    networkDistance: 'SECOND_DEGREE',
    currentCompany: 'Acme',
    currentPosition: 'CTO',
    ...patch,
  };
}

export function createFakeUnipile(): FakeUnipile {
  const calls: FakeUnipile['calls'] = [];
  const failures = new Map<Method, unknown[]>();
  const hooks = new Map<Method, (() => Promise<void>)[]>();
  const profiles = new Map<string, UnipileProfile>();
  const sentInvitations: SentInvitation[] = [];
  const chatMessages = new Map<string, ChatMessage[]>();
  const chatByAttendee = new Map<string, string>();
  let invitationCount = 0;
  let messageCount = 0;

  async function enter(method: Method, args: unknown[]): Promise<void> {
    calls.push({ method, args });
    for (const hook of hooks.get(method) ?? []) await hook();
    const queue = failures.get(method);
    if (queue && queue.length > 0) throw queue.shift();
  }

  return {
    calls,
    profiles,
    sentInvitations,
    chatMessages,
    chatByAttendee,
    failNext(method, error) {
      failures.set(method, [...(failures.get(method) ?? []), error]);
    },
    onCall(method, hook) {
      hooks.set(method, [...(hooks.get(method) ?? []), hook]);
    },
    async getProfile(identifier) {
      await enter('getProfile', [identifier]);
      const profile = profiles.get(identifier);
      if (!profile) throw new UnipileError(404, 'errors/invalid_resource_identifier', 'User not found');
      return profile;
    },
    async sendInvitation(providerId, message) {
      await enter('sendInvitation', [providerId, message]);
      invitationCount += 1;
      return { invitationId: `inv_${invitationCount}` };
    },
    async listSentInvitations() {
      await enter('listSentInvitations', []);
      return [...sentInvitations];
    },
    async cancelInvitation(invitationId) {
      await enter('cancelInvitation', [invitationId]);
      const index = sentInvitations.findIndex((i) => i.id === invitationId);
      if (index >= 0) sentInvitations.splice(index, 1);
    },
    async startChat(providerId, text) {
      await enter('startChat', [providerId, text]);
      messageCount += 1;
      return { chatId: `chat_${providerId}`, messageId: `msg_${messageCount}` };
    },
    async sendMessage(chatId, text) {
      await enter('sendMessage', [chatId, text]);
      messageCount += 1;
      return { messageId: `msg_${messageCount}` };
    },
    async findChatWithAttendee(providerId) {
      await enter('findChatWithAttendee', [providerId]);
      return chatByAttendee.get(providerId) ?? null;
    },
    async listChatMessages(chatId, limit, after) {
      await enter('listChatMessages', after === undefined ? [chatId, limit] : [chatId, limit, after]);
      return chatMessages.get(chatId) ?? [];
    },
  };
}
