import { and, desc, eq, sql } from 'drizzle-orm';
import { events, leads, leadStatus, type EventRow, type Lead, type LeadStatus } from '@/db/schema';
import type { Db } from '@/db/types';
import { leadDisplayName } from './display';

/** The most leads the dashboard table shows. */
export const LEAD_LIST_LIMIT = 1000;

export async function listLeads(db: Db, filter: { status?: LeadStatus }): Promise<Lead[]> {
  return db
    .select()
    .from(leads)
    .where(filter.status ? eq(leads.status, filter.status) : undefined)
    .orderBy(desc(leads.updatedAt), desc(leads.id))
    .limit(LEAD_LIST_LIMIT);
}

export async function countLeadsByStatus(db: Db): Promise<Record<LeadStatus, number>> {
  const rows = await db
    .select({ status: leads.status, count: sql<number>`count(*)`.mapWith(Number) })
    .from(leads)
    .groupBy(leads.status);
  const counts = Object.fromEntries(leadStatus.enumValues.map((status) => [status, 0])) as Record<LeadStatus, number>;
  for (const row of rows) counts[row.status] = row.count;
  return counts;
}

export async function setLeadPaused(db: Db, id: number, paused: boolean, now: Date): Promise<void> {
  await db.update(leads).set({ paused, updatedAt: now }).where(eq(leads.id, id));
}

/**
 * Sends a failed lead back to the status it failed in (`queued` when unknown), due now. One conditional
 * statement: false when the lead is gone or no longer failed.
 */
export async function retryFailedLead(db: Db, id: number, now: Date): Promise<boolean> {
  const retried = await db
    .update(leads)
    .set({
      // In SET, a column reference reads the row as it was before this update.
      status: sql`coalesce(${leads.failedFromStatus}, 'queued')`,
      failureReason: null,
      failedFromStatus: null,
      retryCount: 0,
      nextActionAt: now,
      updatedAt: now,
    })
    .where(and(eq(leads.id, id), eq(leads.status, 'failed')))
    .returning({ id: leads.id });
  return retried.length > 0;
}

/** Its events stay, with `leadId` set to null, so the caps still count them. */
export async function removeLead(db: Db, id: number): Promise<void> {
  await db.delete(leads).where(eq(leads.id, id));
}

/** Newest first. `leadName` is null for an event with no lead, or whose lead was removed. */
export async function listRecentEvents(db: Db, limit: number): Promise<Array<EventRow & { leadName: string | null }>> {
  const rows = await db
    .select({ event: events, slug: leads.slug, firstName: leads.firstName, lastName: leads.lastName })
    .from(events)
    .leftJoin(leads, eq(events.leadId, leads.id))
    .orderBy(desc(events.createdAt), desc(events.id))
    .limit(limit);
  return rows.map(({ event, slug, firstName, lastName }) => ({
    ...event,
    leadName: slug === null ? null : leadDisplayName({ slug, firstName, lastName }),
  }));
}
