import { and, asc, eq, inArray, isNull, lte } from 'drizzle-orm';
import { events, leads, type Lead } from '@/db/schema';
import type { Db } from '@/db/types';
import type { Settings } from '@/lib/settings/settings';
import { DRY_RUN_ID_PREFIX } from '@/lib/unipile/dry-run';
import { classifyUnipileError, UnipileError } from '@/lib/unipile/errors';
import type { SentInvitation, UnipileProfile } from '@/lib/unipile/types';
import type { EngineDeps } from './deps';
import { logEvent, logEvents } from './events';
import { getAppState, incrementErrorStreak, pauseForAccountError, updateAppState } from './state';
import { firstMessageDueAt } from './steps';

export const ACCEPTANCE_CHECKS_PER_TICK = 3;

/** An invite sent less than this long ago may not be in Unipile's sent list yet. */
export const INVITE_POLL_GRACE_MS = 600_000;

const HOUR_MS = 3_600_000;

/**
 * An invite that a poll found missing at least this long ago, while the person is still not a connection,
 * was declined or withdrawn by hand. The check normally runs on the tick after a poll, so it takes the
 * next poll, 3 to 5 hours later, to get here; a check that was itself delayed by this long also does.
 */
export const INVITE_GONE_AFTER_MS = HOUR_MS;
const INVITE_POLL_MIN_INTERVAL_MS = 3 * HOUR_MS;
const INVITE_POLL_JITTER_MS = 2 * HOUR_MS;
const INVITE_POLL_RETRY_MS = HOUR_MS;

type HousekeepingKind = 'acceptance_check' | 'invite_withdrawal' | 'invite_poll';

const notPaused = eq(leads.paused, false);

const stillInviteSent = (leadId: number) => and(eq(leads.id, leadId), eq(leads.status, 'invite_sent'));

/** Ends the sequence of every due follow-up 2 lead, in one compare-and-set statement. */
export async function finishDueLeads(db: Db, now: Date): Promise<number> {
  const finished = await db
    .update(leads)
    .set({ status: 'no_response', nextActionAt: null, lastAction: 'no_response', lastActionAt: now, updatedAt: now })
    .where(and(eq(leads.status, 'followup_2'), notPaused, lte(leads.nextActionAt, now)))
    .returning({ id: leads.id });
  return finished.length;
}

/**
 * Logs `action_failed` and applies the error policy that housekeeping shares with the actions: an account
 * error pauses the app at once, and a limit or transient error counts toward the error streak. Returns
 * whether the lead has to stay as it is for a later tick; the caller then stops calling Unipile too.
 */
async function recordUnipileError(
  deps: EngineDeps,
  ctx: { kind: HousekeepingKind; at: Date; leadId?: number },
  err: unknown,
): Promise<{ keepForLater: boolean }> {
  const status = err instanceof UnipileError ? err.status : null;
  const type = err instanceof UnipileError ? err.type : null;
  const message = err instanceof Error ? err.message : String(err);
  await logEvent(deps.db, { type: 'action_failed', at: ctx.at, leadId: ctx.leadId, payload: { kind: ctx.kind, status, type, message } });

  const reason = type ?? `http_${status}`;
  switch (classifyUnipileError(err)) {
    case 'account':
      await pauseForAccountError(deps.db, reason);
      return { keepForLater: true };
    case 'limit':
    case 'transient':
      await incrementErrorStreak(deps.db, reason);
      return { keepForLater: true };
    default:
      return { keepForLater: false };
  }
}

/** Whether a poll found this lead's invite missing from the sent list at least INVITE_GONE_AFTER_MS before `now`. */
async function wasInviteMissingEarlier(db: Db, leadId: number, now: Date): Promise<boolean> {
  const [event] = await db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.type, 'invite_missing'),
        eq(events.leadId, leadId),
        lte(events.createdAt, new Date(now.getTime() - INVITE_GONE_AFTER_MS)),
      ),
    )
    .limit(1);
  return event !== undefined;
}

/**
 * Fetches the profile of up to `min(ACCEPTANCE_CHECKS_PER_TICK, maxProfileViews)` flagged invites to see
 * whether they were accepted. An invite that is not accepted and that an earlier poll already found
 * missing is gone for good: its lead is set to `invite_expired`, so it is not checked on every poll
 * until its expiry. Returns how many profile fetches it made, failed ones included.
 */
export async function runAcceptanceChecks(deps: EngineDeps, settings: Settings, maxProfileViews: number): Promise<number> {
  const limit = Math.min(ACCEPTANCE_CHECKS_PER_TICK, maxProfileViews);
  if (limit <= 0) return 0;
  const now = deps.now();
  const flagged = await deps.db
    .select()
    .from(leads)
    .where(and(eq(leads.status, 'invite_sent'), eq(leads.acceptanceCheckPending, true), notPaused))
    .orderBy(asc(leads.id))
    .limit(limit);

  let calls = 0;
  for (const lead of flagged) {
    calls += 1;
    let profile: UnipileProfile;
    try {
      // The invite step stores the providerId; the slug identifies the same profile.
      profile = await deps.unipile.getProfile(lead.providerId ?? lead.slug);
    } catch (err) {
      const { keepForLater } = await recordUnipileError(deps, { kind: 'acceptance_check', at: now, leadId: lead.id }, err);
      if (keepForLater) break;
      await deps.db.update(leads).set({ acceptanceCheckPending: false, updatedAt: now }).where(stillInviteSent(lead.id));
      continue;
    }
    await logEvent(deps.db, { type: 'profile_view', at: now, leadId: lead.id });

    let outcome: Partial<Lead>;
    if (profile.networkDistance === 'FIRST_DEGREE') {
      outcome = { status: 'accepted', nextActionAt: firstMessageDueAt(now, deps.random, settings.delays), lastAction: 'accepted', lastActionAt: now };
    } else if (await wasInviteMissingEarlier(deps.db, lead.id, now)) {
      // Nothing to withdraw: the invite is already off the sent list.
      outcome = { status: 'invite_expired', nextActionAt: null, lastAction: 'invite_gone', lastActionAt: now };
    } else {
      outcome = {};
    }
    // Compare-and-set: if a webhook moved the lead first, its update stands.
    await deps.db
      .update(leads)
      .set({ ...outcome, acceptanceCheckPending: false, updatedAt: now })
      .where(stillInviteSent(lead.id));
  }
  return calls;
}

/**
 * Withdraws the invite that expired first and sets its lead to `invite_expired`. A limit, transient or
 * account error leaves the lead for a later tick; any other withdraw error does not block the expiry.
 * An invite whose acceptance check is still pending waits for that check: it may have been accepted.
 * Returns whether a lead was expired.
 *
 * `settings` is part of the housekeeping signature but not read: the expiry date was fixed on
 * `nextActionAt` when the invite was sent.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function expireOneInvite(deps: EngineDeps, settings: Settings): Promise<boolean> {
  const now = deps.now();
  const [lead] = await deps.db
    .select()
    .from(leads)
    .where(and(eq(leads.status, 'invite_sent'), notPaused, eq(leads.acceptanceCheckPending, false), lte(leads.nextActionAt, now)))
    .orderBy(asc(leads.nextActionAt), asc(leads.id))
    .limit(1);
  if (!lead) return false;

  if (lead.invitationId) {
    try {
      await deps.unipile.cancelInvitation(lead.invitationId);
      await logEvent(deps.db, {
        type: 'invite_withdrawn',
        at: now,
        leadId: lead.id,
        payload: { invitationId: lead.invitationId, dryRun: deps.dryRun },
      });
    } catch (err) {
      const { keepForLater } = await recordUnipileError(deps, { kind: 'invite_withdrawal', at: now, leadId: lead.id }, err);
      if (keepForLater) return false;
    }
  }

  const expired = await deps.db
    .update(leads)
    .set({ status: 'invite_expired', nextActionAt: null, lastAction: 'invite_withdrawn', lastActionAt: now, updatedAt: now })
    .where(stillInviteSent(lead.id))
    .returning({ id: leads.id });
  return expired.length > 0;
}

/** Finds the sent invitation of a lead by its invitation id, by provider id, or by public identifier ignoring case. */
function invitationFinder(invitations: SentInvitation[]): (lead: Lead) => string | undefined {
  const ids = new Set<string>();
  const byUserId = new Map<string, string>();
  const byPublicId = new Map<string, string>();
  for (const invitation of invitations) {
    ids.add(invitation.id);
    if (invitation.invitedUserId) byUserId.set(invitation.invitedUserId, invitation.id);
    if (invitation.invitedUserPublicId) byPublicId.set(invitation.invitedUserPublicId.toLowerCase(), invitation.id);
  }
  return (lead) =>
    (lead.invitationId !== null && ids.has(lead.invitationId) ? lead.invitationId : undefined) ??
    (lead.providerId ? byUserId.get(lead.providerId) : undefined) ??
    byPublicId.get((lead.publicIdentifier ?? lead.slug).toLowerCase());
}

/**
 * The safety net for missed acceptance webhooks. When the poll is due and an invite Unipile knows of is
 * pending, lists the sent invitations once: a pending invite missing from the list is flagged for an
 * acceptance check and remembered with an `invite_missing` event, and a listed one gets its invitation
 * id if the lead lacks it. Returns whether a poll completed.
 */
export async function runInvitePollIfDue(deps: EngineDeps): Promise<boolean> {
  const now = deps.now();
  const { nextInvitePollAt } = await getAppState(deps.db);
  if (nextInvitePollAt !== null && nextInvitePollAt > now) return false;

  // A dry-run invite was never sent, so Unipile's list can say nothing about it.
  const pending = (await deps.db.select().from(leads).where(and(eq(leads.status, 'invite_sent'), notPaused))).filter(
    (lead) => !lead.invitationId?.startsWith(DRY_RUN_ID_PREFIX),
  );
  if (pending.length === 0) return false;

  // Scheduled before the list is fetched: a tick killed during the poll must not repeat it five minutes later.
  const delayMs = INVITE_POLL_MIN_INTERVAL_MS + Math.round(deps.random() * INVITE_POLL_JITTER_MS);
  await updateAppState(deps.db, { nextInvitePollAt: new Date(now.getTime() + delayMs) });

  let invitations: SentInvitation[];
  try {
    invitations = await deps.unipile.listSentInvitations();
  } catch (err) {
    await recordUnipileError(deps, { kind: 'invite_poll', at: now }, err);
    await updateAppState(deps.db, { nextInvitePollAt: new Date(now.getTime() + INVITE_POLL_RETRY_MS) });
    return false;
  }

  const findInvitation = invitationFinder(invitations);
  const settledBefore = now.getTime() - INVITE_POLL_GRACE_MS;
  const missing: Lead[] = [];
  for (const lead of pending) {
    if (lead.inviteSentAt === null || lead.inviteSentAt.getTime() > settledBefore) continue;
    const invitationId = findInvitation(lead);
    if (invitationId === undefined) {
      missing.push(lead);
    } else if (lead.invitationId === null) {
      await deps.db
        .update(leads)
        .set({ invitationId, updatedAt: now })
        .where(and(stillInviteSent(lead.id), isNull(leads.invitationId)));
    }
  }
  if (missing.length > 0) {
    // The events are the poll's memory: the acceptance check reads them to tell an invite that is gone
    // for good from one that was only just accepted.
    await logEvents(deps.db, missing.map((lead) => ({ type: 'invite_missing' as const, at: now, leadId: lead.id })));
    const unflagged = missing.filter((lead) => !lead.acceptanceCheckPending).map((lead) => lead.id);
    if (unflagged.length > 0) {
      await deps.db
        .update(leads)
        .set({ acceptanceCheckPending: true, updatedAt: now })
        .where(and(inArray(leads.id, unflagged), eq(leads.status, 'invite_sent')));
    }
  }
  return true;
}
