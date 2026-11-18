import type { LeadStatus } from '@/db/schema';
import { addLocalDays } from '@/lib/schedule/window';
import type { Settings } from '@/lib/settings/settings';

export type StepKind = 'invite' | 'expire_invite' | 'first_message' | 'followup_1' | 'followup_2' | 'finish';

export type MessageStep = 'first_message' | 'followup_1' | 'followup_2';

/**
 * How long after a lead's last recorded action an outgoing message still counts as part of it. Recorded
 * times and LinkedIn's clock can differ by a few seconds, and the app records a step before LinkedIn stamps it.
 */
export const ECHO_WINDOW_MS = 120_000;

/** The statuses that wait for a message, and the message each one sends. */
export const MESSAGE_STEP_BY_STATUS = {
  accepted: 'first_message',
  already_connected: 'first_message',
  messaged: 'followup_1',
  followup_1: 'followup_2',
} as const satisfies Partial<Record<LeadStatus, MessageStep>>;

const NEXT_STEP: Record<LeadStatus, StepKind | null> = {
  queued: 'invite',
  invite_sent: 'expire_invite',
  ...MESSAGE_STEP_BY_STATUS,
  followup_2: 'finish',
  replied: null,
  no_response: null,
  invite_expired: null,
  failed: null,
};

const STATUS_AFTER_MESSAGE = {
  first_message: 'messaged',
  followup_1: 'followup_1',
  followup_2: 'followup_2',
} as const satisfies Record<MessageStep, LeadStatus>;

/** The step a lead in `status` waits for, or null when its sequence is over. */
export function nextStep(status: LeadStatus): StepKind | null {
  return NEXT_STEP[status];
}

export function statusAfterMessage(step: MessageStep): 'messaged' | 'followup_1' | 'followup_2' {
  return STATUS_AFTER_MESSAGE[step];
}

/**
 * When the step after a send is due: calendar days in the window's timezone, so the local time of day is
 * kept. With `random`, a follow-up also gets a random part of `followupJitterMinutes` on top, so it does not
 * come at the same time of day as the message before it (spec §8 "Spacing"). The end of the sequence does not.
 */
export function nextDueAfterSend(
  status: 'messaged' | 'followup_1' | 'followup_2',
  sentAt: Date,
  settings: Settings,
  random?: () => number,
): Date {
  const days = {
    messaged: settings.delays.followup1Days,
    followup_1: settings.delays.followup2Days,
    followup_2: settings.delays.finishDays,
  }[status];
  const due = addLocalDays(sentAt, days, settings.window.timezone);
  if (random === undefined || status === 'followup_2') return due;
  return new Date(due.getTime() + Math.floor(random() * settings.pacing.followupJitterMinutes * 60_000));
}

/** A random point between the minimum and maximum first-message delay after acceptance. */
export function firstMessageDueAt(acceptedAt: Date, random: () => number, delays: Settings['delays']): Date {
  const { firstMessageMinMinutes: min, firstMessageMaxMinutes: max } = delays;
  const minutes = min + random() * (max - min);
  return new Date(acceptedAt.getTime() + Math.round(minutes * 60_000));
}
