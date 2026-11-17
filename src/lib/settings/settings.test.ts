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
});

describe('startBlockers', () => {
  it('blocks Start until templates are saved', () =>
    expect(startBlockers(DEFAULT_SETTINGS)).toEqual(['Save your templates in Settings first']));
  it('allows Start once valid templates are saved', () => expect(startBlockers({ ...DEFAULT_SETTINGS, templatesSaved: true })).toEqual([]));
  it('returns template errors once saved', () =>
    expect(startBlockers({ ...withTemplate('followup1', 'Hi {{firstname}}'), templatesSaved: true })).toEqual([
      'Follow-up 1: unknown variable {{firstname}}',
    ]));
});
