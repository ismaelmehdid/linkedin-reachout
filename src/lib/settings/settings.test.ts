import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, parseSettings, startBlockers, validateSettings, type Settings } from './settings';

const withTemplate = (key: keyof Settings['templates'], value: string): Settings => ({
  ...DEFAULT_SETTINGS,
  templates: { ...DEFAULT_SETTINGS.templates, [key]: value },
});

describe('parseSettings', () => {
  it('fills fields missing from stored JSON with defaults', () =>
    expect(parseSettings({ caps: { invitesPerDay: 10 } }).caps).toEqual({ ...DEFAULT_SETTINGS.caps, invitesPerDay: 10 }));
  it('returns the defaults for an empty object', () => expect(parseSettings({})).toEqual(DEFAULT_SETTINGS));
  it('replaces window days whole instead of merging by index', () =>
    expect(parseSettings({ window: { days: [6] } }).window.days).toEqual([6]));
  it('throws on a wrongly typed value', () => expect(() => parseSettings({ caps: { invitesPerDay: 'many' } })).toThrow());
  it('throws on a negative number', () => expect(() => parseSettings({ caps: { invitesPerDay: -1 } })).toThrow());
});

describe('validateSettings', () => {
  it('accepts the defaults', () => expect(validateSettings(DEFAULT_SETTINGS)).toEqual([]));
  it('rejects a minimum first-message delay above the maximum', () =>
    expect(validateSettings({ ...DEFAULT_SETTINGS, delays: { ...DEFAULT_SETTINGS.delays, firstMessageMinMinutes: 200 } })).toEqual([
      'First message delay: minimum must not exceed maximum',
    ]));
  it('reports an empty template with its label', () =>
    expect(validateSettings(withTemplate('firstMessage', '  '))).toEqual(['First message: is empty']));
  it('reports an unclosed tag', () =>
    expect(validateSettings(withTemplate('followup2', 'Hi {{first name}}'))).toEqual([
      'Follow-up 2: has an unclosed or malformed {{ }} tag',
    ]));
  it('reports an unknown variable', () =>
    expect(validateSettings(withTemplate('followup1', 'Hi {{firstname}}'))).toEqual([
      'Follow-up 1: unknown variable {{firstname}}',
    ]));
  it('rejects an invite note longer than 300 characters', () =>
    expect(validateSettings(withTemplate('inviteNote', 'a'.repeat(301)))).toEqual(['Invite note: longer than 300 characters']));
  it('accepts an invite note of exactly 300 characters', () =>
    expect(validateSettings(withTemplate('inviteNote', 'a'.repeat(300)))).toEqual([]));
  it('requires the window start to be before its end', () =>
    expect(validateSettings({ ...DEFAULT_SETTINGS, window: { ...DEFAULT_SETTINGS.window, start: '19:00', end: '08:30' } })).toEqual([
      'Active window: start must be before end',
    ]));
  it('requires at least one active day', () =>
    expect(validateSettings({ ...DEFAULT_SETTINGS, window: { ...DEFAULT_SETTINGS.window, days: [] } })).toEqual([
      'Active window: pick at least one day',
    ]));
  it('rejects an unknown timezone', () =>
    expect(validateSettings({ ...DEFAULT_SETTINGS, window: { ...DEFAULT_SETTINGS.window, timezone: 'Mars/Base' } })).toEqual([
      'Active window: unknown timezone Mars/Base',
    ]));
  it('rejects a random wait above 100 seconds', () =>
    expect(validateSettings({ ...DEFAULT_SETTINGS, caps: { ...DEFAULT_SETTINGS.caps, jitterMaxSeconds: 101 } })).toEqual([
      'Random wait: must be 100 seconds or less',
    ]));
  it('accepts a random wait of exactly 100 seconds', () =>
    expect(validateSettings({ ...DEFAULT_SETTINGS, caps: { ...DEFAULT_SETTINGS.caps, jitterMaxSeconds: 100 } })).toEqual([]));
  it('reports a known variable in single braces', () =>
    expect(validateSettings(withTemplate('followup1', 'Hi {first_name}'))).toEqual(['Follow-up 1: {first_name} needs double braces']));

  const withCaps = (caps: Partial<Settings['caps']>): Settings => ({ ...DEFAULT_SETTINGS, caps: { ...DEFAULT_SETTINGS.caps, ...caps } });
  const withDelays = (delays: Partial<Settings['delays']>): Settings => ({ ...DEFAULT_SETTINGS, delays: { ...DEFAULT_SETTINGS.delays, ...delays } });

  it('keeps every cap at or under the limit Unipile documents', () => {
    expect(validateSettings(withCaps({ invitesPerDay: 81, invitesPerWeek: 201, messagesPerDay: 101, profileViewsPerDay: 101 }))).toEqual([
      'Invites per day: must be 80 or less',
      'Invites per 7 days: must be 200 or less',
      'Messages per day: must be 100 or less',
      'Profile views per day: must be 100 or less',
    ]);
    expect(validateSettings(withCaps({ invitesPerDay: 80, invitesPerWeek: 200, messagesPerDay: 100, profileViewsPerDay: 100 }))).toEqual([]);
  });
  it('requires every delay counted in days to be at least 1 day', () => {
    expect(validateSettings(withDelays({ followup1Days: 0, followup2Days: 0, finishDays: 0, inviteExpiryDays: 0 }))).toEqual([
      'Follow-up 1 delay: must be at least 1 day',
      'Follow-up 2 delay: must be at least 1 day',
      'End delay: must be at least 1 day',
      'Invite expiry: must be at least 1 day',
    ]);
    expect(validateSettings(withDelays({ followup1Days: 1, followup2Days: 1, finishDays: 1, inviteExpiryDays: 1 }))).toEqual([]);
  });
  it('still accepts a first message with no delay', () =>
    expect(validateSettings(withDelays({ firstMessageMinMinutes: 0, firstMessageMaxMinutes: 0 }))).toEqual([]));
});

describe('startBlockers', () => {
  const OWN_TEMPLATES: Settings['templates'] = {
    inviteNote: 'Hi {{first_name}}, I work on outreach tooling too.',
    firstMessage: 'Thanks for connecting, {{first_name}}. What does {{company|your team}} use today?',
    followup1: 'Hi {{first_name}}, did you get a chance to look?',
    followup2: 'Last one from me, {{first_name}}.',
  };
  const saved = (templates: Partial<Settings['templates']> = {}): Settings => ({
    ...DEFAULT_SETTINGS,
    templates: { ...OWN_TEMPLATES, ...templates },
    templatesSaved: true,
  });

  it('blocks Start until templates are saved', () =>
    expect(startBlockers(DEFAULT_SETTINGS)).toEqual(['Save your templates in Settings first']));
  it('allows Start once four templates of the owner\'s own are saved', () => expect(startBlockers(saved())).toEqual([]));
  it('blocks Start while saved templates are still the shipped placeholders', () =>
    expect(startBlockers({ ...DEFAULT_SETTINGS, templatesSaved: true })).toEqual([
      'Invite note: replace the placeholder text',
      'First message: replace the placeholder text',
      'Follow-up 1: replace the placeholder text',
      'Follow-up 2: replace the placeholder text',
    ]));
  it('names each template that is still a placeholder, ignoring spaces around it', () =>
    expect(startBlockers(saved({ firstMessage: `  ${DEFAULT_SETTINGS.templates.firstMessage}\n`, followup2: DEFAULT_SETTINGS.templates.followup2 }))).toEqual([
      'First message: replace the placeholder text',
      'Follow-up 2: replace the placeholder text',
    ]));
  it('returns template errors once saved', () =>
    expect(startBlockers(saved({ followup1: 'Hi {{firstname}}' }))).toEqual(['Follow-up 1: unknown variable {{firstname}}']));
  it('lets the placeholders be saved, so a cap can be changed before the templates are written', () =>
    expect(validateSettings(DEFAULT_SETTINGS)).toEqual([]));
});
