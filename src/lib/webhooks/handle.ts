import { and, asc, eq, or, sql, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { leads, type Lead, type LeadStatus } from '@/db/schema';
import type { Db } from '@/db/types';
import { logEvent } from '@/lib/engine/events';
import { ECHO_WINDOW_MS, firstMessageDueAt, nextDueAfterSend } from '@/lib/engine/steps';
import { getSettings } from '@/lib/settings/repo';
import { parseWebhookPayload, type WebhookEvent } from './parse';

export type WebhookOutcome = 'ignored' | 'unknown_lead' | 'replied' | 'acceptance_check' | 'accepted' | 'manual_message';

export type WebhookResult = { outcome: WebhookOutcome; leadId: number | null };

export type WebhookOptions = { accountId: string; now: Date; random: () => number };

type MessageEvent = Extract<WebhookEvent, { kind: 'message' }>;
type RelationEvent = Extract<WebhookEvent, { kind: 'new_relation' }>;

const UNKNOWN_LEAD: WebhookResult = { outcome: 'unknown_lead', leadId: null };

const ignored = (leadId: number | null): WebhookResult => ({ outcome: 'ignored', leadId });

/** Sets the chat only when the lead has none yet, in the same statement. */
const chatIdIfNone = (chatId: string) => sql`coalesce(${leads.chatId}, ${chatId})`;

/**
 * Updates one lead and stamps `updatedAt`. With `whenStatus`, it is compare-and-set: the row changes
 * only while the lead is still in that status. Returns whether a row matched.
 */
async function updateLead(
  db: Db,
  leadId: number,
  whenStatus: LeadStatus | null,
  patch: PgUpdateSetSource<typeof leads>,
  now: Date,
): Promise<boolean> {
  const where = whenStatus === null ? eq(leads.id, leadId) : and(eq(leads.id, leadId), eq(leads.status, whenStatus));
  const rows = await db
    .update(leads)
    .set({ ...patch, updatedAt: now })
    .where(where)
    .returning({ id: leads.id });
  return rows.length > 0;
}

async function findLeadByProviderId(db: Db, providerId: string): Promise<Lead | undefined> {
  const [lead] = await db.select().from(leads).where(eq(leads.providerId, providerId));
  return lead;
}

/** Any message from the lead stops their sequence for good, so it wins over the engine: no condition on status. */
async function handleReply(db: Db, event: MessageEvent, opts: WebhookOptions): Promise<WebhookResult> {
  const lead = await findLeadByProviderId(db, event.senderProviderId);
  if (!lead) return UNKNOWN_LEAD;
  if (lead.status === 'replied') return ignored(lead.id);

  const updated = await updateLead(
    db,
    lead.id,
    null,
    {
      status: 'replied',
      chatId: chatIdIfNone(event.chatId),
      nextActionAt: null,
      acceptanceCheckPending: false,
      lastAction: 'reply_received',
      lastActionAt: event.timestamp ?? opts.now,
    },
    opts.now,
  );
  // No row: the lead was removed after it was read.
  return updated ? { outcome: 'replied', leadId: lead.id } : UNKNOWN_LEAD;
}

/**
 * An owner message no later than the lead's last action plus the echo window is not a new manual step:
 * it is the echo of the app's own send, a late or retried copy of the invite note, or an out-of-order
 * delivery. The margin applies on every status because recorded times and LinkedIn's clock can differ
 * by a few seconds, and when in doubt it is safer for the app to still send its message.
 */
function isAtOrBeforeLastAction(lead: Lead, msgAt: Date): boolean {
  if (lead.lastActionAt === null) return true;
  return msgAt.getTime() <= lead.lastActionAt.getTime() + ECHO_WINDOW_MS;
}

/** A message the account owner sent, in the app or directly on LinkedIn. */
async function handleOwnMessage(db: Db, event: MessageEvent, opts: WebhookOptions): Promise<WebhookResult> {
  if (event.otherAttendeeProviderIds.length !== 1) return ignored(null);
  const lead = await findLeadByProviderId(db, event.otherAttendeeProviderIds[0]);
  if (!lead) return UNKNOWN_LEAD;

  // Accepting an invite that had a note opens a chat with the note in it. A reply without accepting
  // does too, so the tick confirms the acceptance with a profile fetch.
  if (lead.status === 'invite_sent') {
    const flagged = await updateLead(db, lead.id, 'invite_sent', { acceptanceCheckPending: true, chatId: event.chatId }, opts.now);
    return flagged ? { outcome: 'acceptance_check', leadId: lead.id } : ignored(lead.id);
  }

  // A message without a time cannot be placed after the last action, so it is never a new manual step.
  const msgAt = event.timestamp;
  if (msgAt === null || isAtOrBeforeLastAction(lead, msgAt)) {
    // Not a new step, but still the lead's chat: the tick reads it before the next message.
    if (lead.chatId === null) await updateLead(db, lead.id, null, { chatId: chatIdIfNone(event.chatId) }, opts.now);
    return ignored(lead.id);
  }

  // A manual message counts as a step: before the first message it replaces it, after that it resets the timer.
  let patch: PgUpdateSetSource<typeof leads>;
  if (lead.status === 'accepted' || lead.status === 'already_connected') {
    const settings = await getSettings(db);
    patch = { status: 'messaged', chatId: event.chatId, nextActionAt: nextDueAfterSend('messaged', msgAt, settings, opts.random) };
  } else if (lead.status === 'messaged' || lead.status === 'followup_1' || lead.status === 'followup_2') {
    const settings = await getSettings(db);
    patch = { chatId: chatIdIfNone(event.chatId), nextActionAt: nextDueAfterSend(lead.status, msgAt, settings, opts.random) };
  } else {
    return ignored(lead.id);
  }

  // Compare-and-set, so a step the engine sends meanwhile keeps its own status and schedule.
  const updated = await updateLead(
    db,
    lead.id,
    lead.status,
    { ...patch, lastAction: 'manual_message', lastActionAt: msgAt },
    opts.now,
  );
  return updated ? { outcome: 'manual_message', leadId: lead.id } : ignored(lead.id);
}

/**
 * Finds the lead a new relation is about. Several rows can match one person (a second URL that failed as a
 * duplicate): the one waiting for acceptance wins, then the one with the same provider id.
 */
async function findRelationLead(db: Db, event: RelationEvent): Promise<Lead | undefined> {
  const matches: SQL[] = [];
  if (event.providerId !== null) matches.push(eq(leads.providerId, event.providerId));
  if (event.publicIdentifier !== null) {
    const publicIdentifier = sql`lower(${event.publicIdentifier})`;
    matches.push(eq(sql`lower(${leads.slug})`, publicIdentifier), eq(sql`lower(${leads.publicIdentifier})`, publicIdentifier));
  }
  if (matches.length === 0) return undefined;

  const found = await db.select().from(leads).where(or(...matches)).orderBy(asc(leads.id));
  return (
    found.find((lead) => lead.status === 'invite_sent') ??
    found.find((lead) => event.providerId !== null && lead.providerId === event.providerId) ??
    found[0]
  );
}

async function handleNewRelation(db: Db, event: RelationEvent, opts: WebhookOptions): Promise<WebhookResult> {
  const lead = await findRelationLead(db, event);
  if (!lead) return UNKNOWN_LEAD;
  if (lead.status !== 'invite_sent') return ignored(lead.id);

  const settings = await getSettings(db);
  const accepted = await updateLead(
    db,
    lead.id,
    'invite_sent',
    {
      status: 'accepted',
      nextActionAt: firstMessageDueAt(opts.now, opts.random, settings.delays),
      acceptanceCheckPending: false,
      lastAction: 'accepted',
      lastActionAt: opts.now,
    },
    opts.now,
  );
  return accepted ? { outcome: 'accepted', leadId: lead.id } : ignored(lead.id);
}

/** Applies one webhook event to the lead it is about. Acts on paused leads too. */
export async function handleWebhookEvent(db: Db, event: WebhookEvent, opts: WebhookOptions): Promise<WebhookResult> {
  if (event.accountId !== opts.accountId) return ignored(null);
  if (event.kind === 'new_relation') return handleNewRelation(db, event, opts);
  if (event.senderProviderId === event.ownerProviderId) return handleOwnMessage(db, event, opts);
  return handleReply(db, event, opts);
}

function eventName(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const name: unknown = (body as { event?: unknown }).event;
  return typeof name === 'string' ? name : null;
}

/** Parses and handles a webhook body, and logs it whatever the outcome. */
export async function processWebhook(db: Db, body: unknown, opts: WebhookOptions): Promise<WebhookResult> {
  const event = parseWebhookPayload(body);
  const result = event ? await handleWebhookEvent(db, event, opts) : ignored(null);
  await logEvent(db, {
    type: 'webhook_received',
    at: opts.now,
    leadId: result.leadId,
    payload: { event: eventName(body), outcome: result.outcome },
  });
  return result;
}
