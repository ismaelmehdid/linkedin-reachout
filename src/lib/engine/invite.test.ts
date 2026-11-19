import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { leads, type Lead } from '@/db/schema';
import type { Settings } from '@/lib/settings/settings';
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
    expect(methods()).toEqual(['getProfile']);
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
  it.each([0, -30, Number.NaN, Number.POSITIVE_INFINITY])('pauses invites until the next active day when retry_after is %d', async (retryAfter) => {
    e.fake.failNext('getProfile', new UnipileError(429, 'errors/too_many_requests', '', retryAfter));
    await run();
    expect((await getAppState(e.db)).invitesPausedUntil).toEqual(new Date('2026-11-18T07:30:00Z'));
  });
  it('clears the retry count when the lead turns out to be connected already', async () => {
    await e.db.update(leads).set({ retryCount: 1 }).where(eq(leads.id, lead.id));
    e.fake.profiles.set('jane-doe', makeProfile({ networkDistance: 'FIRST_DEGREE' }));
    expect((await run()).result).toBe('already_connected');
    expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'already_connected', retryCount: 0 });
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
  describe('an error that is about the account, not the lead', () => {
    const reconnect = (detail: string) => `Auto-paused: Unipile rejected the account (${detail}). Reconnect the LinkedIn account in Unipile, then press Start.`;

    it.each([
      ['a 401 on the profile fetch', 'getProfile', new UnipileError(401, 'errors/disconnected_account', 'The account appears to be disconnected'), 'errors/disconnected_account'],
      ['a 403 without a type on the invite', 'sendInvitation', new UnipileError(403, null, 'Forbidden'), 'http_403'],
      ['a credentials error on the invite', 'sendInvitation', new UnipileError(422, 'errors/expired_credentials', 'Expired'), 'errors/expired_credentials'],
    ] as const)('pauses the app at once and leaves the lead as it is on %s', async (_label, method, error, detail) => {
      e.fake.failNext(method, error);
      expect(await run()).toEqual({ leadId: lead.id, result: 'deferred' });
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'queued', retryCount: 0, failureReason: null, nextActionAt: lead.nextActionAt });
      expect(await getAppState(e.db)).toMatchObject({ running: false, pauseReason: reconnect(detail), consecutiveErrors: 0, invitesPausedUntil: null });
      expect((await listEvents(e.db)).at(-1)).toMatchObject({ type: 'action_failed', leadId: lead.id, payload: { kind: 'invite', status: error.status, type: error.type } });
    });
  });

  describe('failed actions in a row', () => {
    /** A lead whose profile Unipile does not know: its invite fails with a 404, which is permanent. */
    const failOne = async () => {
      const ghost = await seedLead(e.db);
      expect((await runInviteAction(e.deps, ghost, e.settings)).result).toBe('failed');
    };

    it('pauses the app at the fifth failed action with no send in between', async () => {
      for (let i = 0; i < 4; i++) await failOne();
      expect(await getAppState(e.db)).toMatchObject({ running: true, pauseReason: null });
      await failOne();
      expect(await getAppState(e.db)).toMatchObject({ running: false, pauseReason: 'Auto-paused: 5 actions failed in a row with no successful send.' });
    });
    it('counts only the failures since the last invite or message that went out', async () => {
      for (let i = 0; i < 4; i++) await failOne();
      expect((await run()).result).toBe('invited');
      for (let i = 0; i < 4; i++) await failOne();
      expect((await getAppState(e.db)).running).toBe(true);
      await failOne();
      expect((await getAppState(e.db)).running).toBe(false);
    });
    it('counts an error that fails a lead after its one retry, and errors that left their lead alone', async () => {
      // Three transient errors would trip the error streak first, so two of them, then failures of another kind.
      for (let i = 0; i < 2; i++) {
        e.fake.failNext('getProfile', new UnipileError(503, null, 'down'));
        expect((await run()).result).toBe('deferred');
      }
      await failOne();
      await failOne();
      expect((await getAppState(e.db)).running).toBe(true);
      e.fake.failNext('sendInvitation', new UnipileError(422, 'errors/brand_new_error', ''));
      expect((await run()).result).toBe('retry');
      expect((await getAppState(e.db)).running).toBe(true);
      e.fake.failNext('sendInvitation', new UnipileError(422, 'errors/brand_new_error', ''));
      expect((await runInviteAction(e.deps, await getLead(e.db, lead.id), e.settings)).result).toBe('failed');
      expect(await getAppState(e.db)).toMatchObject({ running: false, pauseReason: 'Auto-paused: 5 actions failed in a row with no successful send.' });
    });
    it('does not count a lead that fails without an error from Unipile', async () => {
      for (let i = 0; i < 4; i++) await failOne();
      e.fake.profiles.set('jane-doe', makeProfile({ currentCompany: null }));
      expect((await run()).result).toBe('failed');
      expect((await getLead(e.db, lead.id)).failureReason).toBe('missing_variable: company');
      expect((await getAppState(e.db)).running).toBe(true);
    });
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

  describe('an AI lead, whose drafts are approved', () => {
    const NOTE = 'Jane, your Acme job post for a Rust engineer caught my eye. Open to a chat?';
    const seedAi = (patch: Partial<Lead> = {}) =>
      seedLead(e.db, { slug: 'jane-ai', draftStatus: 'approved', inviteNoteDraft: NOTE, firstMessageDraft: 'Thanks for connecting, Jane', ...patch });
    const runAi = async (patch: Partial<Lead> = {}, templates?: Parameters<typeof createTestEngine>[0]) => {
      if (templates) e = await createTestEngine(templates);
      // No position and no headline: templates that use them cannot render for this lead.
      e.fake.profiles.set('jane-ai', makeProfile({ currentPosition: null, headline: null }));
      lead = await seedAi(patch);
      return runInviteAction(e.deps, lead, e.settings);
    };

    it('sends the approved note as written', async () => {
      expect((await runAi()).result).toBe('invited');
      expect(e.fake.calls).toEqual([{ method: 'getProfile', args: ['jane-ai'] }, { method: 'sendInvitation', args: ['ACoJane', NOTE] }]);
      expect((await listEvents(e.db)).at(-1)).toMatchObject({ type: 'invite_sent', leadId: lead.id, payload: { text: NOTE, dryRun: false } });
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'invite_sent', inviteNoteDraft: NOTE, updatedAt: NOW });
    });
    it('is not failed by invite-note and first-message templates it does not use', async () => {
      expect((await runAi({}, { templates: { inviteNote: 'About {{position}}', firstMessage: '{{headline}}' } })).result).toBe('invited');
      expect(e.fake.calls.at(-1)).toEqual({ method: 'sendInvitation', args: ['ACoJane', NOTE] });
    });
    it.each([
      ['an empty note', { inviteNoteDraft: null }, 'missing_draft'],
      ['a blank note', { inviteNoteDraft: '   ' }, 'missing_draft'],
      ['a blank first message', { firstMessageDraft: '' }, 'missing_draft'],
      ['a note with a raw tag', { inviteNoteDraft: 'Hi {{first_name}}' }, 'invalid_template'],
      ['a note over 300 characters', { inviteNoteDraft: 'x'.repeat(320) }, 'note_too_long: 320/300'],
    ] as const)('fails the lead and sends nothing on %s', async (_label, patch, reason) => {
      expect((await runAi(patch)).result).toBe('failed');
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'failed', failureReason: reason, failedFromStatus: 'queued', updatedAt: NOW });
      expect(methods()).toEqual(['getProfile']);
      expect((await listEvents(e.db)).map((x) => x.type)).toEqual(['profile_view']);
    });
    it('still fails before inviting when a follow-up template misses a variable', async () => {
      e = await createTestEngine({ templates: { followup1: 'About {{position}}' } });
      e.fake.profiles.set('jane-ai', makeProfile({ currentPosition: null }));
      lead = await seedAi();
      expect((await runInviteAction(e.deps, lead, e.settings)).result).toBe('failed');
      expect((await getLead(e.db, lead.id)).failureReason).toBe('missing_variable: position');
      expect(methods()).toEqual(['getProfile']);
    });
    it('goes to already_connected without checking the invite-note and first-message templates', async () => {
      e = await createTestEngine({ templates: { inviteNote: 'About {{position}}', firstMessage: '{{headline}}' } });
      e.fake.profiles.set('jane-ai', makeProfile({ networkDistance: 'FIRST_DEGREE', currentPosition: null, headline: null }));
      lead = await seedAi({ inviteNoteDraft: null });
      expect((await runInviteAction(e.deps, lead, e.settings)).result).toBe('already_connected');
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'already_connected', nextActionAt: NOW, updatedAt: NOW });
      expect(methods()).toEqual(['getProfile']);
    });
    it.each([
      ['regenerated', { draftStatus: 'generating', inviteNoteDraft: null, firstMessageDraft: null }],
      ['edited back to ready', { draftStatus: 'ready', inviteNoteDraft: 'A new note' }],
      ['edited and approved again', { inviteNoteDraft: 'A new note' }],
    ] as const)('sends no invite when the drafts were %s during the profile fetch', async (_label, patch) => {
      e.fake.onCall('getProfile', async () => { await e.db.update(leads).set(patch).where(eq(leads.id, lead.id)); });
      expect((await runAi()).result).toBe('superseded');
      expect(methods()).toEqual(['getProfile']);
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'queued', providerId: null, failureReason: null, ...patch });
      expect((await listEvents(e.db)).map((x) => x.type)).toEqual(['profile_view']);
    });
    it('fails with draft_not_approved and sends nothing when a founder\'s drafts are not approved', async () => {
      expect((await runAi({ draftStatus: 'ready' })).result).toBe('failed');
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'failed', failureReason: 'draft_not_approved' });
      expect(methods()).toEqual(['getProfile']);
    });
    it('fails an already connected founder whose drafts are not approved', async () => {
      e.fake.profiles.set('jane-ai', makeProfile({ networkDistance: 'FIRST_DEGREE' }));
      lead = await seedAi({ draftStatus: 'pending', inviteNoteDraft: null, firstMessageDraft: null });
      expect((await runInviteAction(e.deps, lead, e.settings)).result).toBe('failed');
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'failed', failureReason: 'draft_not_approved' });
    });
    it('fails an already connected lead whose first message draft is blank', async () => {
      e.fake.profiles.set('jane-ai', makeProfile({ networkDistance: 'FIRST_DEGREE' }));
      lead = await seedAi({ firstMessageDraft: ' ' });
      expect((await runInviteAction(e.deps, lead, e.settings)).result).toBe('failed');
      expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'failed', failureReason: 'missing_draft' });
    });
    it('sends the note draft while Settings keeps the AI-written note', async () => {
      expect((await runAi({}, { settings: (s) => ({ ...s, founderInviteNote: 'draft' }) })).result).toBe('invited');
      expect(e.fake.calls.at(-1)).toEqual({ method: 'sendInvitation', args: ['ACoJane', NOTE] });
    });

    describe('while Settings sends the invite-note template to founders', () => {
      const templateMode = (templates?: Partial<Settings['templates']>): Parameters<typeof createTestEngine>[0] => ({
        templates,
        settings: (s) => ({ ...s, founderInviteNote: 'template' }),
      });

      it('invites with the template rendered from the fetched profile, and logs that text', async () => {
        // The stored first name is not the one sent: the profile fetched for this invite wins.
        expect((await runAi({ firstName: 'Janet' }, templateMode())).result).toBe('invited');
        expect(e.fake.calls).toEqual([{ method: 'getProfile', args: ['jane-ai'] }, { method: 'sendInvitation', args: ['ACoJane', 'Hi Jane from Acme'] }]);
        expect((await listEvents(e.db)).at(-1)).toMatchObject({ type: 'invite_sent', leadId: lead.id, payload: { text: 'Hi Jane from Acme', dryRun: false } });
        // The note draft is kept, not sent.
        expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'invite_sent', firstName: 'Jane', inviteNoteDraft: NOTE, updatedAt: NOW });
      });
      it('fails with missing_variable and sends nothing when the template needs a value the profile lacks', async () => {
        expect((await runAi({}, templateMode({ inviteNote: 'About {{position}}' }))).result).toBe('failed');
        expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'failed', failureReason: 'missing_variable: position', failedFromStatus: 'queued' });
        expect(methods()).toEqual(['getProfile']);
        expect((await listEvents(e.db)).map((x) => x.type)).toEqual(['profile_view']);
      });
      it('invites a founder whose note draft is blank', async () => {
        expect((await runAi({ inviteNoteDraft: null }, templateMode())).result).toBe('invited');
        expect(e.fake.calls.at(-1)).toEqual({ method: 'sendInvitation', args: ['ACoJane', 'Hi Jane from Acme'] });
      });
      it('still fails with draft_not_approved and sends nothing when the drafts are not approved', async () => {
        expect((await runAi({ draftStatus: 'ready' }, templateMode())).result).toBe('failed');
        expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'failed', failureReason: 'draft_not_approved' });
        expect(methods()).toEqual(['getProfile']);
      });
      it('still fails with missing_draft and sends nothing when the first message draft is blank', async () => {
        expect((await runAi({ firstMessageDraft: ' ' }, templateMode())).result).toBe('failed');
        expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'failed', failureReason: 'missing_draft', failedFromStatus: 'queued' });
        expect(methods()).toEqual(['getProfile']);
      });
      it('sends no invite when the note draft changed during the profile fetch', async () => {
        e = await createTestEngine(templateMode());
        e.fake.onCall('getProfile', async () => { await e.db.update(leads).set({ inviteNoteDraft: 'A new note' }).where(eq(leads.id, lead.id)); });
        expect((await runAi()).result).toBe('superseded');
        expect(methods()).toEqual(['getProfile']);
        expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'queued', providerId: null, failureReason: null, inviteNoteDraft: 'A new note' });
      });
    });
  });
});
