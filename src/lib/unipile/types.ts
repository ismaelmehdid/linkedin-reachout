export type NetworkDistance = 'FIRST_DEGREE' | 'SECOND_DEGREE' | 'THIRD_DEGREE' | 'OUT_OF_NETWORK';

export type UnipileProfile = {
  providerId: string;
  publicIdentifier: string | null;
  firstName: string | null;
  lastName: string | null;
  headline: string | null;
  location: string | null;
  networkDistance: NetworkDistance | null;
  currentCompany: string | null;
  currentPosition: string | null;
};

export type SentInvitation = {
  id: string;
  invitedUserId: string | null;
  invitedUserPublicId: string | null;
};

export type ChatMessage = {
  id: string;
  isSender: boolean;
  timestamp: string;
  text: string | null;
};

/**
 * The three write methods resolve whenever Unipile accepted the write. An id is null when the answer
 * did not carry one: the action still happened, so a caller must never treat a null id as a failure.
 */
export interface UnipileClient {
  getProfile(identifier: string): Promise<UnipileProfile>;
  sendInvitation(providerId: string, message: string): Promise<{ invitationId: string | null }>;
  listSentInvitations(): Promise<SentInvitation[]>;
  cancelInvitation(invitationId: string): Promise<void>;
  startChat(providerId: string, text: string): Promise<{ chatId: string | null; messageId: string | null }>;
  sendMessage(chatId: string, text: string): Promise<{ messageId: string | null }>;
  /** The id of the one-to-one chat with this person, or null when there is none. */
  findChatWithAttendee(providerId: string): Promise<string | null>;
  /** With `after`, only messages newer than that time. */
  listChatMessages(chatId: string, limit: number, after?: Date): Promise<ChatMessage[]>;
}
