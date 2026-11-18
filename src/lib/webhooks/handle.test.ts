import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/db/types';
import { saveSettings } from '@/lib/settings/repo';
import { DEFAULT_SETTINGS } from '@/lib/settings/settings';
import { createTestDb } from '@/test-utils/db';
import { NOW, getLead, listEvents, seedLead } from '@/test-utils/engine';
import { processWebhook } from './handle';

const message = (over: Record<string, unknown> = {}) => ({
  account_id: 'acc_1', account_type: 'LINKEDIN', account_info: { type: 'LINKEDIN', feature: 'classic', user_id: 'ACoMe' },
  event: 'message_received', chat_id: 'chat_1', timestamp: '2026-11-17T08:00:00.000Z', webhook_name: 'reachout', message_id: 'm1', message: 'Hey',
  sender: { attendee_id: 'att_2', attendee_name: 'Jane Doe', attendee_provider_id: 'ACoJane', attendee_profile_url: 'https://www.linkedin.com/in/jane-doe' },
  attendees: [{ attendee_id: 'att_1', attendee_provider_id: 'ACoMe' }, { attendee_id: 'att_2', attendee_provider_id: 'ACoJane' }], attachments: [], ...over,
});
const fromMe = { sender: { attendee_id: 'att_1', attendee_provider_id: 'ACoMe' } };
const relation = { event: 'new_relation', account_id: 'acc_1', account_type: 'LINKEDIN', webhook_name: 'reachout', user_full_name: 'Jane Doe',
  user_provider_id: 'ACoJane', user_public_identifier: 'jane-doe', user_profile_url: 'https://www.linkedin.com/in/jane-doe', user_picture_url: null };

describe('processWebhook', () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
    // Follow-up jitter off, so the times below are the delays alone; one test saves the real defaults.
    await saveSettings(db, { ...DEFAULT_SETTINGS, pacing: { ...DEFAULT_SETTINGS.pacing, followupJitterMinutes: 0 } });
  });

  const opts = { accountId: 'acc_1', now: NOW, random: () => 0.5 };
  const handle = (body: unknown) => processWebhook(db, body, opts);

  it('marks a lead as replied when they write, whatever their status', async () => {
    const lead = await seedLead(db, { status: 'messaged', providerId: 'ACoJane' });
    expect(await handle(message())).toEqual({ outcome: 'replied', leadId: lead.id });
    expect(await getLead(db, lead.id)).toMatchObject({ status: 'replied', chatId: 'chat_1', nextActionAt: null, lastAction: 'reply_received' });
  });

  it('handles the same reply delivered twice', async () => { // Review Focus 5
    const lead = await seedLead(db, { status: 'queued', providerId: 'ACoJane' });
    await handle(message());
    expect(await handle(message())).toEqual({ outcome: 'ignored', leadId: lead.id });
    expect((await getLead(db, lead.id)).status).toBe('replied');
  });

  it('flags an acceptance check when our note shows up in a new chat', async () => {
    const lead = await seedLead(db, { status: 'invite_sent', providerId: 'ACoJane' });
    expect((await handle(message(fromMe))).outcome).toBe('acceptance_check');
    expect(await getLead(db, lead.id)).toMatchObject({ status: 'invite_sent', acceptanceCheckPending: true, chatId: 'chat_1' });
  });

  it('counts a manual message before the first message as the first message', async () => {
    const lead = await seedLead(db, { status: 'accepted', providerId: 'ACoJane', lastAction: 'accepted', lastActionAt: new Date('2026-11-17T06:00:00Z') });
    expect((await handle(message(fromMe))).outcome).toBe('manual_message');
    expect(await getLead(db, lead.id)).toMatchObject({ status: 'messaged', nextActionAt: new Date('2026-11-19T08:00:00Z') });
  });

  it('adds a random part of the follow-up jitter to the timer of a manual message', async () => {
    await saveSettings(db, DEFAULT_SETTINGS);
    const lead = await seedLead(db, { status: 'accepted', providerId: 'ACoJane', lastAction: 'accepted', lastActionAt: new Date('2026-11-17T06:00:00Z') });
    expect((await handle(message(fromMe))).outcome).toBe('manual_message');
    // 2 days after the message, plus half of the default 180 minutes.
    expect(await getLead(db, lead.id)).toMatchObject({ status: 'messaged', nextActionAt: new Date('2026-11-19T09:30:00Z') });
  });

  it('resets the timer on a manual message after follow-up 1', async () => {
    const lead = await seedLead(db, { status: 'followup_1', providerId: 'ACoJane', lastAction: 'followup_1', lastActionAt: new Date('2026-11-15T09:00:00Z') });
    await handle(message(fromMe));
    expect(await getLead(db, lead.id)).toMatchObject({ status: 'followup_1', nextActionAt: new Date('2026-11-20T08:00:00Z'), lastAction: 'manual_message' });
  });

  it('ignores the echo of a message the app just sent', async () => {
    const lead = await seedLead(db, { status: 'messaged', providerId: 'ACoJane', lastAction: 'first_message',
      lastActionAt: new Date('2026-11-17T07:59:30Z'), nextActionAt: new Date('2026-11-19T07:59:30Z') });
    expect((await handle(message(fromMe))).outcome).toBe('ignored');
    expect((await getLead(db, lead.id)).nextActionAt).toEqual(new Date('2026-11-19T07:59:30Z'));
  });

  it('ignores group chats and other accounts', async () => {
    await seedLead(db, { status: 'invite_sent', providerId: 'ACoJane' });
    const group = message({ ...fromMe, attendees: [{ attendee_provider_id: 'ACoMe' }, { attendee_provider_id: 'ACoJane' }, { attendee_provider_id: 'ACoBob' }] });
    expect((await handle(group)).outcome).toBe('ignored');
    expect((await handle(message({ account_id: 'acc_other' }))).outcome).toBe('ignored');
  });

  it('accepts on new_relation, by provider id or by public identifier in any case', async () => {
    const a = await seedLead(db, { status: 'invite_sent', providerId: 'ACoJane' });
    expect(await handle(relation)).toEqual({ outcome: 'accepted', leadId: a.id });
    expect(await getLead(db, a.id)).toMatchObject({ status: 'accepted', nextActionAt: new Date('2026-11-17T11:00:00Z') });
    const b = await seedLead(db, { status: 'invite_sent', slug: 'Bob-Smith', providerId: 'ACoBobOld' });
    expect((await handle({ ...relation, user_provider_id: 'ACoBobNew', user_public_identifier: 'bob-smith' })).leadId).toBe(b.id);
  });

  it('ignores new_relation for a lead past the invite stage', async () => {
    const lead = await seedLead(db, { status: 'messaged', providerId: 'ACoJane' });
    expect((await handle(relation)).outcome).toBe('ignored');
    expect((await getLead(db, lead.id)).status).toBe('messaged');
  });

  it('logs every webhook, ignored ones included', async () => {
    await handle({ event: 'message_read' });
    expect((await listEvents(db)).map((x) => [x.type, x.payload])).toEqual([['webhook_received', { event: 'message_read', outcome: 'ignored' }]]);
  });

  it('ignores a late copy of the invite note after the lead was accepted, but keeps its chat', async () => {
    const lead = await seedLead(db, { status: 'accepted', providerId: 'ACoJane', lastAction: 'accepted',
      lastActionAt: new Date('2026-11-17T08:30:00Z'), nextActionAt: new Date('2026-11-17T10:30:00Z') });
    expect((await handle(message(fromMe))).outcome).toBe('ignored');
    // The tick reads this chat before the first message, so a reply to the note stops the sequence.
    expect(await getLead(db, lead.id)).toMatchObject({ status: 'accepted', chatId: 'chat_1', nextActionAt: new Date('2026-11-17T10:30:00Z'),
      lastAction: 'accepted', lastActionAt: new Date('2026-11-17T08:30:00Z'), updatedAt: NOW });
  });

  it('keeps the chat a lead already has when it ignores an owner message from another chat', async () => {
    const lead = await seedLead(db, { status: 'messaged', providerId: 'ACoJane', chatId: 'chat_0', lastAction: 'first_message',
      lastActionAt: new Date('2026-11-17T07:59:30Z') });
    expect((await handle(message(fromMe))).outcome).toBe('ignored');
    expect(await getLead(db, lead.id)).toEqual(lead);
  });

  it('ignores an owner message without a time, except for a lead waiting for acceptance', async () => {
    const undated = message({ ...fromMe, timestamp: undefined });
    const accepted = await seedLead(db, { status: 'accepted', providerId: 'ACoJane', lastAction: 'accepted', lastActionAt: new Date('2026-11-17T06:00:00Z') });
    expect(await handle(undated)).toEqual({ outcome: 'ignored', leadId: accepted.id });
    expect(await getLead(db, accepted.id)).toMatchObject({ status: 'accepted', chatId: 'chat_1', lastAction: 'accepted' });

    const due = new Date('2026-11-18T09:00:00Z');
    const followedUp = await seedLead(db, { status: 'followup_1', providerId: 'ACoBob', chatId: 'chat_2', lastAction: 'followup_1',
      lastActionAt: new Date('2026-11-15T09:00:00Z'), nextActionAt: due });
    const toBob = { ...undated, chat_id: 'chat_2', attendees: [{ attendee_provider_id: 'ACoMe' }, { attendee_provider_id: 'ACoBob' }] };
    expect(await handle(toBob)).toEqual({ outcome: 'ignored', leadId: followedUp.id });
    expect(await getLead(db, followedUp.id)).toMatchObject({ status: 'followup_1', nextActionAt: due, lastAction: 'followup_1' });

    const invited = await seedLead(db, { status: 'invite_sent', providerId: 'ACoAnn' });
    const toAnn = { ...undated, chat_id: 'chat_3', attendees: [{ attendee_provider_id: 'ACoMe' }, { attendee_provider_id: 'ACoAnn' }] };
    expect(await handle(toAnn)).toEqual({ outcome: 'acceptance_check', leadId: invited.id });
  });

  it('never moves a follow-up earlier because of an old owner message', async () => {
    const lead = await seedLead(db, { status: 'messaged', providerId: 'ACoJane', lastAction: 'first_message',
      lastActionAt: new Date('2026-11-17T08:30:00Z'), nextActionAt: new Date('2026-11-19T08:30:00Z') });
    expect((await handle(message(fromMe))).outcome).toBe('ignored');
    expect((await getLead(db, lead.id)).nextActionAt).toEqual(new Date('2026-11-19T08:30:00Z'));
  });

  it('records when a lead was accepted', async () => {
    const lead = await seedLead(db, { status: 'invite_sent', providerId: 'ACoJane' });
    await handle(relation);
    expect((await getLead(db, lead.id)).lastActionAt).toEqual(NOW);
  });

  it('ignores an owner message for a lead with no recorded action', async () => {
    const lead = await seedLead(db, { status: 'accepted', providerId: 'ACoJane' });
    expect((await handle(message(fromMe))).outcome).toBe('ignored');
    expect((await getLead(db, lead.id)).status).toBe('accepted');
  });

  it('stamps updatedAt with the injected time', async () => {
    const lead = await seedLead(db, { status: 'messaged', providerId: 'ACoJane' });
    await handle(message());
    expect((await getLead(db, lead.id)).updatedAt).toEqual(NOW);
  });

  it('reports a message from someone who is not a lead', async () => {
    expect(await handle(message())).toEqual({ outcome: 'unknown_lead', leadId: null });
    expect(await handle(message(fromMe))).toEqual({ outcome: 'unknown_lead', leadId: null });
    expect(await handle(relation)).toEqual({ outcome: 'unknown_lead', leadId: null });
  });

  it('keeps the chat a lead already has when they reply elsewhere', async () => {
    const lead = await seedLead(db, { status: 'followup_1', providerId: 'ACoJane', chatId: 'chat_0' });
    await handle(message());
    expect(await getLead(db, lead.id)).toMatchObject({ status: 'replied', chatId: 'chat_0', lastActionAt: new Date('2026-11-17T08:00:00Z') });
  });

  it('accepts on new_relation by the stored public identifier', async () => {
    const lead = await seedLead(db, { status: 'invite_sent', slug: 'ACoAAJane', providerId: 'ACoAAJane', publicIdentifier: 'Jane-Doe' });
    expect(await handle({ ...relation, user_provider_id: 'ACoJaneOther' })).toEqual({ outcome: 'accepted', leadId: lead.id });
  });

  it('accepts the lead waiting for acceptance when a failed duplicate also matches', async () => {
    await seedLead(db, { status: 'failed', slug: 'jane-doe', failureReason: 'duplicate_person' });
    const lead = await seedLead(db, { status: 'invite_sent', slug: 'ACoAAJane', providerId: 'ACoAAJane', publicIdentifier: 'jane-doe' });
    expect(await handle({ ...relation, user_provider_id: 'ACoJaneOther' })).toEqual({ outcome: 'accepted', leadId: lead.id });
  });

  it('logs the lead and the injected time with the outcome', async () => {
    const lead = await seedLead(db, { status: 'messaged', providerId: 'ACoJane' });
    await handle(message());
    expect(await listEvents(db)).toMatchObject([{ type: 'webhook_received', leadId: lead.id, createdAt: NOW, payload: { event: 'message_received', outcome: 'replied' } }]);
  });

  describe('the same webhook delivered twice gives the same final state', () => { // Review Focus 5
    it('for a manual first message', async () => {
      const lead = await seedLead(db, { status: 'accepted', providerId: 'ACoJane', lastAction: 'accepted', lastActionAt: new Date('2026-11-17T06:00:00Z') });
      await handle(message(fromMe));
      const once = await getLead(db, lead.id);
      expect(once).toMatchObject({ status: 'messaged', lastAction: 'manual_message', lastActionAt: new Date('2026-11-17T08:00:00Z') });
      expect((await handle(message(fromMe))).outcome).toBe('ignored');
      expect(await getLead(db, lead.id)).toEqual(once);
    });

    it('for an acceptance check', async () => {
      const lead = await seedLead(db, { status: 'invite_sent', providerId: 'ACoJane' });
      await handle(message(fromMe));
      const once = await getLead(db, lead.id);
      expect((await handle(message(fromMe))).outcome).toBe('acceptance_check');
      expect(await getLead(db, lead.id)).toEqual(once);
    });

    it('for a new relation', async () => {
      const lead = await seedLead(db, { status: 'invite_sent', providerId: 'ACoJane' });
      await handle(relation);
      const once = await getLead(db, lead.id);
      expect(await handle(relation)).toEqual({ outcome: 'ignored', leadId: lead.id });
      expect(await getLead(db, lead.id)).toEqual(once);
    });
  });
});
