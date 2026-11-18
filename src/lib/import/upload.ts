import type { FounderImportResult } from '@/lib/leads/import-founders';
import type { FounderRecord } from './scraper-files';

/**
 * Splitting the upload into server action calls, and the summary shown while it runs. Pure: it runs in
 * the browser.
 */

/** Records per server action call. */
export const UPLOAD_BATCH_RECORDS = 50;
/** Well under the 1 MB server action body limit, leaving room for the encoding around the records. */
export const UPLOAD_BATCH_MAX_BYTES = 700_000;

const recordBytes = (record: FounderRecord, encoder: TextEncoder) => encoder.encode(JSON.stringify(record)).length;

/**
 * The records in order, in batches of at most `maxRecords` and, as far as one record allows, at most
 * `maxBytes` of JSON. A record bigger than `maxBytes` goes alone.
 */
export function uploadBatches(
  records: FounderRecord[],
  { maxRecords = UPLOAD_BATCH_RECORDS, maxBytes = UPLOAD_BATCH_MAX_BYTES } = {},
): FounderRecord[][] {
  const encoder = new TextEncoder();
  const batches: FounderRecord[][] = [];
  let batch: FounderRecord[] = [];
  let bytes = 0;
  for (const record of records) {
    const size = recordBytes(record, encoder);
    if (batch.length > 0 && (batch.length >= maxRecords || bytes + size > maxBytes)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(record);
    bytes += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

export type UploadTotals = {
  /** Founder records to send. */
  total: number;
  /** Founder records sent so far. */
  sent: number;
  added: number;
  duplicates: number;
  invalid: FounderImportResult['invalid'];
  skippedNoLinkedIn: number;
};

export const EMPTY_UPLOAD_TOTALS: UploadTotals = {
  total: 0,
  sent: 0,
  added: 0,
  duplicates: 0,
  invalid: [],
  skippedNoLinkedIn: 0,
};

/** The totals after one more batch came back. */
export function addImportResult(totals: UploadTotals, result: FounderImportResult): UploadTotals {
  return {
    ...totals,
    sent: totals.sent + result.added + result.duplicates.length + result.invalid.length,
    added: totals.added + result.added,
    duplicates: totals.duplicates + result.duplicates.length,
    invalid: [...totals.invalid, ...result.invalid],
  };
}

export function formatUploadSummary(totals: UploadTotals, done: boolean): string {
  const invalid = done && totals.invalid.length > 0
    ? `${totals.invalid.length} invalid URL: ${totals.invalid
        .map((i) => `${i.name.trim() || 'unnamed founder'} (${i.error})`)
        .join(', ')}`
    : `${totals.invalid.length} invalid URL`;
  const parts = [
    `${totals.added} added`,
    `${totals.duplicates} already imported`,
    invalid,
    `${totals.skippedNoLinkedIn} skipped (no LinkedIn)`,
  ];
  if (!done) parts.unshift(`Uploading ${totals.sent} of ${totals.total} founders`);
  return parts.join(' · ');
}
