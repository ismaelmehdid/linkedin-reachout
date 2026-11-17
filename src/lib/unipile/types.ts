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

export interface UnipileClient {
  getProfile(identifier: string): Promise<UnipileProfile>;
  sendInvitation(providerId: string, message: string): Promise<{ invitationId: string }>;
  listSentInvitations(): Promise<SentInvitation[]>;
  cancelInvitation(invitationId: string): Promise<void>;
  startChat(providerId: string, text: string): Promise<{ chatId: string; messageId: string }>;
  sendMessage(chatId: string, text: string): Promise<{ messageId: string }>;
  listChatMessages(chatId: string, limit: number): Promise<ChatMessage[]>;
}
