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
  it('stops before the outreach action when housekeeping meets an account error', async () => {
    await updateAppState(e.db, { nextInvitePollAt: new Date('2026-11-17T12:00:00Z') });
    const flagged = await seedLead(e.db, { status: 'invite_sent', providerId: 'ACoAnn', acceptanceCheckPending: true, nextActionAt: new Date('2026-12-08T09:00:00Z') });
    const lead = await queued();
    e.fake.failNext('getProfile', new UnipileError(403, 'errors/account_restricted', 'Restricted'));
    expect(await runTick(e.deps)).toEqual({ status: 'paused', finished: 0, action: null });
    expect(e.fake.calls).toEqual([{ method: 'getProfile', args: ['ACoAnn'] }]);
    expect(e.sleeps).toEqual([]);
    expect((await getLead(e.db, flagged.id)).acceptanceCheckPending).toBe(true);
    expect((await getLead(e.db, lead.id)).status).toBe('queued');
    expect((await getAppState(e.db)).pauseReason).toBe(
      'Auto-paused: Unipile rejected the account (errors/account_restricted). Reconnect the LinkedIn account in Unipile, then press Start.',
    );
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

describe('tick with spacing on', () => {
  let e: TestEngine;
  beforeEach(async () => {
    e = await createTestEngine({ settings: (s) => ({ ...s, pacing: { minGapMinutes: 4, maxGapMinutes: 45, dayStartJitterMinutes: 45, followupJitterMinutes: 0 } }) });
  });

  const acceptedDue = () => seedLead(e.db, { status: 'accepted', providerId: 'ACoBob', firstName: 'Bob', sequenceStartedAt: NOW });
  const methods = () => e.fake.calls.map((c) => c.method);
  const at = (ms: number) => new Date(NOW.getTime() + ms);

  it('sends nothing before the planned moment', async () => {
    await updateAppState(e.db, { nextOutreachAt: at(10 * 60_000) }); await acceptedDue();
    expect((await runTick(e.deps)).action).toBeNull();
    expect(methods()).toEqual([]); expect(e.sleeps).toEqual([]);
  });
  it('waits until the planned second, then sends', async () => {
    await updateAppState(e.db, { nextOutreachAt: at(40_000) }); await acceptedDue();
    expect((await runTick(e.deps)).action?.result).toBe('messaged');
    expect(e.sleeps).toEqual([40_000]);
  });
  it('uses the random wait when the planned moment has passed', async () => {
    await updateAppState(e.db, { nextOutreachAt: at(-60_000) }); await acceptedDue();
    await runTick(e.deps);
    expect(e.sleeps).toEqual([45_000]);
  });
  it('plans the next send a random pause later, spread over the rest of the day', async () => {
    await updateAppState(e.db, { nextOutreachAt: NOW }); await acceptedDue();
    for (let i = 0; i < 36; i++) await seedLead(e.db, { slug: `queued-${i}` });
    await runTick(e.deps);
    // 9 hours are left (the window closes at 18:00Z); 35 invites are planned (the daily cap), no other message is due.
    const expected = Math.round(((9 * 60 * 60_000) / 35) * (0.5 + 0.5));
    expect((await getAppState(e.db)).nextOutreachAt).toEqual(at(expected));
  });
  it('keeps the longest average pause when little is planned', async () => {
    await updateAppState(e.db, { nextOutreachAt: NOW }); await acceptedDue();
    await runTick(e.deps);
    expect((await getAppState(e.db)).nextOutreachAt).toEqual(at(45 * 60_000));
  });
  it('starts the day at a random moment and sends nothing before it', async () => {
    e.setNow(new Date('2026-11-17T07:31:00Z')); await acceptedDue();
    expect((await runTick(e.deps)).action).toBeNull();
    expect((await getAppState(e.db)).nextOutreachAt).toEqual(new Date('2026-11-17T07:52:30Z'));
    expect(methods()).toEqual([]);
  });
  it('starts within two minutes when the app is started during the day', async () => {
    await acceptedDue();
    expect((await runTick(e.deps)).action?.result).toBe('messaged');
    expect(e.sleeps).toEqual([60_000]);
  });
  it('does not reuse yesterday\'s planned moment', async () => {
    await updateAppState(e.db, { nextOutreachAt: new Date('2026-11-16T17:50:00Z') }); await acceptedDue();
    await runTick(e.deps);
    expect(e.sleeps).toEqual([60_000]);
  });
  it('leaves the planned moment alone when a check after the wait stops the send', async () => {
    await updateAppState(e.db, { nextOutreachAt: at(30_000) }); await acceptedDue();
    e.deps.sleep = async () => { await setRunning(e.db, false); };
    await runTick(e.deps);
    expect((await getAppState(e.db)).nextOutreachAt).toEqual(at(30_000));
  });
  it('withdraws one invite, then waits a random 10 to 30 minutes before the next', async () => {
    // The poll is pushed out of the way, so the only Unipile call in this test is the withdrawal.
    await updateAppState(e.db, { nextOutreachAt: at(10 * 60_000), nextInvitePollAt: at(6 * 3_600_000) });
    const a = await seedLead(e.db, { status: 'invite_sent', invitationId: 'inv_a', nextActionAt: at(-2 * 3_600_000) });
    const b = await seedLead(e.db, { status: 'invite_sent', invitationId: 'inv_b', nextActionAt: at(-3_600_000) });
    await runTick(e.deps); await runTick(e.deps);
    expect(methods()).toEqual(['cancelInvitation']);
    expect((await getAppState(e.db)).nextWithdrawalAt).toEqual(at(20 * 60_000));
    e.setNow(at(21 * 60_000)); await updateAppState(e.db, { nextOutreachAt: at(60 * 60_000) });
    await runTick(e.deps);
    expect([(await getLead(e.db, a.id)).status, (await getLead(e.db, b.id)).status]).toEqual(['invite_expired', 'invite_expired']);
  });

  // Beyond the brief's list: the time limits and the checks after the wait, with spacing on.
  it('never waits longer than the random-wait maximum for the planned moment', async () => {
    // 90 s is the longest wait (the random-wait maximum); a moment 91 s away is left for a later tick.
    await updateAppState(e.db, { nextOutreachAt: at(91_000) }); await acceptedDue();
    expect((await runTick(e.deps)).action).toBeNull();
    expect(e.sleeps).toEqual([]);
    await updateAppState(e.db, { nextOutreachAt: at(90_000) });
    expect((await runTick(e.deps)).action?.result).toBe('messaged');
    expect(e.sleeps).toEqual([90_000]);
  });
  it('leaves the planned moment for a later tick when slow housekeeping cut the time to wait for it', async () => {
    await seedLead(e.db, { status: 'invite_sent', providerId: 'ACoSlow', acceptanceCheckPending: true, inviteSentAt: NOW, nextActionAt: new Date('2026-12-08T09:00:00Z') });
    e.fake.profiles.set('ACoSlow', makeProfile({ providerId: 'ACoSlow' }));
    await updateAppState(e.db, { nextOutreachAt: at(111_000), nextInvitePollAt: at(3_600_000) });
    // Housekeeping takes 25 s, so the action has to start within 85 s more: the planned moment is 86 s away.
    e.fake.onCall('getProfile', async () => { e.setNow(at(25_000)); });
    await acceptedDue();
    expect((await runTick(e.deps)).action).toBeNull();
    expect(methods()).toEqual(['getProfile']);
    expect(e.sleeps).toEqual([]);
  });
  it('sends nothing when the lead replied while the tick waited for the planned moment', async () => {
    await updateAppState(e.db, { nextOutreachAt: at(30_000) }); const lead = await acceptedDue();
    e.deps.sleep = async () => { await e.db.update(leads).set({ status: 'replied' }).where(eq(leads.id, lead.id)); };
    expect((await runTick(e.deps)).action).toEqual({ leadId: lead.id, result: 'superseded' });
    expect(methods()).toEqual([]);
    expect((await getAppState(e.db)).nextOutreachAt).toEqual(at(30_000));
  });
  it('sends nothing when the active window closed while the tick waited for the planned moment', async () => {
    e.setNow(new Date('2026-11-17T17:59:30Z'));
    await updateAppState(e.db, { nextOutreachAt: new Date('2026-11-17T18:00:10Z') }); await acceptedDue();
    e.deps.sleep = async (ms) => { e.sleeps.push(ms); e.setNow(new Date('2026-11-17T18:00:10Z')); };
    expect(await runTick(e.deps)).toMatchObject({ status: 'outside_window', action: null });
    expect(e.sleeps).toEqual([40_000]);
    expect(methods()).toEqual([]);
  });
  it('plans the next send after an action that failed without sending', async () => {
    await updateAppState(e.db, { nextOutreachAt: NOW });
    // No first name: the first message cannot be rendered, and the lead fails before anything is sent.
    await seedLead(e.db, { status: 'accepted', providerId: 'ACoBob', sequenceStartedAt: NOW });
    expect((await runTick(e.deps)).action?.result).toBe('failed');
    expect((await getAppState(e.db)).nextOutreachAt).toEqual(at(45 * 60_000));
  });
  it('counts the messages due before the window closes among the planned sends', async () => {
    await updateAppState(e.db, { nextOutreachAt: NOW }); await acceptedDue();
    // Due later today, so planned; tomorrow's follow-up is not.
    for (let i = 0; i < 19; i++) await seedLead(e.db, { status: 'messaged', providerId: `ACoLater${i}`, nextActionAt: at(3_600_000) });
    await seedLead(e.db, { status: 'messaged', providerId: 'ACoTomorrow', nextActionAt: new Date('2026-11-18T09:00:00Z') });
    await runTick(e.deps);
    // 9 hours over 19 planned messages and no invite: about 28.4 minutes on average.
    expect((await getAppState(e.db)).nextOutreachAt).toEqual(at(Math.round((9 * 60 * 60_000) / 19)));
  });
  it('spaces nothing on a day the window is closed', async () => {
    e.setNow(new Date('2026-11-21T10:00:00Z')); await acceptedDue();
    expect((await runTick(e.deps)).status).toBe('outside_window');
    expect((await getAppState(e.db)).nextOutreachAt).toBeNull();
  });
});
