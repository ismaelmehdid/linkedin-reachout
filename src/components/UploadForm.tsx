'use client';

import { useRef, useState, type FormEvent } from 'react';
import { importFoundersAction } from '@/app/actions';
import { parseScraperFiles } from '@/lib/import/scraper-files';
import {
  addImportResult,
  EMPTY_UPLOAD_TOTALS,
  formatUploadSummary,
  uploadBatches,
  type UploadTotals,
} from '@/lib/import/upload';

/**
 * Uploads the scraper's files (`companies.json`, or `founders.csv` with `jobs.csv`). The files are read
 * here in the browser, and the founders go to the server in batches, one after another.
 */
export function UploadForm() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [totals, setTotals] = useState<UploadTotals | null>(null);
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const files = Array.from(inputRef.current?.files ?? []);
    if (files.length === 0) return;

    setPending(true);
    setErrors([]);
    setTotals(null);
    setDone(false);
    setFailure(null);
    try {
      const parsed = parseScraperFiles(
        await Promise.all(files.map(async (file) => ({ name: file.name, text: await file.text() }))),
      );
      setErrors(parsed.errors);

      let current: UploadTotals = {
        ...EMPTY_UPLOAD_TOTALS,
        total: parsed.records.length,
        skippedNoLinkedIn: parsed.skippedNoLinkedIn,
      };
      setTotals(current);
      for (const batch of uploadBatches(parsed.records)) {
        current = addImportResult(current, await importFoundersAction(batch));
        setTotals(current);
      }
      setDone(true);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'unknown error');
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">Upload founders</h2>
      <form onSubmit={upload} className="flex flex-col gap-2">
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".json,.csv"
          required
          aria-label="The scraper's files: companies.json, or founders.csv with jobs.csv"
          className="text-sm"
        />
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded bg-zinc-900 px-3 py-2 font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          Upload
        </button>
      </form>
      {errors.length > 0 && (
        <ul role="alert" className="list-disc pl-5 text-sm text-red-600">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      {totals && (
        <p role="status" className="text-sm">
          {formatUploadSummary(totals, done)}
        </p>
      )}
      {failure && (
        <p role="alert" className="text-sm text-red-600">
          Upload stopped: {failure}. Uploading the same files again skips the founders already added.
        </p>
      )}
    </section>
  );
}
