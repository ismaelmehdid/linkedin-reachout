import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { leads, type Lead } from '@/db/schema';
import { UnipileError } from '@/lib/unipile/errors';
import { createTestEngine, getLead, listEvents, NOW, seedLead, type TestEngine } from '@/test-utils/engine';
import { makeProfile } from '@/test-utils/fake-unipile';
import { runInviteAction } from './invite';
import { getAppState } from './state';

describe('invite action', () => {
  let e: TestEngine;
  let lead: Lead;
  beforeEach(async () => {
    e = await createTestEngine();
    lead = await seedLead(e.db, { slug: 'jane-doe' });
    e.fake.profiles.set('jane-doe', makeProfile());
  });

  const run = () => runInviteAction(e.deps, lead, e.settings);
  const methods = () => e.fake.calls.map((c) => c.method);

  it('sends the invite with the rendered note and schedules expiry in 21 days', async () => {
    expect(await run()).toEqual({ leadId: lead.id, result: 'invited' });
    expect(e.fake.calls).toEqual([{ method: 'getProfile', args: ['jane-doe'] }, { method: 'sendInvitation', args: ['ACoJane', 'Hi Jane from Acme'] }]);
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'invite_sent', providerId: 'ACoJane', firstName: 'Jane', company: 'Acme',
      position: 'CTO', invitationId: 'inv_1', inviteSentAt: NOW, sequenceStartedAt: NOW, nextActionAt: new Date('2026-12-08T09:00:00Z'), lastAction: 'invite_sent', lastActionAt: NOW, updatedAt: NOW });
    expect((await listEvents(e.db)).map((x) => x.type)).toEqual(['profile_view', 'invite_sent']);
  });
  it('moves first-degree connections straight to the first message', async () => {
    e.fake.profiles.set('jane-doe', makeProfile({ networkDistance: 'FIRST_DEGREE' }));
    expect((await run()).result).toBe('already_connected');
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'already_connected', nextActionAt: NOW, sequenceStartedAt: NOW,
      lastAction: 'already_connected', lastActionAt: NOW, updatedAt: NOW });
    expect(methods()).toEqual(['getProfile']);
  });
  it('fails before inviting when a later template misses a variable', async () => { // Review Focus 4
    e = await createTestEngine({ templates: { followup2: 'About {{position}}' } }); lead = await seedLead(e.db, { slug: 'jane-doe' });
    e.fake.profiles.set('jane-doe', makeProfile({ currentPosition: null }));
    expect((await run()).result).toBe('failed');
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'failed', failureReason: 'missing_variable: position', failedFromStatus: 'queued', firstName: 'Jane',
      lastAction: 'failed', lastActionAt: NOW, updatedAt: NOW });
    expect(methods()).toEqual(['getProfile']);
  });
  it('fails before inviting when the rendered note is over 300 characters', async () => { // Review Focus 4
    e.fake.profiles.set('jane-doe', makeProfile({ currentCompany: 'A'.repeat(290) }));
    await run();
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'failed', failureReason: 'note_too_long: 303/300' });
  });
  it('marks a second URL of the same person as duplicate_person', async () => { // Review Focus 1
    await seedLead(e.db, { slug: 'jane-old', providerId: 'ACoJane', status: 'invite_sent' });
    await run();
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'failed', failureReason: 'duplicate_person', updatedAt: NOW });
    expect(methods()).toEqual(['getProfile']);
  });
  it('treats already_connected from Unipile as connected', async () => {
    e.fake.failNext('sendInvitation', new UnipileError(422, 'errors/already_connected', ''));
    await run();
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'already_connected', nextActionAt: NOW, lastAction: 'already_connected', lastActionAt: NOW });
  });
  it('treats already_invited_recently as invite_sent without a new invite event', async () => {
    e.fake.failNext('sendInvitation', new UnipileError(422, 'errors/already_invited_recently', ''));
    expect((await run()).result).toBe('already_invited');
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'invite_sent', invitationId: null, nextActionAt: new Date('2026-12-08T09:00:00Z'),
      lastAction: 'invite_sent', lastActionAt: NOW });
    expect((await listEvents(e.db)).map((x) => x.type)).toEqual(['profile_view']);
  });
  it('pauses invites until the next active day on a limit error and keeps the lead queued', async () => {
    e.fake.failNext('sendInvitation', new UnipileError(422, 'errors/cannot_resend_yet', ''));
    expect((await run()).result).toBe('deferred');
    expect((await getLead(e.db, lead.id)).status).toBe('queued');
    expect(await getAppState(e.db)).toMatchObject({ invitesPausedUntil: new Date('2026-11-18T07:30:00Z'), consecutiveErrors: 1 });
  });
  it('pauses invites for retry_after seconds on HTTP 429', async () => {
    e.fake.failNext('getProfile', new UnipileError(429, 'errors/too_many_requests', '', 600));
    await run();
    expect((await getAppState(e.db)).invitesPausedUntil).toEqual(new Date('2026-11-17T09:10:00Z'));
  });
  it('leaves the lead untouched on a 5xx error', async () => { // Review Focus 3
    e.fake.failNext('sendInvitation', new UnipileError(503, null, 'down'));
    expect((await run()).result).toBe('deferred');
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'queued', retryCount: 0 });
    expect((await getAppState(e.db)).consecutiveErrors).toBe(1);
  });
  it('retries an unknown error once, then fails the lead', async () => {
    e.fake.failNext('sendInvitation', new UnipileError(422, 'errors/brand_new_error', ''));
    e.fake.failNext('sendInvitation', new UnipileError(422, 'errors/brand_new_error', ''));
    expect((await run()).result).toBe('retry');
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'queued', retryCount: 1 });
    expect((await runInviteAction(e.deps, await getLead(e.db, lead.id), e.settings)).result).toBe('failed');
    expect((await getLead(e.db, lead.id)).failureReason).toBe('errors/brand_new_error');
  });
  it('fails the lead on a permanent error or a missing profile', async () => {
    e.fake.failNext('sendInvitation', new UnipileError(422, 'errors/cannot_invite_attendee', ''));
    await run();
    expect((await getLead(e.db, lead.id)).failureReason).toBe('errors/cannot_invite_attendee');
    const ghost = await seedLead(e.db, { slug: 'ghost' });
    await runInviteAction(e.deps, ghost, e.settings);
    expect((await getLead(e.db, ghost.id)).failureReason).toBe('errors/invalid_resource_identifier');
  });
  it('records the dry-run flag and the text on the invite event', async () => {
    e = await createTestEngine({ dryRun: true }); lead = await seedLead(e.db, { slug: 'jane-doe' }); e.fake.profiles.set('jane-doe', makeProfile());
    await run();
    expect((await listEvents(e.db)).at(-1)).toMatchObject({ type: 'invite_sent', payload: { text: 'Hi Jane from Acme', dryRun: true } });
    expect((await getLead(e.db, lead.id)).invitationId).toMatch(/^dry_/);
  });

  // Beyond the plan's list: specified behavior the tests above do not pin down.
  it('logs every action error with its kind, status, type and message', async () => {
    e.fake.failNext('sendInvitation', new UnipileError(503, null, 'down'));
    await run();
    expect((await listEvents(e.db)).at(-1)).toMatchObject({ type: 'action_failed', leadId: lead.id, createdAt: NOW,
      payload: { kind: 'invite', status: 503, type: null, message: 'down' } });
  });
  it('keeps the invite event but reports superseded when a webhook changes the lead during the send', async () => {
    e.fake.onCall('sendInvitation', async () => { await e.db.update(leads).set({ status: 'replied' }).where(eq(leads.id, lead.id)); });
    expect((await run()).result).toBe('superseded');
    expect((await getLead(e.db, lead.id)).status).toBe('replied');
    expect((await listEvents(e.db)).map((x) => x.type)).toEqual(['profile_view', 'invite_sent']);
  });
  it('records an invite that Unipile accepted without an invitation id', async () => {
    e.deps.unipile = { ...e.fake, sendInvitation: async () => ({ invitationId: null }) };
    expect((await run()).result).toBe('invited');
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'invite_sent', invitationId: null, inviteSentAt: NOW, nextActionAt: new Date('2026-12-08T09:00:00Z') });
    expect((await listEvents(e.db)).map((x) => x.type)).toEqual(['profile_view', 'invite_sent']);
  });
  it('retries an unexpected non-Unipile error from the profile fetch', async () => {
    e.fake.failNext('getProfile', new TypeError('bug'));
    expect((await run()).result).toBe('retry');
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'queued', retryCount: 1, updatedAt: NOW });
    expect((await listEvents(e.db)).map((x) => [x.type, x.payload])).toEqual([['action_failed', { kind: 'invite', status: null, type: null, message: 'bug' }]]);
  });
});
