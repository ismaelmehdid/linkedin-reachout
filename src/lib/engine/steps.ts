import type { LeadStatus } from '@/db/schema';
import { addLocalDays } from '@/lib/schedule/window';
import type { Settings } from '@/lib/settings/settings';

export type StepKind = 'invite' | 'expire_invite' | 'first_message' | 'followup_1' | 'followup_2' | 'finish';

export type MessageStep = 'first_message' | 'followup_1' | 'followup_2';

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

/** When the step after a send is due: calendar days in the window's timezone, so the local time of day is kept. */
export function nextDueAfterSend(status: 'messaged' | 'followup_1' | 'followup_2', sentAt: Date, settings: Settings): Date {
  const days = {
    messaged: settings.delays.followup1Days,
    followup_1: settings.delays.followup2Days,
    followup_2: settings.delays.finishDays,
  }[status];
  return addLocalDays(sentAt, days, settings.window.timezone);
}

/** A random point between the minimum and maximum first-message delay after acceptance. */
export function firstMessageDueAt(acceptedAt: Date, random: () => number, delays: Settings['delays']): Date {
  const { firstMessageMinMinutes: min, firstMessageMaxMinutes: max } = delays;
  const minutes = min + random() * (max - min);
  return new Date(acceptedAt.getTime() + Math.round(minutes * 60_000));
}
