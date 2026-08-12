import { ToolError, type ToolContext } from '@ontrove/mcp';
import { type Cabin, cabinCoverageNotes, type Region, resolveSources } from './programs.ts';
import type { Cursor } from './wire.ts';

/**
 * Input validation and query-string construction.
 *
 * Everything here exists to convert a request that *would* have come back as an
 * empty HTTP 200 into a named mistake before an API call is spent. Seats.aero
 * has almost no "you asked for something impossible" response: a city name in
 * place of an airport code, an unknown mileage program, an unknown region, a
 * route to itself, a reversed date range and a window entirely in the past all
 * return `{"data":[],"hasMore":false}` with an HTTP 200, which reads as "no
 * award space on that route". (Only a malformed date and an unknown cabin
 * actually 400.) Each of those is named here instead.
 */

const AIRPORT = /^[A-Z]{3}$/;

/**
 * The caller's stored `home_airports` setting, as the manifest declares it.
 *
 * Read defensively rather than trusted: `ctx.config` is user-entered data that
 * reached us through storage, and a tool that assumed its own setting's shape
 * would be the one place in this file that trusts an input. Anything that is
 * not a list of strings reads as "not set", landing on the same error a caller
 * gets for omitting the argument with nothing stored — a stated requirement,
 * never a silent search of everywhere.
 *
 * The codes are NOT validated here. `airportList` already names a bad one
 * precisely, and doing it twice means two messages for one mistake.
 */
export function homeAirports(ctx: ToolContext): string[] {
  const stored = ctx.config?.home_airports;
  if (!Array.isArray(stored)) return [];
  return stored.filter((value): value is string => typeof value === 'string');
}
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalise and validate a list of IATA airport codes into the comma-delimited
 * string the API takes.
 *
 * Codes are upper-cased for consistency of output, not out of necessity —
 * `origin_airport=sfo` was verified to return the same results as `SFO`. The
 * validation is the part that earns its keep: a city name or a 4-letter ICAO
 * code is accepted by the API and answered with an empty page.
 */
export function airportList(codes: readonly string[], field: string): string {
  const cleaned = codes.flatMap((c) => c.split(',')).map((c) => c.trim().toUpperCase());
  const values = cleaned.filter(Boolean);
  if (values.length === 0) {
    throw new ToolError(`${field}: give at least one 3-letter IATA airport code, e.g. SFO.`, {
      retryable: false,
    });
  }
  const bad = values.filter((c) => !AIRPORT.test(c));
  if (bad.length > 0) {
    throw new ToolError(
      `${field}: ${bad.join(', ')} ${bad.length === 1 ? 'is not a' : 'are not'} 3-letter IATA airport code${bad.length === 1 ? '' : 's'}. Seats.aero searches by airport (SFO, LHR), not by city or country.`,
      { retryable: false },
    );
  }
  return [...new Set(values)].join(',');
}

/** Assert a `YYYY-MM-DD` string that is also a real calendar date. */
export function isoDate(value: string, field: string): string {
  const trimmed = value.trim();
  if (!ISO_DATE.test(trimmed) || Number.isNaN(Date.parse(`${trimmed}T00:00:00Z`))) {
    throw new ToolError(`${field}: "${value}" is not a YYYY-MM-DD date.`, { retryable: false });
  }
  return trimmed;
}

/**
 * Validate a departure window, refusing a reversed one and flagging a window
 * that has already passed.
 *
 * A past window is a note rather than an error: the cached data only ever holds
 * future departures, so `2024-01-01 → 2024-01-31` comes back empty. That is a
 * true statement about the API and a false one about the route.
 *
 * The cutoff deliberately allows a **full day of slack** instead of taking a
 * time zone. A departure date is local to the origin airport, so there is no one
 * "today" to compare against — a search leaving Auckland can still be same-day
 * when UTC has rolled over, and the caller's own zone is a third answer again.
 * Earth's civil offsets span UTC-12 to UTC+14, so a date more than a day behind
 * UTC is in the past by every clock, and this note can never be wrong.
 */
export function departureWindow(
  start: string | undefined,
  end: string | undefined,
  now: Date,
): { start?: string; end?: string; notes: string[] } {
  const from = start === undefined ? undefined : isoDate(start, 'start_date');
  const to = end === undefined ? undefined : isoDate(end, 'end_date');
  if (from && to && from > to) {
    throw new ToolError(
      `start_date (${from}) is after end_date (${to}) — Seats.aero would answer that with an empty result rather than an error.`,
      { retryable: false },
    );
  }
  const cutoff = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const notes: string[] = [];
  if (to && to < cutoff) {
    notes.push(
      `The requested window ends ${to}, which is in the past everywhere on Earth (UTC today is ${now
        .toISOString()
        .slice(
          0,
          10,
        )}). Seats.aero only holds future departures, so an empty result here means "the window has passed", not "no award space".`,
    );
  }
  return { start: from, end: to, notes };
}

/**
 * Page-size ceilings when trips are embedded, measured against the live API.
 *
 * `take` alone is cheap — 1000 records is 2.1 MB in 1.6 s. Embedding trips is
 * not: the same 1000 with `include_trips` is **11.5 MB in 8.4 s**, which is at
 * or past the hosted gateway's wall clock before this server has parsed a byte,
 * and produces a response no caller can use. `minify_trips` halves it (4.9 MB,
 * 2.7 s) but does not make it small.
 *
 * So the page is clamped rather than the request refused: the caller asked for
 * something legitimate, the limit is ours, and a clamp with a note costs neither
 * an API call nor a round trip. Measurements at the chosen ceilings: 200 with
 * full trips ≈ 2.6 MB, 500 with minified trips ≈ 2.5 MB.
 */
const TRIPS_TAKE_CAP = 200;
const MINIFIED_TAKE_CAP = 500;

/** Clamp `take` when embedded trips would make the response unusable. */
export function tripAwareTake(input: {
  take: number;
  include_trips: boolean;
  minify_trips: boolean;
}): { take: number; notes: string[] } {
  if (!input.include_trips) return { take: input.take, notes: [] };
  const cap = input.minify_trips ? MINIFIED_TAKE_CAP : TRIPS_TAKE_CAP;
  if (input.take <= cap) return { take: input.take, notes: [] };
  return {
    take: cap,
    notes: [
      `take was reduced from ${input.take} to ${cap} because include_trips is on: ${input.take} results with trips embedded is roughly ${
        input.minify_trips ? '10 MB' : '11 MB'
      } and takes long enough to risk the request timing out.${
        input.minify_trips
          ? ' Drop include_trips to page 1000 at a time.'
          : ' Add minify_trips to raise this to 500, or drop include_trips to page 1000 at a time and call get_trips on the ids you care about.'
      }`,
    ],
  };
}

/** Set a query parameter only when the caller supplied a value. */
function put(params: URLSearchParams, name: string, value: string | undefined): void {
  if (value !== undefined && value !== '') params.set(name, value);
}

/** The `search_awards` input surface, in snake_case as the tool receives it. */
export interface SearchInput {
  origin_airport?: string[];
  destination_airport: string[];
  start_date?: string;
  end_date?: string;
  cabins?: Cabin[];
  sources?: string[];
  carriers?: string[];
  only_direct_flights: boolean;
  order_by?: 'lowest_mileage';
  include_trips: boolean;
  minify_trips: boolean;
  include_filtered: boolean;
  take: number;
  skip: number;
  cursor?: Cursor;
}

/**
 * Build the `GET /search` query, validating every caller-supplied value first.
 *
 * `homeAirports` is the user's stored setting, used only when the caller named
 * no origin. A default, not an override: a model that says where to fly from
 * always wins, because the setting exists to save a person from repeating
 * themselves, not to overrule them.
 * Returns the notes validation produced so the handler can carry them into the
 * result instead of letting an empty page speak for itself.
 */
export function searchQuery(
  input: SearchInput,
  now: Date,
  homeAirports: readonly string[] = [],
): { params: URLSearchParams; notes: string[] } {
  const params = new URLSearchParams();
  const origins = input.origin_airport?.length ? input.origin_airport : homeAirports;
  if (origins.length === 0) {
    throw new ToolError(
      'origin_airport: give at least one 3-letter IATA airport code, e.g. SFO — or set your home airports in this toolkit\u2019s settings and omit it.',
      { retryable: false },
    );
  }
  params.set('origin_airport', airportList(origins, 'origin_airport'));
  params.set('destination_airport', airportList(input.destination_airport, 'destination_airport'));

  const window = departureWindow(input.start_date, input.end_date, now);
  put(params, 'start_date', window.start);
  put(params, 'end_date', window.end);

  const sources = input.sources?.length ? resolveSources(input.sources, 'sources') : [];
  const cabins = input.cabins ?? [];
  const sizing = tripAwareTake(input);
  const notes = [
    ...window.notes,
    ...cabinCoverageNotes(sources, cabins),
    ...sameAirportNotes(params.get('origin_airport'), params.get('destination_airport')),
    ...sizing.notes,
  ];

  if (sources.length > 0) params.set('sources', sources.join(','));
  if (cabins.length > 0) params.set('cabins', [...new Set(cabins)].join(','));
  if (input.carriers?.length) params.set('carriers', carrierList(input.carriers));

  params.set('take', String(sizing.take));
  if (input.skip > 0) params.set('skip', String(input.skip));
  if (input.cursor !== undefined) params.set('cursor', String(input.cursor));
  if (input.only_direct_flights) params.set('only_direct_flights', 'true');
  if (input.include_filtered) params.set('include_filtered', 'true');
  if (input.order_by) params.set('order_by', input.order_by);
  if (input.include_trips) {
    params.set('include_trips', 'true');
    if (input.minify_trips) params.set('minify_trips', 'true');
  } else if (input.minify_trips) {
    notes.push('minify_trips was ignored — it only applies when include_trips is on.');
  }
  return { params, notes };
}

/**
 * Flag airports asked to be both origin and destination.
 *
 * `origin_airport=SFO&destination_airport=SFO` is an empty HTTP 200, identical
 * to a route with no award space — so the one reading that is certainly wrong
 * (a route to itself) is named rather than left to look like bad luck.
 */
export function sameAirportNotes(origin: string | null, destination: string | null): string[] {
  const from = new Set((origin ?? '').split(',').filter(Boolean));
  const overlap = (destination ?? '').split(',').filter((code) => code && from.has(code));
  if (overlap.length === 0) return [];
  return [
    `${overlap.join(', ')} ${overlap.length === 1 ? 'is' : 'are'} listed as both origin and destination. Seats.aero answers a route to itself with an empty result, not an error.`,
  ];
}

/** Validate IATA carrier codes (2 characters, e.g. `AA`, `B6`, `LH`). */
export function carrierList(codes: readonly string[]): string {
  const values = codes
    .flatMap((c) => c.split(','))
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
  const bad = values.filter((c) => !/^[\dA-Z]{2}$/.test(c));
  if (bad.length > 0) {
    throw new ToolError(
      `carriers: ${bad.join(', ')} ${bad.length === 1 ? 'is not a' : 'are not'} 2-character IATA airline code${bad.length === 1 ? '' : 's'} (e.g. AA, B6, LH).`,
      { retryable: false },
    );
  }
  return [...new Set(values)].join(',');
}

/** The `explore_availability` input surface. */
export interface ExploreInput {
  source: string;
  cabin?: Cabin;
  start_date?: string;
  end_date?: string;
  origin_region?: Region;
  destination_region?: Region;
  include_filtered: boolean;
  take: number;
  skip: number;
  cursor?: Cursor;
}

/** Build the `GET /availability` query for one mileage program. */
export function exploreQuery(
  input: ExploreInput,
  now: Date,
): { params: URLSearchParams; notes: string[] } {
  const [source] = resolveSources([input.source], 'source');
  if (source === undefined) {
    throw new ToolError('source: give one Seats.aero mileage program slug, e.g. aeroplan.', {
      retryable: false,
    });
  }
  const window = departureWindow(input.start_date, input.end_date, now);
  const notes = [
    ...window.notes,
    ...cabinCoverageNotes([source], input.cabin ? [input.cabin] : []),
  ];

  const params = new URLSearchParams({ source });
  put(params, 'cabin', input.cabin);
  put(params, 'start_date', window.start);
  put(params, 'end_date', window.end);
  put(params, 'origin_region', input.origin_region);
  put(params, 'destination_region', input.destination_region);
  params.set('take', String(input.take));
  if (input.skip > 0) params.set('skip', String(input.skip));
  if (input.cursor !== undefined) params.set('cursor', String(input.cursor));
  if (input.include_filtered) params.set('include_filtered', 'true');
  return { params, notes };
}
