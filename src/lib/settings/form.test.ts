import { describe, it, expect } from 'vitest';
import { createTestDb } from '@/test-utils/db';
import { formDataToSettings } from './form';
import { saveSettings } from './repo';
import { DEFAULT_SETTINGS, type Settings } from './settings';

const fullForm = (over: Record<string, string> = {}) => {
  const fd = new FormData();
  const s = DEFAULT_SETTINGS;
  const fields: Record<string, string> = {
    inviteNote: 'Hi {{first_name}}',
    firstMessage: s.templates.firstMessage,
    followup1: s.templates.followup1,
    followup2: s.templates.followup2,
    ...Object.fromEntries(Object.entries({ ...s.delays, ...s.caps }).map(([k, v]) => [k, String(v)])),
    windowStart: '08:30',
    windowEnd: '19:00',
    timezone: 'Europe/Paris',
    ...over,
  };
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  fd.append('windowDays', '1');
  fd.append('windowDays', '3');
  return fd;
};

const SECTIONS = ['templates', 'delays', 'caps', 'window'] as const;

const sortedKeys = (value: object) => Object.keys(value).sort();

describe('formDataToSettings', () => {
  it('maps the form fields to settings', () =>
    expect(formDataToSettings(fullForm({ invitesPerDay: '20' }))).toEqual({
      templates: { ...DEFAULT_SETTINGS.templates, inviteNote: 'Hi {{first_name}}' },
      delays: DEFAULT_SETTINGS.delays,
      caps: { ...DEFAULT_SETTINGS.caps, invitesPerDay: 20 },
      window: { days: [1, 3], start: '08:30', end: '19:00', timezone: 'Europe/Paris' },
    }));

  it('turns an empty number field into NaN so validation rejects it', () =>
    expect((formDataToSettings(fullForm({ invitesPerDay: '' })) as Settings).caps.invitesPerDay).toBeNaN());

  it('turns a blank number field into NaN as well', () =>
    expect((formDataToSettings(fullForm({ invitesPerDay: '  ' })) as Settings).caps.invitesPerDay).toBeNaN());

  it('round-trips through saveSettings', async () =>
    expect((await saveSettings(await createTestDb(), formDataToSettings(fullForm()))).ok).toBe(true));

  // saveSettings merges its input over the defaults, so a key left out would silently reset to its default.
  it.each([
    ['a full form', fullForm()],
    ['an empty form', new FormData()],
  ])('emits every key of templates, delays, caps and window for %s', (_name, form) => {
    const settings = formDataToSettings(form) as Settings;
    for (const section of SECTIONS) expect(sortedKeys(settings[section])).toEqual(sortedKeys(DEFAULT_SETTINGS[section]));
  });

  it('makes saveSettings reject a form with missing fields instead of saving defaults', async () => {
    const result = await saveSettings(await createTestDb(), formDataToSettings(new FormData()));
    expect(result.ok).toBe(false);
  });
});
