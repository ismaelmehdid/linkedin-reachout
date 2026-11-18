import { describe, expect, it } from 'vitest';
import { dayStartAt, pickGapMs, withdrawalGapMs, WITHDRAWAL_GAP_MAX_MINUTES, WITHDRAWAL_GAP_MIN_MINUTES } from './pacing';

const P = { minGapMinutes: 4, maxGapMinutes: 45, dayStartJitterMinutes: 45, followupJitterMinutes: 180 };
const MIN = 60_000;

describe('pacing', () => {
  it('spreads the planned sends over the time that is left', () => {
    expect(pickGapMs({ timeLeftMs: 300 * MIN, planned: 30, pacing: P, random: () => 0.5 })).toBe(10 * MIN);
    expect(pickGapMs({ timeLeftMs: 300 * MIN, planned: 30, pacing: P, random: () => 0 })).toBe(5 * MIN);
    expect(pickGapMs({ timeLeftMs: 300 * MIN, planned: 30, pacing: P, random: () => 0.9 })).toBe(14 * MIN);
  });
  it('keeps the average pause between the minimum and the maximum', () => {
    expect(pickGapMs({ timeLeftMs: 300 * MIN, planned: 1000, pacing: P, random: () => 0.5 })).toBe(4 * MIN);
    expect(pickGapMs({ timeLeftMs: 300 * MIN, planned: 1, pacing: P, random: () => 0.5 })).toBe(45 * MIN);
    expect(pickGapMs({ timeLeftMs: 300 * MIN, planned: 0, pacing: P, random: () => 0.5 })).toBe(45 * MIN);
  });
  it('gives no pause when spacing is off', () =>
    expect(pickGapMs({ timeLeftMs: 300 * MIN, planned: 5, pacing: { ...P, minGapMinutes: 0, maxGapMinutes: 0 }, random: () => 0.5 })).toBe(0));
  it('starts the day at a random moment after the window opens', () =>
    expect(dayStartAt(new Date('2026-11-17T07:30:00Z'), new Date('2026-11-17T07:31:00Z'), P, () => 0.5)).toEqual(new Date('2026-11-17T07:52:30Z')));
  it('starts within two minutes when the day is already under way', () =>
    expect(dayStartAt(new Date('2026-11-17T07:30:00Z'), new Date('2026-11-17T09:00:00Z'), P, () => 0.5)).toEqual(new Date('2026-11-17T09:01:00Z')));
  it('does not delay the start when the day-start setting is 0', () =>
    expect(dayStartAt(new Date('2026-11-17T07:30:00Z'), new Date('2026-11-17T07:31:00Z'), { ...P, dayStartJitterMinutes: 0 }, () => 0.5)).toEqual(new Date('2026-11-17T07:31:00Z')));
  it('pauses 10 to 30 minutes between withdrawals, and not at all when spacing is off', () => {
    expect(withdrawalGapMs(P, () => 0.5)).toBe(20 * MIN);
    expect(withdrawalGapMs({ ...P, maxGapMinutes: 0 }, () => 0.5)).toBe(0);
  });

  // Beyond the brief's list: the ends of each random range, and a minimum stored above the maximum.
  it('draws each pause between half and one and a half times the average', () => {
    expect(pickGapMs({ timeLeftMs: 300 * MIN, planned: 30, pacing: P, random: () => 0.999 })).toBe(Math.round(10 * MIN * 1.499));
    expect(pickGapMs({ timeLeftMs: 0, planned: 30, pacing: P, random: () => 0 })).toBe(2 * MIN);
  });
  it('lets the maximum win over a minimum stored above it', () =>
    expect(pickGapMs({ timeLeftMs: 300 * MIN, planned: 1000, pacing: { ...P, minGapMinutes: 60, maxGapMinutes: 45 }, random: () => 0.5 })).toBe(45 * MIN));
  it('starts the day no later than the day-start setting after the window opens', () => {
    const opens = new Date('2026-11-17T07:30:00Z');
    expect(dayStartAt(opens, opens, P, () => 0)).toEqual(new Date('2026-11-17T07:30:00Z'));
    expect(dayStartAt(opens, new Date('2026-11-17T07:29:00Z'), P, () => 0.999)).toEqual(new Date(opens.getTime() + Math.round(0.999 * 45 * MIN)));
  });
  it('keeps every withdrawal pause inside its range', () => {
    expect(withdrawalGapMs(P, () => 0)).toBe(WITHDRAWAL_GAP_MIN_MINUTES * MIN);
    expect(withdrawalGapMs(P, () => 0.999)).toBeLessThan(WITHDRAWAL_GAP_MAX_MINUTES * MIN);
    expect([WITHDRAWAL_GAP_MIN_MINUTES, WITHDRAWAL_GAP_MAX_MINUTES]).toEqual([10, 30]);
  });
});
