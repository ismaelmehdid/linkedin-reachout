import { and, eq } from 'drizzle-orm';
import { leads, type Lead, type NewLead } from '@/db/schema';
import type { Db } from '@/db/types';
import { nextActiveDayStart } from '@/lib/schedule/window';
import type { Settings } from '@/lib/settings/settings';
import { classifyUnipileError, UnipileError } from '@/lib/unipile/errors';
import type { EngineDeps } from './deps';
import { logEvent } from './events';
import { incrementErrorStreak, updateAppState } from './state';

/** `deferred`: a limit or transient error. `superseded`: the compare-and-set update matched no row. */
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

/** Compare-and-set on `lead.status`, so a lead a webhook already moved on stays as it is. */
export async function failLead(db: Db, lead: Lead, reason: string, at: Date): Promise<void> {
  await updateLeadIfStatus(
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

function describeError(err: unknown): { status: number | null; type: string | null; message: string } {
  if (err instanceof UnipileError) return { status: err.status, type: err.type, message: err.message };
  return { status: null, type: null, message: err instanceof Error ? err.message : String(err) };
}

/**
 * The error policy (spec §10) for a failed invite or message action. Limit and transient errors
 * leave the lead as it is; permanent errors fail it; any other error is retried once, then fails it.
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
      const retryAfterSeconds = err instanceof UnipileError ? err.retryAfterSeconds : null;
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
    case 'permanent':
      await failLead(db, lead, reason, now);
      return outcome('failed');
    default: {
      // Unknown errors, and any class the calling action does not handle itself.
      if (lead.retryCount === 0) {
        // The lead keeps its `nextActionAt`, so it stays due for the next tick.
        const marked = await updateLeadIfStatus(db, lead, { retryCount: 1 }, now);
        return outcome(marked ? 'retry' : 'superseded');
      }
      await failLead(db, lead, type ?? message, now);
      return outcome('failed');
    }
  }
}
