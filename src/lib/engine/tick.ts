import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { leads, type Lead, type LeadStatus } from '@/db/schema';
import type { Db } from '@/db/types';
import { isInActiveWindow } from '@/lib/schedule/window';
import { getSettings } from '@/lib/settings/repo';
import type { EngineDeps } from './deps';
import type { ActionOutcome } from './failure';
import { expireOneInvite, finishDueLeads, runAcceptanceChecks, runInvitePollIfDue } from './housekeeping';
import { runInviteAction } from './invite';
import { runMessageAction } from './message';
import { acquireTickLock, getAppState, releaseTickLock, type AppState } from './state';
import { MESSAGE_STEP_BY_STATUS, type MessageStep } from './steps';
import { getUsage, remainingCapacity, type Remaining } from './usage';

/**
 * How long a tick holds the lock: 240 000 ms on purpose. `releaseTickLock` is unconditional, which is safe
 * only because the HTTP function that runs a tick is killed after 180 s, before this lease can expire.
 * If a tick outlived its lease, the next tick could take the lock and this tick's release would free it.
 */
export const TICK_LEASE_MS = 240_000;

export type TickResult = {
  status: 'locked' | 'paused' | 'outside_window' | 'done';
  finished: number;
  action: ActionOutcome | null;
};

type MessageStatus = keyof typeof MESSAGE_STEP_BY_STATUS;

const MESSAGE_STATUSES = Object.keys(MESSAGE_STEP_BY_STATUS) as MessageStatus[];

type PickedAction = { kind: 'message'; lead: Lead; step: MessageStep } | { kind: 'invite'; lead: Lead };

const isPausedAfter = (until: Date | null, now: Date) => until !== null && until > now;

/** One lead in one of `statuses`, not paused and due, picked at random among them (spec §8). */
async function pickDueLead(db: Db, statuses: LeadStatus[], now: Date): Promise<Lead | undefined> {
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(inArray(leads.status, statuses), eq(leads.paused, false), lte(leads.nextActionAt, now)))
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
    const lead = await pickDueLead(db, ['queued'], now);
    if (lead) return { kind: 'invite', lead };
  }
  return null;
}

/**
 * The picked lead as it is after the random wait, or null when it no longer qualifies: deleted, paused,
 * moved to another status (a reply, or a manual message before the first message), or no longer due
 * (a manual message after the first message moves `nextActionAt` and keeps the status).
 */
async function rereadPickedLead(db: Db, picked: Lead, now: Date): Promise<Lead | null> {
  const [lead] = await db.select().from(leads).where(eq(leads.id, picked.id));
  if (!lead || lead.paused || lead.status !== picked.status) return null;
  if (lead.nextActionAt === null || lead.nextActionAt > now) return null;
  return lead;
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
  await expireOneInvite(deps, settings);
  await runInvitePollIfDue(deps);

  const state = await getAppState(db);
  if (!state.running) return { status: 'paused', finished, action: null };

  const picked = await pickAction(db, state, await readRemaining(), now);
  if (picked === null) return { status: 'done', finished, action: null };

  await deps.sleep(Math.floor(deps.random() * settings.caps.jitterMaxSeconds * 1000));

  // A reply, a manual message or a pause can land during the wait; the action runs on the lead as it is now.
  const lead = await rereadPickedLead(db, picked.lead, now);
  if (lead === null) return { status: 'done', finished, action: { leadId: picked.lead.id, result: 'superseded' } };
  const action =
    picked.kind === 'message'
      ? await runMessageAction(deps, lead, picked.step, settings)
      : await runInviteAction(deps, lead, settings);
  return { status: 'done', finished, action };
}

/**
 * One engine tick (spec §8, §13): takes the lock, does housekeeping, then performs at most one outreach
 * action inside the caps and the active window. Returns `locked` at once when another tick holds the lock.
 */
export async function runTick(deps: EngineDeps): Promise<TickResult> {
  const now = deps.now();
  if (!(await acquireTickLock(deps.db, now, TICK_LEASE_MS))) return { status: 'locked', finished: 0, action: null };
  try {
    return await runLockedTick(deps, now);
  } finally {
    await releaseTickLock(deps.db);
  }
}
