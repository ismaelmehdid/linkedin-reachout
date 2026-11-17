import { events, type EventType } from '@/db/schema';
import type { Db } from '@/db/types';

/** Caps are counted from `createdAt`, so it is always the injected time `at`, never the database clock. */
export async function logEvent(
  db: Db,
  e: { type: EventType; at: Date; leadId?: number | null; payload?: Record<string, unknown> },
): Promise<void> {
  await db.insert(events).values({ type: e.type, createdAt: e.at, leadId: e.leadId ?? null, payload: e.payload ?? {} });
}
