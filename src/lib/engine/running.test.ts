import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/db/types';
import { saveSettings } from '@/lib/settings/repo';
import { DEFAULT_SETTINGS } from '@/lib/settings/settings';
import { createTestDb } from '@/test-utils/db';
import { setRunningUnlessBlocked } from './running';
import { ERROR_STREAK_LIMIT, getAppState, incrementErrorStreak, setRunning } from './state';

/** Settings a start accepts: saved, valid, and no longer the shipped placeholder drafts. */
const READY_SETTINGS = {
  ...DEFAULT_SETTINGS,
  templates: {
    inviteNote: 'Hi {{first_name}}, glad to connect.',
    firstMessage: 'Thanks for connecting, {{first_name}}.',
    followup1: 'Hi {{first_name}}, any thoughts?',
    followup2: 'Last one from me, {{first_name}}.',
  },
};

/** Runs the app, then lets the error streak stop it the way the engine does. */
async function autoPause(db: Db): Promise<void> {
  await setRunning(db, true);
  for (let i = 0; i < ERROR_STREAK_LIMIT; i++) await incrementErrorStreak(db, 'http_503');
}

describe('setRunningUnlessBlocked', () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
  });

  it('pauses an app the engine already auto-paused and keeps its reason and error streak', async () => {
    // Nothing blocks a start, so a toggle would restart sending here.
    expect((await saveSettings(db, READY_SETTINGS)).ok).toBe(true);
    await autoPause(db);
    const before = await getAppState(db);
    expect(before).toMatchObject({ running: false, consecutiveErrors: ERROR_STREAK_LIMIT });
    expect(before.pauseReason).toContain('Auto-paused');

    expect(await setRunningUnlessBlocked(db, false)).toEqual({ blockers: [] });
    expect(await getAppState(db)).toMatchObject({
      running: false,
      pauseReason: before.pauseReason,
      consecutiveErrors: ERROR_STREAK_LIMIT,
    });
  });

  it('pauses a running app', async () => {
    await setRunning(db, true);
    expect(await setRunningUnlessBlocked(db, false)).toEqual({ blockers: [] });
    expect((await getAppState(db)).running).toBe(false);
  });

  it('returns the start blockers without starting', async () => {
    await autoPause(db);
    const before = await getAppState(db);
    // The settings were never saved, so the templates are not saved either.
    expect(await setRunningUnlessBlocked(db, true)).toEqual({ blockers: ['Save your templates in Settings first'] });
    expect(await getAppState(db)).toEqual(before);
  });

  it('starts when nothing blocks it, clearing the pause reason and the error streak', async () => {
    expect((await saveSettings(db, READY_SETTINGS)).ok).toBe(true);
    await autoPause(db);
    expect(await setRunningUnlessBlocked(db, true)).toEqual({ blockers: [] });
    expect(await getAppState(db)).toMatchObject({ running: true, pauseReason: null, consecutiveErrors: 0 });
  });

  it('does not start while a saved template is still a shipped placeholder', async () => {
    // Saving the placeholders works, for example to change a cap; sending them must not.
    expect((await saveSettings(db, { ...READY_SETTINGS, templates: { ...READY_SETTINGS.templates, firstMessage: DEFAULT_SETTINGS.templates.firstMessage } })).ok).toBe(true);
    expect(await setRunningUnlessBlocked(db, true)).toEqual({ blockers: ['First message: replace the placeholder text'] });
    expect((await getAppState(db)).running).toBe(false);
  });
});
