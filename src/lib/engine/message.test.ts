import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { leads } from '@/db/schema';
import { createUnipileClient } from '@/lib/unipile/client';
import { UnipileError } from '@/lib/unipile/errors';
import type { UnipileClient } from '@/lib/unipile/types';
import { processWebhook } from '@/lib/webhooks/handle';
import { createTestEngine, getLead, listEvents, NOW, seedLead, type TestEngine } from '@/test-utils/engine';
import { makeProfile } from '@/test-utils/fake-unipile';
import { runAcceptanceChecks } from './housekeeping';
import { runMessageAction } from './message';
import { getAppState, updateAppState } from './state';
import { runTick } from './tick';

const SEQ = new Date('2026-11-10T09:00:00Z');

/** Two days before NOW: when a `messaged` lead got its first message. */
const FIRST_MESSAGE_AT = new Date('2026-11-15T09:00:00Z');

/** A real client over a scripted `fetch`, to put Unipile's own response bodies in front of the engine. */
function unipileAnswering(answer: (method: string, url: string) => Response): { client: UnipileClient; requests: { method: string; url: string }[] } {
  const requests: { method: string; url: string }[] = [];
  const fetchStub = async (url: string | URL | Request, init?: RequestInit) => {
    const request = { method: init?.method ?? 'GET', url: String(url) };
    requests.push(request);
    return answer(request.method, request.url);
  };
  return { client: createUnipileClient({ dsn: 'api1.unipile.com:13111', apiKey: 'k', accountId: 'acc_1', fetch: fetchStub as typeof fetch }), requests };
}

/** The `message_received` webhook of a message the account owner sent to Jane. */
const ownerMessageWebhook = (timestamp: string, messageId: string) => ({
  account_id: 'acc_1', account_info: { user_id: 'ACoMe' }, event: 'message_received', chat_id: 'chat_1', timestamp, message_id: messageId,
  sender: { attendee_provider_id: 'ACoMe' }, attendees: [{ attendee_provider_id: 'ACoMe' }, { attendee_provider_id: 'ACoJane' }],
});

describe('message action', () => {
  let e: TestEngine;
  beforeEach(async () => {
    e = await createTestEngine();
  });

  const replyAt = (iso: string) => [{ id: 'm1', isSender: false, timestamp: iso, text: 'Hey' }];
  const own = (id: string, iso: string, text: string) => ({ id, isSender: true, timestamp: iso, text });
  const methods = () => e.fake.calls.map((c) => c.method);
  const sends = () => e.fake.calls.filter((c) => c.method === 'sendMessage' || c.method === 'startChat');

  it('starts a chat for the first message and schedules follow-up 1 two days later', async () => {
    const lead = await seedLead(e.db, { status: 'accepted', providerId: 'ACoJane', firstName: 'Jane', sequenceStartedAt: SEQ });
    expect(await runMessageAction(e.deps, lead, 'first_message', e.settings)).toEqual({ leadId: lead.id, result: 'messaged' });
    expect(e.fake.calls).toEqual([{ method: 'findChatWithAttendee', args: ['ACoJane'] }, { method: 'startChat', args: ['ACoJane', 'Thanks Jane'] }]);
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'messaged', chatId: 'chat_ACoJane', nextActionAt: new Date('2026-11-19T09:00:00Z'), lastAction: 'first_message' });
    expect((await listEvents(e.db)).at(-1)).toMatchObject({ type: 'message_sent', payload: { step: 'first_message', text: 'Thanks Jane', dryRun: false } });
  });
  it('sends follow-up 1 in the existing chat and schedules follow-up 2 three days later', async () => {
    const lead = await seedLead(e.db, { status: 'messaged', providerId: 'ACoJane', firstName: 'Jane', chatId: 'chat_1', sequenceStartedAt: SEQ });
    await runMessageAction(e.deps, lead, 'followup_1', e.settings);
    expect(methods()).toEqual(['listChatMessages', 'sendMessage']);
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
    expect(methods()).toEqual(['listChatMessages']);
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
      { id: 'm5', isSender: false, timestamp: 'not-a-date', text: 'Garbled' }, // counts at now, so a parsed reply time wins
      { id: 'm4', isSender: false, timestamp: '2026-11-16T10:00:00Z', text: 'Still keen' },
      { id: 'm3', isSender: true, timestamp: '2026-11-15T09:00:00Z', text: 'Bump Jane' },
      { id: 'm2', isSender: false, timestamp: '2026-11-14T18:00:00Z', text: 'Sounds good' },
      { id: 'm1', isSender: false, timestamp: '2026-11-01T08:00:00Z', text: 'Old chat' },
    ]);
    expect(await runMessageAction(e.deps, lead, 'followup_2', e.settings)).toEqual({ leadId: lead.id, result: 'replied' });
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'replied', lastActionAt: new Date('2026-11-14T18:00:00Z'), updatedAt: NOW });
    // The read asks Unipile only for the messages since the sequence started.
    expect(e.fake.calls).toEqual([{ method: 'listChatMessages', args: ['chat_1', 50, SEQ] }]);
  });
  it('sends the follow-up when the only own message in the chat is the previous step itself', async () => {
    const lead = await seedLead(e.db, { status: 'messaged', providerId: 'ACoJane', firstName: 'Jane', chatId: 'chat_1', sequenceStartedAt: SEQ,
      lastAction: 'first_message', lastActionAt: FIRST_MESSAGE_AT });
    // LinkedIn stamped the first message a few seconds after the time the app recorded for it.
    e.fake.chatMessages.set('chat_1', [own('m1', '2026-11-15T09:00:20Z', 'Thanks Jane')]);
    expect((await runMessageAction(e.deps, lead, 'followup_1', e.settings)).result).toBe('messaged');
    expect(sends()).toEqual([{ method: 'sendMessage', args: ['chat_1', 'Bump Jane'] }]);
  });
  it('sends nothing when the reply check fails, and applies the error policy', async () => {
    const lead = await seedLead(e.db, { status: 'messaged', providerId: 'ACoJane', firstName: 'Jane', chatId: 'chat_1', sequenceStartedAt: SEQ });
    e.fake.failNext('listChatMessages', new UnipileError(503, null, 'down'));
    expect((await runMessageAction(e.deps, lead, 'followup_1', e.settings)).result).toBe('deferred');
    expect(methods()).toEqual(['listChatMessages']);
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'messaged', retryCount: 0 });
    expect((await listEvents(e.db)).map((x) => [x.type, x.payload])).toEqual([['action_failed', { kind: 'message', status: 503, type: null, message: 'down' }]]);
  });
  it('pauses the app at once, and leaves the lead as it is, when Unipile rejects the account', async () => {
    const lead = await seedLead(e.db, { status: 'messaged', providerId: 'ACoJane', firstName: 'Jane', chatId: 'chat_1', sequenceStartedAt: SEQ });
    e.fake.failNext('listChatMessages', new UnipileError(401, 'errors/disconnected_account', 'The account appears to be disconnected'));
    expect((await runMessageAction(e.deps, lead, 'followup_1', e.settings)).result).toBe('deferred');
    expect(sends()).toEqual([]);
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'messaged', retryCount: 0, failureReason: null, nextActionAt: lead.nextActionAt });
    expect(await getAppState(e.db)).toMatchObject({
      running: false,
      pauseReason: 'Auto-paused: Unipile rejected the account (errors/disconnected_account). Reconnect the LinkedIn account in Unipile, then press Start.',
      messagesPausedUntil: null,
    });
  });
  it('stops the first message when the lead answered the invite note', async () => {
    const lead = await seedLead(e.db, { status: 'accepted', providerId: 'ACoJane', firstName: 'Jane', chatId: 'chat_1', sequenceStartedAt: SEQ });
    e.fake.chatMessages.set('chat_1', replyAt('2026-11-17T08:00:00Z'));
    expect((await runMessageAction(e.deps, lead, 'first_message', e.settings)).result).toBe('replied');
    expect(methods()).toEqual(['listChatMessages']);
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'replied', nextActionAt: null, lastAction: 'reply_received', lastActionAt: new Date('2026-11-17T08:00:00Z') });
  });
  it('sends the first message in the chat that holds only our own invite note', async () => {
    const lead = await seedLead(e.db, { status: 'accepted', providerId: 'ACoJane', firstName: 'Jane', chatId: 'chat_1', inviteSentAt: SEQ, sequenceStartedAt: SEQ });
    e.fake.chatMessages.set('chat_1', [own('m1', '2026-11-10T09:00:05Z', 'Hi Jane from Acme')]);
    expect((await runMessageAction(e.deps, lead, 'first_message', e.settings)).result).toBe('messaged');
    expect(methods()).toEqual(['listChatMessages', 'sendMessage']);
    expect(e.fake.calls[1].args).toEqual(['chat_1', 'Thanks Jane']);
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'messaged', chatId: 'chat_1' });
  });
  it('counts a lead message with an unparsable timestamp as a reply, at now', async () => {
    const lead = await seedLead(e.db, { status: 'messaged', providerId: 'ACoJane', firstName: 'Jane', chatId: 'chat_1', sequenceStartedAt: SEQ });
    e.fake.chatMessages.set('chat_1', replyAt('not-a-date'));
    expect((await runMessageAction(e.deps, lead, 'followup_1', e.settings)).result).toBe('replied');
    expect(methods()).toEqual(['listChatMessages']);
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'replied', lastAction: 'reply_received', lastActionAt: NOW });
  });
  it('fails the lead instead of sending text that still contains {{', async () => {
    const lead = await seedLead(e.db, { status: 'accepted', providerId: 'ACoJane', firstName: 'Ja{{ne', sequenceStartedAt: SEQ });
    expect((await runMessageAction(e.deps, lead, 'first_message', e.settings)).result).toBe('failed');
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'failed', failureReason: 'invalid_template', failedFromStatus: 'accepted', lastAction: 'failed', lastActionAt: NOW });
    expect(sends()).toEqual([]);
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
    // The lookup is a read, so it reaches Unipile in a dry run too; no write does.
    expect(e.fake.calls).toEqual([{ method: 'findChatWithAttendee', args: ['ACoJane'] }]);
    expect((await getLead(e.db, lead.id)).chatId).toMatch(/^dry_/);
    expect((await listEvents(e.db)).at(-1)).toMatchObject({ type: 'message_sent', payload: { step: 'first_message', text: 'Thanks Jane', dryRun: true } });
  });

  describe('a send that Unipile accepted is never treated as failed', () => {
    it('counts a 201 without a message id as sent, once, and sends nothing on the next tick', async () => { // final review, probe 1
      const { client, requests } = unipileAnswering((method) =>
        method === 'POST'
          ? Response.json({ object: 'MessageSent', message_id: null }, { status: 201 })
          : Response.json({ object: 'MessageList', items: [], cursor: null }));
      e.deps.unipile = client;
      const lead = await seedLead(e.db, { status: 'messaged', providerId: 'ACoJane', firstName: 'Jane', chatId: 'chat_1', sequenceStartedAt: SEQ });

      expect((await runTick(e.deps)).action).toEqual({ leadId: lead.id, result: 'messaged' });
      expect((await runTick(e.deps)).action).toBeNull();

      expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1);
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'followup_1', retryCount: 0, failureReason: null, lastAction: 'followup_1' });
      expect((await listEvents(e.db)).map((x) => x.type)).toEqual(['message_sent']);
    });
    it('counts a new chat that came back without a chat id as sent, and leaves the chat unknown', async () => {
      const { client, requests } = unipileAnswering((method) =>
        method === 'POST'
          ? Response.json({ object: 'ChatStarted', chat_id: null, message_id: null }, { status: 201 })
          : Response.json({ object: 'ChatList', items: [], cursor: null }));
      e.deps.unipile = client;
      const lead = await seedLead(e.db, { status: 'accepted', providerId: 'ACoJane', firstName: 'Jane', sequenceStartedAt: SEQ });

      expect(await runMessageAction(e.deps, lead, 'first_message', e.settings)).toEqual({ leadId: lead.id, result: 'messaged' });

      expect(requests.map((r) => r.method)).toEqual(['GET', 'POST']);
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'messaged', chatId: null, failureReason: null, lastAction: 'first_message', nextActionAt: new Date('2026-11-19T09:00:00Z') });
      expect((await listEvents(e.db)).map((x) => x.type)).toEqual(['message_sent']);
    });
    it('finds the chat again for the follow-up of a lead whose first message left the chat unknown', async () => {
      const lead = await seedLead(e.db, { status: 'messaged', providerId: 'ACoJane', firstName: 'Jane', sequenceStartedAt: SEQ, lastAction: 'first_message', lastActionAt: FIRST_MESSAGE_AT });
      e.fake.chatByAttendee.set('ACoJane', 'chat_9');
      e.fake.chatMessages.set('chat_9', [own('m1', '2026-11-15T09:00:20Z', 'Thanks Jane')]);
      expect((await runMessageAction(e.deps, lead, 'followup_1', e.settings)).result).toBe('messaged');
      expect(sends()).toEqual([{ method: 'sendMessage', args: ['chat_9', 'Bump Jane'] }]);
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'followup_1', chatId: 'chat_9' });
    });
  });

  describe('the chat is read before every message', () => {
    it('records a follow-up that is already in the chat instead of sending it again', async () => {
      const lead = await seedLead(e.db, { status: 'messaged', providerId: 'ACoJane', firstName: 'Jane', chatId: 'chat_1', sequenceStartedAt: SEQ,
        lastAction: 'first_message', lastActionAt: FIRST_MESSAGE_AT, retryCount: 1 });
      await updateAppState(e.db, { consecutiveErrors: 2 });
      // LinkedIn may change the spacing of a message; the words are what is compared.
      e.fake.chatMessages.set('chat_1', [own('m2', '2026-11-17T08:55:00Z', ' Bump  Jane\n'), own('m1', '2026-11-15T09:00:20Z', 'Thanks Jane')]);

      expect(await runMessageAction(e.deps, lead, 'followup_1', e.settings)).toEqual({ leadId: lead.id, result: 'messaged' });

      expect(methods()).toEqual(['listChatMessages']);
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'followup_1', chatId: 'chat_1', lastAction: 'followup_1', lastActionAt: new Date('2026-11-17T08:55:00Z'),
        nextActionAt: new Date('2026-11-20T08:55:00Z'), retryCount: 0, updatedAt: NOW });
      expect((await listEvents(e.db)).map((x) => [x.type, x.leadId, x.createdAt, x.payload])).toEqual([
        ['message_sent', lead.id, NOW, { step: 'followup_1', text: 'Bump Jane', dryRun: false, recovered: true }],
      ]);
      expect((await getAppState(e.db)).consecutiveErrors).toBe(0);
    });
    it('records a first message that is already in the chat instead of sending it again', async () => {
      const lead = await seedLead(e.db, { status: 'accepted', providerId: 'ACoJane', firstName: 'Jane', chatId: 'chat_1', inviteSentAt: SEQ, sequenceStartedAt: SEQ,
        lastAction: 'accepted', lastActionAt: new Date('2026-11-17T07:00:00Z') });
      e.fake.chatMessages.set('chat_1', [own('m2', '2026-11-17T08:55:00Z', 'Thanks Jane'), own('m1', '2026-11-10T09:00:05Z', 'Hi Jane from Acme')]);

      expect((await runMessageAction(e.deps, lead, 'first_message', e.settings)).result).toBe('messaged');

      expect(methods()).toEqual(['listChatMessages']);
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'messaged', lastAction: 'first_message', lastActionAt: new Date('2026-11-17T08:55:00Z'), nextActionAt: new Date('2026-11-19T08:55:00Z') });
      expect((await listEvents(e.db)).map((x) => [x.type, x.payload])).toEqual([['message_sent', { step: 'first_message', text: 'Thanks Jane', dryRun: false, recovered: true }]]);
    });
    it('does not send a follow-up again when the database failed right after the send', async () => { // final review, probe 2
      const lead = await seedLead(e.db, { status: 'messaged', providerId: 'ACoJane', firstName: 'Jane', chatId: 'chat_1', sequenceStartedAt: SEQ,
        lastAction: 'first_message', lastActionAt: FIRST_MESSAGE_AT });
      e.fake.chatMessages.set('chat_1', [own('m1', '2026-11-15T09:00:20Z', 'Thanks Jane')]);
      const realDb = e.deps.db;
      let failNextInsert = false;
      // The message reaches the chat, then the first database write after it fails.
      e.fake.onCall('sendMessage', async () => {
        failNextInsert = true;
        e.fake.chatMessages.get('chat_1')?.unshift(own('m2', NOW.toISOString(), 'Bump Jane'));
      });
      e.deps.db = new Proxy(realDb, {
        get(target, prop, receiver) {
          if (prop === 'insert' && failNextInsert) {
            failNextInsert = false;
            return () => { throw new Error('neon: fetch failed'); };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      await expect(runTick(e.deps)).rejects.toThrow('neon: fetch failed');
      e.deps.db = realDb;
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'messaged', lastAction: 'first_message' });

      expect((await runTick(e.deps)).action).toEqual({ leadId: lead.id, result: 'messaged' });

      expect(sends()).toEqual([{ method: 'sendMessage', args: ['chat_1', 'Bump Jane'] }]);
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'followup_1', lastAction: 'followup_1', lastActionAt: NOW, nextActionAt: new Date('2026-11-20T09:00:00Z') });
      expect((await listEvents(e.db)).map((x) => [x.type, x.payload])).toEqual([['message_sent', { step: 'followup_1', text: 'Bump Jane', dryRun: false, recovered: true }]]);
    });
    it('does not send a follow-up again when the webhook recorded its lost send as a manual message', async () => {
      const lead = await seedLead(e.db, { status: 'messaged', providerId: 'ACoJane', firstName: 'Jane', chatId: 'chat_1', sequenceStartedAt: SEQ,
        lastAction: 'first_message', lastActionAt: FIRST_MESSAGE_AT });
      // The follow-up went out at NOW, its record was lost, and Unipile then reported the message by webhook.
      e.fake.chatMessages.set('chat_1', [own('m2', NOW.toISOString(), 'Bump Jane'), own('m1', '2026-11-15T09:00:20Z', 'Thanks Jane')]);
      const echo = await processWebhook(e.db, ownerMessageWebhook(NOW.toISOString(), 'm2'), { accountId: 'acc_1', now: new Date(NOW.getTime() + 3000), random: () => 0.5 });
      expect(echo.outcome).toBe('manual_message');
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'messaged', lastAction: 'manual_message', lastActionAt: NOW, nextActionAt: new Date('2026-11-19T09:00:00Z') });

      // Two days later the same follow-up is due again.
      e.setNow(new Date('2026-11-19T09:00:00Z'));
      expect((await runTick(e.deps)).action).toEqual({ leadId: lead.id, result: 'messaged' });

      expect(sends()).toEqual([]);
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'followup_1', lastAction: 'followup_1', lastActionAt: NOW, nextActionAt: new Date('2026-11-20T09:00:00Z') });
    });
    it('still sends the follow-up after a real manual message, once its timer ran out', async () => {
      const manualAt = new Date('2026-11-15T12:00:00Z');
      const lead = await seedLead(e.db, { status: 'messaged', providerId: 'ACoJane', firstName: 'Jane', chatId: 'chat_1', sequenceStartedAt: SEQ,
        lastAction: 'manual_message', lastActionAt: manualAt });
      e.fake.chatMessages.set('chat_1', [own('m2', manualAt.toISOString(), 'One more thing, Jane'), own('m1', '2026-11-15T09:00:20Z', 'Thanks Jane')]);
      expect((await runMessageAction(e.deps, lead, 'followup_1', e.settings)).result).toBe('messaged');
      expect(sends()).toEqual([{ method: 'sendMessage', args: ['chat_1', 'Bump Jane'] }]);
    });
    it('stops the first message when the owner wrote by hand before the acceptance was recorded', async () => { // final review, probe 4
      const opts = { accountId: 'acc_1', random: () => 0.5 };
      const lead = await seedLead(e.db, { status: 'invite_sent', slug: 'jane-doe', providerId: 'ACoJane', firstName: 'Jane', company: 'Acme', inviteSentAt: SEQ,
        sequenceStartedAt: SEQ, lastAction: 'invite_sent', lastActionAt: SEQ, nextActionAt: new Date('2026-12-01T09:00:00Z') });
      // Saturday evening: the invite is accepted, so its note shows up in a chat. Sunday: the owner writes by hand.
      const note = await processWebhook(e.db, ownerMessageWebhook('2026-11-14T19:00:00.000Z', 'note'), { ...opts, now: new Date('2026-11-14T19:00:05Z') });
      const manual = await processWebhook(e.db, ownerMessageWebhook('2026-11-15T10:00:00.000Z', 'manual'), { ...opts, now: new Date('2026-11-15T10:00:05Z') });
      expect([note.outcome, manual.outcome]).toEqual(['acceptance_check', 'acceptance_check']);
      // Monday morning: the tick confirms the acceptance.
      e.setNow(new Date('2026-11-16T08:00:00Z'));
      e.fake.profiles.set('ACoJane', makeProfile({ networkDistance: 'FIRST_DEGREE' }));
      await runAcceptanceChecks(e.deps, e.settings, 3);
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'accepted', chatId: 'chat_1', nextActionAt: new Date('2026-11-16T10:00:00Z') });
      e.fake.chatMessages.set('chat_1', [
        own('manual', '2026-11-15T10:00:00.000Z', 'Hi Jane, great to connect - quick question about Acme...'),
        own('note', '2026-11-14T19:00:00.000Z', 'Hi Jane from Acme'),
      ]);

      e.setNow(new Date('2026-11-16T11:30:00Z'));
      expect((await runTick(e.deps)).action).toEqual({ leadId: lead.id, result: 'superseded' });

      expect(sends()).toEqual([]);
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'messaged', lastAction: 'manual_message', lastActionAt: new Date('2026-11-15T10:00:00Z'),
        nextActionAt: new Date('2026-11-17T10:00:00Z'), updatedAt: new Date('2026-11-16T11:30:00Z') });
      expect((await listEvents(e.db)).filter((x) => x.type === 'message_sent')).toEqual([]);
    });
    it('counts a message the owner wrote to an existing connection as the first message', async () => {
      const lead = await seedLead(e.db, { status: 'already_connected', providerId: 'ACoJane', firstName: 'Jane', sequenceStartedAt: SEQ, lastAction: 'already_connected', lastActionAt: SEQ });
      e.fake.chatByAttendee.set('ACoJane', 'chat_9');
      e.fake.chatMessages.set('chat_9', [own('m2', '2026-11-10T09:03:00Z', 'Hi Jane, long time'), own('m1', '2026-10-01T09:00:00Z', 'Happy birthday')]);
      expect((await runMessageAction(e.deps, lead, 'first_message', e.settings)).result).toBe('superseded');
      expect(sends()).toEqual([]);
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'messaged', chatId: 'chat_9', lastAction: 'manual_message', lastActionAt: new Date('2026-11-10T09:03:00Z'),
        nextActionAt: new Date('2026-11-12T09:03:00Z') });
    });
    it('resets the follow-up timer on a hand-written message that no webhook reported', async () => {
      const lead = await seedLead(e.db, { status: 'followup_1', providerId: 'ACoJane', firstName: 'Jane', chatId: 'chat_1', sequenceStartedAt: SEQ,
        lastAction: 'followup_1', lastActionAt: FIRST_MESSAGE_AT, retryCount: 1 });
      e.fake.chatMessages.set('chat_1', [own('m3', '2026-11-16T10:00:00Z', 'Also, Jane'), own('m2', '2026-11-16T09:00:00Z', 'By the way'), own('m1', '2026-11-15T09:00:20Z', 'Bump Jane')]);
      expect(await runMessageAction(e.deps, lead, 'followup_2', e.settings)).toEqual({ leadId: lead.id, result: 'superseded' });
      expect(sends()).toEqual([]);
      // The newest hand-written message restarts the wait for follow-up 2: three days.
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'followup_1', lastAction: 'manual_message', lastActionAt: new Date('2026-11-16T10:00:00Z'),
        nextActionAt: new Date('2026-11-19T10:00:00Z'), updatedAt: NOW });
    });
    it('sends nothing when an own message has no readable time or the lead has no recorded action', async () => {
      const undated = await seedLead(e.db, { status: 'messaged', providerId: 'ACoJane', firstName: 'Jane', chatId: 'chat_1', sequenceStartedAt: SEQ,
        lastAction: 'first_message', lastActionAt: FIRST_MESSAGE_AT });
      e.fake.chatMessages.set('chat_1', [own('m1', 'not-a-date', 'Hello again')]);
      expect((await runMessageAction(e.deps, undated, 'followup_1', e.settings)).result).toBe('superseded');
      expect(await getLead(e.db, undated.id)).toMatchObject({ status: 'messaged', lastAction: 'manual_message', lastActionAt: NOW });

      const unrecorded = await seedLead(e.db, { status: 'messaged', providerId: 'ACoBob', firstName: 'Bob', chatId: 'chat_2', sequenceStartedAt: SEQ });
      e.fake.chatMessages.set('chat_2', [own('m1', '2026-11-15T09:00:00Z', 'Thanks Bob')]);
      expect((await runMessageAction(e.deps, unrecorded, 'followup_1', e.settings)).result).toBe('superseded');
      expect(await getLead(e.db, unrecorded.id)).toMatchObject({ status: 'messaged', lastAction: 'manual_message', lastActionAt: new Date('2026-11-15T09:00:00Z') });
      expect(sends()).toEqual([]);
    });
    it('looks the chat up for a lead that has none, and stops on a reply found there', async () => {
      const lead = await seedLead(e.db, { status: 'accepted', providerId: 'ACoJane', firstName: 'Jane', inviteSentAt: SEQ, sequenceStartedAt: SEQ });
      e.fake.chatByAttendee.set('ACoJane', 'chat_9');
      e.fake.chatMessages.set('chat_9', [...replyAt('2026-11-17T08:00:00Z'), own('note', '2026-11-10T09:00:05Z', 'Hi Jane from Acme')]);
      expect(await runMessageAction(e.deps, lead, 'first_message', e.settings)).toEqual({ leadId: lead.id, result: 'replied' });
      expect(e.fake.calls).toEqual([{ method: 'findChatWithAttendee', args: ['ACoJane'] }, { method: 'listChatMessages', args: ['chat_9', 50, SEQ] }]);
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'replied', chatId: 'chat_9', nextActionAt: null, lastAction: 'reply_received', lastActionAt: new Date('2026-11-17T08:00:00Z') });
    });
    it('sends the first message into the looked-up chat that holds only the invite note', async () => {
      const lead = await seedLead(e.db, { status: 'accepted', providerId: 'ACoJane', firstName: 'Jane', inviteSentAt: SEQ, sequenceStartedAt: SEQ });
      e.fake.chatByAttendee.set('ACoJane', 'chat_9');
      e.fake.chatMessages.set('chat_9', [own('note', '2026-11-10T09:00:05Z', 'Hi Jane from Acme')]);
      expect((await runMessageAction(e.deps, lead, 'first_message', e.settings)).result).toBe('messaged');
      expect(e.fake.calls).toEqual([
        { method: 'findChatWithAttendee', args: ['ACoJane'] },
        { method: 'listChatMessages', args: ['chat_9', 50, SEQ] },
        { method: 'sendMessage', args: ['chat_9', 'Thanks Jane'] },
      ]);
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'messaged', chatId: 'chat_9' });
    });
    it('keeps the looked-up chat and sends nothing when reading it fails', async () => {
      const lead = await seedLead(e.db, { status: 'accepted', providerId: 'ACoJane', firstName: 'Jane', sequenceStartedAt: SEQ });
      e.fake.chatByAttendee.set('ACoJane', 'chat_9');
      e.fake.failNext('listChatMessages', new UnipileError(503, null, 'down'));
      expect((await runMessageAction(e.deps, lead, 'first_message', e.settings)).result).toBe('deferred');
      expect(sends()).toEqual([]);
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'accepted', chatId: 'chat_9', updatedAt: NOW });
    });
    it('sends nothing when the chat lookup fails, and applies the error policy', async () => {
      const lead = await seedLead(e.db, { status: 'accepted', providerId: 'ACoJane', firstName: 'Jane', sequenceStartedAt: SEQ });
      e.fake.failNext('findChatWithAttendee', new UnipileError(503, null, 'down'));
      expect((await runMessageAction(e.deps, lead, 'first_message', e.settings)).result).toBe('deferred');
      expect(methods()).toEqual(['findChatWithAttendee']);
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'accepted', chatId: null });
      expect((await listEvents(e.db)).map((x) => [x.type, x.payload])).toEqual([['action_failed', { kind: 'message', status: 503, type: null, message: 'down' }]]);
    });
    it('leaves a lead that a webhook changed during the chat lookup alone', async () => {
      const lead = await seedLead(e.db, { status: 'accepted', providerId: 'ACoJane', firstName: 'Jane', sequenceStartedAt: SEQ });
      e.fake.chatByAttendee.set('ACoJane', 'chat_9');
      e.fake.onCall('findChatWithAttendee', async () => { await e.db.update(leads).set({ status: 'replied' }).where(eq(leads.id, lead.id)); });
      expect((await runMessageAction(e.deps, lead, 'first_message', e.settings)).result).toBe('superseded');
      expect(methods()).toEqual(['findChatWithAttendee']);
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'replied', chatId: null });
    });
    it('in a dry run, reads the real chat but leaves a dry-run chat id, so the lead never continues for real', async () => {
      e = await createTestEngine({ dryRun: true });
      const lead = await seedLead(e.db, { status: 'already_connected', providerId: 'ACoJane', firstName: 'Jane', sequenceStartedAt: SEQ });
      e.fake.chatByAttendee.set('ACoJane', 'chat_9');
      expect((await runMessageAction(e.deps, lead, 'first_message', e.settings)).result).toBe('messaged');
      expect(e.fake.calls).toEqual([{ method: 'findChatWithAttendee', args: ['ACoJane'] }, { method: 'listChatMessages', args: ['chat_9', 50, SEQ] }]);
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'messaged', chatId: 'dry_chat_9' });
    });
  });

  describe('an AI lead, whose drafts are approved', () => {
    const DRAFT = 'Thanks for connecting, Jane. How is the Rust hire going?';
    const accepted = (patch: Parameters<typeof seedLead>[1] = {}) =>
      seedLead(e.db, { status: 'accepted', providerId: 'ACoJane', firstName: 'Jane', sequenceStartedAt: SEQ, draftStatus: 'approved',
        inviteNoteDraft: 'Hi Jane', firstMessageDraft: DRAFT, ...patch });

    it('sends the approved first message as written', async () => {
      // The seeded lead has no headline, so this template could not render for it.
      e = await createTestEngine({ templates: { firstMessage: 'About {{headline}}' } });
      const lead = await accepted();
      expect((await runMessageAction(e.deps, lead, 'first_message', e.settings)).result).toBe('messaged');
      expect(sends()).toEqual([{ method: 'startChat', args: ['ACoJane', DRAFT] }]);
      expect((await listEvents(e.db)).at(-1)).toMatchObject({ type: 'message_sent', payload: { step: 'first_message', text: DRAFT, dryRun: false } });
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'messaged', lastAction: 'first_message', updatedAt: NOW });
    });
    it('records a first message draft that is already in the chat instead of sending it again', async () => {
      const lead = await accepted({ chatId: 'chat_1', inviteSentAt: SEQ });
      e.fake.chatMessages.set('chat_1', [own('m2', '2026-11-17T08:55:00Z', ` ${DRAFT.replace(' How', '\n How')} `), own('m1', '2026-11-10T09:00:05Z', 'Hi Jane')]);
      expect((await runMessageAction(e.deps, lead, 'first_message', e.settings)).result).toBe('messaged');
      expect(methods()).toEqual(['listChatMessages']);
      expect((await listEvents(e.db)).map((x) => [x.type, x.payload])).toEqual([['message_sent', { step: 'first_message', text: DRAFT, dryRun: false, recovered: true }]]);
    });
    it('treats the rendered first-message template in the chat as a manual message, not as the draft', async () => {
      const lead = await accepted({ chatId: 'chat_1', inviteSentAt: SEQ });
      e.fake.chatMessages.set('chat_1', [own('m2', '2026-11-17T08:55:00Z', 'Thanks Jane'), own('m1', '2026-11-10T09:00:05Z', 'Hi Jane')]);
      expect((await runMessageAction(e.deps, lead, 'first_message', e.settings)).result).toBe('superseded');
      expect(sends()).toEqual([]);
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'messaged', lastAction: 'manual_message' });
    });
    it.each([null, '  '])('fails with missing_draft and sends nothing when the first message draft is %j', async (draft) => {
      const lead = await accepted({ firstMessageDraft: draft });
      expect((await runMessageAction(e.deps, lead, 'first_message', e.settings)).result).toBe('failed');
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'failed', failureReason: 'missing_draft', failedFromStatus: 'accepted', updatedAt: NOW });
      expect(sends()).toEqual([]);
    });
    it('fails a first message draft that holds a raw tag', async () => {
      const lead = await accepted({ firstMessageDraft: 'Thanks {{first_name}}' });
      await runMessageAction(e.deps, lead, 'first_message', e.settings);
      expect((await getLead(e.db, lead.id)).failureReason).toBe('invalid_template');
      expect(sends()).toEqual([]);
    });
    it.each(['ready', 'pending'] as const)('fails with draft_not_approved and sends nothing when an accepted founder\'s drafts are %s', async (draftStatus) => {
      const lead = await accepted({ draftStatus });
      expect((await runMessageAction(e.deps, lead, 'first_message', e.settings)).result).toBe('failed');
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'failed', failureReason: 'draft_not_approved', failedFromStatus: 'accepted', updatedAt: NOW });
      expect(sends()).toEqual([]);
      expect((await listEvents(e.db)).filter((x) => x.type === 'message_sent')).toEqual([]);
    });
    it('sends follow-up 1 from the template', async () => {
      const lead = await accepted({ status: 'messaged', chatId: 'chat_1' });
      await runMessageAction(e.deps, lead, 'followup_1', e.settings);
      expect(sends()).toEqual([{ method: 'sendMessage', args: ['chat_1', 'Bump Jane'] }]);
    });
  });
});
