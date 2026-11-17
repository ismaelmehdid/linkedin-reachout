import { beforeEach, describe, expect, it } from 'vitest';
import { createTestEngine, getLead, listEvents, NOW, seedLead, type TestEngine } from '@/test-utils/engine';
import { makeProfile } from '@/test-utils/fake-unipile';
import { UnipileError } from '@/lib/unipile/errors';
import { expireOneInvite, finishDueLeads, runAcceptanceChecks, runInvitePollIfDue } from './housekeeping';
import { getAppState, updateAppState } from './state';
import { runTick } from './tick';

const ago = (ms: number) => new Date(NOW.getTime() - ms);
const after = (ms: number) => new Date(NOW.getTime() + ms);
const H = 3_600_000;
const MIN = 60_000;

/** An invite's expiry, far enough away that the withdrawal never runs in a test about something else. */
const EXPIRY = new Date('2026-12-08T09:00:00Z');

const ACCOUNT_ERROR = new UnipileError(401, 'errors/disconnected_account', 'The account appears to be disconnected');
const ACCOUNT_PAUSE = 'Auto-paused: Unipile rejected the account (errors/disconnected_account). Reconnect the LinkedIn account in Unipile, then press Start.';

describe('housekeeping', () => {
  let e: TestEngine;
  beforeEach(async () => {
    e = await createTestEngine();
  });

  it('marks follow-up 2 leads as no_response once due, skipping paused ones', async () => {
    const due = await seedLead(e.db, { status: 'followup_2', nextActionAt: ago(60_000) });
    const later = await seedLead(e.db, { status: 'followup_2', nextActionAt: new Date(NOW.getTime() + H) });
    const paused = await seedLead(e.db, { status: 'followup_2', nextActionAt: ago(60_000), paused: true });
    expect(await finishDueLeads(e.db, NOW)).toBe(1);
    expect(await Promise.all([due, later, paused].map(async (l) => (await getLead(e.db, l.id)).status))).toEqual(['no_response', 'followup_2', 'followup_2']);
    expect(await getLead(e.db, due.id)).toMatchObject({ nextActionAt: null, lastAction: 'no_response', lastActionAt: NOW, updatedAt: NOW });
    expect(e.fake.calls).toEqual([]);
  });

  it('accepts a flagged lead whose profile is now first degree', async () => {
    const lead = await seedLead(e.db, { status: 'invite_sent', providerId: 'ACoJane', acceptanceCheckPending: true });
    e.fake.profiles.set('ACoJane', makeProfile({ networkDistance: 'FIRST_DEGREE' }));
    expect(await runAcceptanceChecks(e.deps, e.settings, 90)).toBe(1);
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'accepted', acceptanceCheckPending: false, nextActionAt: new Date('2026-11-17T11:00:00Z'), lastAction: 'accepted', lastActionAt: NOW, updatedAt: NOW });
    expect((await listEvents(e.db)).map((x) => x.type)).toEqual(['profile_view']);
  });

  it('clears the flag when the profile is not first degree yet', async () => {
    const lead = await seedLead(e.db, { status: 'invite_sent', providerId: 'ACoJane', acceptanceCheckPending: true });
    e.fake.profiles.set('ACoJane', makeProfile());
    await runAcceptanceChecks(e.deps, e.settings, 90);
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'invite_sent', acceptanceCheckPending: false, updatedAt: NOW });
  });

  it('checks at most 3 leads, and none without profile views left', async () => {
    for (let i = 0; i < 5; i++) await seedLead(e.db, { status: 'invite_sent', providerId: `ACo${i}`, acceptanceCheckPending: true });
    expect(await runAcceptanceChecks(e.deps, e.settings, 0)).toBe(0);
    expect(await runAcceptanceChecks(e.deps, e.settings, 90)).toBe(3);
  });

  it('stops the acceptance checks at the first limit or 5xx error, keeping the flag', async () => {
    const first = await seedLead(e.db, { status: 'invite_sent', providerId: 'ACoA', acceptanceCheckPending: true });
    await seedLead(e.db, { status: 'invite_sent', providerId: 'ACoB', acceptanceCheckPending: true });
    e.fake.failNext('getProfile', new UnipileError(503, null, 'down'));
    expect(await runAcceptanceChecks(e.deps, e.settings, 90)).toBe(1);
    expect((await getLead(e.db, first.id)).acceptanceCheckPending).toBe(true);
    expect((await getAppState(e.db)).consecutiveErrors).toBe(1);
  });

  it('clears the flag and logs the failure on any other profile error', async () => {
    const lead = await seedLead(e.db, { status: 'invite_sent', providerId: 'ACoGone', acceptanceCheckPending: true });
    expect(await runAcceptanceChecks(e.deps, e.settings, 90)).toBe(1);
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'invite_sent', acceptanceCheckPending: false });
    expect((await listEvents(e.db)).map((x) => x.type)).toEqual(['action_failed']);
    expect((await getAppState(e.db)).consecutiveErrors).toBe(0);
  });

  it('pauses the app and keeps the flag when the acceptance check meets an account error', async () => {
    const first = await seedLead(e.db, { status: 'invite_sent', providerId: 'ACoA', acceptanceCheckPending: true });
    const second = await seedLead(e.db, { status: 'invite_sent', providerId: 'ACoB', acceptanceCheckPending: true });
    e.fake.failNext('getProfile', ACCOUNT_ERROR);
    expect(await runAcceptanceChecks(e.deps, e.settings, 90)).toBe(1);
    expect(await getLead(e.db, first.id)).toMatchObject({ status: 'invite_sent', acceptanceCheckPending: true });
    expect((await getLead(e.db, second.id)).acceptanceCheckPending).toBe(true);
    expect(await getAppState(e.db)).toMatchObject({ running: false, pauseReason: ACCOUNT_PAUSE, consecutiveErrors: 0 });
    expect((await listEvents(e.db)).map((x) => [x.type, x.leadId])).toEqual([['action_failed', first.id]]);
  });

  describe('an invite that left the sent list', () => {
    const seedGone = () => seedLead(e.db, { status: 'invite_sent', slug: 'jane-doe', providerId: 'ACoJane', invitationId: 'inv_1', inviteSentAt: ago(48 * H), nextActionAt: EXPIRY });
    const types = async () => (await listEvents(e.db)).map((x) => x.type);

    it('expires after two polls when the person never connected, at a cost of two profile views', async () => {
      const lead = await seedGone();
      e.fake.profiles.set('ACoJane', makeProfile());

      // The first poll misses the invite; the check five minutes later finds no connection.
      expect(await runInvitePollIfDue(e.deps)).toBe(true);
      expect((await getLead(e.db, lead.id)).acceptanceCheckPending).toBe(true);
      e.setNow(after(5 * MIN));
      await runAcceptanceChecks(e.deps, e.settings, 90);
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'invite_sent', acceptanceCheckPending: false, nextActionAt: EXPIRY });

      // The second poll, four hours after the first, misses it again.
      e.setNow(after(4 * H));
      expect(await runInvitePollIfDue(e.deps)).toBe(true);
      e.setNow(after(4 * H + 5 * MIN));
      await runAcceptanceChecks(e.deps, e.settings, 90);

      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'invite_expired', acceptanceCheckPending: false, nextActionAt: null,
        lastAction: 'invite_gone', lastActionAt: after(4 * H + 5 * MIN), updatedAt: after(4 * H + 5 * MIN) });
      expect(await types()).toEqual(['invite_missing', 'profile_view', 'invite_missing', 'profile_view']);
      expect((await listEvents(e.db)).filter((x) => x.type === 'invite_missing').map((x) => [x.leadId, x.createdAt])).toEqual([[lead.id, NOW], [lead.id, after(4 * H)]]);
      // An invite that is gone is not withdrawn.
      expect(e.fake.calls.map((c) => c.method)).toEqual(['listSentInvitations', 'getProfile', 'listSentInvitations', 'getProfile']);
    });
    it('is accepted when the person connects between the two polls', async () => {
      const lead = await seedGone();
      e.fake.profiles.set('ACoJane', makeProfile());
      await runInvitePollIfDue(e.deps);
      e.setNow(after(5 * MIN));
      await runAcceptanceChecks(e.deps, e.settings, 90);

      e.fake.profiles.set('ACoJane', makeProfile({ networkDistance: 'FIRST_DEGREE' }));
      e.setNow(after(4 * H));
      await runInvitePollIfDue(e.deps);
      e.setNow(after(4 * H + 5 * MIN));
      await runAcceptanceChecks(e.deps, e.settings, 90);

      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'accepted', acceptanceCheckPending: false, lastAction: 'accepted', nextActionAt: after(4 * H + 5 * MIN + 2 * H) });
    });
    it('stays pending when the only poll that missed it was less than an hour ago', async () => {
      const lead = await seedGone();
      e.fake.profiles.set('ACoJane', makeProfile());
      await runInvitePollIfDue(e.deps);
      e.setNow(after(59 * MIN));
      await runAcceptanceChecks(e.deps, e.settings, 90);
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'invite_sent', acceptanceCheckPending: false });
    });
    it('does not expire a lead for another lead\'s missing invite', async () => {
      const gone = await seedGone();
      const other = await seedLead(e.db, { status: 'invite_sent', providerId: 'ACoBob', acceptanceCheckPending: true, nextActionAt: EXPIRY });
      e.fake.profiles.set('ACoJane', makeProfile());
      e.fake.profiles.set('ACoBob', makeProfile({ providerId: 'ACoBob' }));
      e.fake.sentInvitations.push({ id: 'inv_b', invitedUserId: 'ACoBob', invitedUserPublicId: 'bob' });
      await runInvitePollIfDue(e.deps);
      e.setNow(after(2 * H));
      await runAcceptanceChecks(e.deps, e.settings, 90);
      expect((await getLead(e.db, gone.id)).status).toBe('invite_expired');
      expect(await getLead(e.db, other.id)).toMatchObject({ status: 'invite_sent', acceptanceCheckPending: false });
    });
    it('costs two profile views over many polls, not one per poll', async () => { // final review, probe 5
      const lead = await seedGone();
      e.fake.profiles.set('ACoJane', makeProfile());
      // Two working days of ticks: one at each poll time, one five minutes later, as cron-job.org would.
      const days = ['2026-11-17', '2026-11-18'];
      const times = ['09:00', '09:05', '13:00', '13:05', '17:00', '17:05'];
      for (const day of days) {
        for (const time of times) {
          e.setNow(new Date(`${day}T${time}:00Z`));
          await runTick(e.deps);
        }
      }
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'invite_expired', lastAction: 'invite_gone', lastActionAt: new Date('2026-11-17T13:05:00Z') });
      expect((await types()).filter((type) => type === 'profile_view')).toHaveLength(2);
      // Once the lead is expired, no invite is pending and the list is not fetched again.
      expect(e.fake.calls.filter((c) => c.method === 'listSentInvitations')).toHaveLength(2);
    });
  });

  it('withdraws one expired invite per call', async () => {
    const a = await seedLead(e.db, { status: 'invite_sent', invitationId: 'inv_a', nextActionAt: ago(2 * H) });
    const b = await seedLead(e.db, { status: 'invite_sent', invitationId: 'inv_b', nextActionAt: ago(H) });
    expect(await expireOneInvite(e.deps, e.settings)).toBe(true);
    expect(e.fake.calls).toEqual([{ method: 'cancelInvitation', args: ['inv_a'] }]);
    expect((await getLead(e.db, a.id)).status).toBe('invite_expired');
    expect((await getLead(e.db, b.id)).status).toBe('invite_sent');
    expect((await listEvents(e.db)).map((x) => x.type)).toEqual(['invite_withdrawn']);
    expect(await getLead(e.db, a.id)).toMatchObject({ nextActionAt: null, lastAction: 'invite_withdrawn', lastActionAt: NOW, updatedAt: NOW });
  });

  it('expires an invite without an id, or one Unipile no longer knows, without blocking', async () => {
    const noId = await seedLead(e.db, { status: 'invite_sent', invitationId: null, nextActionAt: ago(H) });
    await expireOneInvite(e.deps, e.settings);
    expect((await getLead(e.db, noId.id)).status).toBe('invite_expired');
    const gone = await seedLead(e.db, { status: 'invite_sent', invitationId: 'inv_x', nextActionAt: ago(H) });
    e.fake.failNext('cancelInvitation', new UnipileError(404, null, 'not found'));
    await expireOneInvite(e.deps, e.settings);
    expect((await getLead(e.db, gone.id)).status).toBe('invite_expired');
  });

  it('keeps the invite when the withdraw call fails with a 5xx', async () => {
    const lead = await seedLead(e.db, { status: 'invite_sent', invitationId: 'inv_a', nextActionAt: ago(H) });
    e.fake.failNext('cancelInvitation', new UnipileError(502, null, ''));
    expect(await expireOneInvite(e.deps, e.settings)).toBe(false);
    expect((await getLead(e.db, lead.id)).status).toBe('invite_sent');
    expect((await getAppState(e.db)).consecutiveErrors).toBe(1);
  });

  it('pauses the app and keeps the invite when the withdraw call meets an account error', async () => {
    const lead = await seedLead(e.db, { status: 'invite_sent', invitationId: 'inv_a', nextActionAt: ago(H) });
    e.fake.failNext('cancelInvitation', new UnipileError(403, null, 'Forbidden'));
    expect(await expireOneInvite(e.deps, e.settings)).toBe(false);
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'invite_sent', nextActionAt: ago(H) });
    expect(await getAppState(e.db)).toMatchObject({
      running: false,
      pauseReason: 'Auto-paused: Unipile rejected the account (http_403). Reconnect the LinkedIn account in Unipile, then press Start.',
      consecutiveErrors: 0,
    });
  });

  it('does not expire an invite whose acceptance check is still pending', async () => {
    const flagged = await seedLead(e.db, { status: 'invite_sent', invitationId: 'inv_a', nextActionAt: ago(2 * H), acceptanceCheckPending: true });
    expect(await expireOneInvite(e.deps, e.settings)).toBe(false);
    expect(e.fake.calls).toEqual([]);
    expect((await getLead(e.db, flagged.id)).status).toBe('invite_sent');
    // A later invite that is not flagged is still withdrawn.
    const plain = await seedLead(e.db, { status: 'invite_sent', invitationId: 'inv_b', nextActionAt: ago(H) });
    expect(await expireOneInvite(e.deps, e.settings)).toBe(true);
    expect(e.fake.calls).toEqual([{ method: 'cancelInvitation', args: ['inv_b'] }]);
    expect((await getLead(e.db, plain.id)).status).toBe('invite_expired');
    expect((await getLead(e.db, flagged.id)).status).toBe('invite_sent');
  });

  it('leaves paused leads alone in the acceptance checks and the invite expiry', async () => {
    const flagged = await seedLead(e.db, { status: 'invite_sent', providerId: 'ACoJane', acceptanceCheckPending: true, paused: true });
    const expired = await seedLead(e.db, { status: 'invite_sent', invitationId: 'inv_a', nextActionAt: ago(H), paused: true });
    expect(await runAcceptanceChecks(e.deps, e.settings, 90)).toBe(0);
    expect(await expireOneInvite(e.deps, e.settings)).toBe(false);
    expect(e.fake.calls).toEqual([]);
    expect((await getLead(e.db, flagged.id)).acceptanceCheckPending).toBe(true);
    expect((await getLead(e.db, expired.id)).status).toBe('invite_sent');
  });

  it('polls sent invites, flags the ones that disappeared and stores missing ids', async () => {
    const a = await seedLead(e.db, { status: 'invite_sent', providerId: 'ACoA', inviteSentAt: ago(48 * H) });
    const b = await seedLead(e.db, { status: 'invite_sent', providerId: 'ACoB', inviteSentAt: ago(48 * H), invitationId: null });
    const fresh = await seedLead(e.db, { status: 'invite_sent', providerId: 'ACoC', inviteSentAt: ago(5 * 60_000) });
    e.fake.sentInvitations.push({ id: 'inv_b', invitedUserId: 'ACoB', invitedUserPublicId: 'bee' });
    expect(await runInvitePollIfDue(e.deps)).toBe(true);
    expect(await getLead(e.db, a.id)).toMatchObject({ acceptanceCheckPending: true, updatedAt: NOW });
    expect(await getLead(e.db, b.id)).toMatchObject({ acceptanceCheckPending: false, invitationId: 'inv_b', updatedAt: NOW });
    expect((await getLead(e.db, fresh.id)).acceptanceCheckPending).toBe(false);
    expect((await getAppState(e.db)).nextInvitePollAt).toEqual(new Date('2026-11-17T13:00:00Z'));
    // The poll remembers each invite it missed.
    expect((await listEvents(e.db)).map((x) => [x.type, x.leadId, x.createdAt])).toEqual([['invite_missing', a.id, NOW]]);
  });

  it('remembers a missing invite again when its check is still pending', async () => {
    const lead = await seedLead(e.db, { status: 'invite_sent', providerId: 'ACoA', inviteSentAt: ago(48 * H), acceptanceCheckPending: true });
    expect(await runInvitePollIfDue(e.deps)).toBe(true);
    expect(await getLead(e.db, lead.id)).toMatchObject({ acceptanceCheckPending: true });
    expect((await listEvents(e.db)).map((x) => [x.type, x.leadId])).toEqual([['invite_missing', lead.id]]);
  });

  it('matches a sent invite by its invitation id', async () => {
    const lead = await seedLead(e.db, { status: 'invite_sent', providerId: 'ACoOld', invitationId: 'inv_7', inviteSentAt: ago(48 * H) });
    e.fake.sentInvitations.push({ id: 'inv_7', invitedUserId: 'ACoNew', invitedUserPublicId: 'someone-else' });
    expect(await runInvitePollIfDue(e.deps)).toBe(true);
    expect(await getLead(e.db, lead.id)).toMatchObject({ acceptanceCheckPending: false, invitationId: 'inv_7' });
    expect(await listEvents(e.db)).toEqual([]);
  });

  it('schedules the next poll before it fetches the list', async () => {
    await seedLead(e.db, { status: 'invite_sent', providerId: 'ACoA', inviteSentAt: ago(48 * H) });
    let duringFetch: Date | null = null;
    e.fake.onCall('listSentInvitations', async () => { duringFetch = (await getAppState(e.db)).nextInvitePollAt; });
    expect(await runInvitePollIfDue(e.deps)).toBe(true);
    // A tick killed during the fetch finds the poll already scheduled, and does not repeat it five minutes later.
    expect(duringFetch).toEqual(new Date('2026-11-17T13:00:00Z'));
  });

  it('matches a sent invite by public identifier, ignoring case', async () => {
    const bySlug = await seedLead(e.db, { slug: 'Jane-Doe', status: 'invite_sent', providerId: 'ACoJane', inviteSentAt: ago(48 * H) });
    const byPublicId = await seedLead(e.db, { status: 'invite_sent', providerId: 'ACoBob', publicIdentifier: 'bob-smith', inviteSentAt: ago(48 * H) });
    e.fake.sentInvitations.push(
      { id: 'inv_1', invitedUserId: null, invitedUserPublicId: 'jane-doe' },
      { id: 'inv_2', invitedUserId: null, invitedUserPublicId: 'BOB-SMITH' },
    );
    expect(await runInvitePollIfDue(e.deps)).toBe(true);
    expect(await getLead(e.db, bySlug.id)).toMatchObject({ acceptanceCheckPending: false, invitationId: 'inv_1' });
    expect(await getLead(e.db, byPublicId.id)).toMatchObject({ acceptanceCheckPending: false, invitationId: 'inv_2' });
  });

  it('ignores dry-run invites, which Unipile never saw', async () => {
    const dry = await seedLead(e.db, { status: 'invite_sent', providerId: 'ACoD', invitationId: 'dry_inv_1', inviteSentAt: ago(48 * H) });
    expect(await runInvitePollIfDue(e.deps)).toBe(false);
    expect(e.fake.calls).toEqual([]);
    expect((await getLead(e.db, dry.id)).acceptanceCheckPending).toBe(false);
  });

  it('does not poll before the next poll time or with no pending invite', async () => {
    expect(await runInvitePollIfDue(e.deps)).toBe(false);
    await seedLead(e.db, { status: 'invite_sent', providerId: 'ACoA', inviteSentAt: ago(48 * H) });
    await updateAppState(e.db, { nextInvitePollAt: new Date(NOW.getTime() + H) });
    expect(await runInvitePollIfDue(e.deps)).toBe(false);
    expect(e.fake.calls).toEqual([]);
  });

  it('retries the poll in an hour after an error, counting a limit in the error streak', async () => {
    const lead = await seedLead(e.db, { status: 'invite_sent', providerId: 'ACoA', inviteSentAt: ago(48 * H) });
    e.fake.failNext('listSentInvitations', new UnipileError(429, null, 'slow down'));
    expect(await runInvitePollIfDue(e.deps)).toBe(false);
    expect((await getLead(e.db, lead.id)).acceptanceCheckPending).toBe(false);
    expect(await getAppState(e.db)).toMatchObject({ nextInvitePollAt: new Date('2026-11-17T10:00:00Z'), consecutiveErrors: 1 });
    expect((await listEvents(e.db)).map((x) => x.type)).toEqual(['action_failed']);
  });

  it('pauses the app when the poll meets an account error, and flags nothing', async () => {
    const lead = await seedLead(e.db, { status: 'invite_sent', providerId: 'ACoA', inviteSentAt: ago(48 * H) });
    e.fake.failNext('listSentInvitations', ACCOUNT_ERROR);
    expect(await runInvitePollIfDue(e.deps)).toBe(false);
    expect((await getLead(e.db, lead.id)).acceptanceCheckPending).toBe(false);
    expect(await getAppState(e.db)).toMatchObject({ running: false, pauseReason: ACCOUNT_PAUSE, nextInvitePollAt: new Date('2026-11-17T10:00:00Z'), consecutiveErrors: 0 });
    expect((await listEvents(e.db)).map((x) => [x.type, x.payload])).toEqual([
      ['action_failed', { kind: 'invite_poll', status: 401, type: 'errors/disconnected_account', message: 'The account appears to be disconnected' }],
    ]);
  });
});
