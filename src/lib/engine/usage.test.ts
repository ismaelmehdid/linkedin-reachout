import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/db/types';
import { DEFAULT_SETTINGS } from '@/lib/settings/settings';
import { createTestDb } from '@/test-utils/db';
import { NOW, listEvents, seedEvents, seedLead } from '@/test-utils/engine';
import { logEvent } from './events';
import { getUsage, remainingCapacity } from './usage';

describe('usage', () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
  });

  it('counts today in Paris time and the last 7 days', async () => {
    await seedEvents(db, 'invite_sent', 2, new Date('2026-11-16T23:30:00Z')); // 00:30 in Paris, today
    await seedEvents(db, 'invite_sent', 3, new Date('2026-11-16T22:30:00Z')); // 23:30 in Paris, yesterday
    await seedEvents(db, 'invite_sent', 4, new Date('2026-11-10T08:00:00Z')); // 7 days and 1 hour ago
    await seedEvents(db, 'message_sent', 5, new Date('2026-11-17T08:00:00Z'));
    await seedEvents(db, 'profile_view', 6, new Date('2026-11-17T08:00:00Z'));
    expect(await getUsage(db, NOW, 'Europe/Paris')).toEqual({ invitesToday: 2, invitesLast7Days: 5, messagesToday: 5, profileViewsToday: 6 });
  });

  it('stores a logged event at the injected time and counts it', async () => {
    const lead = await seedLead(db);
    await logEvent(db, { type: 'message_sent', at: NOW, leadId: lead.id, payload: { step: 'first_message' } });
    await logEvent(db, { type: 'webhook_received', at: NOW });
    expect(await listEvents(db)).toMatchObject([
      { type: 'message_sent', createdAt: NOW, leadId: lead.id, payload: { step: 'first_message' } },
      { type: 'webhook_received', createdAt: NOW, leadId: null, payload: {} },
    ]);
    expect((await getUsage(db, NOW, 'Europe/Paris')).messagesToday).toBe(1);
  });

  it('takes the tighter of the daily and weekly invite caps and never goes below 0', () => {
    expect(remainingCapacity({ invitesToday: 10, invitesLast7Days: 180, messagesToday: 0, profileViewsToday: 0 }, DEFAULT_SETTINGS.caps))
      .toEqual({ invites: 10, messages: 90, profileViews: 90 });
    expect(remainingCapacity({ invitesToday: 36, invitesLast7Days: 36, messagesToday: 95, profileViewsToday: 0 }, DEFAULT_SETTINGS.caps))
      .toEqual({ invites: 0, messages: 0, profileViews: 90 });
  });
});
