import { DateTime } from 'luxon';

export type ActiveWindow = {
  /** ISO weekdays: 1 = Monday ... 7 = Sunday. */
  days: number[];
  /** Local HH:MM, inclusive. */
  start: string;
  /** Local HH:MM, exclusive. */
  end: string;
  timezone: string;
};

function parseTime(value: string): { hour: number; minute: number } {
  const [hour, minute] = value.split(':').map(Number);
  return { hour, minute };
}

function at(day: DateTime, time: string): DateTime {
  return day.startOf('day').set({ ...parseTime(time), second: 0, millisecond: 0 });
}

function local(date: Date, timezone: string): DateTime {
  return DateTime.fromJSDate(date, { zone: timezone });
}

export function isInActiveWindow(now: Date, w: ActiveWindow): boolean {
  const t = local(now, w.timezone);
  if (!w.days.includes(t.weekday)) return false;
  return t >= at(t, w.start) && t < at(t, w.end);
}

/** The opening and closing instants of the active window that contains `now`, or null outside the window. */
export function windowBounds(now: Date, w: ActiveWindow): { start: Date; end: Date } | null {
  if (!isInActiveWindow(now, w)) return null;
  const t = local(now, w.timezone);
  return { start: at(t, w.start).toJSDate(), end: at(t, w.end).toJSDate() };
}

/** First active day strictly after `day`, at the window opening. */
function openingAfter(day: DateTime, w: ActiveWindow): DateTime {
  if (w.days.length === 0) throw new Error('Active window has no days');
  for (let i = 1; i <= 7; i++) {
    const candidate = day.plus({ days: i });
    if (w.days.includes(candidate.weekday)) return at(candidate, w.start);
  }
  throw new Error('Active window has no valid days');
}

export function nextWindowStart(now: Date, w: ActiveWindow): Date {
  if (isInActiveWindow(now, w)) return now;
  const t = local(now, w.timezone);
  if (w.days.includes(t.weekday)) {
    const opening = at(t, w.start);
    if (t < opening) return opening.toJSDate();
  }
  return openingAfter(t, w).toJSDate();
}

export function nextActiveDayStart(now: Date, w: ActiveWindow): Date {
  return openingAfter(local(now, w.timezone), w).toJSDate();
}

export function startOfLocalDay(now: Date, timezone: string): Date {
  return local(now, timezone).startOf('day').toJSDate();
}

export function addLocalDays(date: Date, days: number, timezone: string): Date {
  return local(date, timezone).plus({ days }).toJSDate();
}
