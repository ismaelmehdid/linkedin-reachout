import { describe, expect, it } from 'vitest';
import { leads } from '@/db/schema';
import { importLeads } from '@/lib/leads/import';
import { processWebhook } from '@/lib/webhooks/handle';
import { createTestEngine, getLead, listEvents } from '@/test-utils/engine';
import { makeProfile } from '@/test-utils/fake-unipile';
import { runTick } from './tick';

const OWNER = 'ACoMe';
const JANE = 'ACoJane';
const CHAT = 'chat_1';

/** A `message_received` webhook for a message the account owner sent in the chat with Jane. */
const ownerMessage = (messageId: string, timestamp: Date) => ({
  account_id: 'acc_1', account_info: { user_id: OWNER }, event: 'message_received', chat_id: CHAT, message_id: messageId,
  timestamp: timestamp.toISOString(), sender: { attendee_provider_id: OWNER },
  attendees: [{ attendee_provider_id: OWNER }, { attendee_provider_id: JANE }],
});

const newRelation = { event: 'new_relation', account_id: 'acc_1', user_provider_id: JANE, user_public_identifier: 'jane-doe' };

describe('the whole sequence', () => {
  it('takes a pasted lead from the invite to no_response, one step at a time', async () => {
    const e = await createTestEngine();
    e.fake.profiles.set('jane-doe', makeProfile());

    const tickAt = (iso: string) => {
      e.setNow(new Date(iso));
      return runTick(e.deps);
    };
    const webhookAt = (iso: string, body: unknown) => processWebhook(e.db, body, { accountId: 'acc_1', now: new Date(iso), random: e.deps.random });
    const sends = () => e.fake.calls.filter((c) => ['sendInvitation', 'startChat', 'sendMessage'].includes(c.method));
    /**
     * What LinkedIn and Unipile do with a message the app sent in the tick at `iso`: the message is in
     * the chat, stamped two seconds later, and a webhook reports it one second after that.
     */
    const deliverLastMessage = (iso: string) => {
      const [chatId, text] = e.fake.calls.at(-1)?.args as [string, string];
      const stampedAt = new Date(new Date(iso).getTime() + 2000);
      const id = `m${e.fake.chatMessages.get(chatId)?.length}`;
      e.fake.chatMessages.get(chatId)?.unshift({ id, isSender: true, timestamp: stampedAt.toISOString(), text });
      return webhookAt(new Date(stampedAt.getTime() + 1000).toISOString(), ownerMessage(id, stampedAt));
    };

    // Tuesday: the owner pastes a profile link, and the next tick sends the invite with its note.
    expect(await importLeads(e.db, 'https://www.linkedin.com/in/jane-doe/', new Date('2026-11-17T09:00:00Z'))).toEqual({ added: 1, duplicates: [], invalid: [] });
    const [{ id }] = await e.db.select({ id: leads.id }).from(leads);
    expect((await tickAt('2026-11-17T09:00:00Z')).action).toEqual({ leadId: id, result: 'invited' });
    expect(await getLead(e.db, id)).toMatchObject({ status: 'invite_sent', providerId: JANE, invitationId: 'inv_1', nextActionAt: new Date('2026-12-08T09:00:00Z') });
    e.fake.sentInvitations.push({ id: 'inv_1', invitedUserId: JANE, invitedUserPublicId: 'jane-doe' });

    // While the invite is pending, ticks and the invite poll change nothing.
    expect((await tickAt('2026-11-17T09:05:00Z')).action).toBeNull();
    expect((await tickAt('2026-11-17T13:05:00Z')).action).toBeNull();
    expect(await getLead(e.db, id)).toMatchObject({ status: 'invite_sent', acceptanceCheckPending: false });

    // Wednesday: Jane accepts. The invite leaves the sent list, and a chat that holds the note appears.
    e.fake.sentInvitations.length = 0;
    e.fake.profiles.set(JANE, makeProfile({ networkDistance: 'FIRST_DEGREE' }));
    const noteAt = new Date('2026-11-17T09:00:03Z');
    e.fake.chatByAttendee.set(JANE, CHAT);
    e.fake.chatMessages.set(CHAT, [{ id: 'm0', isSender: true, timestamp: noteAt.toISOString(), text: 'Hi Jane from Acme' }]);
    expect((await webhookAt('2026-11-18T10:00:00Z', ownerMessage('m0', noteAt))).outcome).toBe('acceptance_check');
    // The next tick confirms the acceptance with a profile fetch and schedules the first message two hours later.
    expect((await tickAt('2026-11-18T10:05:00Z')).action).toBeNull();
    expect(await getLead(e.db, id)).toMatchObject({ status: 'accepted', chatId: CHAT, nextActionAt: new Date('2026-11-18T12:05:00Z') });
    expect((await tickAt('2026-11-18T12:00:00Z')).action).toBeNull();

    // The first message, in the chat of the note. Its own webhook is not a manual message.
    expect((await tickAt('2026-11-18T12:05:00Z')).action).toEqual({ leadId: id, result: 'messaged' });
    expect((await deliverLastMessage('2026-11-18T12:05:00Z')).outcome).toBe('ignored');
    expect(await getLead(e.db, id)).toMatchObject({ status: 'messaged', lastAction: 'first_message', nextActionAt: new Date('2026-11-20T12:05:00Z') });
    // The relation webhook may arrive hours after the acceptance: by then it changes nothing.
    expect((await webhookAt('2026-11-18T15:00:00Z', newRelation)).outcome).toBe('ignored');

    // Follow-up 1 two days later, and not a tick earlier.
    expect((await tickAt('2026-11-19T12:05:00Z')).action).toBeNull();
    expect((await tickAt('2026-11-20T12:00:00Z')).action).toBeNull();
    expect((await tickAt('2026-11-20T12:05:00Z')).action).toEqual({ leadId: id, result: 'messaged' });
    expect((await deliverLastMessage('2026-11-20T12:05:00Z')).outcome).toBe('ignored');
    expect(await getLead(e.db, id)).toMatchObject({ status: 'followup_1', lastAction: 'followup_1', nextActionAt: new Date('2026-11-23T12:05:00Z') });

    // Follow-up 2 three days later.
    expect((await tickAt('2026-11-23T12:00:00Z')).action).toBeNull();
    expect((await tickAt('2026-11-23T12:05:00Z')).action).toEqual({ leadId: id, result: 'messaged' });
    expect((await deliverLastMessage('2026-11-23T12:05:00Z')).outcome).toBe('ignored');
    expect(await getLead(e.db, id)).toMatchObject({ status: 'followup_2', lastAction: 'followup_2', nextActionAt: new Date('2026-11-26T12:05:00Z') });

    // Three more days without a reply end the sequence.
    expect(await tickAt('2026-11-26T12:00:00Z')).toEqual({ status: 'done', finished: 0, action: null });
    expect(await tickAt('2026-11-26T12:05:00Z')).toEqual({ status: 'done', finished: 1, action: null });
    expect(await getLead(e.db, id)).toMatchObject({ status: 'no_response', nextActionAt: null, lastAction: 'no_response', lastActionAt: new Date('2026-11-26T12:05:00Z') });
    expect(await tickAt('2026-11-26T12:10:00Z')).toEqual({ status: 'done', finished: 0, action: null });

    // Jane got exactly one invite and three messages, each once, all in the same chat.
    expect(sends()).toEqual([
      { method: 'sendInvitation', args: [JANE, 'Hi Jane from Acme'] },
      { method: 'sendMessage', args: [CHAT, 'Thanks Jane'] },
      { method: 'sendMessage', args: [CHAT, 'Bump Jane'] },
      { method: 'sendMessage', args: [CHAT, 'Last Jane'] },
    ]);
    expect((await listEvents(e.db)).map((x) => [x.type, (x.payload as { step?: string; outcome?: string }).step ?? (x.payload as { outcome?: string }).outcome ?? null])).toEqual([
      ['profile_view', null],
      ['invite_sent', null],
      ['webhook_received', 'acceptance_check'],
      ['profile_view', null],
      ['message_sent', 'first_message'],
      ['webhook_received', 'ignored'],
      ['webhook_received', 'ignored'],
      ['message_sent', 'followup_1'],
      ['webhook_received', 'ignored'],
      ['message_sent', 'followup_2'],
      ['webhook_received', 'ignored'],
    ]);
    // One random wait before each of the four sends, and none on the ticks that sent nothing.
    expect(e.sleeps).toEqual([45_000, 45_000, 45_000, 45_000]);
  });
});
