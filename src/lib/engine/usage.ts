import { and, eq, gte, inArray, sql, type SQL } from 'drizzle-orm';
import { events, type EventType } from '@/db/schema';
import type { Db } from '@/db/types';
import { startOfLocalDay } from '@/lib/schedule/window';
import type { Settings } from '@/lib/settings/settings';

export type Usage = { invitesToday: number; invitesLast7Days: number; messagesToday: number; profileViewsToday: number };

export type Remaining = { invites: number; messages: number; profileViews: number };

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const countWhere = (condition: SQL | undefined) => sql<number>`count(*) filter (where ${condition})`.mapWith(Number);

/** "Today" starts at local midnight in `timezone`; the week is the rolling 7 × 24 h before `now`. */
export async function getUsage(db: Db, now: Date, timezone: string): Promise<Usage> {
  const todayStart = startOfLocalDay(now, timezone);
  const weekStart = new Date(now.getTime() - WEEK_MS);
  const isType = (type: EventType) => eq(events.type, type);
  const today = gte(events.createdAt, todayStart);

  const [row] = await db
    .select({
      invitesToday: countWhere(and(isType('invite_sent'), today)),
      invitesLast7Days: countWhere(isType('invite_sent')),
      messagesToday: countWhere(and(isType('message_sent'), today)),
      profileViewsToday: countWhere(and(isType('profile_view'), today)),
    })
    .from(events)
    // Local midnight is always less than a day back, so the week covers today as well.
    .where(and(gte(events.createdAt, weekStart), inArray(events.type, ['invite_sent', 'message_sent', 'profile_view'])));
  return row;
}

export function remainingCapacity(u: Usage, caps: Settings['caps']): Remaining {
  const left = (cap: number, used: number) => Math.max(0, cap - used);
  return {
    invites: Math.min(left(caps.invitesPerDay, u.invitesToday), left(caps.invitesPerWeek, u.invitesLast7Days)),
    messages: left(caps.messagesPerDay, u.messagesToday),
    profileViews: left(caps.profileViewsPerDay, u.profileViewsToday),
  };
}
