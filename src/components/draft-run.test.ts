import { describe, expect, it } from 'vitest';
import type { DraftCounts, GenerateNextResult } from '@/app/drafts/generate-next';
import {
  addRunResult,
  blockedMessage,
  EMPTY_RUN_PROGRESS,
  formatDraftCounts,
  formatRunProgress,
  runDraftWorkers,
} from './draft-run';

const COUNTS: DraftCounts = { none: 3, pending: 4, generating: 1, ready: 2, approved: 5, failed: 1 };

const result = (
  status: GenerateNextResult['status'],
  error: string | null = null,
  leadId: number | null = 1,
): GenerateNextResult => ({
  status,
  leadId: status === 'none_left' || status === 'blocked' ? null : leadId,
  error,
  counts: COUNTS,
});

describe('formatDraftCounts', () => {
  it('lists every draft status but none', () => {
    expect(formatDraftCounts(COUNTS)).toBe('4 pending · 1 generating · 2 ready to approve · 5 approved · 1 failed');
  });
});

describe('addRunResult and formatRunProgress', () => {
  it('counts written and failed drafts, but not a lead changed meanwhile', () => {
    let progress = EMPTY_RUN_PROGRESS;
    for (const r of [
      result('ready'),
      result('failed', 'timeout'),
      result('failed', 'lead_changed'),
      result('ready'),
      result('none_left'),
    ]) {
      progress = addRunResult(progress, r);
    }
    expect(progress).toEqual({ written: 2, failed: 1 });
    expect(formatRunProgress(progress, { inFlight: 3, stopping: false, finished: false })).toBe(
      'Writing drafts: 2 written, 1 failed, 3 in progress.',
    );
    expect(formatRunProgress(progress, { inFlight: 2, stopping: true, finished: false })).toBe(
      'Stopping: 2 written, 1 failed, waiting for 2 in progress.',
    );
    expect(formatRunProgress(progress, { inFlight: 0, stopping: false, finished: true })).toBe('Done: 2 written, 1 failed.');
  });
});

describe('blockedMessage', () => {
  it('explains each known reason, and names an unknown one', () => {
    expect(blockedMessage('missing_api_key')).toBe('Add OPENAI_API_KEY to the server environment and restart.');
    expect(blockedMessage('missing_about_me')).toBe('Write your About me first.');
    expect(blockedMessage('something_new')).toBe('Generation is blocked: something_new.');
  });
});

/** A fake generate call whose answers are released by hand, to watch how the workers interleave. */
function controlledGenerate() {
  const calls: Array<(r: GenerateNextResult) => void> = [];
  const generate = () => new Promise<GenerateNextResult>((resolve) => calls.push(resolve));
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { calls, generate, flush };
}

describe('runDraftWorkers', () => {
  it('runs the workers in parallel until each one hears none_left', async () => {
    const { calls, generate, flush } = controlledGenerate();
    const seen: GenerateNextResult[] = [];
    const run = runDraftWorkers({ workers: 4, generate, shouldStop: () => false, onResult: (r) => seen.push(r) });
    await flush();
    expect(calls).toHaveLength(4);

    calls[0](result('ready'));
    await flush();
    expect(calls).toHaveLength(5);

    for (const i of [1, 2, 3, 4]) calls[i](result('none_left'));
    await flush();
    expect(calls).toHaveLength(5);
    expect(await run).toEqual({ blocked: null });
    expect(seen.map((r) => r.status)).toEqual(['ready', 'none_left', 'none_left', 'none_left', 'none_left']);
  });

  it('takes no new lead once stopped, and lets the calls in flight finish', async () => {
    const { calls, generate, flush } = controlledGenerate();
    let stop = false;
    const seen: GenerateNextResult[] = [];
    const run = runDraftWorkers({ workers: 2, generate, shouldStop: () => stop, onResult: (r) => seen.push(r) });
    await flush();
    stop = true;
    calls[0](result('ready'));
    calls[1](result('failed', 'timeout'));
    await flush();
    expect(calls).toHaveLength(2);
    expect(await run).toEqual({ blocked: null });
    expect(seen).toHaveLength(2);
  });

  it('stops every worker on blocked, and returns why', async () => {
    const { calls, generate, flush } = controlledGenerate();
    const run = runDraftWorkers({ workers: 3, generate, shouldStop: () => false, onResult: () => {} });
    await flush();
    calls[0](result('blocked', 'missing_api_key'));
    await flush();
    calls[1](result('ready'));
    calls[2](result('ready'));
    await flush();
    expect(calls).toHaveLength(3);
    expect(await run).toEqual({ blocked: 'missing_api_key' });
  });

  it('stops every worker when a call throws, and rethrows once the others are done', async () => {
    const { calls, generate, flush } = controlledGenerate();
    let failures = 0;
    const run = runDraftWorkers({
      workers: 2,
      generate: () => {
        if (calls.length === 0 && failures === 0) {
          failures += 1;
          return Promise.reject(new Error('HTTP 504'));
        }
        return generate();
      },
      shouldStop: () => false,
      onResult: () => {},
    });
    await flush();
    expect(calls).toHaveLength(1);
    calls[0](result('ready'));
    await expect(run).rejects.toThrow('HTTP 504');
    expect(calls).toHaveLength(1);
  });
});
