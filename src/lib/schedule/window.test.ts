import { describe, it, expect } from 'vitest';
import {
  isInActiveWindow,
  nextWindowStart,
  nextActiveDayStart,
  startOfLocalDay,
  addLocalDays,
  windowBounds,
} from './window';

const W = { days: [1, 2, 3, 4, 5], start: '08:30', end: '19:00', timezone: 'Europe/Paris' };
const d = (iso: string) => new Date(iso);

describe('active window', () => {
  it('opens at 08:30 and closes at 19:00 Paris time', () => {
    expect(isInActiveWindow(d('2026-11-17T07:30:00Z'), W)).toBe(true);
    expect(isInActiveWindow(d('2026-11-17T07:29:59Z'), W)).toBe(false);
    expect(isInActiveWindow(d('2026-11-17T18:00:00Z'), W)).toBe(false);
    expect(isInActiveWindow(d('2026-11-21T10:00:00Z'), W)).toBe(false); // Saturday
  });

  it('finds the next window opening', () => {
    expect(nextWindowStart(d('2026-11-17T10:00:00Z'), W)).toEqual(d('2026-11-17T10:00:00Z'));
    expect(nextWindowStart(d('2026-11-17T05:00:00Z'), W)).toEqual(d('2026-11-17T07:30:00Z'));
    expect(nextWindowStart(d('2026-11-17T19:00:00Z'), W)).toEqual(d('2026-11-18T07:30:00Z'));
    expect(nextWindowStart(d('2026-11-20T18:30:00Z'), W)).toEqual(d('2026-11-23T07:30:00Z')); // Friday evening to Monday
  });

  it('handles the March 2027 change to summer time', () =>
    expect(nextWindowStart(d('2027-03-26T18:00:00Z'), W)).toEqual(d('2027-03-29T06:30:00Z')));

  it('finds the start of the next active day', () => {
    expect(nextActiveDayStart(d('2026-11-17T10:00:00Z'), W)).toEqual(d('2026-11-18T07:30:00Z'));
    expect(nextActiveDayStart(d('2026-11-20T10:00:00Z'), W)).toEqual(d('2026-11-23T07:30:00Z'));
  });

  it('computes the local start of day', () => {
    expect(startOfLocalDay(d('2026-11-17T22:30:00Z'), 'Europe/Paris')).toEqual(d('2026-11-16T23:00:00Z'));
    expect(startOfLocalDay(d('2026-11-17T23:30:00Z'), 'Europe/Paris')).toEqual(d('2026-11-17T23:00:00Z'));
  });

  it('adds calendar days at the same local time across a time change', () =>
    expect(addLocalDays(d('2027-03-27T09:00:00Z'), 2, 'Europe/Paris')).toEqual(d('2027-03-29T08:00:00Z')));

  it('gives the bounds of the window that contains now, and null outside it', () => {
    expect(windowBounds(d('2026-11-17T09:00:00Z'), W)).toEqual({ start: d('2026-11-17T07:30:00Z'), end: d('2026-11-17T18:00:00Z') });
    expect(windowBounds(d('2026-11-17T18:00:00Z'), W)).toBeNull();
    expect(windowBounds(d('2027-03-29T07:00:00Z'), W)).toEqual({ start: d('2027-03-29T06:30:00Z'), end: d('2027-03-29T17:00:00Z') });
  });
});
