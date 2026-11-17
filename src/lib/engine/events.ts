import { events, type EventType } from '@/db/schema';
import type { Db } from '@/db/types';

type NewEvent = { type: EventType; at: Date; leadId?: number | null; payload?: Record<string, unknown> };

/** Caps are counted from `createdAt`, so it is always the injected time `at`, never the database clock. */
export async function logEvents(db: Db, list: NewEvent[]): Promise<void> {
  if (list.length === 0) return;
  await db.insert(events).values(list.map((e) => ({ type: e.type, createdAt: e.at, leadId: e.leadId ?? null, payload: e.payload ?? {} })));
}

export function logEvent(db: Db, e: NewEvent): Promise<void> {
  return logEvents(db, [e]);
}
