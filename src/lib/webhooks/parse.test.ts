import { describe, expect, it } from 'vitest';
import { parseWebhookPayload } from './parse';

const message = (over: Record<string, unknown> = {}) => ({
  account_id: 'acc_1', account_type: 'LINKEDIN', account_info: { type: 'LINKEDIN', feature: 'classic', user_id: 'ACoMe' },
  event: 'message_received', chat_id: 'chat_1', timestamp: '2026-11-17T08:00:00.000Z', webhook_name: 'reachout', message_id: 'm1', message: 'Hey',
  sender: { attendee_id: 'att_2', attendee_name: 'Jane Doe', attendee_provider_id: 'ACoJane', attendee_profile_url: 'https://www.linkedin.com/in/jane-doe' },
  attendees: [{ attendee_id: 'att_1', attendee_provider_id: 'ACoMe' }, { attendee_id: 'att_2', attendee_provider_id: 'ACoJane' }], attachments: [], ...over,
});
const relation = { event: 'new_relation', account_id: 'acc_1', account_type: 'LINKEDIN', webhook_name: 'reachout', user_full_name: 'Jane Doe',
  user_provider_id: 'ACoJane', user_public_identifier: 'jane-doe', user_profile_url: 'https://www.linkedin.com/in/jane-doe', user_picture_url: null };

describe('parseWebhookPayload', () => {
  it('parses a received message', () => expect(parseWebhookPayload(message())).toEqual({ kind: 'message', accountId: 'acc_1', chatId: 'chat_1',
    messageId: 'm1', timestamp: new Date('2026-11-17T08:00:00.000Z'), senderProviderId: 'ACoJane', ownerProviderId: 'ACoMe', otherAttendeeProviderIds: ['ACoJane'] }));

  it('parses a new relation', () =>
    expect(parseWebhookPayload(relation)).toEqual({ kind: 'new_relation', accountId: 'acc_1', providerId: 'ACoJane', publicIdentifier: 'jane-doe' }));

  it('ignores other events and malformed bodies', () => {
    expect(parseWebhookPayload(message({ event: 'message_read' }))).toBeNull();
    expect(parseWebhookPayload('nope')).toBeNull();
    expect(parseWebhookPayload({ event: 'message_received' })).toBeNull();
  });

  it('lists the other attendees once each, without the owner', () => {
    const attendees = [{ attendee_provider_id: 'ACoMe' }, { attendee_provider_id: 'ACoJane' }, { attendee_provider_id: 'ACoJane' }, { attendee_id: 'att_9' }];
    expect(parseWebhookPayload(message({ attendees }))).toMatchObject({ otherAttendeeProviderIds: ['ACoJane'] });
  });

  it('gives null for a missing message id or timestamp, and an unreadable timestamp', () => {
    expect(parseWebhookPayload(message({ message_id: undefined, timestamp: undefined }))).toMatchObject({ messageId: null, timestamp: null });
    expect(parseWebhookPayload(message({ timestamp: 'not a date' }))).toMatchObject({ timestamp: null });
  });

  it('keeps a new relation that has no provider id or no public identifier', () =>
    expect(parseWebhookPayload({ ...relation, user_provider_id: null, user_public_identifier: undefined }))
      .toEqual({ kind: 'new_relation', accountId: 'acc_1', providerId: null, publicIdentifier: null }));
});
