import { z } from 'zod';
import { INVITE_NOTE_MAX_LENGTH, validateTemplate } from '@/lib/templates/render';
import type { ActiveWindow } from '@/lib/schedule/window';

export type Settings = {
  templates: { inviteNote: string; firstMessage: string; followup1: string; followup2: string };
  templatesSaved: boolean;
  delays: {
    firstMessageMinMinutes: number;
    firstMessageMaxMinutes: number;
    followup1Days: number;
    followup2Days: number;
    finishDays: number;
    inviteExpiryDays: number;
  };
  caps: {
    invitesPerDay: number;
    invitesPerWeek: number;
    messagesPerDay: number;
    profileViewsPerDay: number;
    jitterMaxSeconds: number;
  };
  window: ActiveWindow;
};

export const DEFAULT_SETTINGS: Settings = {
  templates: {
    inviteNote: 'Hi {{first_name}}, I came across your profile and would be glad to connect.',
    firstMessage: 'Thanks for connecting, {{first_name}}! [Write your first message here.]',
    followup1: 'Hi {{first_name}}, just bumping my previous message.',
    followup2: 'Hi {{first_name}}, last note from me. Happy to chat whenever it suits you.',
  },
  templatesSaved: false,
  delays: {
    firstMessageMinMinutes: 60,
    firstMessageMaxMinutes: 180,
    followup1Days: 2,
    followup2Days: 3,
    finishDays: 3,
    inviteExpiryDays: 21,
  },
  caps: {
    invitesPerDay: 35,
    invitesPerWeek: 190,
    messagesPerDay: 90,
    profileViewsPerDay: 90,
    jitterMaxSeconds: 90,
  },
  window: { days: [1, 2, 3, 4, 5], start: '08:30', end: '19:00', timezone: 'Europe/Paris' },
};

const count = z.number().int().min(0);
const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');

const settingsSchema = z.object({
  templates: z.object({
    inviteNote: z.string(),
    firstMessage: z.string(),
    followup1: z.string(),
    followup2: z.string(),
  }),
  templatesSaved: z.boolean(),
  delays: z.object({
    firstMessageMinMinutes: count,
    firstMessageMaxMinutes: count,
    followup1Days: count,
    followup2Days: count,
    finishDays: count,
    inviteExpiryDays: count,
  }),
  caps: z.object({
    invitesPerDay: count,
    invitesPerWeek: count,
    messagesPerDay: count,
    profileViewsPerDay: count,
    jitterMaxSeconds: count,
  }),
  window: z.object({
    days: z.array(z.number().int().min(1).max(7)),
    start: localTime,
    end: localTime,
    timezone: z.string(),
  }),
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Merges `override` over `base`. Plain objects merge by key; every other value, arrays included, replaces. */
function deepMerge(base: unknown, override: unknown): unknown {
  if (override === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const merged: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) merged[key] = deepMerge(base[key], override[key]);
  return merged;
}

/** Same as `parseSettings`, but reports type errors as `<dotted.path>: <message>` strings. */
export function safeParseSettings(raw: unknown): { ok: true; settings: Settings } | { ok: false; errors: string[] } {
  const result = settingsSchema.safeParse(deepMerge(DEFAULT_SETTINGS, raw));
  if (result.success) return { ok: true, settings: result.data };
  return { ok: false, errors: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) };
}

/** Deep-merges `raw` over the defaults and checks types. Throws `ZodError` on bad types. */
export function parseSettings(raw: unknown): Settings {
  return settingsSchema.parse(deepMerge(DEFAULT_SETTINGS, raw));
}

const TEMPLATE_LABELS: Record<keyof Settings['templates'], string> = {
  inviteNote: 'Invite note',
  firstMessage: 'First message',
  followup1: 'Follow-up 1',
  followup2: 'Follow-up 2',
};

const TEMPLATE_KEYS = Object.keys(TEMPLATE_LABELS) as (keyof Settings['templates'])[];

function templateErrors(templates: Settings['templates']): string[] {
  const errors: string[] = [];
  for (const key of TEMPLATE_KEYS) {
    const label = TEMPLATE_LABELS[key];
    const template = templates[key];
    for (const issue of validateTemplate(template)) {
      if (issue.kind === 'empty') errors.push(`${label}: is empty`);
      else if (issue.kind === 'unknown_variable') errors.push(`${label}: unknown variable {{${issue.name}}}`);
      else if (issue.kind === 'single_brace') errors.push(`${label}: {${issue.name}} needs double braces`);
      else errors.push(`${label}: has an unclosed or malformed {{ }} tag`);
    }
    if (key === 'inviteNote' && template.length > INVITE_NOTE_MAX_LENGTH) {
      errors.push(`Invite note: longer than ${INVITE_NOTE_MAX_LENGTH} characters`);
    }
  }
  return errors;
}

function isKnownTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The longest random wait before an action, in seconds. The tick never waits longer, whatever is stored:
 * its time budget (`ACTION_START_BUDGET_MS` in the engine's tick) is built on this value.
 */
export const MAX_JITTER_SECONDS = 100;

/** The most each cap may be set to: the limits Unipile documents for a paid LinkedIn account (spec §8). */
const CAP_LIMITS: [keyof Settings['caps'], string, number][] = [
  ['invitesPerDay', 'Invites per day', 80],
  ['invitesPerWeek', 'Invites per 7 days', 200],
  ['messagesPerDay', 'Messages per day', 100],
  ['profileViewsPerDay', 'Profile views per day', 100],
];

/** The delays counted in days. With 0, a follow-up would go out on the tick after the previous message. */
const DAY_DELAYS: [keyof Settings['delays'], string][] = [
  ['followup1Days', 'Follow-up 1 delay'],
  ['followup2Days', 'Follow-up 2 delay'],
  ['finishDays', 'End delay'],
  ['inviteExpiryDays', 'Invite expiry'],
];

export function validateSettings(s: Settings): string[] {
  const errors = templateErrors(s.templates);
  if (s.delays.firstMessageMinMinutes > s.delays.firstMessageMaxMinutes) {
    errors.push('First message delay: minimum must not exceed maximum');
  }
  for (const [key, label] of DAY_DELAYS) {
    if (s.delays[key] < 1) errors.push(`${label}: must be at least 1 day`);
  }
  for (const [key, label, limit] of CAP_LIMITS) {
    if (s.caps[key] > limit) errors.push(`${label}: must be ${limit} or less`);
  }
  if (s.caps.jitterMaxSeconds > MAX_JITTER_SECONDS) {
    errors.push(`Random wait: must be ${MAX_JITTER_SECONDS} seconds or less`);
  }
  // HH:MM strings are zero-padded, so string comparison is chronological.
  if (s.window.start >= s.window.end) errors.push('Active window: start must be before end');
  if (s.window.days.length === 0) errors.push('Active window: pick at least one day');
  if (!isKnownTimezone(s.window.timezone)) errors.push(`Active window: unknown timezone ${s.window.timezone}`);
  return errors;
}

/**
 * What stops Start. A template that is still its shipped draft blocks it too: saving the drafts is
 * allowed, for example to change a cap first, but "[Write your first message here.]" must never be sent.
 */
export function startBlockers(s: Settings): string[] {
  if (!s.templatesSaved) return ['Save your templates in Settings first'];
  const placeholders = TEMPLATE_KEYS.filter((key) => s.templates[key].trim() === DEFAULT_SETTINGS.templates[key].trim());
  return [...templateErrors(s.templates), ...placeholders.map((key) => `${TEMPLATE_LABELS[key]}: replace the placeholder text`)];
}
