import type { CsvRow } from './csv.ts';

/**
 * Reading OWID's two time axes, and noticing when the data came back from a
 * different window than the one requested.
 *
 * Two upstream facts drive all of it: a chart's time column is either a YEAR
 * (which may be negative, for BCE) or a `YYYY-MM-DD` DAY; and `time` is not a
 * filter — grapher snaps to the nearest available point rather than returning
 * nothing, so a request for 1800-1810 can legitimately answer with 1831.
 */

/** The `[first, last]` time values present in the rows, in sorted order. */
export function timeRange(rows: CsvRow[]): { first: string; last: string } | null {
  const first = rows[0]?.time;
  if (first === undefined) return null;
  let low = first;
  let high = first;
  for (const row of rows) {
    if (earlier(row.time, low)) low = row.time;
    if (earlier(high, row.time)) high = row.time;
  }
  return { first: low, last: high };
}

/**
 * Is `a` an earlier time than `b`?
 *
 * Years are compared as numbers, not text. OWID charts reach back past year
 * zero — population series start at -10000 — and lexically "-10000" sorts
 * after "1750", which would report a range running backwards.  `YYYY-MM-DD`
 * days are fixed-width, so string order is already chronological.
 */
function earlier(a: string, b: string): boolean {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na < nb;
  return a < b;
}

/** A time point as a comparable number: a year, or a `YYYY-MM-DD` as `YYYYMMDD`. */
function timeValue(point: string): number | undefined {
  const date = /^(-?\d+)-(\d{2})-(\d{2})$/.exec(point);
  if (date?.[1] !== undefined && date[2] !== undefined && date[3] !== undefined) {
    return Number(date[1]) * 10_000 + Number(date[2]) * 100 + Number(date[3]);
  }
  return /^-?\d+$/.test(point) ? Number(point) : undefined;
}

/** The same, for a row's time cell — years compare as years, days as `YYYYMMDD`. */
function rowValue(time: string, timeUnit: 'year' | 'day'): number | undefined {
  return timeUnit === 'day' ? timeValue(time) : timeValue(time.split('-')[0] ?? time);
}

/**
 * The inclusive bounds a `time` argument asks for, when it states any.
 *
 * Dates count, not just bare years: `1990-01-01..2000-12-31` is a perfectly
 * legal request on a daily chart and used to slip through unchecked, which
 * skipped the snap warning on exactly the charts most likely to snap.
 *
 * Reversed ranges are normalised. `2020..2000` parses, and left as-is it makes
 * `from <= year <= to` unsatisfiable — so every row looked out of range and the
 * warning fired on data that was entirely correct.
 */
function requestedBounds(time: string | undefined): { from: number; to: number } | undefined {
  if (!time) return undefined;
  const [rawFrom, rawTo] = time.includes('..') ? time.split('..') : [time, time];
  const from = timeValue(rawFrom ?? '');
  const to = timeValue(rawTo ?? '');
  if (from === undefined || to === undefined) return undefined;
  return from <= to ? { from, to } : { from: to, to: from };
}

/**
 * Note when the data came back from outside the window that was asked for.
 *
 * Grapher does not treat `time` as a filter that can return nothing: asked for
 * `1800..1810` on a series starting in 1831, it answers with 1831. Silently
 * relabelling that as the requested decade would be the worst outcome here —
 * a wrong year attached to a real number.
 */
export function noteTimeSnap(
  rows: CsvRow[],
  timeUnit: 'year' | 'day',
  time: string | undefined,
  notes: string[],
): void {
  const bounds = requestedBounds(time);
  if (!bounds || rows.length === 0) return;
  // Warn when ANY row falls outside, not when none falls inside. Coverage
  // differs per entity: asking two countries for 1800–1810 where one series
  // starts in 1800 and the other in 1831 used to satisfy the "some row is in
  // range" test and pass the snapped rows off, silently, as the decade asked
  // for.
  const outside = rows.filter((row) => {
    const value = rowValue(row.time, timeUnit);
    return value !== undefined && (value < bounds.from || value > bounds.to);
  });
  if (outside.length === 0) return;
  const example = outside[0];
  notes.push(
    `${String(outside.length)} of ${String(rows.length)} rows fall OUTSIDE the requested time range — Our World in Data snaps to the nearest available time rather than returning nothing${
      example ? ` (e.g. ${example.entity} at ${example.time})` : ''
    }. Read the time on each row rather than assuming the range you asked for.`,
  );
}
