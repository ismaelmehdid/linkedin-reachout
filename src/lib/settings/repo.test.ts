import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/db/types';
import { createTestDb } from '@/test-utils/db';
import { getSettings, saveSettings } from './repo';
import { DEFAULT_SETTINGS, type Settings } from './settings';

const withTemplate = (key: keyof Settings['templates'], value: string): Settings => ({
  ...DEFAULT_SETTINGS,
  templates: { ...DEFAULT_SETTINGS.templates, [key]: value },
});

describe('settings repo', () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
  });

  it('returns the defaults when nothing is saved', async () => expect(await getSettings(db)).toEqual(DEFAULT_SETTINGS));

  it('saves, reloads and marks templates as saved', async () => {
    const result = await saveSettings(db, { ...DEFAULT_SETTINGS, caps: { ...DEFAULT_SETTINGS.caps, invitesPerDay: 20 } });
    expect(result.ok).toBe(true);
    expect(await getSettings(db)).toMatchObject({ templatesSaved: true, caps: { invitesPerDay: 20 } });
  });

  it('overwrites the single row on a second save', async () => {
    await saveSettings(db, DEFAULT_SETTINGS);
    await saveSettings(db, { ...DEFAULT_SETTINGS, caps: { ...DEFAULT_SETTINGS.caps, invitesPerDay: 5 } });
    expect((await getSettings(db)).caps.invitesPerDay).toBe(5);
  });

  it('rejects unknown variables with a readable error', async () =>
    expect(await saveSettings(db, withTemplate('followup1', 'Hi {{firstname}}'))).toEqual({
      ok: false,
      errors: ['Follow-up 1: unknown variable {{firstname}}'],
    }));

  it('rejects a non-integer cap', async () => {
    const result = await saveSettings(db, { ...DEFAULT_SETTINGS, caps: { ...DEFAULT_SETTINGS.caps, invitesPerDay: Number.NaN } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/^caps\.invitesPerDay: /);
  });

  it.each([
    ['start after end', { start: '19:00', end: '08:30' }],
    ['no days', { days: [] }],
    ['unknown timezone', { timezone: 'Mars/Base' }],
  ])('rejects an invalid active window (%s) and stores nothing', async (_name, patch) => {
    const result = await saveSettings(db, { ...DEFAULT_SETTINGS, window: { ...DEFAULT_SETTINGS.window, ...patch } });
    expect(result.ok).toBe(false);
    expect(await getSettings(db)).toEqual(DEFAULT_SETTINGS);
  });
});
