import { and, eq, gt, sql } from 'drizzle-orm';
import { events, leads, type Lead, type NewLead } from '@/db/schema';
import type { Db } from '@/db/types';
import { nextActiveDayStart } from '@/lib/schedule/window';
import type { Settings } from '@/lib/settings/settings';
import { classifyUnipileError, positiveSeconds, UnipileError } from '@/lib/unipile/errors';
import type { EngineDeps } from './deps';
import { logEvent } from './events';
import { incrementErrorStreak, pauseApp, pauseForAccountError, updateAppState } from './state';

/** This many failed actions with no invite or message sent in between pause the app (spec §10). */
export const FAILED_ACTION_LIMIT = 5;

/**
 * `deferred`: a limit, transient or account error left the lead as it is. `superseded`: nothing was sent,
 * because the lead changed first (the compare-and-set update matched no row) or because the owner had
 * written by hand.
 */
export type ActionOutcome = {
  leadId: number;
  result: 'invited' | 'already_connected' | 'already_invited' | 'messaged' | 'replied' | 'failed' | 'retry' | 'deferred' | 'superseded';
};

/**
 * Compare-and-set: updates the lead only while its status is still the one in `lead`, and stamps
 * `updatedAt` with the injected time `at`. Returns false when no row matched, which means a webhook
 * changed the lead first.
 */
export async function updateLeadIfStatus(
  db: Db,
  lead: Pick<Lead, 'id' | 'status'>,
  patch: Partial<NewLead>,
  at: Date,
): Promise<boolean> {
  const rows = await db
    .update(leads)
    .set({ ...patch, updatedAt: at })
    .where(and(eq(leads.id, lead.id), eq(leads.status, lead.status)))
    .returning({ id: leads.id });
  return rows.length > 0;
}

/**
 * Compare-and-set on `lead.status`, so a lead a webhook already moved on stays as it is.
 * Returns whether the lead was set to `failed`.
 */
export function failLead(db: Db, lead: Lead, reason: string, at: Date): Promise<boolean> {
  return updateLeadIfStatus(
    db,
    lead,
    {
      status: 'failed',
      failureReason: reason,
      failedFromStatus: lead.status,
      nextActionAt: null,
      lastAction: 'failed',
      lastActionAt: at,
    },
    at,
  );
}

/**
 * Pauses the app when FAILED_ACTION_LIMIT `action_failed` events are newer than the latest invite or
 * message that went out. One lead that cannot be reached is normal; a row of failures with nothing
 * getting through means something is wrong that no error type named. Events are compared by id, which
 * is their insertion order: within one tick they share the same `createdAt`.
 */
async function pauseAfterRepeatedFailures(db: Db): Promise<void> {
  const lastSendId = sql`(select coalesce(max(${events.id}), 0) from ${events} where ${events.type} in ('invite_sent', 'message_sent'))`;
  const [row] = await db
    .select({ failures: sql<number>`count(*)`.mapWith(Number) })
    .from(events)
    .where(and(eq(events.type, 'action_failed'), gt(events.id, lastSendId)));
  if (row.failures >= FAILED_ACTION_LIMIT) {
    await pauseApp(db, `Auto-paused: ${FAILED_ACTION_LIMIT} actions failed in a row with no successful send.`);
  }
}

function describeError(err: unknown): { status: number | null; type: string | null; message: string } {
  if (err instanceof UnipileError) return { status: err.status, type: err.type, message: err.message };
  return { status: null, type: null, message: err instanceof Error ? err.message : String(err) };
}

/**
 * The error policy (spec §10) for a failed invite or message action. Limit and transient errors leave
 * the lead as it is; an account error does too, and pauses the app at once; permanent errors fail the
 * lead; any other error is retried once, then fails it. A lead that fails here counts toward the pause
 * after FAILED_ACTION_LIMIT failed actions in a row.
 */
export async function handleActionError(
  deps: EngineDeps,
  ctx: { lead: Lead; kind: 'invite' | 'message'; settings: Settings },
  err: unknown,
): Promise<ActionOutcome> {
  const { db } = deps;
  const { lead, kind, settings } = ctx;
  const now = deps.now();
  const outcome = (result: ActionOutcome['result']): ActionOutcome => ({ leadId: lead.id, result });
  const { status, type, message } = describeError(err);
  await logEvent(db, { type: 'action_failed', at: now, leadId: lead.id, payload: { kind, status, type, message } });

  const reason = type ?? `http_${status}`;
  switch (classifyUnipileError(err)) {
    case 'limit': {
      // A delay of 0 would end the pause at once, so only a real delay replaces the next active day.
      const retryAfterSeconds = err instanceof UnipileError ? positiveSeconds(err.retryAfterSeconds) : null;
      const until =
        retryAfterSeconds !== null
          ? new Date(now.getTime() + retryAfterSeconds * 1000)
          : nextActiveDayStart(now, settings.window);
      await updateAppState(db, kind === 'invite' ? { invitesPausedUntil: until } : { messagesPausedUntil: until });
      await incrementErrorStreak(db, reason);
      return outcome('deferred');
    }
    case 'transient':
      await incrementErrorStreak(db, reason);
      return outcome('deferred');
    case 'account':
      // The lead keeps its `nextActionAt`: it is tried again once the account works and Start is pressed.
      await pauseForAccountError(db, reason);
      return outcome('deferred');
    case 'permanent':
      if (await failLead(db, lead, reason, now)) await pauseAfterRepeatedFailures(db);
      return outcome('failed');
    default: {
      // Unknown errors, and any class the calling action does not handle itself.
      if (lead.retryCount === 0) {
        // The lead keeps its `nextActionAt`, so it stays due for the next tick.
        const marked = await updateLeadIfStatus(db, lead, { retryCount: 1 }, now);
        return outcome(marked ? 'retry' : 'superseded');
      }
      if (await failLead(db, lead, type ?? message, now)) await pauseAfterRepeatedFailures(db);
      return outcome('failed');
    }
  }
}
