import { DateTime } from 'luxon';
import type { EventRow, Lead } from '@/db/schema';
import type { AppState } from '@/lib/engine/state';
import { nextStep, type StepKind } from '@/lib/engine/steps';
import type { ImportResult } from './import';

const STEP_LABELS: Record<StepKind, string> = {
  invite: 'Invite',
  expire_invite: 'Withdraw invite',
  first_message: 'First message',
  followup_1: 'Follow-up 1',
  followup_2: 'Follow-up 2',
  finish: 'Mark no response',
};

/** The step the lead waits for and when it is due, or null when its sequence is over. */
export function describeNextAction(lead: Lead): { label: string; dueAt: Date | null } | null {
  const step = nextStep(lead.status);
  if (step === null) return null;
  const label = STEP_LABELS[step];
  return { label: lead.paused ? `Paused · ${label}` : label, dueAt: lead.nextActionAt };
}

export function leadDisplayName(lead: Pick<Lead, 'firstName' | 'lastName' | 'slug'>): string {
  return [lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.slug;
}

/**
 * The current role read from LinkedIn, `<position> at <company>`, or the one of them that is present.
 * Null when neither is: an empty or blank value counts as absent.
 */
export function leadRoleLine(lead: Pick<Lead, 'position' | 'company'>): string | null {
  const position = lead.position?.trim() || null;
  const company = lead.company?.trim() || null;
  if (position && company) return `${position} at ${company}`;
  return position ?? company;
}

/** `yyyy-MM-dd HH:mm` in `timezone`. */
export function formatLocal(date: Date, timezone: string): string {
  return DateTime.fromJSDate(date, { zone: timezone }).toFormat('yyyy-MM-dd HH:mm');
}

/** For example `2 added · 1 already contacted: jane-doe · 1 invalid: <line> (<error>)`. */
export function formatImportSummary(result: ImportResult): string {
  const parts = [`${result.added} added`];
  if (result.duplicates.length > 0) {
    parts.push(`${result.duplicates.length} already contacted: ${result.duplicates.join(', ')}`);
  }
  if (result.invalid.length > 0) {
    parts.push(`${result.invalid.length} invalid: ${result.invalid.map((i) => `${i.line} (${i.error})`).join(', ')}`);
  }
  return parts.join(' · ');
}

/**
 * The line under an event in the log: why an action failed, which webhook arrived and what it led to, or
 * the text of an invite or a message. Null for an event with nothing more to say.
 */
export function eventDetail(event: Pick<EventRow, 'type' | 'payload'>): string | null {
  const payload = typeof event.payload === 'object' && event.payload !== null ? (event.payload as Record<string, unknown>) : {};
  const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);
  switch (event.type) {
    case 'action_failed': {
      const status = typeof payload.status === 'number' ? `http_${payload.status}` : null;
      const parts = [text(payload.kind), text(payload.type) ?? status, text(payload.message)].filter((part) => part !== null);
      return parts.length > 0 ? parts.join(' · ') : null;
    }
    case 'webhook_received': {
      const outcome = text(payload.outcome);
      return outcome === null ? null : `${text(payload.event) ?? 'unknown event'}: ${outcome}`;
    }
    case 'invite_sent':
    case 'message_sent': {
      const sent = text(payload.text);
      if (sent === null) return null;
      // Found in the chat before a send: the message had gone out, but its record had been lost.
      if (payload.recovered === true) return `recorded (already sent): ${sent}`;
      return payload.dryRun === true ? `would send: ${sent}` : `sent: ${sent}`;
    }
    default:
      return null;
  }
}

/**
 * The dashboard's banners. The first always says whether sends are real, so a missing banner is never
 * the only sign of live sending. A pause shows only while its end is after `now`, as the tick counts it.
 */
export function dashboardBanners(
  state: Pick<AppState, 'pauseReason' | 'invitesPausedUntil' | 'messagesPausedUntil'>,
  opts: { dryRun: boolean; now: Date; timezone: string },
): string[] {
  const banners = [opts.dryRun ? 'Dry run: nothing is sent to LinkedIn' : 'Live: actions are sent to LinkedIn'];
  if (state.pauseReason) banners.push(state.pauseReason);
  const addPauseBanner = (kind: string, until: Date | null) => {
    if (until !== null && until > opts.now) banners.push(`${kind} paused until ${formatLocal(until, opts.timezone)}`);
  };
  addPauseBanner('Invites', state.invitesPausedUntil);
  addPauseBanner('Messages', state.messagesPausedUntil);
  return banners;
}
