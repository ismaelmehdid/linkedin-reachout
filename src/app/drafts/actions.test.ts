import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@/db/types';
import { saveSettings } from '@/lib/settings/repo';
import { DEFAULT_SETTINGS } from '@/lib/settings/settings';
import { createTestDb } from '@/test-utils/db';
import { getLead, seedLead } from '@/test-utils/engine';

const { state, revalidated } = vi.hoisted(() => ({ state: { db: null as unknown }, revalidated: [] as string[] }));

vi.mock('@/lib/auth/require-session', () => ({ requireSession: async () => {} }));
vi.mock('@/db/client', () => ({ getDb: async () => state.db }));
vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => {
    revalidated.push(path);
  },
}));

const {
  approveAllReadyDraftsAction,
  approveDraftAction,
  generateNextDraftAction,
  getDraftCountsAction,
  regenerateDraftAction,
  retryFailedDraftsAction,
  saveDraftAction,
} = await import('./actions');

const context = {
  founder: { name: 'Jane Doe', bio: null, pastCompanies: null },
  company: { name: 'Acme', batch: null, website: null, oneLiner: null, description: null, teamSize: null, jobs: [] },
};
const drafts = { inviteNote: 'Hi Jane, coffee?', firstMessage: 'Hi Jane, the full pitch.' };

/** A Responses API answer holding `drafts`, as OpenAI sends it over raw HTTP. */
const openAiAnswer = () =>
  new Response(
    JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(drafts) }] }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

describe('draft actions', () => {
  let db: Db;
  let fetchCalls: string[];

  beforeEach(async () => {
    db = await createTestDb();
    state.db = db;
    revalidated.length = 0;
    fetchCalls = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      return openAiAnswer();
    });
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    vi.stubEnv('OPENAI_MODEL', '');
    expect((await saveSettings(db, { ...DEFAULT_SETTINGS, aboutMe: 'Paris to San Francisco.' })).ok).toBe(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  describe('generateNextDraftAction', () => {
    it('is blocked without an OpenAI key, before taking any lead', async () => {
      vi.stubEnv('OPENAI_API_KEY', '  ');
      const lead = await seedLead(db, { draftStatus: 'pending', context });
      const result = await generateNextDraftAction();
      expect(result).toMatchObject({ status: 'blocked', leadId: null, error: 'missing_api_key' });
      expect(result.counts.pending).toBe(1);
      expect((await getLead(db, lead.id)).draftStatus).toBe('pending');
      expect(fetchCalls).toEqual([]);
    });

    it('is blocked while About me is empty', async () => {
      await saveSettings(db, { ...DEFAULT_SETTINGS, aboutMe: '   ' });
      await seedLead(db, { draftStatus: 'pending', context });
      expect(await generateNextDraftAction()).toMatchObject({ status: 'blocked', error: 'missing_about_me' });
      expect(fetchCalls).toEqual([]);
    });

    it('writes one lead per call, returns the counts, then says none_left', async () => {
      const a = await seedLead(db, { draftStatus: 'pending', context });
      const b = await seedLead(db, { draftStatus: 'pending', context });
      expect(await generateNextDraftAction()).toEqual({
        status: 'ready',
        leadId: a.id,
        error: null,
        counts: { none: 0, pending: 1, generating: 0, ready: 1, approved: 0, failed: 0 },
      });
      expect(fetchCalls).toEqual(['https://api.openai.com/v1/responses']);
      expect(revalidated).toEqual(['/']);
      expect((await generateNextDraftAction()).leadId).toBe(b.id);
      expect(await getLead(db, b.id)).toMatchObject({ draftStatus: 'ready', inviteNoteDraft: drafts.inviteNote });
      expect(await generateNextDraftAction()).toMatchObject({ status: 'none_left', leadId: null, error: null });
    });

    it('returns the failure code of a lead OpenAI did not write', async () => {
      vi.stubGlobal('fetch', async () => new Response('{}', { status: 429 }));
      const lead = await seedLead(db, { draftStatus: 'pending', context });
      expect(await generateNextDraftAction()).toMatchObject({ status: 'failed', leadId: lead.id, error: 'rate_limited' });
      expect((await getLead(db, lead.id)).draftError).toBe('rate_limited');
    });
  });

  it('counts drafts', async () => {
    await seedLead(db, { draftStatus: 'ready' });
    expect((await getDraftCountsAction()).ready).toBe(1);
  });

  it('approves one draft or every ready draft, and retries or regenerates', async () => {
    const a = await seedLead(db, { draftStatus: 'ready', inviteNoteDraft: 'n', firstMessageDraft: 'm' });
    const b = await seedLead(db, { draftStatus: 'ready', inviteNoteDraft: 'n', firstMessageDraft: 'm' });
    const c = await seedLead(db, { draftStatus: 'failed', draftError: 'timeout' });
    expect(await approveDraftAction(b.id, 'an older note')).toEqual({ ok: false });
    expect((await getLead(db, b.id)).draftStatus).toBe('ready');
    expect(await approveDraftAction(a.id, 'n')).toEqual({ ok: true });
    expect((await getLead(db, a.id)).draftStatus).toBe('approved');
    expect(await approveAllReadyDraftsAction()).toBe(1);
    expect((await getLead(db, b.id)).draftStatus).toBe('approved');
    expect(await retryFailedDraftsAction()).toBe(1);
    expect((await getLead(db, c.id)).draftStatus).toBe('pending');
    await regenerateDraftAction(a.id);
    expect(await getLead(db, a.id)).toMatchObject({ draftStatus: 'pending', inviteNoteDraft: null });
    expect(revalidated.length).toBe(5);
  });

  it('refuses a seen note that is not a string', async () => {
    const lead = await seedLead(db, { draftStatus: 'ready', inviteNoteDraft: 'n', firstMessageDraft: 'm' });
    for (const seen of [null, undefined, 1, {}]) {
      await expect(approveDraftAction(lead.id, seen as unknown as string)).rejects.toThrow('Invalid invite note');
    }
  });

  it('refuses a lead id that is not a positive integer', async () => {
    for (const id of [0, -1, 1.5, '1', null]) {
      await expect(approveDraftAction(id as number, 'n')).rejects.toThrow('Invalid lead id');
      await expect(regenerateDraftAction(id as number)).rejects.toThrow('Invalid lead id');
      await expect(saveDraftAction(id as number, drafts)).rejects.toThrow('Invalid lead id');
    }
  });

  describe('saveDraftAction', () => {
    it('saves trimmed texts as approved', async () => {
      const lead = await seedLead(db, { draftStatus: 'ready', inviteNoteDraft: 'n', firstMessageDraft: 'm' });
      expect(await saveDraftAction(lead.id, { inviteNote: ` ${drafts.inviteNote} `, firstMessage: drafts.firstMessage })).toEqual({
        ok: true,
      });
      expect(await getLead(db, lead.id)).toMatchObject({ draftStatus: 'approved', inviteNoteDraft: drafts.inviteNote });
    });

    it('returns the check errors and saves nothing', async () => {
      const lead = await seedLead(db, { draftStatus: 'ready', inviteNoteDraft: 'n', firstMessageDraft: 'm' });
      const result = await saveDraftAction(lead.id, { inviteNote: 'a'.repeat(301), firstMessage: 'Hi {{first_name}}' });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.errors).toHaveLength(2);
      expect((await getLead(db, lead.id)).draftStatus).toBe('ready');
    });

    it('says which part was refused past the invite', async () => {
      const sent = await seedLead(db, { status: 'invite_sent', draftStatus: 'approved', inviteNoteDraft: 'n', firstMessageDraft: 'm' });
      const result = await saveDraftAction(sent.id, { inviteNote: 'changed', firstMessage: 'new message' });
      expect(result).toEqual({ ok: false, errors: [expect.stringMatching(/^Invite note: /)] });
      expect((await getLead(db, sent.id)).firstMessageDraft).toBe('new message');

      const messaged = await seedLead(db, { status: 'messaged', draftStatus: 'approved', inviteNoteDraft: 'n', firstMessageDraft: 'm' });
      expect(await saveDraftAction(messaged.id, drafts)).toEqual({ ok: false, errors: [expect.stringMatching(/^Drafts: /)] });
    });

    it('refuses a payload that is not two strings', async () => {
      const lead = await seedLead(db, { draftStatus: 'ready' });
      for (const payload of [null, 'text', { inviteNote: 'a' }, { inviteNote: 'a', firstMessage: 1 }, { ...drafts, extra: 'x' }]) {
        await expect(saveDraftAction(lead.id, payload)).rejects.toThrow('Invalid draft texts');
      }
    });
  });
});
