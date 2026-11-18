import { existsSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { leads, type LeadContext } from '@/db/schema';
import type { Db } from '@/db/types';
import {
  FOUNDER_RECORD_LIMITS,
  MAX_JOBS_PER_COMPANY,
  parseScraperFiles,
  type FounderRecord,
} from '@/lib/import/scraper-files';
import { UPLOAD_BATCH_MAX_BYTES, uploadBatches } from '@/lib/import/upload';
import { createTestDb } from '@/test-utils/db';
import { importFounders, MAX_FOUNDERS_PER_IMPORT } from './import-founders';

const NOW = new Date('2026-11-17T09:00:00Z');

const context = (founderName: string, patch: Partial<LeadContext['company']> = {}): LeadContext => ({
  founder: { name: founderName, bio: 'Builds things.', pastCompanies: null },
  company: {
    name: 'Acme',
    batch: 'F26',
    website: 'https://acme.dev',
    oneLiner: null,
    description: 'Rockets.',
    teamSize: 4,
    jobs: [
      {
        title: 'Founding Engineer',
        category: 'founding_engineer',
        location: 'San Francisco, CA, US',
        remote: 'no',
        salary: null,
        equity: null,
        url: null,
        description: 'Build it.',
      },
    ],
    ...patch,
  },
});

const record = (url: string, name = 'Jane Doe'): FounderRecord => ({ linkedinUrl: url, context: context(name) });

describe('importFounders', () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
  });

  it('adds founders as queued leads, due now, with their context and drafts pending', async () => {
    expect(
      await importFounders(
        db,
        [record('https://linkedin.com/in/jane-doe', 'Jane  van der Berg'), record('linkedin.com/in/cher', 'Cher')],
        NOW,
      ),
    ).toEqual({ added: 2, duplicates: [], invalid: [] });

    const rows = await db.select().from(leads).orderBy(leads.id);
    expect(
      rows.map((r) => ({
        slug: r.slug,
        linkedinUrl: r.linkedinUrl,
        status: r.status,
        nextActionAt: r.nextActionAt,
        firstName: r.firstName,
        lastName: r.lastName,
        context: r.context,
        draftStatus: r.draftStatus,
        inviteNoteDraft: r.inviteNoteDraft,
        firstMessageDraft: r.firstMessageDraft,
      })),
    ).toEqual([
      {
        slug: 'jane-doe',
        linkedinUrl: 'https://www.linkedin.com/in/jane-doe',
        status: 'queued',
        nextActionAt: NOW,
        firstName: 'Jane',
        lastName: 'van der Berg',
        context: context('Jane  van der Berg'),
        draftStatus: 'pending',
        inviteNoteDraft: null,
        firstMessageDraft: null,
      },
      {
        slug: 'cher',
        linkedinUrl: 'https://www.linkedin.com/in/cher',
        status: 'queued',
        nextActionAt: NOW,
        firstName: 'Cher',
        lastName: null,
        context: context('Cher'),
        draftStatus: 'pending',
        inviteNoteDraft: null,
        firstMessageDraft: null,
      },
    ]);
  });

  it('leaves both names empty for a founder with a blank name', async () => {
    await importFounders(db, [record('linkedin.com/in/anon', '  ')], NOW);
    const [row] = await db.select().from(leads);
    expect([row.firstName, row.lastName]).toEqual([null, null]);
  });

  it('skips people already in the database, whatever their status or letter case', async () => {
    await db.insert(leads).values({ slug: 'jane-doe', linkedinUrl: 'https://www.linkedin.com/in/jane-doe', status: 'failed' });
    expect(await importFounders(db, [record('linkedin.com/in/Jane-Doe')], NOW)).toEqual({
      added: 0,
      duplicates: ['Jane-Doe'],
      invalid: [],
    });
    const [row] = await db.select().from(leads);
    expect([row.status, row.draftStatus, row.context]).toEqual(['failed', 'none', null]);
  });

  it('skips duplicates inside the same call', async () =>
    expect(
      await importFounders(db, [record('linkedin.com/in/a'), record('https://www.linkedin.com/in/A/')], NOW),
    ).toEqual({ added: 1, duplicates: ['A'], invalid: [] }));

  it('reports an invalid URL with the founder name and still adds the valid ones', async () =>
    expect(
      await importFounders(db, [record('linkedin.com/company/acme', 'Jane Doe'), record('linkedin.com/in/a')], NOW),
    ).toEqual({
      added: 1,
      duplicates: [],
      invalid: [{ name: 'Jane Doe', error: 'not a profile URL (expected linkedin.com/in/...)' }],
    }));

  it('does not throw when two imports of the same founder overlap', async () => {
    const results = await Promise.all([
      importFounders(db, [record('linkedin.com/in/a')], NOW),
      importFounders(db, [record('linkedin.com/in/a')], NOW),
    ]);
    expect(results.reduce((sum, r) => sum + r.added, 0)).toBe(1);
    expect(await db.select().from(leads)).toHaveLength(1);
  });

  it('adds nothing for an empty list', async () =>
    expect(await importFounders(db, [], NOW)).toEqual({ added: 0, duplicates: [], invalid: [] }));

  it('throws on a payload that is not a bounded list of founder records', async () => {
    const tooLong = (n: number) => 'x'.repeat(n + 1);
    const bad: unknown[] = [
      null,
      'linkedin.com/in/a',
      { linkedinUrl: 'linkedin.com/in/a' },
      [{ linkedinUrl: 'linkedin.com/in/a' }],
      [{ ...record('linkedin.com/in/a'), extra: 1 }],
      [{ linkedinUrl: 1, context: context('Jane') }],
      [record(`linkedin.com/in/${tooLong(FOUNDER_RECORD_LIMITS.linkedinUrl)}`)],
      [{ linkedinUrl: 'linkedin.com/in/a', context: context(tooLong(FOUNDER_RECORD_LIMITS.founderName)) }],
      [
        {
          linkedinUrl: 'linkedin.com/in/a',
          context: context('Jane', {
            jobs: Array.from({ length: MAX_JOBS_PER_COMPANY + 1 }, () => context('Jane').company.jobs[0]),
          }),
        },
      ],
      [
        {
          linkedinUrl: 'linkedin.com/in/a',
          context: context('Jane', {
            jobs: [{ ...context('Jane').company.jobs[0], description: tooLong(FOUNDER_RECORD_LIMITS.jobDescription) }],
          }),
        },
      ],
      [{ linkedinUrl: 'linkedin.com/in/a', context: context('Jane', { teamSize: -1 }) }],
      [{ linkedinUrl: 'linkedin.com/in/a', context: context('Jane', { teamSize: 1.5 }) }],
      Array.from({ length: MAX_FOUNDERS_PER_IMPORT + 1 }, (_, i) => record(`linkedin.com/in/p${i}`)),
    ];
    for (const payload of bad) await expect(importFounders(db, payload, NOW)).rejects.toThrow();
    expect(await db.select().from(leads)).toHaveLength(0);
  });

  it('accepts a full batch at the limit', async () => {
    const batch = Array.from({ length: MAX_FOUNDERS_PER_IMPORT }, (_, i) => record(`linkedin.com/in/p${i}`));
    expect((await importFounders(db, batch, NOW)).added).toBe(MAX_FOUNDERS_PER_IMPORT);
  });
});

const SAMPLE_JSON = '/Users/ismaelmehdid/Desktop/scrapper/data/companies.json';

describe.skipIf(!existsSync(SAMPLE_JSON))('importFounders with the real sample file', () => {
  it('takes every batch the upload form would send, and adds every founder once', async () => {
    const db = await createTestDb();
    const { records } = parseScraperFiles([{ name: 'companies.json', text: readFileSync(SAMPLE_JSON, 'utf8') }]);
    const batches = uploadBatches(records);
    let added = 0;
    for (const batch of batches) {
      expect(new TextEncoder().encode(JSON.stringify(batch)).length).toBeLessThanOrEqual(UPLOAD_BATCH_MAX_BYTES);
      const result = await importFounders(db, batch, NOW);
      expect(result.invalid).toEqual([]);
      added += result.added;
    }
    expect(added).toBe(264);
    expect((await importFounders(db, batches[0], NOW)).duplicates).toHaveLength(batches[0].length);
  });
});
