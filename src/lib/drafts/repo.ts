import { and, eq, inArray, lt, ne, or, sql } from 'drizzle-orm';
import { DRAFT_STATUSES, leads, type DraftStatus, type Lead, type LeadStatus } from '@/db/schema';
import type { Db } from '@/db/types';
import type { DraftTexts } from '@/lib/openai/client';
import { checkDraftTexts } from './validate';

// Every function here is one conditional statement (neon-http has no transactions), and none of them ever
// touches a lead whose draft status is `none`: a pasted lead uses the templates.

/** A generation that took a lead longer ago than this has died, and the lead can be taken again. */
export const DRAFT_CLAIM_STALE_MS = 5 * 60_000;

/** A first message can still be edited while the lead is in one of these: it has not been sent. */
const FIRST_MESSAGE_EDITABLE: LeadStatus[] = ['queued', 'invite_sent', 'accepted', 'already_connected'];

/** The draft statuses that can be sent back to `pending` for a new generation. */
const REQUEUEABLE: DraftStatus[] = ['ready', 'approved', 'failed'];

const clearedDrafts = { inviteNoteDraft: null, firstMessageDraft: null, draftError: null, draftClaimedAt: null };

/** Throws on a text that must never be stored as sendable: callers check the texts first. */
function assertSendable(texts: DraftTexts): void {
  const errors = checkDraftTexts(texts);
  if (errors.length > 0) throw new Error(`Invalid draft texts: ${errors.join('; ')}`);
}

export async function countDrafts(db: Db): Promise<Record<DraftStatus, number>> {
  const rows = await db
    .select({ status: leads.draftStatus, count: sql<number>`count(*)`.mapWith(Number) })
    .from(leads)
    .groupBy(leads.draftStatus);
  const counts = Object.fromEntries(DRAFT_STATUSES.map((status) => [status, 0])) as Record<DraftStatus, number>;
  for (const row of rows) if (row.status in counts) counts[row.status] = row.count;
  return counts;
}

/**
 * Takes one queued lead for a generation: a `pending` one, or a `generating` one whose claim is stale.
 * One statement, with `SKIP LOCKED`, so two workers never take the same lead. Null when none is left.
 */
export async function claimNextDraft(db: Db, now: Date): Promise<Lead | null> {
  const staleBefore = new Date(now.getTime() - DRAFT_CLAIM_STALE_MS);
  const next = db
    .select({ id: leads.id })
    .from(leads)
    .where(
      and(
        eq(leads.status, 'queued'),
        or(eq(leads.draftStatus, 'pending'), and(eq(leads.draftStatus, 'generating'), lt(leads.draftClaimedAt, staleBefore))),
      ),
    )
    .orderBy(leads.id)
    .limit(1)
    .for('update', { skipLocked: true });
  const [lead] = await db
    .update(leads)
    .set({ draftStatus: 'generating', draftClaimedAt: now, updatedAt: now })
    .where(sql`${leads.id} = (${next})`)
    .returning();
  return lead ?? null;
}

/** Only while the lead is still `generating`: a lead edited, requeued or removed meanwhile is left alone. */
export async function saveGeneratedDraft(db: Db, id: number, texts: DraftTexts, now: Date): Promise<boolean> {
  assertSendable(texts);
  const saved = await db
    .update(leads)
    .set({
      draftStatus: 'ready',
      inviteNoteDraft: texts.inviteNote,
      firstMessageDraft: texts.firstMessage,
      draftError: null,
      draftClaimedAt: null,
      updatedAt: now,
    })
    .where(and(eq(leads.id, id), eq(leads.draftStatus, 'generating')))
    .returning({ id: leads.id });
  return saved.length > 0;
}

/** Only while the lead is still `generating`. `reason` is a short code, never an OpenAI response. */
export async function failDraft(db: Db, id: number, reason: string, now: Date): Promise<boolean> {
  const failed = await db
    .update(leads)
    .set({ draftStatus: 'failed', ...clearedDrafts, draftError: reason, updatedAt: now })
    .where(and(eq(leads.id, id), eq(leads.draftStatus, 'generating')))
    .returning({ id: leads.id });
  return failed.length > 0;
}

export async function approveDraft(db: Db, id: number, now: Date): Promise<boolean> {
  const approved = await db
    .update(leads)
    .set({ draftStatus: 'approved', updatedAt: now })
    .where(and(eq(leads.id, id), eq(leads.draftStatus, 'ready')))
    .returning({ id: leads.id });
  return approved.length > 0;
}

/** Only the ready drafts of queued leads. Returns how many were approved. */
export async function approveAllReadyDrafts(db: Db, now: Date): Promise<number> {
  const approved = await db
    .update(leads)
    .set({ draftStatus: 'approved', updatedAt: now })
    .where(and(eq(leads.status, 'queued'), eq(leads.draftStatus, 'ready')))
    .returning({ id: leads.id });
  return approved.length;
}

/**
 * Sends a ready, approved or failed draft back to `pending`, with its texts cleared, so the next generation
 * writes it again and it needs a new approval. Only while the lead is queued: past the invite, a lead keeps
 * its drafts.
 */
export async function requeueDraft(db: Db, id: number, now: Date): Promise<boolean> {
  const requeued = await db
    .update(leads)
    .set({ draftStatus: 'pending', ...clearedDrafts, updatedAt: now })
    .where(and(eq(leads.id, id), eq(leads.status, 'queued'), inArray(leads.draftStatus, REQUEUEABLE)))
    .returning({ id: leads.id });
  return requeued.length > 0;
}

/** Every failed draft of a queued lead back to `pending`. Returns how many. */
export async function retryFailedDrafts(db: Db, now: Date): Promise<number> {
  const retried = await db
    .update(leads)
    .set({ draftStatus: 'pending', ...clearedDrafts, updatedAt: now })
    .where(and(eq(leads.status, 'queued'), eq(leads.draftStatus, 'failed')))
    .returning({ id: leads.id });
  return retried.length;
}

export type DraftPart = 'inviteNote' | 'firstMessage';

/** `refused`: the parts that were not saved. A refused first message means nothing was saved. */
export type SaveEditedDraftResult = { ok: true } | { ok: false; refused: DraftPart[] };

/**
 * Saves the owner's texts as `approved`. The note may change only while the lead is queued (it goes with
 * the invite); the first message while it has not been sent. Past the invite, a note equal to the stored
 * one is no change and is not refused. A save during a generation wins: the generation's result is then
 * dropped, since it only saves a lead that is still `generating`.
 */
export async function saveEditedDraft(db: Db, id: number, texts: DraftTexts, now: Date): Promise<SaveEditedDraftResult> {
  assertSendable(texts);
  const hasDrafts = ne(leads.draftStatus, 'none');

  const both = await db
    .update(leads)
    .set({
      draftStatus: 'approved',
      inviteNoteDraft: texts.inviteNote,
      firstMessageDraft: texts.firstMessage,
      draftError: null,
      draftClaimedAt: null,
      updatedAt: now,
    })
    .where(and(eq(leads.id, id), eq(leads.status, 'queued'), hasDrafts))
    .returning({ id: leads.id });
  if (both.length > 0) return { ok: true };

  // The lead was not queued: the invite is sent, or the first message too, or the lead is gone.
  const pastInvite = FIRST_MESSAGE_EDITABLE.filter((status) => status !== 'queued');
  const [message] = await db
    .update(leads)
    .set({ draftStatus: 'approved', firstMessageDraft: texts.firstMessage, draftError: null, updatedAt: now })
    .where(and(eq(leads.id, id), inArray(leads.status, pastInvite), hasDrafts))
    .returning({ inviteNoteDraft: leads.inviteNoteDraft });
  if (message === undefined) return { ok: false, refused: ['inviteNote', 'firstMessage'] };
  return message.inviteNoteDraft === texts.inviteNote ? { ok: true } : { ok: false, refused: ['inviteNote'] };
}
