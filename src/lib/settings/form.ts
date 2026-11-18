import type { Settings } from './settings';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

/** A blank or missing field becomes NaN, which validation rejects, instead of `Number('') === 0`. */
function count(form: FormData, name: string): number {
  const value = text(form, name);
  return value.trim() === '' ? NaN : Number(value);
}

/**
 * Reads the settings form. Every key of `templates`, `delays`, `caps`, `pacing` and `window` is always present, even when
 * the form leaves a field out: `saveSettings` merges its input over the defaults, so a missing key would be
 * silently reset to its default instead of rejected. The result is checked by `saveSettings`, hence `unknown`.
 */
export function formDataToSettings(form: FormData): unknown {
  const settings: Omit<Settings, 'templatesSaved'> = {
    templates: {
      inviteNote: text(form, 'inviteNote'),
      firstMessage: text(form, 'firstMessage'),
      followup1: text(form, 'followup1'),
      followup2: text(form, 'followup2'),
    },
    delays: {
      firstMessageMinMinutes: count(form, 'firstMessageMinMinutes'),
      firstMessageMaxMinutes: count(form, 'firstMessageMaxMinutes'),
      followup1Days: count(form, 'followup1Days'),
      followup2Days: count(form, 'followup2Days'),
      finishDays: count(form, 'finishDays'),
      inviteExpiryDays: count(form, 'inviteExpiryDays'),
    },
    caps: {
      invitesPerDay: count(form, 'invitesPerDay'),
      invitesPerWeek: count(form, 'invitesPerWeek'),
      messagesPerDay: count(form, 'messagesPerDay'),
      profileViewsPerDay: count(form, 'profileViewsPerDay'),
      jitterMaxSeconds: count(form, 'jitterMaxSeconds'),
    },
    pacing: {
      minGapMinutes: count(form, 'minGapMinutes'),
      maxGapMinutes: count(form, 'maxGapMinutes'),
      dayStartJitterMinutes: count(form, 'dayStartJitterMinutes'),
      followupJitterMinutes: count(form, 'followupJitterMinutes'),
    },
    window: {
      days: form.getAll('windowDays').map(Number),
      start: text(form, 'windowStart'),
      end: text(form, 'windowEnd'),
      timezone: text(form, 'timezone'),
    },
  };
  return settings;
}
