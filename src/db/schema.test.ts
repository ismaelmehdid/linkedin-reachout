import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '@/test-utils/db';
import { events, leads } from './schema';

const url = (slug: string) => `https://www.linkedin.com/in/${slug}`;

describe('database schema', () => {
  it('applies migrations and stores a lead with defaults', async () => {
    const db = await createTestDb();
    const [lead] = await db.insert(leads).values({ slug: 'jane-doe', linkedinUrl: url('jane-doe') }).returning();
    expect(lead).toMatchObject({ status: 'queued', retryCount: 0, paused: false, acceptanceCheckPending: false });
  });

  it('rejects a second lead whose slug differs only by case', async () => {
    const db = await createTestDb();
    await db.insert(leads).values({ slug: 'jane-doe', linkedinUrl: url('jane-doe') });
    await expect(db.insert(leads).values({ slug: 'Jane-Doe', linkedinUrl: url('Jane-Doe') })).rejects.toThrow();
  });

  it('rejects two leads with the same provider id', async () => {
    const db = await createTestDb();
    await db.insert(leads).values({ slug: 'a', linkedinUrl: url('a'), providerId: 'ACoJane' });
    await expect(db.insert(leads).values({ slug: 'b', linkedinUrl: url('b'), providerId: 'ACoJane' })).rejects.toThrow();
  });

  it('keeps events when their lead is deleted', async () => {
    const db = await createTestDb();
    const [lead] = await db.insert(leads).values({ slug: 'a', linkedinUrl: url('a') }).returning();
    await db.insert(events).values({ leadId: lead.id, type: 'invite_sent', createdAt: new Date('2026-11-17T09:00:00Z') });
    await db.delete(leads).where(eq(leads.id, lead.id));
    expect((await db.select().from(events))[0].leadId).toBeNull();
  });
});
