import { describe, expect, it } from 'vitest';
import type { FounderRecord } from './scraper-files';
import { addImportResult, EMPTY_UPLOAD_TOTALS, formatUploadSummary, uploadBatches } from './upload';

const record = (url: string, description = ''): FounderRecord => ({
  linkedinUrl: url,
  context: {
    founder: { name: 'Jane Doe', bio: null, pastCompanies: null },
    company: {
      name: 'Acme',
      batch: null,
      website: null,
      oneLiner: null,
      description,
      hiringDescription: null,
      teamSize: null,
      jobs: [],
    },
  },
});

describe('uploadBatches', () => {
  it('splits records into batches of at most the given count, in order', () => {
    const records = Array.from({ length: 5 }, (_, i) => record(`linkedin.com/in/p${i}`));
    expect(uploadBatches(records, { maxRecords: 2, maxBytes: 1_000_000 }).map((b) => b.map((r) => r.linkedinUrl))).toEqual([
      ['linkedin.com/in/p0', 'linkedin.com/in/p1'],
      ['linkedin.com/in/p2', 'linkedin.com/in/p3'],
      ['linkedin.com/in/p4'],
    ]);
  });

  it('starts a new batch before one would pass the size limit, counting UTF-8 bytes', () => {
    const big = record('linkedin.com/in/big', 'é'.repeat(400));
    const size = new TextEncoder().encode(JSON.stringify(big)).length;
    const batches = uploadBatches([big, big, big], { maxRecords: 50, maxBytes: size * 2 + 10 });
    expect(batches.map((b) => b.length)).toEqual([2, 1]);
  });

  it('still sends a record bigger than the size limit, alone', () => {
    const big = record('linkedin.com/in/big', 'x'.repeat(1000));
    expect(uploadBatches([big, big], { maxRecords: 50, maxBytes: 100 }).map((b) => b.length)).toEqual([1, 1]);
  });

  it('gives no batch for no records', () => {
    expect(uploadBatches([])).toEqual([]);
  });

  it('uses batches of 50 by default', () => {
    const records = Array.from({ length: 120 }, (_, i) => record(`linkedin.com/in/p${i}`));
    expect(uploadBatches(records).map((b) => b.length)).toEqual([50, 50, 20]);
  });
});

describe('upload summary', () => {
  it('adds up the results of each batch', () => {
    const totals = [
      { added: 2, duplicates: ['a'], invalid: [] },
      { added: 1, duplicates: ['b', 'c'], invalid: [{ name: 'Jane Doe', error: 'not a LinkedIn URL' }] },
    ].reduce(addImportResult, { ...EMPTY_UPLOAD_TOTALS, total: 7, skippedNoLinkedIn: 1 });
    expect(totals).toEqual({
      total: 7,
      sent: 7,
      added: 3,
      duplicates: 3,
      invalid: [{ name: 'Jane Doe', error: 'not a LinkedIn URL' }],
      skippedNoLinkedIn: 1,
    });
  });

  it('shows the progress while uploading, then the final counts', () => {
    const running = { total: 264, sent: 50, added: 48, duplicates: 2, invalid: [], skippedNoLinkedIn: 1 };
    expect(formatUploadSummary(running, false)).toBe(
      'Uploading 50 of 264 founders · 48 added · 2 already imported · 0 invalid URL · 1 skipped (no LinkedIn)',
    );
    const done = {
      ...running,
      sent: 264,
      added: 260,
      invalid: [
        { name: 'Jane Doe', error: 'not a LinkedIn URL' },
        { name: '', error: 'not a profile URL (expected linkedin.com/in/...)' },
      ],
    };
    expect(formatUploadSummary(done, true)).toBe(
      '260 added · 2 already imported · 2 invalid URL: Jane Doe (not a LinkedIn URL), unnamed founder (not a profile URL (expected linkedin.com/in/...)) · 1 skipped (no LinkedIn)',
    );
  });
});
