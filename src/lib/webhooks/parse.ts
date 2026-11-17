import { z } from 'zod';

export type WebhookEvent =
  | { kind: 'message'; accountId: string; chatId: string; messageId: string | null; timestamp: Date | null;
      senderProviderId: string; ownerProviderId: string; otherAttendeeProviderIds: string[] }
  | { kind: 'new_relation'; accountId: string; providerId: string | null; publicIdentifier: string | null };

const id = z.string().min(1);
const optionalText = z.string().nullish();

const messageReceivedSchema = z.looseObject({
  event: z.literal('message_received'),
  account_id: id,
  account_info: z.looseObject({ user_id: id }),
  chat_id: id,
  message_id: optionalText,
  timestamp: optionalText,
  sender: z.looseObject({ attendee_provider_id: id }),
  // Only the provider ids matter; an attendee without one is skipped rather than failing the whole message.
  attendees: z.array(z.looseObject({ attendee_provider_id: z.unknown().optional() })).nullish(),
});

const newRelationSchema = z.looseObject({
  event: z.literal('new_relation'),
  account_id: id,
  user_provider_id: optionalText,
  user_public_identifier: optionalText,
});

function parseTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A Unipile `message_received` or `new_relation` payload as an event; null for any other event or a malformed body. */
export function parseWebhookPayload(body: unknown): WebhookEvent | null {
  const message = messageReceivedSchema.safeParse(body);
  if (message.success) {
    const m = message.data;
    const owner = m.account_info.user_id;
    const others = new Set<string>();
    for (const attendee of m.attendees ?? []) {
      const providerId = attendee.attendee_provider_id;
      if (typeof providerId === 'string' && providerId !== '' && providerId !== owner) others.add(providerId);
    }
    return {
      kind: 'message',
      accountId: m.account_id,
      chatId: m.chat_id,
      messageId: m.message_id || null,
      timestamp: parseTimestamp(m.timestamp),
      senderProviderId: m.sender.attendee_provider_id,
      ownerProviderId: owner,
      otherAttendeeProviderIds: [...others],
    };
  }

  const relation = newRelationSchema.safeParse(body);
  if (relation.success) {
    const r = relation.data;
    return {
      kind: 'new_relation',
      accountId: r.account_id,
      providerId: r.user_provider_id || null,
      publicIdentifier: r.user_public_identifier || null,
    };
  }

  return null;
}
