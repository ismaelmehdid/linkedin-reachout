'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { approveAllReadyDraftsAction, retryFailedDraftsAction } from '@/app/drafts/actions';
import type { DraftCounts } from '@/app/drafts/generate-next';
import {
  addRunResult,
  blockedMessage,
  DRAFT_WORKERS,
  EMPTY_RUN_PROGRESS,
  formatDraftCounts,
  formatRunProgress,
  generateThroughRoute,
  runDraftWorkers,
  type RunProgress,
} from './draft-run';

type Run = { progress: RunProgress; inFlight: number; stopping: boolean; finished: boolean };

const BUTTON = 'rounded border border-zinc-300 px-3 py-2 text-sm disabled:opacity-50 dark:border-zinc-700';
const PRIMARY =
  'rounded bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900';

/**
 * Writes the AI drafts of the uploaded founders, a few at a time, while this tab stays open. Each worker
 * calls POST /api/drafts/generate (a route, not an action: the browser runs actions one at a time).
 */
export function DraftsPanel({ counts }: { counts: DraftCounts }) {
  const router = useRouter();
  const stopRequested = useRef(false);
  const [liveCounts, setLiveCounts] = useState<DraftCounts | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const running = run !== null && !run.finished;
  // The counts each generation returns are shown until the refreshed page brings new ones.
  const [countsSeen, setCountsSeen] = useState(counts);
  if (counts !== countsSeen) {
    setCountsSeen(counts);
    if (!running) setLiveCounts(null);
  }
  const shown = liveCounts ?? counts;

  async function generate() {
    stopRequested.current = false;
    setBlocked(null);
    setFailure(null);
    setNotice(null);
    setRun({ progress: EMPTY_RUN_PROGRESS, inFlight: 0, stopping: false, finished: false });
    try {
      const outcome = await runDraftWorkers({
        workers: DRAFT_WORKERS,
        generate: async () => {
          setRun((r) => r && { ...r, inFlight: r.inFlight + 1 });
          try {
            return await generateThroughRoute();
          } finally {
            setRun((r) => r && { ...r, inFlight: r.inFlight - 1 });
          }
        },
        shouldStop: () => stopRequested.current,
        onResult: (result) => {
          setLiveCounts(result.counts);
          setRun((r) => r && { ...r, progress: addRunResult(r.progress, result) });
        },
      });
      setBlocked(outcome.blocked);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'unknown error');
    } finally {
      setRun((r) => r && { ...r, inFlight: 0, finished: true });
      router.refresh();
    }
  }

  function stop() {
    stopRequested.current = true;
    setRun((r) => r && { ...r, stopping: true });
  }

  async function approveAll() {
    if (!window.confirm(`Approve ${counts.ready} ready drafts? Approved drafts are sent as soon as the app is running.`)) return;
    setBusy(true);
    setNotice(null);
    try {
      const approved = await approveAllReadyDraftsAction();
      setNotice(`Approved ${approved} drafts.`);
    } catch {
      setNotice('Approving failed. Reload the page and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function retryFailed() {
    setBusy(true);
    setNotice(null);
    try {
      const retried = await retryFailedDraftsAction();
      setNotice(`${retried} failed drafts are pending again. Press Generate drafts to write them.`);
    } catch {
      setNotice('Retrying failed. Reload the page and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">AI drafts</h2>
      <p className="text-sm">{formatDraftCounts(shown)}</p>
      <p className="text-sm text-zinc-500">
        Only approved drafts are sent, and they are sent as soon as the app is running. Keep this tab open while drafts are
        written; pressing Generate drafts again continues where it stopped.
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={generate} disabled={running || busy} className={PRIMARY}>
          Generate drafts
        </button>
        {running && (
          <button type="button" onClick={stop} disabled={run.stopping} className={BUTTON}>
            Stop
          </button>
        )}
        <button type="button" onClick={approveAll} disabled={running || busy || counts.ready === 0} className={BUTTON}>
          Approve all ready drafts
        </button>
        <button type="button" onClick={retryFailed} disabled={running || busy || counts.failed === 0} className={BUTTON}>
          Retry failed
        </button>
      </div>
      {run && (
        <p role="status" className="text-sm">
          {formatRunProgress(run.progress, run)}
        </p>
      )}
      {blocked && (
        <p role="alert" className="text-sm text-red-600">
          {blocked === 'missing_about_me' ? (
            <Link href="/settings" className="underline">
              {blockedMessage(blocked)}
            </Link>
          ) : (
            blockedMessage(blocked)
          )}
        </p>
      )}
      {failure && (
        <p role="alert" className="text-sm text-red-600">
          Generation stopped: {failure}. Press Generate drafts to continue.
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
    </section>
  );
}
