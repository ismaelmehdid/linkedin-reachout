import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { leads } from '@/db/schema';
import { UnipileError } from '@/lib/unipile/errors';
import { createTestEngine, getLead, listEvents, NOW, seedLead, type TestEngine } from '@/test-utils/engine';
import { runMessageAction } from './message';
import { getAppState, updateAppState } from './state';

const SEQ = new Date('2026-11-10T09:00:00Z');

describe('message action', () => {
  let e: TestEngine;
  beforeEach(async () => {
    e = await createTestEngine();
  });

  const replyAt = (iso: string) => [{ id: 'm1', isSender: false, timestamp: iso, text: 'Hey' }];

  it('starts a chat for the first message and schedules follow-up 1 two days later', async () => {
    const lead = await seedLead(e.db, { status: 'accepted', providerId: 'ACoJane', firstName: 'Jane', sequenceStartedAt: SEQ });
    expect(await runMessageAction(e.deps, lead, 'first_message', e.settings)).toEqual({ leadId: lead.id, result: 'messaged' });
    expect(e.fake.calls).toEqual([{ method: 'startChat', args: ['ACoJane', 'Thanks Jane'] }]);
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'messaged', chatId: 'chat_ACoJane', nextActionAt: new Date('2026-11-19T09:00:00Z'), lastAction: 'first_message' });
    expect((await listEvents(e.db)).at(-1)).toMatchObject({ type: 'message_sent', payload: { step: 'first_message', text: 'Thanks Jane', dryRun: false } });
  });
  it('sends follow-up 1 in the existing chat and schedules follow-up 2 three days later', async () => {
    const lead = await seedLead(e.db, { status: 'messaged', providerId: 'ACoJane', firstName: 'Jane', chatId: 'chat_1', sequenceStartedAt: SEQ });
    await runMessageAction(e.deps, lead, 'followup_1', e.settings);
    expect(e.fake.calls.map((c) => c.method)).toEqual(['listChatMessages', 'sendMessage']);
    expect(e.fake.calls[1].args).toEqual(['chat_1', 'Bump Jane']);
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'followup_1', nextActionAt: new Date('2026-11-20T09:00:00Z') });
  });
  it('schedules the end three days after follow-up 2', async () => {
    const lead = await seedLead(e.db, { status: 'followup_1', providerId: 'ACoJane', firstName: 'Jane', chatId: 'chat_1', sequenceStartedAt: SEQ });
    await runMessageAction(e.deps, lead, 'followup_2', e.settings);
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'followup_2', nextActionAt: new Date('2026-11-20T09:00:00Z') });
  });
  it('stops instead of sending when the lead already replied', async () => {
    const lead = await seedLead(e.db, { status: 'messaged', providerId: 'ACoJane', firstName: 'Jane', chatId: 'chat_1', sequenceStartedAt: SEQ });
    e.fake.chatMessages.set('chat_1', replyAt('2026-11-17T08:00:00Z'));
    expect((await runMessageAction(e.deps, lead, 'followup_1', e.settings)).result).toBe('replied');
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'replied', nextActionAt: null, lastAction: 'reply_received' });
    expect(e.fake.calls.map((c) => c.method)).toEqual(['listChatMessages']);
  });
  it('ignores messages from before the sequence started', async () => {
    const lead = await seedLead(e.db, { status: 'messaged', providerId: 'ACoJane', firstName: 'Jane', chatId: 'chat_1', sequenceStartedAt: SEQ });
    e.fake.chatMessages.set('chat_1', replyAt('2026-11-01T08:00:00Z'));
    expect((await runMessageAction(e.deps, lead, 'followup_1', e.settings)).result).toBe('messaged');
  });
  it('lets a reply that lands during the send win', async () => { // Review Focus 2
    const lead = await seedLead(e.db, { status: 'messaged', providerId: 'ACoJane', firstName: 'Jane', chatId: 'chat_1', sequenceStartedAt: SEQ });
    e.fake.onCall('sendMessage', async () => { await e.db.update(leads).set({ status: 'replied' }).where(eq(leads.id, lead.id)); });
    expect((await runMessageAction(e.deps, lead, 'followup_1', e.settings)).result).toBe('superseded');
    expect((await getLead(e.db, lead.id)).status).toBe('replied');
  });
  it('fails the lead when an edited template now needs a missing variable', async () => {
    e = await createTestEngine({ templates: { followup1: 'About {{position}}' } });
    const lead = await seedLead(e.db, { status: 'messaged', providerId: 'ACoJane', firstName: 'Jane', chatId: 'chat_1', sequenceStartedAt: SEQ });
    await runMessageAction(e.deps, lead, 'followup_1', e.settings);
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'failed', failureReason: 'missing_variable: position', failedFromStatus: 'messaged' });
  });
  it('fails the lead when Unipile says there is no connection', async () => {
    const lead = await seedLead(e.db, { status: 'accepted', providerId: 'ACoJane', firstName: 'Jane', sequenceStartedAt: SEQ });
    e.fake.failNext('startChat', new UnipileError(422, 'errors/no_connection_with_recipient', ''));
    await runMessageAction(e.deps, lead, 'first_message', e.settings);
    expect((await getLead(e.db, lead.id)).failureReason).toBe('errors/no_connection_with_recipient');
  });
  it('pauses messages until the next active day on a limit error', async () => {
    const lead = await seedLead(e.db, { status: 'accepted', providerId: 'ACoJane', firstName: 'Jane', sequenceStartedAt: SEQ });
    e.fake.failNext('startChat', new UnipileError(429, null, ''));
    await runMessageAction(e.deps, lead, 'first_message', e.settings);
    expect((await getAppState(e.db)).messagesPausedUntil).toEqual(new Date('2026-11-18T07:30:00Z'));
    expect((await getLead(e.db, lead.id)).status).toBe('accepted');
  });

  // Beyond the plan's list: specified behavior the tests above do not pin down.
  it('stamps the send with now, clears the retry count and resets the error streak', async () => {
    await updateAppState(e.db, { consecutiveErrors: 2 });
    const lead = await seedLead(e.db, { status: 'messaged', providerId: 'ACoJane', firstName: 'Jane', chatId: 'chat_1', sequenceStartedAt: SEQ, retryCount: 1 });
    expect((await runMessageAction(e.deps, lead, 'followup_1', e.settings)).result).toBe('messaged');
    expect(await getLead(e.db, lead.id)).toMatchObject({ chatId: 'chat_1', retryCount: 0, lastAction: 'followup_1', lastActionAt: NOW, updatedAt: NOW });
    expect((await getAppState(e.db)).consecutiveErrors).toBe(0);
    expect((await listEvents(e.db)).at(-1)).toMatchObject({ type: 'message_sent', leadId: lead.id, createdAt: NOW });
  });
  it('records the earliest reply after the sequence start and ignores the owner\'s own messages', async () => {
    const lead = await seedLead(e.db, { status: 'followup_1', providerId: 'ACoJane', firstName: 'Jane', chatId: 'chat_1', sequenceStartedAt: SEQ });
    e.fake.chatMessages.set('chat_1', [
      { id: 'm4', isSender: false, timestamp: '2026-11-16T10:00:00Z', text: 'Still keen' },
      { id: 'm3', isSender: true, timestamp: '2026-11-15T09:00:00Z', text: 'Bump Jane' },
      { id: 'm2', isSender: false, timestamp: '2026-11-14T18:00:00Z', text: 'Sounds good' },
      { id: 'm1', isSender: false, timestamp: '2026-11-01T08:00:00Z', text: 'Old chat' },
    ]);
    expect(await runMessageAction(e.deps, lead, 'followup_2', e.settings)).toEqual({ leadId: lead.id, result: 'replied' });
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'replied', lastActionAt: new Date('2026-11-14T18:00:00Z'), updatedAt: NOW });
    expect(e.fake.calls).toEqual([{ method: 'listChatMessages', args: ['chat_1', 50] }]);
  });
  it('sends nothing when only the owner wrote since the sequence started', async () => {
    const lead = await seedLead(e.db, { status: 'messaged', providerId: 'ACoJane', firstName: 'Jane', chatId: 'chat_1', sequenceStartedAt: SEQ });
    e.fake.chatMessages.set('chat_1', [{ id: 'm1', isSender: true, timestamp: '2026-11-15T09:00:00Z', text: 'Thanks Jane' }]);
    expect((await runMessageAction(e.deps, lead, 'followup_1', e.settings)).result).toBe('messaged');
  });
  it('sends nothing when the reply check fails, and applies the error policy', async () => {
    const lead = await seedLead(e.db, { status: 'messaged', providerId: 'ACoJane', firstName: 'Jane', chatId: 'chat_1', sequenceStartedAt: SEQ });
    e.fake.failNext('listChatMessages', new UnipileError(503, null, 'down'));
    expect((await runMessageAction(e.deps, lead, 'followup_1', e.settings)).result).toBe('deferred');
    expect(e.fake.calls.map((c) => c.method)).toEqual(['listChatMessages']);
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'messaged', retryCount: 0 });
    expect((await listEvents(e.db)).map((x) => [x.type, x.payload])).toEqual([['action_failed', { kind: 'message', status: 503, type: null, message: 'down' }]]);
  });
  it('sends the first message in an existing chat without a reply check', async () => {
    const lead = await seedLead(e.db, { status: 'already_connected', providerId: 'ACoJane', firstName: 'Jane', chatId: 'chat_1', sequenceStartedAt: SEQ });
    expect((await runMessageAction(e.deps, lead, 'first_message', e.settings)).result).toBe('messaged');
    expect(e.fake.calls).toEqual([{ method: 'sendMessage', args: ['chat_1', 'Thanks Jane'] }]);
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'messaged', chatId: 'chat_1' });
  });
  it('fails the lead instead of sending text that still contains {{', async () => {
    const lead = await seedLead(e.db, { status: 'accepted', providerId: 'ACoJane', firstName: 'Ja{{ne', sequenceStartedAt: SEQ });
    expect((await runMessageAction(e.deps, lead, 'first_message', e.settings)).result).toBe('failed');
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'failed', failureReason: 'invalid_template', failedFromStatus: 'accepted', lastAction: 'failed', lastActionAt: NOW });
    expect(e.fake.calls).toEqual([]);
  });
  it('fails the lead when there is neither a chat nor a provider id to send to', async () => {
    const lead = await seedLead(e.db, { status: 'accepted', firstName: 'Jane', sequenceStartedAt: SEQ });
    expect((await runMessageAction(e.deps, lead, 'first_message', e.settings)).result).toBe('failed');
    expect((await getLead(e.db, lead.id)).failureReason).toBe('missing_provider_id');
    expect(e.fake.calls).toEqual([]);
  });
  it('records the dry-run flag and stores the dry-run chat id', async () => {
    e = await createTestEngine({ dryRun: true });
    const lead = await seedLead(e.db, { status: 'accepted', providerId: 'ACoJane', firstName: 'Jane', sequenceStartedAt: SEQ });
    expect((await runMessageAction(e.deps, lead, 'first_message', e.settings)).result).toBe('messaged');
    expect(e.fake.calls).toEqual([]);
    expect((await getLead(e.db, lead.id)).chatId).toMatch(/^dry_/);
    expect((await listEvents(e.db)).at(-1)).toMatchObject({ type: 'message_sent', payload: { step: 'first_message', text: 'Thanks Jane', dryRun: true } });
  });
});
