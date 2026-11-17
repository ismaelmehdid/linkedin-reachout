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

function templateErrors(templates: Settings['templates']): string[] {
  const errors: string[] = [];
  for (const key of Object.keys(TEMPLATE_LABELS) as (keyof Settings['templates'])[]) {
    const label = TEMPLATE_LABELS[key];
    const template = templates[key];
    for (const issue of validateTemplate(template)) {
      if (issue.kind === 'empty') errors.push(`${label}: is empty`);
      else if (issue.kind === 'unknown_variable') errors.push(`${label}: unknown variable {{${issue.name}}}`);
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

const MAX_JITTER_SECONDS = 100;

export function validateSettings(s: Settings): string[] {
  const errors = templateErrors(s.templates);
  if (s.delays.firstMessageMinMinutes > s.delays.firstMessageMaxMinutes) {
    errors.push('First message delay: minimum must not exceed maximum');
  }
  // The tick's 180 s budget holds 30 s of housekeeping, this wait and two Unipile calls of 20 s.
  if (s.caps.jitterMaxSeconds > MAX_JITTER_SECONDS) {
    errors.push(`Random wait: must be ${MAX_JITTER_SECONDS} seconds or less`);
  }
  // HH:MM strings are zero-padded, so string comparison is chronological.
  if (s.window.start >= s.window.end) errors.push('Active window: start must be before end');
  if (s.window.days.length === 0) errors.push('Active window: pick at least one day');
  if (!isKnownTimezone(s.window.timezone)) errors.push(`Active window: unknown timezone ${s.window.timezone}`);
  return errors;
}

export function startBlockers(s: Settings): string[] {
  if (!s.templatesSaved) return ['Save your templates in Settings first'];
  return templateErrors(s.templates);
}
