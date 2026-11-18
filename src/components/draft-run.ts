// Pure module: no Node, database or React imports. Used by DraftsPanel in the browser and by its tests.
import type { DraftCounts, GenerateNextResult } from '@/app/drafts/generate-next';

/** How many generations run at once. Each takes about 30 s. */
export const DRAFT_WORKERS = 4;

/** The error of a lead that was edited, regenerated or removed during its generation: not a failure. */
const LEAD_CHANGED = 'lead_changed';

export function formatDraftCounts(counts: DraftCounts): string {
  return [
    `${counts.pending} pending`,
    `${counts.generating} generating`,
    `${counts.ready} ready to approve`,
    `${counts.approved} approved`,
    `${counts.failed} failed`,
  ].join(' · ');
}

export type RunProgress = { written: number; failed: number };

export const EMPTY_RUN_PROGRESS: RunProgress = { written: 0, failed: 0 };

export function addRunResult(progress: RunProgress, result: GenerateNextResult): RunProgress {
  if (result.status === 'ready') return { ...progress, written: progress.written + 1 };
  if (result.status === 'failed' && result.error !== LEAD_CHANGED) return { ...progress, failed: progress.failed + 1 };
  return progress;
}

export function formatRunProgress(
  progress: RunProgress,
  run: { inFlight: number; stopping: boolean; finished: boolean },
): string {
  const done = `${progress.written} written, ${progress.failed} failed`;
  if (run.finished) return `Done: ${done}.`;
  if (run.stopping) return `Stopping: ${done}, waiting for ${run.inFlight} in progress.`;
  return `Writing drafts: ${done}, ${run.inFlight} in progress.`;
}

/** What the owner must do before generation can run. */
export function blockedMessage(error: string): string {
  if (error === 'missing_api_key') return 'Add OPENAI_API_KEY to the server environment and restart.';
  if (error === 'missing_about_me') return 'Write your About me first.';
  return `Generation is blocked: ${error}.`;
}

/**
 * Runs `workers` loops at once, each asking for one generation after another until it hears `none_left`.
 * `shouldStop` stops taking new leads; calls in flight finish. A `blocked` answer or a call that throws
 * stops every loop; the error is rethrown once the calls in flight are done.
 */
export async function runDraftWorkers(opts: {
  workers: number;
  generate: () => Promise<GenerateNextResult>;
  shouldStop: () => boolean;
  onResult: (result: GenerateNextResult) => void;
}): Promise<{ blocked: string | null }> {
  let blocked: string | null = null;
  let thrown: { error: unknown } | null = null;
  const halted = () => blocked !== null || thrown !== null || opts.shouldStop();

  async function worker(): Promise<void> {
    while (!halted()) {
      let result: GenerateNextResult;
      try {
        result = await opts.generate();
      } catch (error) {
        thrown ??= { error };
        return;
      }
      opts.onResult(result);
      if (result.status === 'blocked') blocked ??= result.error ?? 'unknown';
      if (result.status === 'none_left' || result.status === 'blocked') return;
    }
  }

  await Promise.all(Array.from({ length: opts.workers }, worker));
  if (thrown !== null) throw (thrown as { error: unknown }).error;
  return { blocked };
}

/** One generation through the dashboard's route. Throws on any answer but 200, with its status. */
export async function generateThroughRoute(): Promise<GenerateNextResult> {
  const response = await fetch('/api/drafts/generate', { method: 'POST' });
  if (!response.ok) {
    if (response.status === 401) throw new Error('your session ended, log in again');
    throw new Error(`the server answered ${response.status}`);
  }
  return (await response.json()) as GenerateNextResult;
}
