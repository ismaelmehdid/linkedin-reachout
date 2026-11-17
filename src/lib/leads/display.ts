import { DateTime } from 'luxon';
import type { Lead } from '@/db/schema';
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

/** The dashboard's banners. A pause shows only while its end is after `now`, as the tick counts it. */
export function dashboardBanners(
  state: Pick<AppState, 'pauseReason' | 'invitesPausedUntil' | 'messagesPausedUntil'>,
  opts: { dryRun: boolean; now: Date; timezone: string },
): string[] {
  const banners: string[] = [];
  if (opts.dryRun) banners.push('Dry run: nothing is sent to LinkedIn');
  if (state.pauseReason) banners.push(state.pauseReason);
  const addPauseBanner = (kind: string, until: Date | null) => {
    if (until !== null && until > opts.now) banners.push(`${kind} paused until ${formatLocal(until, opts.timezone)}`);
  };
  addPauseBanner('Invites', state.invitesPausedUntil);
  addPauseBanner('Messages', state.messagesPausedUntil);
  return banners;
}
