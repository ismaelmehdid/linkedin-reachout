import { beforeEach, describe, expect, it } from 'vitest';
import type { Lead } from '@/db/schema';
import type { Db } from '@/db/types';
import { createTestDb } from '@/test-utils/db';
import { NOW, getLead, seedLead } from '@/test-utils/engine';
import {
  approveAllReadyDrafts,
  approveDraft,
  claimNextDraft,
  countDrafts,
  failDraft,
  requeueDraft,
  retryFailedDrafts,
  saveEditedDraft,
  saveGeneratedDraft,
} from './repo';

const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const OLD = minutesAgo(60);
const texts = { inviteNote: 'Hi Jane, coffee?', firstMessage: 'Hi Jane, the full pitch.' };
const drafted = { inviteNoteDraft: 'old note', firstMessageDraft: 'old message' };

/** The columns a draft function may change, to check that a refused call changed nothing. */
const draftColumns = (lead: Lead) => ({
  draftStatus: lead.draftStatus,
  inviteNoteDraft: lead.inviteNoteDraft,
  firstMessageDraft: lead.firstMessageDraft,
  draftError: lead.draftError,
  draftClaimedAt: lead.draftClaimedAt,
  updatedAt: lead.updatedAt,
});

describe('draft repository', () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
  });

  it('counts leads for every draft status, zeros included', async () => {
    await seedLead(db);
    await seedLead(db, { draftStatus: 'pending' });
    await seedLead(db, { draftStatus: 'pending' });
    await seedLead(db, { draftStatus: 'failed' });
    expect(await countDrafts(db)).toEqual({ none: 1, pending: 2, generating: 0, ready: 0, approved: 0, failed: 1 });
  });

  describe('claimNextDraft', () => {
    it('takes pending queued leads one at a time, lowest id first, then none', async () => {
      const a = await seedLead(db, { draftStatus: 'pending', updatedAt: OLD });
      const b = await seedLead(db, { draftStatus: 'pending' });
      const first = await claimNextDraft(db, NOW);
      const second = await claimNextDraft(db, NOW);
      expect([first?.id, second?.id]).toEqual([a.id, b.id]);
      expect(first).toMatchObject({ draftStatus: 'generating', draftClaimedAt: NOW, updatedAt: NOW });
      expect(await claimNextDraft(db, NOW)).toBeNull();
    });

    it('takes two different leads when two claims run at once', async () => {
      await seedLead(db, { draftStatus: 'pending' });
      await seedLead(db, { draftStatus: 'pending' });
      const [x, y] = await Promise.all([claimNextDraft(db, NOW), claimNextDraft(db, NOW)]);
      expect(x).not.toBeNull();
      expect(y).not.toBeNull();
      expect(x?.id).not.toBe(y?.id);
    });

    it('takes back a lead claimed more than 5 minutes ago, never a fresh one', async () => {
      await seedLead(db, { draftStatus: 'generating', draftClaimedAt: minutesAgo(4) });
      await seedLead(db, { draftStatus: 'generating', draftClaimedAt: minutesAgo(5) });
      expect(await claimNextDraft(db, NOW)).toBeNull();
      const stale = await seedLead(db, { draftStatus: 'generating', draftClaimedAt: minutesAgo(6) });
      expect((await claimNextDraft(db, NOW))?.id).toBe(stale.id);
    });

    it('never takes a lead past the queue, nor a none, ready, approved or failed lead', async () => {
      await seedLead(db, { draftStatus: 'pending', status: 'invite_sent' });
      await seedLead(db, { draftStatus: 'pending', status: 'failed' });
      for (const draftStatus of ['none', 'ready', 'approved', 'failed'] as const) await seedLead(db, { draftStatus });
      expect(await claimNextDraft(db, NOW)).toBeNull();
    });
  });

  describe('saving a generation', () => {
    it('stores a generated draft as ready and clears the last error', async () => {
      const lead = await seedLead(db, { draftStatus: 'generating', draftError: 'timeout', draftClaimedAt: OLD });
      expect(await saveGeneratedDraft(db, lead.id, texts, NOW)).toBe(true);
      expect(await getLead(db, lead.id)).toMatchObject({
        draftStatus: 'ready',
        inviteNoteDraft: texts.inviteNote,
        firstMessageDraft: texts.firstMessage,
        draftError: null,
        draftClaimedAt: null,
        updatedAt: NOW,
      });
    });

    it('fails a lead with the reason', async () => {
      const lead = await seedLead(db, { draftStatus: 'generating' });
      expect(await failDraft(db, lead.id, 'rate_limited', NOW)).toBe(true);
      expect(await getLead(db, lead.id)).toMatchObject({ draftStatus: 'failed', draftError: 'rate_limited', updatedAt: NOW });
    });

    it('leaves alone a lead that is no longer generating', async () => {
      const lead = await seedLead(db, { draftStatus: 'approved', ...drafted, updatedAt: OLD });
      const before = draftColumns(lead);
      expect(await saveGeneratedDraft(db, lead.id, texts, NOW)).toBe(false);
      expect(await failDraft(db, lead.id, 'timeout', NOW)).toBe(false);
      expect(draftColumns(await getLead(db, lead.id))).toEqual(before);
      expect(await saveGeneratedDraft(db, 999_999, texts, NOW)).toBe(false);
    });

    it('refuses to store a text holding {{', async () => {
      const lead = await seedLead(db, { draftStatus: 'generating' });
      await expect(saveGeneratedDraft(db, lead.id, { ...texts, inviteNote: 'Hi {{first_name}}' }, NOW)).rejects.toThrow();
      expect((await getLead(db, lead.id)).draftStatus).toBe('generating');
    });
  });

  describe('approving', () => {
    it('approves a ready draft, and nothing else', async () => {
      const ready = await seedLead(db, { draftStatus: 'ready', ...drafted, updatedAt: OLD });
      expect(await approveDraft(db, ready.id, NOW)).toBe(true);
      expect(await getLead(db, ready.id)).toMatchObject({ draftStatus: 'approved', ...drafted, updatedAt: NOW });
      for (const draftStatus of ['none', 'pending', 'failed'] as const) {
        const lead = await seedLead(db, { draftStatus, updatedAt: OLD });
        expect(await approveDraft(db, lead.id, NOW)).toBe(false);
        expect(await getLead(db, lead.id)).toMatchObject({ draftStatus, updatedAt: OLD });
      }
    });

    it('approves every ready draft of a queued lead and counts them', async () => {
      const a = await seedLead(db, { draftStatus: 'ready', ...drafted });
      const b = await seedLead(db, { draftStatus: 'ready', ...drafted });
      const pastQueue = await seedLead(db, { draftStatus: 'ready', status: 'invite_sent' });
      const pending = await seedLead(db, { draftStatus: 'pending' });
      expect(await approveAllReadyDrafts(db, NOW)).toBe(2);
      expect((await getLead(db, a.id)).draftStatus).toBe('approved');
      expect(await getLead(db, b.id)).toMatchObject({ draftStatus: 'approved', updatedAt: NOW });
      expect((await getLead(db, pastQueue.id)).draftStatus).toBe('ready');
      expect((await getLead(db, pending.id)).draftStatus).toBe('pending');
      expect(await approveAllReadyDrafts(db, NOW)).toBe(0);
    });
  });

  describe('requeueing', () => {
    it('sends a ready, approved or failed draft of a queued lead back to pending, cleared', async () => {
      for (const draftStatus of ['ready', 'approved', 'failed'] as const) {
        const lead = await seedLead(db, { draftStatus, ...drafted, draftError: 'x', draftClaimedAt: OLD });
        expect(await requeueDraft(db, lead.id, NOW)).toBe(true);
        expect(await getLead(db, lead.id)).toMatchObject({
          draftStatus: 'pending',
          inviteNoteDraft: null,
          firstMessageDraft: null,
          draftError: null,
          draftClaimedAt: null,
          updatedAt: NOW,
        });
      }
    });

    it('refuses a none, pending or generating draft, and a lead past the queue', async () => {
      const leads = [
        await seedLead(db, { draftStatus: 'none', updatedAt: OLD }),
        await seedLead(db, { draftStatus: 'pending', updatedAt: OLD }),
        await seedLead(db, { draftStatus: 'generating', draftClaimedAt: NOW, updatedAt: OLD }),
        await seedLead(db, { draftStatus: 'approved', status: 'invite_sent', ...drafted, updatedAt: OLD }),
      ];
      for (const lead of leads) {
        expect(await requeueDraft(db, lead.id, NOW)).toBe(false);
        expect(draftColumns(await getLead(db, lead.id))).toEqual(draftColumns(lead));
      }
    });

    it('retries every failed draft of a queued lead and counts them', async () => {
      const a = await seedLead(db, { draftStatus: 'failed', draftError: 'timeout' });
      const b = await seedLead(db, { draftStatus: 'failed', draftError: 'refused' });
      const pastQueue = await seedLead(db, { draftStatus: 'failed', status: 'failed' });
      const ready = await seedLead(db, { draftStatus: 'ready', ...drafted });
      expect(await retryFailedDrafts(db, NOW)).toBe(2);
      expect(await getLead(db, a.id)).toMatchObject({ draftStatus: 'pending', draftError: null, updatedAt: NOW });
      expect((await getLead(db, b.id)).draftStatus).toBe('pending');
      expect((await getLead(db, pastQueue.id)).draftStatus).toBe('failed');
      expect((await getLead(db, ready.id)).draftStatus).toBe('ready');
    });
  });

  describe('saveEditedDraft', () => {
    it('saves both texts of a queued lead as approved, whatever its draft status but none', async () => {
      for (const draftStatus of ['pending', 'generating', 'ready', 'approved', 'failed'] as const) {
        const lead = await seedLead(db, { draftStatus, ...drafted, draftError: 'x', updatedAt: OLD });
        expect(await saveEditedDraft(db, lead.id, texts, NOW)).toEqual({ ok: true });
        expect(await getLead(db, lead.id)).toMatchObject({
          draftStatus: 'approved',
          inviteNoteDraft: texts.inviteNote,
          firstMessageDraft: texts.firstMessage,
          draftError: null,
          updatedAt: NOW,
        });
      }
    });

    it('keeps a generation that ends after the edit from overwriting it', async () => {
      const lead = await seedLead(db, { draftStatus: 'generating', draftClaimedAt: NOW });
      await saveEditedDraft(db, lead.id, texts, NOW);
      expect(await saveGeneratedDraft(db, lead.id, { inviteNote: 'AI note', firstMessage: 'AI message' }, NOW)).toBe(false);
      expect((await getLead(db, lead.id)).inviteNoteDraft).toBe(texts.inviteNote);
    });

    it('saves only the first message once the invite is sent, and refuses a changed note', async () => {
      for (const status of ['invite_sent', 'accepted', 'already_connected'] as const) {
        const lead = await seedLead(db, { status, draftStatus: 'approved', ...drafted, updatedAt: OLD });
        expect(await saveEditedDraft(db, lead.id, { inviteNote: drafted.inviteNoteDraft, firstMessage: 'new message' }, NOW)).toEqual({
          ok: true,
        });
        expect(await getLead(db, lead.id)).toMatchObject({
          draftStatus: 'approved',
          inviteNoteDraft: drafted.inviteNoteDraft,
          firstMessageDraft: 'new message',
          updatedAt: NOW,
        });

        expect(await saveEditedDraft(db, lead.id, { inviteNote: 'changed note', firstMessage: 'newer message' }, NOW)).toEqual({
          ok: false,
          refused: ['inviteNote'],
        });
        expect(await getLead(db, lead.id)).toMatchObject({
          inviteNoteDraft: drafted.inviteNoteDraft,
          firstMessageDraft: 'newer message',
        });
      }
    });

    it('refuses both texts once the first message is sent, for a none draft, and for a missing lead', async () => {
      const leads = [
        await seedLead(db, { status: 'messaged', draftStatus: 'approved', ...drafted, updatedAt: OLD }),
        await seedLead(db, { status: 'followup_1', draftStatus: 'approved', ...drafted, updatedAt: OLD }),
        await seedLead(db, { draftStatus: 'none', updatedAt: OLD }),
        await seedLead(db, { status: 'accepted', draftStatus: 'none', updatedAt: OLD }),
      ];
      for (const lead of leads) {
        expect(await saveEditedDraft(db, lead.id, texts, NOW)).toEqual({ ok: false, refused: ['inviteNote', 'firstMessage'] });
        expect(draftColumns(await getLead(db, lead.id))).toEqual(draftColumns(lead));
      }
      expect(await saveEditedDraft(db, 999_999, texts, NOW)).toEqual({ ok: false, refused: ['inviteNote', 'firstMessage'] });
    });

    it('refuses to store an invalid text', async () => {
      const lead = await seedLead(db, { draftStatus: 'ready', ...drafted });
      await expect(saveEditedDraft(db, lead.id, { ...texts, firstMessage: 'Hi {{first_name}}' }, NOW)).rejects.toThrow();
      await expect(saveEditedDraft(db, lead.id, { ...texts, inviteNote: 'a'.repeat(301) }, NOW)).rejects.toThrow();
      expect((await getLead(db, lead.id)).draftStatus).toBe('ready');
    });
  });
});
