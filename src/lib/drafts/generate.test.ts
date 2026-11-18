import { beforeEach, describe, expect, it } from 'vitest';
import { leads, type LeadContext } from '@/db/schema';
import type { Db } from '@/db/types';
import { DraftWriterError, OPENAI_TIMEOUT_MS, type DraftPrompt, type DraftTexts, type DraftWriter } from '@/lib/openai/client';
import { createTestDb } from '@/test-utils/db';
import { NOW, getLead, seedLead } from '@/test-utils/engine';
import { GENERATION_DEADLINE_MS, generateOneDraft } from './generate';

const ABOUT_ME = 'Moved from Paris to San Francisco.';

const context: LeadContext = {
  founder: { name: 'Jane Doe', bio: null, pastCompanies: null },
  company: { name: 'Acme', batch: 'W26', website: null, oneLiner: 'Robots', description: null, teamSize: 3, jobs: [] },
};

const good: DraftTexts = { inviteNote: 'Hi Jane, coffee?', firstMessage: 'Hi Jane, the full pitch.' };

/** A writer that answers each call with the next entry: texts, or an error to throw. */
function fakeWriter(answers: Array<DraftTexts | Error>): DraftWriter & { prompts: DraftPrompt[] } {
  const prompts: DraftPrompt[] = [];
  return {
    prompts,
    async write(prompt) {
      prompts.push(prompt);
      const next = answers.shift();
      if (next === undefined) throw new Error('unexpected call');
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

describe('generateOneDraft', () => {
  let db: Db;
  const now = () => NOW;
  beforeEach(async () => {
    db = await createTestDb();
  });

  it('says none_left when no lead is waiting, without calling the writer', async () => {
    await seedLead(db, { draftStatus: 'ready', context });
    const writer = fakeWriter([]);
    expect(await generateOneDraft({ db, writer, aboutMe: ABOUT_ME, now })).toEqual({ status: 'none_left' });
    expect(writer.prompts).toEqual([]);
  });

  it('writes the drafts of a pending lead from its context and stores them trimmed as ready', async () => {
    const lead = await seedLead(db, { draftStatus: 'pending', context });
    const writer = fakeWriter([{ inviteNote: `  ${good.inviteNote}\n`, firstMessage: `${good.firstMessage} ` }]);
    expect(await generateOneDraft({ db, writer, aboutMe: ABOUT_ME, now })).toEqual({ status: 'ready', leadId: lead.id });
    expect(writer.prompts[0].user).toContain(ABOUT_ME);
    expect(writer.prompts[0].user).toContain('Acme');
    expect(await getLead(db, lead.id)).toMatchObject({
      draftStatus: 'ready',
      inviteNoteDraft: good.inviteNote,
      firstMessageDraft: good.firstMessage,
      draftError: null,
      updatedAt: NOW,
    });
  });

  it('retries a note over 300 characters once, with its length in the prompt', async () => {
    const lead = await seedLead(db, { draftStatus: 'pending', context });
    const writer = fakeWriter([{ ...good, inviteNote: 'a'.repeat(320) }, good]);
    expect(await generateOneDraft({ db, writer, aboutMe: ABOUT_ME, now })).toEqual({ status: 'ready', leadId: lead.id });
    expect(writer.prompts).toHaveLength(2);
    expect(writer.prompts[0].user).not.toMatch(/320 characters/);
    expect(writer.prompts[1].user).toMatch(/320 characters/);
    expect((await getLead(db, lead.id)).inviteNoteDraft).toBe(good.inviteNote);
  });

  it('gives the first call and the retry one shared deadline', async () => {
    const lead = await seedLead(db, { draftStatus: 'pending', context });
    let clock = NOW.getTime();
    const timeouts: Array<number | undefined> = [];
    const answers = [{ ...good, inviteNote: 'a'.repeat(320) }, good];
    const writer: DraftWriter = {
      async write(_prompt, options) {
        timeouts.push(options?.timeoutMs);
        clock += 60_000;
        return answers.shift()!;
      },
    };
    const result = await generateOneDraft({ db, writer, aboutMe: ABOUT_ME, now: () => new Date(clock) });
    expect(result).toEqual({ status: 'ready', leadId: lead.id });
    expect(timeouts).toEqual([OPENAI_TIMEOUT_MS, GENERATION_DEADLINE_MS - 60_000]);
  });

  it('skips the retry and fails note_too_long when too little time is left', async () => {
    const lead = await seedLead(db, { draftStatus: 'pending', context });
    let clock = NOW.getTime();
    let calls = 0;
    const writer: DraftWriter = {
      async write() {
        calls += 1;
        clock += GENERATION_DEADLINE_MS - 14_000;
        return { ...good, inviteNote: 'a'.repeat(320) };
      },
    };
    expect(await generateOneDraft({ db, writer, aboutMe: ABOUT_ME, now: () => new Date(clock) })).toEqual({
      status: 'failed',
      leadId: lead.id,
      error: 'note_too_long: 320/300',
    });
    expect(calls).toBe(1);
  });

  it('fails the lead with note_too_long when the retry is still too long', async () => {
    const lead = await seedLead(db, { draftStatus: 'pending', context });
    const writer = fakeWriter([
      { ...good, inviteNote: 'a'.repeat(320) },
      { ...good, inviteNote: 'a'.repeat(305) },
    ]);
    expect(await generateOneDraft({ db, writer, aboutMe: ABOUT_ME, now })).toEqual({
      status: 'failed',
      leadId: lead.id,
      error: 'note_too_long: 305/300',
    });
    expect(writer.prompts).toHaveLength(2);
    expect(await getLead(db, lead.id)).toMatchObject({
      draftStatus: 'failed',
      draftError: 'note_too_long: 305/300',
      inviteNoteDraft: null,
      updatedAt: NOW,
    });
  });

  it('fails the lead with invalid_output, without a retry, for an empty text or a {{', async () => {
    for (const texts of [
      { ...good, firstMessage: '   ' },
      { ...good, inviteNote: 'Hi {{first_name}}' },
      { inviteNote: 'a'.repeat(320), firstMessage: '' },
    ]) {
      const lead = await seedLead(db, { draftStatus: 'pending', context });
      const writer = fakeWriter([texts]);
      expect(await generateOneDraft({ db, writer, aboutMe: ABOUT_ME, now })).toEqual({
        status: 'failed',
        leadId: lead.id,
        error: 'invalid_output',
      });
      expect(writer.prompts).toHaveLength(1);
      expect(await getLead(db, lead.id)).toMatchObject({ draftStatus: 'failed', draftError: 'invalid_output', inviteNoteDraft: null });
    }
  });

  it('fails the lead with the writer error code, or unexpected_error for any other error', async () => {
    const a = await seedLead(db, { draftStatus: 'pending', context });
    const rateLimited = fakeWriter([new DraftWriterError('rate_limited', 'OpenAI answered 429')]);
    expect(await generateOneDraft({ db, writer: rateLimited, aboutMe: ABOUT_ME, now })).toEqual({
      status: 'failed',
      leadId: a.id,
      error: 'rate_limited',
    });
    expect((await getLead(db, a.id)).draftError).toBe('rate_limited');

    const b = await seedLead(db, { draftStatus: 'pending', context });
    const broken = fakeWriter([new Error('something with sk-secret inside')]);
    expect(await generateOneDraft({ db, writer: broken, aboutMe: ABOUT_ME, now })).toEqual({
      status: 'failed',
      leadId: b.id,
      error: 'unexpected_error',
    });
    expect((await getLead(db, b.id)).draftError).toBe('unexpected_error');
  });

  it('fails a lead without context with missing_context, without calling the writer', async () => {
    const lead = await seedLead(db, { draftStatus: 'pending', context: null });
    const writer = fakeWriter([]);
    expect(await generateOneDraft({ db, writer, aboutMe: ABOUT_ME, now })).toEqual({
      status: 'failed',
      leadId: lead.id,
      error: 'missing_context',
    });
    expect(await getLead(db, lead.id)).toMatchObject({ draftStatus: 'failed', draftError: 'missing_context' });
  });

  it('keeps an edit the owner saved while the drafts were being written', async () => {
    const lead = await seedLead(db, { draftStatus: 'pending', context });
    const writer: DraftWriter = {
      async write() {
        await db.update(leads).set({ draftStatus: 'approved', inviteNoteDraft: 'mine' });
        return good;
      },
    };
    expect(await generateOneDraft({ db, writer, aboutMe: ABOUT_ME, now })).toEqual({
      status: 'failed',
      leadId: lead.id,
      error: 'lead_changed',
    });
    expect(await getLead(db, lead.id)).toMatchObject({ draftStatus: 'approved', inviteNoteDraft: 'mine', draftError: null });
  });
});
