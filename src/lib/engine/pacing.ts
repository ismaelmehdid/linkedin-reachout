import type { Settings } from '@/lib/settings/settings';

/**
 * Spacing between sends (spec §8 "Spacing"): when the next invite, message or withdrawal may happen.
 * Pure functions: the tick reads the clock and the random source and passes them in.
 */

const MINUTE_MS = 60_000;

/** When the day is already under way, its first send comes within this time. */
const LATE_DAY_START_MS = 120_000;

/** The pause after an invite withdrawal is drawn between these two values, in minutes. */
export const WITHDRAWAL_GAP_MIN_MINUTES = 10;
export const WITHDRAWAL_GAP_MAX_MINUTES = 30;

/**
 * The pause before the next send. The average is the time left in today's window divided by the sends
 * still planned for it, kept between the minimum and the maximum pause; the pause is drawn between 50% and
 * 150% of that average. 0 when the maximum is 0: spacing is off.
 */
export function pickGapMs(input: {
  timeLeftMs: number;
  planned: number;
  pacing: Settings['pacing'];
  random: () => number;
}): number {
  const { timeLeftMs, planned, pacing, random } = input;
  if (pacing.maxGapMinutes === 0) return 0;
  const spread = timeLeftMs / Math.max(1, planned);
  // The maximum is applied last, so it wins over a minimum stored above it.
  const averageMs = Math.min(Math.max(spread, pacing.minGapMinutes * MINUTE_MS), pacing.maxGapMinutes * MINUTE_MS);
  return Math.round(averageMs * (0.5 + random()));
}

/**
 * The earliest moment of a day's first send: a random moment within `dayStartJitterMinutes` after the
 * window opened, or, when that moment is already past, within two minutes of `now`. `now` when the
 * setting is 0.
 */
export function dayStartAt(windowStart: Date, now: Date, pacing: Settings['pacing'], random: () => number): Date {
  if (pacing.dayStartJitterMinutes === 0) return new Date(now.getTime());
  const r = random();
  const candidate = windowStart.getTime() + Math.round(r * pacing.dayStartJitterMinutes * MINUTE_MS);
  if (candidate > now.getTime()) return new Date(candidate);
  return new Date(now.getTime() + Math.round(r * LATE_DAY_START_MS));
}

/** The pause after an invite withdrawal: a random 10 to 30 minutes, or 0 when spacing is off. */
export function withdrawalGapMs(pacing: Settings['pacing'], random: () => number): number {
  if (pacing.maxGapMinutes === 0) return 0;
  const minutes = WITHDRAWAL_GAP_MIN_MINUTES + random() * (WITHDRAWAL_GAP_MAX_MINUTES - WITHDRAWAL_GAP_MIN_MINUTES);
  return Math.round(minutes * MINUTE_MS);
}
