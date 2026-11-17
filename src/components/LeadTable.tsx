'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { pauseLeadAction, removeLeadAction, resumeLeadAction, retryLeadAction } from '@/app/actions';

/** One table row, with its dates already formatted in the active window's timezone. */
export type LeadRow = {
  id: number;
  name: string;
  headline: string | null;
  role: string | null;
  linkedinUrl: string;
  status: string;
  failureReason: string | null;
  lastAction: string | null;
  lastActionAt: string | null;
  nextAction: string | null;
  nextActionDueAt: string | null;
  paused: boolean;
};

const REMOVE_CONFIRMATION = 'Remove this lead? Its history stays, and the person can be added again later.';

function RowButton({ children }: { children: ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded border border-zinc-300 px-2 py-1 text-xs disabled:opacity-50 dark:border-zinc-700"
    >
      {children}
    </button>
  );
}

function RowActions({ row }: { row: LeadRow }) {
  return (
    <div className="flex flex-wrap gap-1">
      {row.paused ? (
        <form action={resumeLeadAction.bind(null, row.id)}>
          <RowButton>Resume</RowButton>
        </form>
      ) : (
        // A lead whose sequence is over has nothing left to pause.
        row.nextAction !== null && (
          <form action={pauseLeadAction.bind(null, row.id)}>
            <RowButton>Pause</RowButton>
          </form>
        )
      )}
      {row.status === 'failed' && (
        <form action={retryLeadAction.bind(null, row.id)}>
          <RowButton>Retry</RowButton>
        </form>
      )}
      <form
        action={removeLeadAction.bind(null, row.id)}
        onSubmit={(event) => {
          // A prevented submit never reaches the action.
          if (!window.confirm(REMOVE_CONFIRMATION)) event.preventDefault();
        }}
      >
        <RowButton>Remove</RowButton>
      </form>
    </div>
  );
}

function FilterLink({ href, active, children }: { href: string; active: boolean; children: ReactNode }) {
  return (
    <Link href={href} aria-current={active ? 'page' : undefined} className={active ? 'font-semibold underline' : 'underline-offset-2 hover:underline'}>
      {children}
    </Link>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <div className="text-xs text-zinc-500">{children}</div>;
}

export function LeadTable({ rows, statuses, activeStatus }: { rows: LeadRow[]; statuses: string[]; activeStatus: string | null }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">Leads</h2>
      <nav aria-label="Filter by status" className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
        <FilterLink href="/" active={activeStatus === null}>
          All
        </FilterLink>
        {statuses.map((status) => (
          <FilterLink key={status} href={`/?status=${status}`} active={activeStatus === status}>
            {status}
          </FilterLink>
        ))}
      </nav>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-300 dark:border-zinc-700">
              <th className="py-2 pr-3 font-medium">Name</th>
              <th className="py-2 pr-3 font-medium">LinkedIn</th>
              <th className="py-2 pr-3 font-medium">Status</th>
              <th className="py-2 pr-3 font-medium">Last action</th>
              <th className="py-2 pr-3 font-medium">Next action</th>
              <th className="py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="py-3 text-zinc-500">
                  No leads.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-zinc-200 align-top dark:border-zinc-800">
                <td className="py-2 pr-3">
                  <div>{row.name}</div>
                  {row.headline && <Muted>{row.headline}</Muted>}
                  {row.role !== null && <Muted>{row.role}</Muted>}
                </td>
                <td className="py-2 pr-3">
                  <a href={row.linkedinUrl} target="_blank" rel="noopener noreferrer" className="underline">
                    Profile
                  </a>
                </td>
                <td className="py-2 pr-3">
                  <div>{row.status}</div>
                  {row.failureReason && <Muted>{row.failureReason}</Muted>}
                </td>
                <td className="py-2 pr-3">
                  {row.lastAction ?? '—'}
                  {row.lastActionAt && <Muted>{row.lastActionAt}</Muted>}
                </td>
                <td className="py-2 pr-3">
                  {row.nextAction ?? '—'}
                  {row.nextActionDueAt && <Muted>{row.nextActionDueAt}</Muted>}
                </td>
                <td className="py-2">
                  <RowActions row={row} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
