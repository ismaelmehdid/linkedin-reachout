'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getDb } from '@/db/client';
import type { DraftStatus } from '@/db/schema';
import { requireSession } from '@/lib/auth/require-session';
import { generateOneDraft } from '@/lib/drafts/generate';
import {
  approveAllReadyDrafts,
  approveDraft,
  countDrafts,
  requeueDraft,
  retryFailedDrafts,
  saveEditedDraft,
} from '@/lib/drafts/repo';
import { checkDraftTexts } from '@/lib/drafts/validate';
import { createDraftWriter } from '@/lib/openai/client';
import { readOpenAiConfig } from '@/lib/openai/config';
import { getSettings } from '@/lib/settings/repo';

// Every action below calls requireSession() first: an action runs as a POST to the page that sends it,
// so the request filter alone does not protect it. The page that calls generateNextDraftAction must allow
// one generation in its `maxDuration` (120 s); the OpenAI request gives up at 100 s.

export type DraftCounts = Record<DraftStatus, number>;

/** An action's arguments come from the client, so a lead id is checked before it reaches a query. */
function checkLeadId(id: unknown): number {
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid lead id');
  return id;
}

// Generous bounds that only stop an absurd payload; the real limits are checked by checkDraftTexts.
const draftTextsSchema = z.strictObject({ inviteNote: z.string().max(20_000), firstMessage: z.string().max(20_000) });

/**
 * Takes one lead waiting for drafts and writes them. `blocked` (before any lead is taken) when the OpenAI
 * key or the owner's "About me" is missing. The browser calls it again until `none_left`.
 */
export async function generateNextDraftAction(): Promise<{
  status: 'none_left' | 'ready' | 'failed' | 'blocked';
  leadId: number | null;
  error: string | null;
  counts: DraftCounts;
}> {
  await requireSession();
  const db = await getDb();
  const { apiKey, model } = readOpenAiConfig();
  const blocked = async (error: string) => ({ status: 'blocked' as const, leadId: null, error, counts: await countDrafts(db) });
  if (apiKey === null) return blocked('missing_api_key');
  const { aboutMe } = await getSettings(db);
  if (aboutMe.trim() === '') return blocked('missing_about_me');

  const result = await generateOneDraft({
    db,
    writer: createDraftWriter({ apiKey, model }),
    aboutMe,
    now: () => new Date(),
  });
  if (result.status === 'none_left') return { status: 'none_left', leadId: null, error: null, counts: await countDrafts(db) };
  revalidatePath('/');
  return { status: result.status, leadId: result.leadId, error: result.error ?? null, counts: await countDrafts(db) };
}

/** Reads only, so nothing is revalidated. */
export async function getDraftCountsAction(): Promise<DraftCounts> {
  await requireSession();
  return countDrafts(await getDb());
}

/**
 * `seenInviteNote` is the note the owner read. `ok: false` when the draft is no longer ready or was
 * rewritten since: the refreshed table shows the current draft, to review again.
 */
export async function approveDraftAction(id: number, seenInviteNote: string): Promise<{ ok: boolean }> {
  await requireSession();
  const leadId = checkLeadId(id);
  if (typeof seenInviteNote !== 'string') throw new Error('Invalid invite note');
  const ok = await approveDraft(await getDb(), leadId, seenInviteNote, new Date());
  revalidatePath('/');
  return { ok };
}

/** Returns how many drafts were approved. */
export async function approveAllReadyDraftsAction(): Promise<number> {
  await requireSession();
  const approved = await approveAllReadyDrafts(await getDb(), new Date());
  revalidatePath('/');
  return approved;
}

/** Sends the lead back to `pending` only; the page then runs generation. Does nothing past the invite. */
export async function regenerateDraftAction(id: number): Promise<void> {
  await requireSession();
  const leadId = checkLeadId(id);
  await requeueDraft(await getDb(), leadId, new Date());
  revalidatePath('/');
}

/** Returns how many failed drafts went back to `pending`. */
export async function retryFailedDraftsAction(): Promise<number> {
  await requireSession();
  const retried = await retryFailedDrafts(await getDb(), new Date());
  revalidatePath('/');
  return retried;
}

/** Saves the owner's edit as approved. Texts are trimmed; `errors` are shown to the owner as they are. */
export async function saveDraftAction(id: number, texts: unknown): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  await requireSession();
  const leadId = checkLeadId(id);
  const parsed = draftTextsSchema.safeParse(texts);
  if (!parsed.success) throw new Error('Invalid draft texts');
  const trimmed = { inviteNote: parsed.data.inviteNote.trim(), firstMessage: parsed.data.firstMessage.trim() };

  const errors = checkDraftTexts(trimmed);
  if (errors.length > 0) return { ok: false, errors };

  const result = await saveEditedDraft(await getDb(), leadId, trimmed, new Date());
  revalidatePath('/');
  if (result.ok) return result;
  if (result.refused.includes('firstMessage')) {
    return { ok: false, errors: ['Drafts: this lead can no longer be edited (its first message was sent, or it has no AI drafts)'] };
  }
  return { ok: false, errors: ['Invite note: can no longer be changed, the invite was sent. The first message was saved.'] };
}
