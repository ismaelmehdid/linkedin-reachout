'use client';

import { useActionState } from 'react';
import { setRunningAction } from '@/app/actions';
import type { Usage } from '@/lib/engine/usage';
import type { Settings } from '@/lib/settings/settings';

const INITIAL_RESULT: { blockers: string[] } = { blockers: [] };

// Each button asks for a state, never a toggle. Bound once here, not on each render: after a form post
// without JavaScript, React checks the bound action's signature and waits for its arguments, and a new
// binding on every render would make that wait start over forever.
const startAction = setRunningAction.bind(null, true);
const pauseAction = setRunningAction.bind(null, false);

type Props = {
  counts: { status: string; count: number }[];
  usage: Usage;
  caps: Settings['caps'];
  banners: string[];
  running: boolean;
  /** When the next invite or message may go out, or null when it may come on the next tick. */
  nextSend: string | null;
};

export function StatusBar({ counts, usage, caps, banners, running, nextSend }: Props) {
  const [result, runningAction, pending] = useActionState(running ? pauseAction : startAction, INITIAL_RESULT);
  const usageLine = [
    `Invites today ${usage.invitesToday}/${caps.invitesPerDay}`,
    `7 days ${usage.invitesLast7Days}/${caps.invitesPerWeek}`,
    `Messages today ${usage.messagesToday}/${caps.messagesPerDay}`,
    `Profile views today ${usage.profileViewsToday}/${caps.profileViewsPerDay}`,
  ].join(' · ');

  return (
    <section className="flex flex-col gap-3">
      {banners.map((banner) => (
        <p key={banner} role="alert" className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {banner}
        </p>
      ))}

      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium">{running ? 'Running' : 'Paused'}</span>
        <form action={runningAction}>
          <button
            type="submit"
            disabled={pending}
            className="rounded bg-zinc-900 px-3 py-2 font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {running ? 'Pause' : 'Start'}
          </button>
        </form>
      </div>
      {result.blockers.length > 0 && (
        <ul role="alert" className="list-disc pl-5 text-sm text-red-600">
          {/* Two issues can read the same, so the position is the key. */}
          {result.blockers.map((blocker, i) => (
            <li key={i}>{blocker}</li>
          ))}
        </ul>
      )}

      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {counts.map(({ status, count }) => (
          <li key={status}>
            {status} <span className="font-semibold">{count}</span>
          </li>
        ))}
      </ul>

      <p className="text-sm text-zinc-600 dark:text-zinc-400">{usageLine}</p>
      {nextSend && <p className="text-sm text-zinc-600 dark:text-zinc-400">{nextSend}</p>}
    </section>
  );
}
