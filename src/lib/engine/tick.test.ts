import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { leads, settingsTable } from '@/db/schema';
import { saveSettings } from '@/lib/settings/repo';
import { UnipileError } from '@/lib/unipile/errors';
import { createTestEngine, getLead, listEvents, NOW, seedEvents, seedLead, type TestEngine } from '@/test-utils/engine';
import { makeProfile } from '@/test-utils/fake-unipile';
import { acquireTickLock, getAppState, setRunning, updateAppState } from './state';
import { runTick, TICK_LEASE_MS } from './tick';

describe('tick', () => {
  let e: TestEngine;
  beforeEach(async () => {
    e = await createTestEngine();
    e.fake.profiles.set('jane-doe', makeProfile());
  });

  const queued = () => seedLead(e.db, { slug: 'jane-doe' });
  const acceptedDue = () => seedLead(e.db, { status: 'accepted', providerId: 'ACoBob', firstName: 'Bob', sequenceStartedAt: NOW });
  const methods = () => e.fake.calls.map((c) => c.method);

  it('skips while another tick holds the lock', async () => {
    await acquireTickLock(e.db, NOW, TICK_LEASE_MS); await queued();
    expect(await runTick(e.deps)).toEqual({ status: 'locked', finished: 0, action: null });
    expect(methods()).toEqual([]);
  });
  it('does nothing while paused', async () => {
    await setRunning(e.db, false); const lead = await seedLead(e.db, { status: 'followup_2' });
    expect((await runTick(e.deps)).status).toBe('paused');
    expect((await getLead(e.db, lead.id)).status).toBe('followup_2');
  });
  it('outside the active window only finishes due leads', async () => {
    e.setNow(new Date('2026-11-21T10:00:00Z')); await queued(); await seedLead(e.db, { status: 'followup_2' });
    expect(await runTick(e.deps)).toEqual({ status: 'outside_window', finished: 1, action: null });
    expect(methods()).toEqual([]);
  });
  it('sends a due message before a queued invite, after a random wait', async () => {
    await acceptedDue(); await queued();
    expect((await runTick(e.deps)).action?.result).toBe('messaged');
    expect(methods()).toEqual(['findChatWithAttendee', 'startChat']);
    expect(e.sleeps).toEqual([45_000]);
  });
  it('falls back to an invite once 90 messages were sent today', async () => {
    await seedEvents(e.db, 'message_sent', 90, new Date('2026-11-17T08:00:00Z')); await acceptedDue(); await queued();
    expect((await runTick(e.deps)).action?.result).toBe('invited');
  });
  it.each([
    ['35 invites today', 'invite_sent', 35, '2026-11-17T08:00:00Z'],
    ['190 invites in the last 7 days', 'invite_sent', 190, '2026-11-13T09:00:00Z'],
    ['90 profile views today', 'profile_view', 90, '2026-11-17T08:00:00Z'],
  ] as const)('sends no invite after %s', async (_label, type, count, at) => {
    await seedEvents(e.db, type, count, new Date(at)); await queued();
    expect((await runTick(e.deps)).action).toBeNull();
    expect(methods()).toEqual([]);
  });
  it('sends no invite while invites are paused, and never picks a paused lead', async () => {
    await updateAppState(e.db, { invitesPausedUntil: new Date('2026-11-17T10:00:00Z') }); await queued();
    expect((await runTick(e.deps)).action).toBeNull();
    await updateAppState(e.db, { invitesPausedUntil: null }); await e.db.update(leads).set({ paused: true });
    expect((await runTick(e.deps)).action).toBeNull();
  });
  it('sends nothing when the lead replied during the random wait', async () => {
    const lead = await acceptedDue();
    e.deps.sleep = async () => { await e.db.update(leads).set({ status: 'replied' }).where(eq(leads.id, lead.id)); };
    expect((await runTick(e.deps)).action).toEqual({ leadId: lead.id, result: 'superseded' });
    expect(methods()).toEqual([]);
  });
  it('sends nothing when the lead was paused during the random wait', async () => {
    const lead = await acceptedDue();
    e.deps.sleep = async () => { await e.db.update(leads).set({ paused: true }).where(eq(leads.id, lead.id)); };
    expect((await runTick(e.deps)).action).toEqual({ leadId: lead.id, result: 'superseded' });
    expect(methods()).toEqual([]);
    expect((await getLead(e.db, lead.id)).status).toBe('accepted');
  });
  it('sends nothing when a manual message moved the follow-up during the random wait', async () => {
    const lead = await seedLead(e.db, { status: 'messaged', providerId: 'ACoBob', firstName: 'Bob', chatId: 'chat_ACoBob', sequenceStartedAt: NOW });
    e.deps.sleep = async () => { await e.db.update(leads).set({ nextActionAt: new Date('2026-11-19T09:00:00Z') }).where(eq(leads.id, lead.id)); };
    expect((await runTick(e.deps)).action).toEqual({ leadId: lead.id, result: 'superseded' });
    expect(methods()).toEqual([]);
  });
  it('sends nothing when the app was paused during the random wait', async () => {
    await acceptedDue();
    e.deps.sleep = async () => { await setRunning(e.db, false); };
    expect(await runTick(e.deps)).toMatchObject({ status: 'paused', action: null });
    expect(methods()).toEqual([]);
  });
  it('uses the templates saved during the random wait', async () => {
    await acceptedDue();
    e.deps.sleep = async () => { await saveSettings(e.db, { ...e.settings, templates: { ...e.settings.templates, firstMessage: 'Hello {{first_name}}' } }); };
    await runTick(e.deps);
    expect(e.fake.calls.at(-1)).toEqual({ method: 'startChat', args: ['ACoBob', 'Hello Bob'] });
  });
  it('sends nothing when the active window closed during the random wait', async () => {
    e.setNow(new Date('2026-11-17T17:59:30Z')); await acceptedDue();
    e.deps.sleep = async () => { e.setNow(new Date('2026-11-17T18:00:30Z')); };
    expect((await runTick(e.deps)).action).toBeNull();
    expect(methods()).toEqual([]);
  });
  it('skips the outreach action when housekeeping used up the time budget', async () => {
    await seedLead(e.db, { status: 'invite_sent', providerId: 'ACoSlow', acceptanceCheckPending: true, inviteSentAt: NOW, nextActionAt: new Date('2026-12-08T09:00:00Z') });
    e.fake.profiles.set('ACoSlow', makeProfile({ providerId: 'ACoSlow' }));
    await updateAppState(e.db, { nextInvitePollAt: new Date(NOW.getTime() + 3_600_000) });
    e.fake.onCall('getProfile', async () => { e.setNow(new Date(NOW.getTime() + 31_000)); });
    await acceptedDue();
    expect((await runTick(e.deps)).action).toBeNull();
    expect(methods()).toEqual(['getProfile']);
  });
  it('waits at most 100 seconds, even when a longer wait is stored', async () => {
    // A row written before the 100-second rule existed, or by hand: `saveSettings` would refuse it.
    await e.db.update(settingsTable).set({ value: { ...e.settings, caps: { ...e.settings.caps, jitterMaxSeconds: 300 } } });
    await acceptedDue();
    expect((await runTick(e.deps)).action?.result).toBe('messaged');
    expect(e.sleeps).toEqual([50_000]);
  });
  it('cuts the random wait short after slow housekeeping, so the action still starts in time', async () => {
    e = await createTestEngine({ random: 0.99, settings: (s) => ({ ...s, caps: { ...s.caps, jitterMaxSeconds: 100 } }) });
    await seedLead(e.db, { status: 'invite_sent', providerId: 'ACoSlow', acceptanceCheckPending: true, inviteSentAt: NOW, nextActionAt: new Date('2026-12-08T09:00:00Z') });
    e.fake.profiles.set('ACoSlow', makeProfile({ providerId: 'ACoSlow' }));
    await updateAppState(e.db, { nextInvitePollAt: new Date(NOW.getTime() + 3_600_000) });
    // Housekeeping takes 25 s: inside its own budget, but a 99 s wait would start the action 124 s into the tick.
    e.fake.onCall('getProfile', async () => { e.setNow(new Date(NOW.getTime() + 25_000)); });
    await acceptedDue();
    expect((await runTick(e.deps)).action?.result).toBe('messaged');
    expect(e.sleeps).toEqual([85_000]);
  });
  it('runs the action on the lead as it is after the random wait', async () => {
    const lead = await acceptedDue();
    e.deps.sleep = async () => { await e.db.update(leads).set({ firstName: 'Robert' }).where(eq(leads.id, lead.id)); };
    expect((await runTick(e.deps)).action).toEqual({ leadId: lead.id, result: 'messaged' });
    expect(e.fake.calls.at(-1)).toEqual({ method: 'startChat', args: ['ACoBob', 'Thanks Robert'] });
  });
  it('auto-pauses after three 5xx errors in a row and keeps the lead queued', async () => { // Review Focus 3
    const lead = await queued();
    for (let i = 0; i < 3; i++) e.fake.failNext('getProfile', new UnipileError(503, null, 'down'));
    for (let i = 0; i < 3; i++) await runTick(e.deps);
    expect(await getAppState(e.db)).toMatchObject({ running: false, consecutiveErrors: 3 });
    expect((await getLead(e.db, lead.id)).status).toBe('queued');
    expect((await runTick(e.deps)).status).toBe('paused');
  });
  it('pauses at once on a disconnected account and leaves the lead queued', async () => { // final review, probe 3
    const lead = await queued();
    for (let i = 0; i < 2; i++) e.fake.failNext('getProfile', new UnipileError(401, 'errors/disconnected_account', 'The account appears to be disconnected'));
    expect((await runTick(e.deps)).action).toEqual({ leadId: lead.id, result: 'deferred' });
    expect(await runTick(e.deps)).toEqual({ status: 'paused', finished: 0, action: null });
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'queued', retryCount: 0, failureReason: null });
    expect(await getAppState(e.db)).toMatchObject({
      running: false,
      pauseReason: 'Auto-paused: Unipile rejected the account (errors/disconnected_account). Reconnect the LinkedIn account in Unipile, then press Start.',
      consecutiveErrors: 0,
    });
    // The second tick found the app paused and called nothing.
    expect(methods()).toEqual(['getProfile']);
  });
  it('pauses after five leads in a row failed, and fails no sixth', async () => {
    const ghosts = [];
    for (let i = 0; i < 6; i++) ghosts.push(await seedLead(e.db));
    for (let i = 0; i < 5; i++) expect((await runTick(e.deps)).action?.result).toBe('failed');
    expect(await getAppState(e.db)).toMatchObject({ running: false, pauseReason: 'Auto-paused: 5 actions failed in a row with no successful send.' });
    expect((await runTick(e.deps)).status).toBe('paused');
    const statuses = await Promise.all(ghosts.map(async (ghost) => (await getLead(e.db, ghost.id)).status));
    expect(statuses.filter((status) => status === 'failed')).toHaveLength(5);
    expect(statuses.filter((status) => status === 'queued')).toHaveLength(1);
  });
  it('resets the error streak after a successful send', async () => {
    await queued(); e.fake.failNext('getProfile', new UnipileError(503, null, '')); e.fake.failNext('getProfile', new UnipileError(503, null, ''));
    for (let i = 0; i < 3; i++) await runTick(e.deps);
    expect(await getAppState(e.db)).toMatchObject({ running: true, consecutiveErrors: 0 });
  });
  it('in dry run, calls no write endpoint and logs the text', async () => {
    e = await createTestEngine({ dryRun: true }); e.fake.profiles.set('jane-doe', makeProfile()); const lead = await queued();
    await runTick(e.deps);
    expect(methods()).toEqual(['getProfile']);
    expect((await getLead(e.db, lead.id)).status).toBe('invite_sent');
    expect((await listEvents(e.db)).at(-1)).toMatchObject({ type: 'invite_sent', payload: { dryRun: true, text: 'Hi Jane from Acme' } });
  });
  it('releases the lock when an action throws unexpectedly', async () => {
    const lead = await queued(); e.fake.failNext('getProfile', new TypeError('bug'));
    await runTick(e.deps);
    expect(await acquireTickLock(e.db, NOW, TICK_LEASE_MS)).toBe(true);
    expect((await getLead(e.db, lead.id)).retryCount).toBe(1);
  });

  // Beyond the brief's list: orders and guards that the tests above do not reach.
  it('falls back to an invite while messages are paused', async () => {
    await updateAppState(e.db, { messagesPausedUntil: new Date('2026-11-17T10:00:00Z') }); await acceptedDue(); await queued();
    expect((await runTick(e.deps)).action?.result).toBe('invited');
  });
  it('picks no lead that is not due yet, and then does not wait', async () => {
    const later = new Date('2026-11-17T10:00:00Z');
    await seedLead(e.db, { status: 'accepted', providerId: 'ACoBob', nextActionAt: later }); await seedLead(e.db, { slug: 'jane-doe', nextActionAt: later });
    expect(await runTick(e.deps)).toEqual({ status: 'done', finished: 0, action: null });
    expect(methods()).toEqual([]);
    expect(e.sleeps).toEqual([]);
  });
  it('stops before the outreach action when housekeeping auto-pauses', async () => {
    await updateAppState(e.db, { consecutiveErrors: 2, nextInvitePollAt: new Date('2026-11-17T12:00:00Z') });
    await seedLead(e.db, { status: 'invite_sent', providerId: 'ACoAnn', acceptanceCheckPending: true, nextActionAt: new Date('2026-12-08T09:00:00Z') });
    await queued(); e.fake.failNext('getProfile', new UnipileError(503, null, 'down'));
    expect(await runTick(e.deps)).toEqual({ status: 'paused', finished: 0, action: null });
    expect(e.fake.calls).toEqual([{ method: 'getProfile', args: ['ACoAnn'] }]);
    expect(e.sleeps).toEqual([]);
  });
  it('leaves the lock alone when another tick took it after its own lease ran out', async () => {
    await acceptedDue();
    const later = new Date(NOW.getTime() + TICK_LEASE_MS + 1000);
    // The wait outlives the lease, which cannot happen while the function is killed first: a second tick takes over.
    e.deps.sleep = async () => {
      e.setNow(later);
      expect(await acquireTickLock(e.db, later, TICK_LEASE_MS)).toBe(true);
    };
    await runTick(e.deps);
    expect((await getAppState(e.db)).tickLockUntil).toEqual(new Date(later.getTime() + TICK_LEASE_MS));
  });
  it('releases the lock when the tick itself throws', async () => {
    await queued();
    e.deps.sleep = async () => { throw new Error('boom'); };
    await expect(runTick(e.deps)).rejects.toThrow('boom');
    expect(await acquireTickLock(e.db, NOW, TICK_LEASE_MS)).toBe(true);
  });
});
