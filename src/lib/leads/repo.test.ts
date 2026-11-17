import { beforeEach, describe, expect, it } from 'vitest';
import { leads } from '@/db/schema';
import type { Db } from '@/db/types';
import { logEvent } from '@/lib/engine/events';
import { getUsage } from '@/lib/engine/usage';
import { createTestDb } from '@/test-utils/db';
import { NOW, getLead, seedLead } from '@/test-utils/engine';
import {
  countLeadsByStatus,
  listLeads,
  listRecentEvents,
  removeLead,
  retryFailedLead,
  setLeadPaused,
} from './repo';

const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

describe('lead repository', () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
  });

  it('counts leads for every status, zeros included', async () => {
    await seedLead(db);
    await seedLead(db);
    await seedLead(db, { status: 'replied' });
    const counts = await countLeadsByStatus(db);
    expect(Object.keys(counts)).toHaveLength(11);
    expect([counts.queued, counts.replied, counts.failed]).toEqual([2, 1, 0]);
  });

  it('lists leads newest update first, filtered by status', async () => {
    const old = await seedLead(db, { updatedAt: minutesAgo(30) });
    const recent = await seedLead(db, { updatedAt: minutesAgo(10) });
    const replied = await seedLead(db, { status: 'replied', updatedAt: minutesAgo(20) });
    expect((await listLeads(db, {})).map((l) => l.id)).toEqual([recent.id, replied.id, old.id]);
    expect((await listLeads(db, { status: 'replied' })).map((l) => l.id)).toEqual([replied.id]);
    expect(await listLeads(db, { status: 'failed' })).toEqual([]);
  });

  it('pauses and resumes a lead', async () => {
    const lead = await seedLead(db, { updatedAt: minutesAgo(60) });
    await setLeadPaused(db, lead.id, true, NOW);
    expect(await getLead(db, lead.id)).toMatchObject({ paused: true, updatedAt: NOW, status: 'queued' });
    const later = new Date(NOW.getTime() + 60_000);
    await setLeadPaused(db, lead.id, false, later);
    expect(await getLead(db, lead.id)).toMatchObject({ paused: false, updatedAt: later });
  });

  it('retries a failed lead from the status it failed in, or from queued', async () => {
    const a = await seedLead(db, { status: 'failed', failedFromStatus: 'messaged', failureReason: 'x', retryCount: 1 });
    const b = await seedLead(db, { status: 'failed', failedFromStatus: null });
    expect(await retryFailedLead(db, a.id, NOW)).toBe(true);
    expect(await getLead(db, a.id)).toMatchObject({
      status: 'messaged',
      failureReason: null,
      failedFromStatus: null,
      retryCount: 0,
      nextActionAt: NOW,
      updatedAt: NOW,
    });
    await retryFailedLead(db, b.id, NOW);
    expect((await getLead(db, b.id)).status).toBe('queued');
  });

  it('refuses to retry a lead that is not failed', async () => {
    const lead = await seedLead(db, { status: 'messaged', updatedAt: minutesAgo(60) });
    expect(await retryFailedLead(db, lead.id, NOW)).toBe(false);
    expect(await getLead(db, lead.id)).toMatchObject({ status: 'messaged', updatedAt: minutesAgo(60) });
  });

  it('removes a lead but keeps its events, so caps stay correct', async () => {
    const lead = await seedLead(db);
    await logEvent(db, { type: 'invite_sent', at: NOW, leadId: lead.id });
    await removeLead(db, lead.id);
    expect(await db.select().from(leads)).toEqual([]);
    expect((await getUsage(db, NOW, 'Europe/Paris')).invitesToday).toBe(1);
  });

  it('lists recent events newest first, with the name of their lead', async () => {
    const named = await seedLead(db, { firstName: 'Jane', lastName: 'Doe' });
    const unnamed = await seedLead(db, { slug: 'john-roe' });
    const removed = await seedLead(db);
    await logEvent(db, { type: 'profile_view', at: minutesAgo(40), leadId: named.id });
    await logEvent(db, { type: 'invite_sent', at: minutesAgo(30), leadId: named.id, payload: { text: 'Hi', dryRun: true } });
    await logEvent(db, { type: 'invite_sent', at: minutesAgo(20), leadId: unnamed.id });
    await logEvent(db, { type: 'message_sent', at: minutesAgo(10), leadId: removed.id });
    await logEvent(db, { type: 'webhook_received', at: minutesAgo(5) });
    await removeLead(db, removed.id);

    const recent = await listRecentEvents(db, 4);
    expect(recent.map((e) => [e.type, e.leadName])).toEqual([
      ['webhook_received', null],
      ['message_sent', null],
      ['invite_sent', 'john-roe'],
      ['invite_sent', 'Jane Doe'],
    ]);
    expect(recent[3]).toMatchObject({ leadId: named.id, createdAt: minutesAgo(30), payload: { text: 'Hi', dryRun: true } });
  });
});
