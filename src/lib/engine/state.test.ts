import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/db/types';
import { createTestDb } from '@/test-utils/db';
import { NOW } from '@/test-utils/engine';
import {
  acquireTickLock,
  getAppState,
  incrementErrorStreak,
  releaseTickLock,
  resetErrorStreak,
  setRunning,
  updateAppState,
} from './state';

describe('app state', () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
  });

  it('creates the single row with its defaults on first read', async () =>
    expect(await getAppState(db)).toEqual({
      id: 1,
      running: false,
      pauseReason: null,
      invitesPausedUntil: null,
      messagesPausedUntil: null,
      nextInvitePollAt: null,
      tickLockUntil: null,
      consecutiveErrors: 0,
    }));

  it('gives the lock to one tick at a time', async () => {
    expect(await acquireTickLock(db, NOW, 240_000)).toBe(true);
    expect(await acquireTickLock(db, NOW, 240_000)).toBe(false);
    await releaseTickLock(db);
    expect(await acquireTickLock(db, NOW, 240_000)).toBe(true);
  });

  it('takes over an expired lease', async () => {
    await acquireTickLock(db, NOW, 240_000);
    expect(await acquireTickLock(db, new Date(NOW.getTime() + 240_001), 240_000)).toBe(true);
  });

  it('auto-pauses on the third error in a row', async () => {
    await setRunning(db, true);
    expect(await incrementErrorStreak(db, 'a')).toEqual({ autoPaused: false });
    await incrementErrorStreak(db, 'b');
    expect(await incrementErrorStreak(db, 'errors/cannot_resend_yet')).toEqual({ autoPaused: true });
    expect(await getAppState(db)).toMatchObject({ running: false, pauseReason: 'Auto-paused after 3 Unipile errors in a row (last: errors/cannot_resend_yet)' });
  });

  it('does not auto-pause when a success resets the streak in between', async () => {
    await setRunning(db, true);
    await incrementErrorStreak(db, 'a');
    await incrementErrorStreak(db, 'b');
    await resetErrorStreak(db);
    expect(await incrementErrorStreak(db, 'c')).toEqual({ autoPaused: false });
    expect(await getAppState(db)).toMatchObject({ running: true, pauseReason: null, consecutiveErrors: 1 });
  });

  it('starting again clears the pause reason and the streak', async () => {
    await updateAppState(db, { pauseReason: 'x', consecutiveErrors: 3 }); await setRunning(db, true);
    expect(await getAppState(db)).toMatchObject({ running: true, pauseReason: null, consecutiveErrors: 0 });
  });
});
