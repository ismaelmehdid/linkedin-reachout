import { beforeEach, describe, expect, it } from 'vitest';
import { leads } from '@/db/schema';
import type { Db } from '@/db/types';
import { createTestDb } from '@/test-utils/db';
import { importLeads } from './import';

const NOW = new Date('2026-11-17T09:00:00Z');

describe('importLeads', () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
  });

  it('adds new profiles as queued and due now', async () => {
    expect(await importLeads(db, 'linkedin.com/in/a\n\n linkedin.com/in/b ', NOW)).toEqual({
      added: 2,
      duplicates: [],
      invalid: [],
    });
    const rows = await db.select().from(leads);
    expect(rows.map((r) => [r.slug, r.status, r.nextActionAt])).toEqual([
      ['a', 'queued', NOW],
      ['b', 'queued', NOW],
    ]);
  });

  it('skips people already in the database, whatever their status or letter case', async () => {
    await db.insert(leads).values({
      slug: 'jane-doe',
      linkedinUrl: 'https://www.linkedin.com/in/jane-doe',
      status: 'failed',
    });
    expect(await importLeads(db, 'linkedin.com/in/Jane-Doe', NOW)).toEqual({
      added: 0,
      duplicates: ['Jane-Doe'],
      invalid: [],
    });
  });

  it('skips duplicates inside the same paste', async () =>
    expect(
      await importLeads(db, 'linkedin.com/in/a\nhttps://www.linkedin.com/in/A/', NOW),
    ).toEqual({ added: 1, duplicates: ['A'], invalid: [] }));

  it('reports invalid lines and still adds the valid ones', async () =>
    expect(await importLeads(db, 'linkedin.com/company/acme\nlinkedin.com/in/a', NOW)).toEqual({
      added: 1,
      duplicates: [],
      invalid: [
        {
          line: 'linkedin.com/company/acme',
          error: 'not a profile URL (expected linkedin.com/in/...)',
        },
      ],
    }));

  it('does not throw when two imports of the same profile overlap', async () => {
    const results = await Promise.all([
      importLeads(db, 'linkedin.com/in/a', NOW),
      importLeads(db, 'linkedin.com/in/a', NOW),
    ]);
    expect(results.reduce((sum, r) => sum + r.added, 0)).toBe(1);
    expect(results.filter((r) => r.duplicates.length === 1 && r.duplicates[0] === 'a')).toHaveLength(1);
    expect(await db.select().from(leads)).toHaveLength(1);
  });
});
