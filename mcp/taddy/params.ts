import { ToolError, z } from '@ontrove/mcp';
import { resolveCountries, resolveGenres, resolveLanguages } from './enums.ts';

/**
 * Argument plumbing shared by the tools: date handling, the "exactly one
 * identifier" rule, and the filter block both searches share.
 *
 * **Dates cross a boundary here.** Taddy takes epoch SECONDS on every date
 * filter. A model asked for "episodes since January" writes `2026-01-01`, not
 * `1767225600`, and asking it to do the arithmetic is asking for an off-by-a-
 * timezone bug in someone else's head. So every date-shaped argument is an ISO
 * date on the way in and becomes epoch seconds here, once, in one place.
 */

/** `YYYY-MM-DD`, or a full ISO 8601 instant. */
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?$/;

/** A reusable Zod field for an ISO date argument. */
export function dateField(description: string): z.ZodOptional<z.ZodString> {
  return z.string().regex(ISO_DATE).describe(description).optional();
}

/**
 * Convert an ISO date to epoch seconds.
 *
 * A bare `YYYY-MM-DD` is read as UTC midnight. `Date.parse` already does this
 * for the date-only form, and being explicit about it matters: the alternative
 * reading (local midnight) would shift every boundary by up to a day depending
 * on where the server happens to run.
 */
export function epochSeconds(
  value: string | undefined,
  bound: 'start' | 'end' = 'start',
): number | undefined {
  if (value === undefined) return undefined;
  // A bare date names a WHOLE DAY, so which instant it means depends on which
  // end of a range it sits at. Reading `published_before: 2026-07-27` as that
  // day's midnight excludes everything published on the 27th — and since
  // `published_after` is correct at midnight, the asymmetry is invisible:
  // `after: X, before: X` silently returns nothing at all.
  const time = bound === 'end' ? 'T23:59:59Z' : 'T00:00:00Z';
  const parsed = Date.parse(value.includes('T') ? value : `${value}${time}`);
  if (Number.isNaN(parsed)) {
    throw new ToolError(`"${value}" is not a valid date. Use YYYY-MM-DD.`, { retryable: false });
  }
  return Math.floor(parsed / 1000);
}

/**
 * Pick the one identifier the caller supplied, or explain what went wrong.
 *
 * Taddy's lookups accept several mutually exclusive keys (uuid, name, rssUrl,
 * itunesId) and quietly apply just one when given more. Deciding here — rather
 * than forwarding an ambiguous request — means a caller who sends two never has
 * to work out which of them the answer came from.
 */
export function exactlyOne(
  candidates: Record<string, string | number | undefined>,
  what: string,
): void {
  const given = Object.entries(candidates).filter(([, value]) => value !== undefined);
  if (given.length === 1) return;
  const names = Object.keys(candidates).join(', ');
  if (given.length === 0) {
    throw new ToolError(`Give one way to identify the ${what}: ${names}.`, { retryable: false });
  }
  throw new ToolError(
    `Give exactly ONE way to identify the ${what} — got ${given.map(([key]) => key).join(' and ')}.`,
    { retryable: false },
  );
}

/** The filters common to both search tools, as Zod fields. */
export const commonSearchFields = {
  page: z.number().int().min(1).max(20).default(1).describe('Result page (1–20).'),
  limit: z.number().int().min(1).max(25).default(10).describe('Results per page (1–25).'),
  sort_by: z
    .enum(['EXACTNESS', 'POPULARITY'])
    .default('EXACTNESS')
    .describe(
      'EXACTNESS matches the term closely. POPULARITY is NOT a re-ranking — Taddy restricts the ' +
        'search to only the top 5% most popular podcasts and then weights popularity, so it ' +
        'returns nothing at all for niche topics. If POPULARITY comes back empty, retry with ' +
        'EXACTNESS before concluding the topic is absent.',
    ),
  match_by: z
    .enum(['MOST_TERMS', 'ALL_TERMS', 'EXACT_PHRASE'])
    .default('MOST_TERMS')
    .describe('How a multi-word term is matched. EXACT_PHRASE is the strictest.'),
  safe_mode: z.boolean().default(false).describe('True to exclude content marked explicit.'),
  // Taddy documents no limit on how many genres a filter may name (its own
  // examples pass eight); 10 is a sanity bound, not a mirrored constraint.
  genres: z
    .array(z.string().min(1))
    .max(10)
    .optional()
    .describe('Genre names, e.g. ["true crime", "history"] or "Business > Investing".'),
  languages: z
    .array(z.string().min(1))
    .max(10)
    .optional()
    .describe('Languages, e.g. ["English", "es"].'),
  countries: z
    .array(z.string().min(1))
    .max(10)
    .optional()
    .describe('Countries the content was made in, e.g. ["US", "Canada"].'),
  content_type: z
    .enum(['AUDIO', 'VIDEO'])
    .optional()
    .describe('Restrict to audio-first or video-first podcasts.'),
  published_after: dateField('Only content published on/after this date (YYYY-MM-DD).'),
  published_before: dateField('Only content published on/before this date (YYYY-MM-DD).'),
};

/**
 * The vocabulary values a request was ACTUALLY sent with, echoed back.
 *
 * A caller writes "tech" and the resolver decides which of Taddy's 110 genres
 * that is. When the guess is good the echo is redundant; when it is not, this
 * is the only thing standing between the caller and a wrong conclusion — a
 * thin result set reads as "Taddy has little on this" rather than "you searched
 * for something else". `get_top_charts` already echoes its scope; these three
 * carry it for the same reason.
 */
export interface ResolvedFilters {
  genres?: string[];
  languages?: string[];
  countries?: string[];
}

/** The resolved, wire-ready form of {@link commonSearchFields}. */
export interface CommonSearchVariables {
  page: number;
  limitPerPage: number;
  sortBy: string;
  matchBy: string;
  isSafeMode: boolean;
  genres?: string[];
  languages?: string[];
  countries?: string[];
  contentType?: string[];
  publishedAfter?: number;
  publishedBefore?: number;
}

/** Resolve the shared search arguments into GraphQL variables. */
export function commonSearchVariables(args: {
  page: number;
  limit: number;
  sort_by: string;
  match_by: string;
  safe_mode: boolean;
  genres?: string[];
  languages?: string[];
  countries?: string[];
  content_type?: string;
  published_after?: string;
  published_before?: string;
}): CommonSearchVariables {
  return {
    page: args.page,
    limitPerPage: args.limit,
    sortBy: args.sort_by,
    matchBy: args.match_by,
    isSafeMode: args.safe_mode,
    genres: args.genres ? resolveGenres(args.genres) : undefined,
    languages: args.languages ? resolveLanguages(args.languages) : undefined,
    countries: args.countries ? resolveCountries(args.countries) : undefined,
    // Taddy's filter is a LIST even though only one value is meaningful here.
    contentType: args.content_type ? [args.content_type] : undefined,
    publishedAfter: epochSeconds(args.published_after),
    publishedBefore: epochSeconds(args.published_before, 'end'),
  };
}

/** The Zod shape for {@link ResolvedFilters}, for tool `output` schemas. */
export const resolvedFiltersSchema = z
  .object({
    genres: z.array(z.string()).optional(),
    languages: z.array(z.string()).optional(),
    countries: z.array(z.string()).optional(),
  })
  .describe('The Taddy vocabulary values this request was actually sent with.');

/**
 * Reject a range whose ends are the wrong way round, before it costs a request.
 *
 * Taddy answers `min > max` with an empty result set rather than an error, which
 * is indistinguishable from "nothing matched" — so the caller pays one of 500
 * monthly requests and learns nothing. The bounds are strict inequalities
 * upstream (`greaterThan`/`lessThan`), so an equal pair is empty too and is
 * refused for the same reason.
 */
export function assertRange(
  low: number | string | undefined,
  high: number | string | undefined,
  what: string,
  { strict = false }: { strict?: boolean } = {},
): void {
  if (low === undefined || high === undefined) return;
  const inverted = strict ? low >= high : low > high;
  if (inverted) {
    throw new ToolError(
      `${what}: ${String(low)} is not below ${String(high)}, so nothing can match. Swap them.`,
      { retryable: false },
    );
  }
}

/** Pull the resolved vocabulary values out of built search variables. */
export function resolvedFilters(variables: CommonSearchVariables): ResolvedFilters {
  return {
    genres: variables.genres,
    languages: variables.languages,
    countries: variables.countries,
  };
}

/** Total results for one search type, from Taddy's `responseDetails` array. */
export function totalFor(
  details: { type?: string | null; totalCount?: number | null }[] | null | undefined,
  type: string,
): number | null {
  const match = (details ?? []).find((detail) => detail.type === type);
  return match?.totalCount ?? null;
}
