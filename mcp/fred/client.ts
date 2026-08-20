/**
 * FRED wire layer — the HTTP call, the field mapping, and the frequency algebra
 * the two tools share.
 *
 * Everything here maps FRED's own vocabulary onto ours once, so the tool
 * handlers never touch a snake_case upstream field. Three upstream facts drive
 * the shape:
 *
 *  1. `/series/observations` returns a top-level `count` = the number of
 *     observations matching the request **before** `limit`/`offset` are applied.
 *     That is the only thing that makes truncation detectable, so it is always
 *     carried through (see `fetchObservations`).
 *  2. `/series/search` returns `seasonal_adjustment_short` and `popularity`,
 *     which distinguish otherwise byte-identical hits (`CPIAUCSL` vs `CPIAUCNS`
 *     differ in nothing else). They are mapped, not dropped.
 *  3. `frequency` only ever **down**-samples. Asking a quarterly series for
 *     daily data is a 400 from FRED, so it is rejected here by name instead.
 */
import type { ToolContext } from '@ontrove/extend/toolkit';
import { ToolError } from '@ontrove/extend/toolkit';

/** Base host for the FRED API. */
const BASE_URL = 'https://api.stlouisfed.org/fred';

/**
 * GET a FRED endpoint and parse JSON, surfacing FRED's own error message.
 * The key is read via `ctx.requireSecret` and appended as the `api_key` query
 * param; `file_type=json` is forced. FRED's per-status semantics are preserved
 * via `errorMap` (400 → surface `error_message` non-retryable; 401/403 → check
 * key, non-retryable; everything else falls back to the SDK default mapping).
 */
export async function getJson(
  path: string,
  params: URLSearchParams,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const key = await ctx.requireSecret('FRED_API_KEY');
  params.set('api_key', key);
  params.set('file_type', 'json');
  const parsed = await ctx.fetchJson(`${BASE_URL}${path}?${params}`, {
    init: { headers: { accept: 'application/json' } },
    errorMap(res, body) {
      let reason = '';
      try {
        const j = JSON.parse(body) as { error_message?: unknown };
        if (typeof j.error_message === 'string') reason = j.error_message;
      } catch {
        reason = body.slice(0, 120);
      }
      if (res.status === 400) {
        return new ToolError(`FRED rejected the request: ${reason || 'bad parameters'}.`, {
          retryable: false,
        });
      }
      if (res.status === 403 || res.status === 401) {
        return new ToolError('FRED rejected the API key (check FRED_API_KEY).', {
          retryable: false,
        });
      }
      return undefined;
    },
  });
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ToolError('FRED returned malformed data; try again shortly.', { retryable: true });
  }
  return parsed as Record<string, unknown>;
}

/** Read a string field, or null when absent/blank/not-a-string. */
function str(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  return typeof v === 'string' && v !== '' ? v : null;
}

/** Parse a FRED observation value ("." means missing) to a number or null. */
export function parseValue(value: unknown): number | null {
  if (typeof value !== 'string' || value === '.') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * One FRED series' descriptive metadata, as returned by `/series` and by each
 * `/series/search` hit. `seasonalAdjustment` is the short code (`SA`, `NSA`,
 * `SAAR`, `NA`) — the field that tells `CPIAUCSL` from `CPIAUCNS`.
 */
export interface SeriesMeta {
  id: string;
  title: string | null;
  units: string | null;
  frequency: string | null;
  frequencyShort: string | null;
  seasonalAdjustment: string | null;
  observationStart: string | null;
  observationEnd: string | null;
  lastUpdated: string | null;
  popularity: number | null;
}

/** Map one raw FRED series record onto {@link SeriesMeta}. */
export function mapSeries(raw: unknown): SeriesMeta {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    id: str(o, 'id') ?? '',
    title: str(o, 'title'),
    units: str(o, 'units'),
    frequency: str(o, 'frequency'),
    frequencyShort: str(o, 'frequency_short'),
    seasonalAdjustment: str(o, 'seasonal_adjustment_short') ?? str(o, 'seasonal_adjustment'),
    observationStart: str(o, 'observation_start'),
    observationEnd: str(o, 'observation_end'),
    lastUpdated: str(o, 'last_updated'),
    popularity: typeof o.popularity === 'number' ? o.popularity : null,
  };
}

/**
 * Fetch one series' metadata from `/series`.
 *
 * Returns null rather than throwing: metadata is an enrichment, and a caller
 * who asked for observations should still get them if the descriptive lookup
 * fails. The one exception is a bad API key — that would fail the observation
 * call too, so it is allowed to propagate.
 */
export async function fetchSeriesMeta(
  seriesId: string,
  ctx: ToolContext,
): Promise<SeriesMeta | null> {
  try {
    const body = await getJson('/series', new URLSearchParams({ series_id: seriesId }), ctx);
    const list = Array.isArray(body.seriess) ? body.seriess : [];
    return list.length > 0 ? mapSeries(list[0]) : null;
  } catch (error) {
    if (error instanceof ToolError && /api key/i.test(error.message)) throw error;
    ctx.log('series metadata unavailable', { seriesId });
    return null;
  }
}

/**
 * Frequency codes ordered coarsest-last. FRED can only aggregate a series to an
 * equal-or-lower frequency, so a request is valid iff its rank is >= the
 * series' own rank.
 */
const FREQUENCY_RANK: Record<string, number> = { d: 1, w: 2, bw: 3, m: 4, q: 5, sa: 6, a: 7 };

/** Human names for the frequency codes, for error messages. */
const FREQUENCY_NAME: Record<string, string> = {
  d: 'daily',
  w: 'weekly',
  bw: 'biweekly',
  m: 'monthly',
  q: 'quarterly',
  sa: 'semiannual',
  a: 'annual',
};

/**
 * Reject an up-sampling request (e.g. quarterly series → daily) by name, rather
 * than letting FRED's raw 400 surface. Returns an explanatory string when the
 * request is impossible, or null when it is fine (or when the series' own
 * frequency is unknown, in which case FRED remains the arbiter).
 */
export function frequencyConflict(meta: SeriesMeta | null, requested: string): string | null {
  const own = meta?.frequencyShort?.toLowerCase();
  if (!own) return null;
  const ownRank = FREQUENCY_RANK[own];
  const wantRank = FREQUENCY_RANK[requested];
  if (ownRank === undefined || wantRank === undefined || wantRank >= ownRank) return null;
  return (
    `${meta?.id ?? 'series'} is ${FREQUENCY_NAME[own] ?? own}; it cannot be resampled to ` +
    `${FREQUENCY_NAME[requested] ?? requested}. FRED only aggregates to an equal or lower ` +
    'frequency — drop the frequency argument or pick a coarser one.'
  );
}

/** Spell out a seasonal-adjustment short code for the prose rendering. */
export function seasonalPhrase(short: string | null): string | null {
  switch (short?.toUpperCase()) {
    case 'SA': {
      return 'seasonally adjusted';
    }
    case 'NSA': {
      return 'not seasonally adjusted';
    }
    case 'SAAR': {
      return 'seasonally adjusted annual rate';
    }
    case 'NA': {
      return 'seasonal adjustment n/a';
    }
    default: {
      return short;
    }
  }
}
