import { beforeEach, describe, expect, it } from 'vitest';
import { createTestEngine, getLead, listEvents, NOW, seedLead, type TestEngine } from '@/test-utils/engine';
import { makeProfile } from '@/test-utils/fake-unipile';
import { UnipileError } from '@/lib/unipile/errors';
import { expireOneInvite, finishDueLeads, runAcceptanceChecks, runInvitePollIfDue } from './housekeeping';
import { getAppState, updateAppState } from './state';

const ago = (ms: number) => new Date(NOW.getTime() - ms);
const H = 3_600_000;

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
});
