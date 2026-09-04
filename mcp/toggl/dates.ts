import { ToolError } from '@ontrove/extend/toolkit';

/**
 * Calendar maths for the time-entry window: named periods resolved in the
 * caller's zone, and the instants at which those calendar days begin there.
 *
 * The zone matters twice. This server runs in UTC, so "today" computed naively
 * rolls over mid-afternoon for a Pacific user — `timeZone` decides which
 * calendar day is meant. And the Toggl 2.0 time-entry filters are
 * **timestamps**, not dates, so the day boundary sent upstream has to be the
 * zone's own midnight rather than UTC's: a bare date would start a Vancouver
 * "today" seven hours early and catch last night's entries.
 */

export const PERIODS = ['today', 'yesterday', 'week', 'lastWeek', 'month', 'lastMonth'] as const;
export type Period = (typeof PERIODS)[number];

function badZone(timeZone: string): ToolError {
  return new ToolError(
    `"${timeZone}" is not a recognised IANA time zone (e.g. America/Vancouver).`,
    { retryable: false },
  );
}

/** Calendar Y/M/D of `now` as observed in `timeZone`. */
function calendarDay(now: Date, timeZone: string): { y: number; m: number; d: number } {
  let parts: string;
  try {
    // en-CA renders as YYYY-MM-DD.
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    throw badZone(timeZone);
  }
  const [y, m, d] = parts.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) {
    throw new ToolError(`Could not read a calendar date for time zone "${timeZone}".`, {
      retryable: false,
    });
  }
  return { y, m, d };
}

/** YYYY-MM-DD for a UTC-epoch day index, used for pure calendar arithmetic. */
function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const DAY = 86_400_000;

/**
 * Resolve a named period to a `[start, end)` pair of calendar days — end
 * always exclusive.
 *
 * `timeZone` decides which calendar day "today" means; the arithmetic itself
 * is done on UTC day boundaries, which is exact because only whole days are
 * involved.
 */
export function dateRangeFor(
  period: Period,
  timeZone: string,
  now: Date,
): { start: string; end: string } {
  const { y, m, d } = calendarDay(now, timeZone);
  const today = Date.UTC(y, m - 1, d);

  switch (period) {
    case 'today': {
      return { start: iso(today), end: iso(today + DAY) };
    }
    case 'yesterday': {
      return { start: iso(today - DAY), end: iso(today) };
    }
    case 'week':
    case 'lastWeek': {
      // getUTCDay: 0=Sunday. Shift so Monday starts the week.
      const weekday = new Date(today).getUTCDay();
      const sinceMonday = (weekday + 6) % 7;
      const monday = today - sinceMonday * DAY - (period === 'lastWeek' ? 7 * DAY : 0);
      return { start: iso(monday), end: iso(monday + 7 * DAY) };
    }
    case 'month': {
      return { start: iso(Date.UTC(y, m - 1, 1)), end: iso(Date.UTC(y, m, 1)) };
    }
    case 'lastMonth': {
      return { start: iso(Date.UTC(y, m - 2, 1)), end: iso(Date.UTC(y, m - 1, 1)) };
    }
  }
}

/** The zone's UTC offset in ms at a given instant, via Intl. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const field = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour'),
    field('minute'),
    field('second'),
  );
  return asUtc - utcMs;
}

/**
 * The instant at which a calendar day begins in `timeZone`, as RFC 3339.
 *
 * Two passes through the offset handle a boundary that falls on a DST change.
 */
export function zonedMidnight(day: string, timeZone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
    throw new ToolError(`"${day}" is not a date. Expected YYYY-MM-DD.`, { retryable: false });
  }
  const naive = Date.parse(`${day}T00:00:00Z`);
  let guess: number;
  try {
    guess = naive - zoneOffsetMs(naive, timeZone);
    guess = naive - zoneOffsetMs(guess, timeZone);
  } catch {
    throw badZone(timeZone);
  }
  return new Date(guess).toISOString();
}

/** The range arguments of `get_time_entries`, as given. */
export interface RangeArgs {
  period?: Period;
  start_date?: string;
  end_date?: string;
  time_zone: string;
}

/** A resolved window: the calendar days asked for, and the instants bounding them. */
export interface Window {
  range: { start: string; end: string };
  window: { from: string; to: string };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Turn a period or an explicit pair of dates into calendar days and the
 * instants that bound them in `time_zone`.
 *
 * Explicit dates must come as a pair: the API requires both ends, so guessing
 * one would silently widen or narrow what the caller asked for.
 */
export function resolveWindow(
  { period, start_date, end_date, time_zone }: RangeArgs,
  now: Date,
): Window {
  const isExplicit = !period && Boolean(start_date || end_date);
  if (isExplicit && !(start_date && end_date)) {
    throw new ToolError(
      'Give both start_date and end_date (YYYY-MM-DD, end exclusive), or a period.',
      { retryable: false },
    );
  }
  if (isExplicit && !(DATE.test(start_date ?? '') && DATE.test(end_date ?? ''))) {
    throw new ToolError('start_date and end_date must be YYYY-MM-DD.', { retryable: false });
  }
  const range =
    isExplicit && start_date && end_date
      ? { start: start_date, end: end_date }
      : dateRangeFor(period ?? 'today', time_zone, now);
  const window = {
    from: zonedMidnight(range.start, time_zone),
    to: zonedMidnight(range.end, time_zone),
  };
  if (window.from >= window.to) {
    throw new ToolError(`end_date must be after start_date (got ${range.start} → ${range.end}).`, {
      retryable: false,
    });
  }
  return { range, window };
}
