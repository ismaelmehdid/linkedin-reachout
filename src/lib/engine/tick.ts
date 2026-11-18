import { and, eq, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { leads, type DraftStatus, type Lead, type LeadStatus } from '@/db/schema';
import type { Db } from '@/db/types';
import { isInActiveWindow, windowBounds } from '@/lib/schedule/window';
import { getSettings } from '@/lib/settings/repo';
import { MAX_JITTER_SECONDS, type Settings } from '@/lib/settings/settings';
import type { EngineDeps } from './deps';
import type { ActionOutcome } from './failure';
import { expireOneInvite, finishDueLeads, runAcceptanceChecks, runInvitePollIfDue } from './housekeeping';
import { runInviteAction } from './invite';
import { runMessageAction } from './message';
import { dayStartAt, longestPlanAheadMs, pickGapMs, withdrawalGapMs } from './pacing';
import { acquireTickLock, getAppState, releaseTickLock, tickLeaseEnd, updateAppState, type AppState } from './state';
import { MESSAGE_STEP_BY_STATUS, type MessageStep } from './steps';
import { getUsage, remainingCapacity, type Remaining } from './usage';

/**
 * How long a tick holds the lock: 240 000 ms on purpose. The HTTP function that runs a tick is killed
 * after 180 s, before this lease can expire, so a second tick never starts while one is still running.
 * A tick also releases only its own lease, so even one that outlived it could not free another tick's lock.
 */
export const TICK_LEASE_MS = 240_000;

/**
 * The outreach action is skipped for a tick whose housekeeping ended later than this after the tick's
 * start: its random wait would have to be cut too short to keep the action inside the function's lifetime.
 */
export const OUTREACH_START_BUDGET_MS = 30_000;

/**
 * The outreach action starts within this time of the tick's start; the random wait is cut short to fit.
 * The HTTP function that runs a tick is killed at 180 s (the tick route's `maxDuration`), and a kill between
 * a send and its database write leaves a message that went out with no record of it. The slowest action
 * makes three Unipile calls, each cut off after `UNIPILE_TIMEOUT_MS` (20 s): find the chat, read it, send.
 * 110 s + 3 × 20 s = 170 s, which leaves 10 s for the database calls around them. A test of the tick
 * route checks this sum against `maxDuration`.
 *
 * Housekeeping within `OUTREACH_START_BUDGET_MS` leaves at least 80 s, and a wait is at most
 * `MAX_JITTER_SECONDS` (`PLANNED_WAIT_LOOKAHEAD_MS` for a planned moment), so a wait is only ever cut short
 * after slow housekeeping.
 */
export const ACTION_START_BUDGET_MS = 110_000;

/**
 * A tick waits for a planned send that is at most this far away (spec §8 "Spacing"), whatever the random
 * wait in Settings, so a tick every minute reaches every planned moment. Further away, the send is left for
 * a later tick. It stays within `MAX_JITTER_SECONDS`, the wait that the budgets above were sized for.
 */
export const PLANNED_WAIT_LOOKAHEAD_MS = 90_000;

export type TickResult = {
  status: 'locked' | 'paused' | 'outside_window' | 'done';
  finished: number;
  action: ActionOutcome | null;
};

type MessageStatus = keyof typeof MESSAGE_STEP_BY_STATUS;

const MESSAGE_STATUSES = Object.keys(MESSAGE_STEP_BY_STATUS) as MessageStatus[];

type PickedAction = { kind: 'message'; lead: Lead; step: MessageStep } | { kind: 'invite'; lead: Lead };

/** The opening and closing instants of today's active window. */
type WindowBounds = { start: Date; end: Date };

const isPausedAfter = (until: Date | null, now: Date) => until !== null && until > now;

/** A queued lead is invited only with no drafts (a pasted lead) or approved ones: any other lead waits for its drafts. */
const INVITABLE_DRAFT_STATUSES = ['none', 'approved'] as const satisfies readonly DraftStatus[];

const isInvitable = inArray(leads.draftStatus, [...INVITABLE_DRAFT_STATUSES]);

const countWhere = (condition: SQL | undefined) => sql<number>`count(*) filter (where ${condition})`.mapWith(Number);

/** One lead in one of `statuses`, not paused, due and matching `condition`, picked at random among them (spec §8). */
async function pickDueLead(db: Db, statuses: LeadStatus[], now: Date, condition?: SQL): Promise<Lead | undefined> {
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(inArray(leads.status, statuses), eq(leads.paused, false), lte(leads.nextActionAt, now), condition))
    .orderBy(sql`random()`)
    .limit(1);
  return lead;
}

/** This tick's outreach action, or null when none is due and allowed. A due message comes before a new invite. */
async function pickAction(db: Db, state: AppState, remaining: Remaining, now: Date): Promise<PickedAction | null> {
  if (remaining.messages > 0 && !isPausedAfter(state.messagesPausedUntil, now)) {
    const lead = await pickDueLead(db, MESSAGE_STATUSES, now);
    // The query only returns statuses of MESSAGE_STEP_BY_STATUS.
    if (lead) return { kind: 'message', lead, step: MESSAGE_STEP_BY_STATUS[lead.status as MessageStatus] };
  }
  if (remaining.invites > 0 && remaining.profileViews > 0 && !isPausedAfter(state.invitesPausedUntil, now)) {
    const lead = await pickDueLead(db, ['queued'], now, isInvitable);
    if (lead) return { kind: 'invite', lead };
  }
  return null;
}

/**
 * The picked lead as it is after the random wait, or null when it no longer qualifies: deleted, paused,
 * moved to another status (a reply, or a manual message before the first message), no longer due
 * at `pickedAt` (a manual message after the first message moves `nextActionAt` and keeps the status),
 * or, for an invite, drafts that are no longer approved.
 */
async function rereadPickedLead(db: Db, picked: Lead, pickedAt: Date): Promise<Lead | null> {
  const [lead] = await db.select().from(leads).where(eq(leads.id, picked.id));
  if (!lead || lead.paused || lead.status !== picked.status) return null;
  if (lead.status === 'queued' && !(INVITABLE_DRAFT_STATUSES as readonly DraftStatus[]).includes(lead.draftStatus)) return null;
  if (lead.nextActionAt === null || lead.nextActionAt > pickedAt) return null;
  return lead;
}

/**
 * Withdraws at most one expired invite, once the pause after the previous withdrawal is over, and starts
 * the next pause after a withdrawal (spec §8 "Spacing").
 */
async function expireOneInviteWhenSpaced(deps: EngineDeps, settings: Settings, now: Date): Promise<void> {
  const { nextWithdrawalAt } = await getAppState(deps.db);
  if (nextWithdrawalAt !== null && nextWithdrawalAt > now) return;
  if (!(await expireOneInvite(deps, settings))) return;
  // The pause runs from the withdrawal itself, which may come after slow acceptance checks.
  const withdrawnAt = deps.now();
  await updateAppState(deps.db, { nextWithdrawalAt: new Date(withdrawnAt.getTime() + withdrawalGapMs(settings.pacing, deps.random)) });
}

/**
 * The sends still planned for today: the invites that the caps and the due invitable `queued` leads allow, plus the
 * messages that the cap and the leads due before the window closes allow. Paused leads are not counted,
 * and neither is a type of send that is paused.
 */
async function countPlannedSends(db: Db, state: AppState, remaining: Remaining, now: Date, windowEnd: Date): Promise<number> {
  const [due] = await db
    .select({
      invites: countWhere(and(eq(leads.status, 'queued'), lte(leads.nextActionAt, now), isInvitable)),
      messages: countWhere(and(inArray(leads.status, MESSAGE_STATUSES), lte(leads.nextActionAt, windowEnd))),
    })
    .from(leads)
    .where(and(eq(leads.paused, false), inArray(leads.status, ['queued', ...MESSAGE_STATUSES])));
  const invites = isPausedAfter(state.invitesPausedUntil, now) ? 0 : Math.min(remaining.invites, remaining.profileViews, due.invites);
  const messages = isPausedAfter(state.messagesPausedUntil, now) ? 0 : Math.min(remaining.messages, due.messages);
  return invites + messages;
}

/**
 * Plans the earliest moment of the next send: a random pause from now, so that the sends still planned
 * for today are spread over what is left of the window (spec §8 "Spacing").
 */
async function planNextSend(deps: EngineDeps, settings: Settings, bounds: WindowBounds): Promise<void> {
  const { db } = deps;
  const now = deps.now();
  const remaining = remainingCapacity(await getUsage(db, now, settings.window.timezone), settings.caps);
  const planned = await countPlannedSends(db, await getAppState(db), remaining, now, bounds.end);
  const gapMs = pickGapMs({ timeLeftMs: bounds.end.getTime() - now.getTime(), planned, pacing: settings.pacing, random: deps.random });
  await updateAppState(db, { nextOutreachAt: new Date(now.getTime() + gapMs) });
}

/**
 * Runs the picked action after the wait, checking again what the wait may have changed: the app or the
 * action's type paused, the settings saved, the window closed, or the lead changed. Once the action has
 * been called, it plans the next send, whether the action returned or threw: a throw can come after a
 * real send. A check that stops the action first leaves the plan as it is.
 */
async function runAfterWait(
  deps: EngineDeps,
  picked: PickedAction,
  pickedAt: Date,
  bounds: WindowBounds,
): Promise<{ status: 'paused' | 'outside_window' | 'done'; action: ActionOutcome | null }> {
  const { db } = deps;
  const now = deps.now();
  const state = await getAppState(db);
  if (!state.running) return { status: 'paused', action: null };
  const pausedUntil = picked.kind === 'message' ? state.messagesPausedUntil : state.invitesPausedUntil;
  if (isPausedAfter(pausedUntil, now)) return { status: 'done', action: null };

  const settings = await getSettings(db);
  if (!isInActiveWindow(now, settings.window)) return { status: 'outside_window', action: null };

  const lead = await rereadPickedLead(db, picked.lead, pickedAt);
  if (lead === null) return { status: 'done', action: { leadId: picked.lead.id, result: 'superseded' } };
  let action: ActionOutcome;
  try {
    action =
      picked.kind === 'message'
        ? await runMessageAction(deps, lead, picked.step, settings)
        : await runInviteAction(deps, lead, settings);
  } catch (err) {
    // The action's own error is the one that propagates. A planning failure here is almost always the same
    // database failure, so it is dropped rather than allowed to replace it.
    await planNextSend(deps, settings, bounds).catch(() => {});
    throw err;
  }
  await planNextSend(deps, settings, bounds);
  return { status: 'done', action };
}

async function runLockedTick(deps: EngineDeps, now: Date): Promise<TickResult> {
  const { db } = deps;
  if (!(await getAppState(db)).running) return { status: 'paused', finished: 0, action: null };

  const settings = await getSettings(db);
  const finished = await finishDueLeads(db, now);
  if (!isInActiveWindow(now, settings.window)) return { status: 'outside_window', finished, action: null };

  const readRemaining = async () => remainingCapacity(await getUsage(db, now, settings.window.timezone), settings.caps);

  // Housekeeping does not use the action slot, but its profile views count toward the daily cap.
  await runAcceptanceChecks(deps, settings, (await readRemaining()).profileViews);
  await expireOneInviteWhenSpaced(deps, settings, now);
  await runInvitePollIfDue(deps);

  const state = await getAppState(db);
  if (!state.running) return { status: 'paused', finished, action: null };
  // Housekeeping ran long: the outreach action waits for the next tick.
  if (deps.now().getTime() - now.getTime() > OUTREACH_START_BUDGET_MS) return { status: 'done', finished, action: null };

  // The window was open at `now`, as checked above, so the bounds are always found.
  const bounds = windowBounds(now, settings.window);
  if (bounds === null) return { status: 'outside_window', finished, action: null };

  // The first send of a day waits for its own random moment: an earlier day's planned moment is not reused.
  let plannedAt = state.nextOutreachAt;
  if (plannedAt === null || plannedAt < bounds.start) {
    plannedAt = dayStartAt(bounds.start, now, settings.pacing, deps.random);
    await updateAppState(db, { nextOutreachAt: plannedAt });
  }
  // A moment planned further ahead than the current settings can plan one was made under other settings:
  // it is brought forward to that distance. With spacing off the distance is 0, so this takes effect at once.
  const latestTrusted = new Date(now.getTime() + longestPlanAheadMs(settings.pacing));
  if (plannedAt > latestTrusted) {
    plannedAt = latestTrusted;
    await updateAppState(db, { nextOutreachAt: plannedAt });
  }

  // A stored wait above the validated maximum (an old row, or one edited by hand) is not trusted.
  const jitterSeconds = Math.min(settings.caps.jitterMaxSeconds, MAX_JITTER_SECONDS);
  // What is left, at `at`, of the time in which the action has to start.
  const waitBudgetMs = (at: Date) => ACTION_START_BUDGET_MS - (at.getTime() - now.getTime());

  // A tick waits for a planned moment up to PLANNED_WAIT_LOOKAHEAD_MS away, cut by the time budget: a moment
  // further away is left for a later tick, before any lead is picked.
  const beforePick = deps.now();
  if (plannedAt.getTime() - beforePick.getTime() > Math.min(PLANNED_WAIT_LOOKAHEAD_MS, waitBudgetMs(beforePick))) {
    return { status: 'done', finished, action: null };
  }

  const picked = await pickAction(db, state, await readRemaining(), now);
  if (picked === null) return { status: 'done', finished, action: null };

  // On time, the tick waits until the planned moment. Late, it waits the random wait.
  const beforeWait = deps.now();
  const untilPlannedMs = plannedAt.getTime() - beforeWait.getTime();
  const waitMs = untilPlannedMs > 0 ? untilPlannedMs : Math.floor(deps.random() * jitterSeconds * 1000);
  await deps.sleep(Math.max(0, Math.min(waitMs, waitBudgetMs(beforeWait))));
  return { ...(await runAfterWait(deps, picked, now, bounds)), finished };
}

/**
 * One engine tick (spec §8, §13): takes the lock, does housekeeping, then performs at most one outreach
 * action inside the caps and the active window, not before its planned moment. Returns `locked` at once
 * when another tick holds the lock.
 */
export async function runTick(deps: EngineDeps): Promise<TickResult> {
  const now = deps.now();
  if (!(await acquireTickLock(deps.db, now, TICK_LEASE_MS))) return { status: 'locked', finished: 0, action: null };
  try {
    return await runLockedTick(deps, now);
  } finally {
    await releaseTickLock(deps.db, tickLeaseEnd(now, TICK_LEASE_MS));
  }
}
