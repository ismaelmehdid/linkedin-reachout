'use client';

import { useActionState } from 'react';
import { importLeadsAction } from '@/app/actions';
import { formatImportSummary } from '@/lib/leads/display';
import type { ImportResult } from '@/lib/leads/import';

const INITIAL_RESULT: ImportResult | null = null;

export function ImportForm() {
  const [result, formAction, pending] = useActionState(importLeadsAction, INITIAL_RESULT);

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">Add leads</h2>
      <form action={formAction} className="flex flex-col gap-2">
        <textarea
          name="urls"
          aria-label="LinkedIn profile URLs, one per line"
          placeholder={'One LinkedIn profile URL per line, for example\nlinkedin.com/in/jane-doe'}
          rows={5}
          required
          className="rounded border border-zinc-300 px-3 py-2 font-mono text-sm dark:border-zinc-700"
        />
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded bg-zinc-900 px-3 py-2 font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          Add
        </button>
      </form>
      {result && (
        <p role="status" className="text-sm">
          {formatImportSummary(result)}
        </p>
      )}
    </section>
  );
}
