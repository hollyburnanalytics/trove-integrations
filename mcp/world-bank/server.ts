import { defineMcpServer, ToolError, tool, z } from '@ontrove/mcp';

/**
 * World Bank Data — a no-auth hosted MCP server over the World Bank Indicators
 * API (api.worldbank.org). Two read-only surfaces:
 *  - `search_indicators` — find an indicator code by keyword, and
 *  - `get_indicator` — fetch a country's time-series for an indicator code.
 *
 * No API key required. Country accepts ISO-2/ISO-3 codes or "all"; common
 * indicator codes: NY.GDP.MKTP.CD (GDP US$), SP.POP.TOTL (population),
 * FP.CPI.TOTL.ZG (inflation %), SL.UEM.TOTL.ZS (unemployment %).
 */

/** Base path for the World Bank v2 API. */
const BASE_URL = 'https://api.worldbank.org/v2';

/**
 * How many WDI indicators `search_indicators` pulls to match against. Source 2
 * holds ~1,500, so one page covers it — but the fetched count is compared to
 * the API's own `total` and a shortfall is reported, so the day the catalogue
 * outgrows this the search stops silently losing its tail.
 */
const CATALOG_PAGE = 2000;

/**
 * Sentinels for a one-sided year range. The API rejects an open-ended
 * `date=2010:` ("The provided parameter value is not valid"), so a missing
 * bound is filled with a year outside any real series rather than dropping the
 * caller's filter — which is what the previous `if (start && end)` did.
 */
const MIN_YEAR = 1800;
const MAX_YEAR = 2100;

/**
 * Build the `date` filter, honouring a one-sided range. Returns null when the
 * caller bounded nothing.
 */
function dateRange(start: number | undefined, end: number | undefined): string | null {
  if (start === undefined && end === undefined) return null;
  const from = start ?? MIN_YEAR;
  const to = end ?? MAX_YEAR;
  if (from > to) {
    throw new ToolError(`start (${from}) is after end (${to}); swap them.`, { retryable: false });
  }
  return `${from}:${to}`;
}

/** Read a numeric field from the API's metadata object (it sometimes strings them). */
function metaNumber(meta: Record<string, unknown>, key: string, fallback: number): number {
  const raw = meta[key];
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) {
    return Number(raw);
  }
  return fallback;
}

/** One `{year, value}` point, labelled with its country when the pull spans several. */
interface Observation {
  year: string;
  value: number | null;
  country?: string;
}

/**
 * Map indicator rows into observations, picking up the indicator's display name
 * and the set of countries present.
 *
 * `country: "all"` returns rows for ~265 entities, so the country is carried on
 * each row whenever more than one appears — without it the same year recurs
 * with different values and nothing says which entity each belongs to.
 */
function toObservations(rows: unknown[]): {
  observations: Observation[];
  indicatorName: string | null;
  countries: string[];
} {
  let indicatorName: string | null = null;
  const countries = new Set<string>();
  const raw = rows.map((r) => {
    const o = r as Record<string, unknown>;
    const ind = (o.indicator ?? {}) as Record<string, unknown>;
    const cty = (o.country ?? {}) as Record<string, unknown>;
    if (!indicatorName && typeof ind.value === 'string') indicatorName = ind.value;
    const name = typeof cty.value === 'string' ? cty.value : null;
    if (name) countries.add(name);
    return {
      year: typeof o.date === 'string' ? o.date : '',
      value: typeof o.value === 'number' ? o.value : null,
      country: name,
    };
  });
  const multi = countries.size > 1;
  return {
    observations: raw.map(({ year, value, country }) =>
      multi && country ? { year, value, country } : { year, value },
    ),
    indicatorName,
    countries: [...countries],
  };
}

/**
 * Extract the World Bank API's own error text from a `[{ message: [...] }]`
 * body (how it signals a bad query over HTTP 200), or null when absent. Lets a
 * rejected request surface *why* ("The provided parameter value is not valid")
 * instead of a blanket "check codes".
 */
function wbErrorMessage(parsed: unknown): string | null {
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const first = parsed[0] as Record<string, unknown> | null;
  const message = first && Array.isArray(first.message) ? first.message : null;
  const entry = message?.[0] as Record<string, unknown> | undefined;
  return entry && typeof entry.value === 'string' && entry.value ? entry.value : null;
}

/**
 * GET a World Bank endpoint. The API returns a 2-element array `[metadata,
 * rows]`; this returns that tuple. Kept on raw `ctx.fetch` (the SDK still
 * injects the default User-Agent) because the API signals a bad query with an
 * HTTP-200 `[ { message: [...] } ]` body — a shape error, not a status error —
 * which `fetchJson`'s status mapping can't express.
 *
 * Failures are surfaced with their real cause so transient outages can be told
 * apart from request bugs (the prior version masked every non-2xx, including a
 * 4xx bad-request, as a retryable "temporarily unavailable"):
 *  - a network error → retryable;
 *  - 429 / 5xx → retryable, with the HTTP status in the message;
 *  - any other 4xx → NON-retryable (the request was rejected, not the service);
 *  - an HTTP-200 error body → non-retryable, carrying the upstream message.
 */
async function getWb(
  url: string,
  ctx: { fetch: (url: string | URL, init?: RequestInit) => Promise<Response> },
): Promise<[Record<string, unknown>, unknown[]]> {
  let res: Response;
  try {
    res = await ctx.fetch(url, { headers: { accept: 'application/json' } });
  } catch {
    throw new ToolError('The World Bank API is unreachable; try again shortly.', {
      retryable: true,
    });
  }
  if (!res.ok) {
    // 429 + 5xx are transient (service-side); other 4xx mean the request itself
    // was rejected (e.g. a bad country/indicator code) and a retry won't help.
    const transient = res.status === 429 || res.status >= 500;
    throw new ToolError(
      transient
        ? `The World Bank API is temporarily unavailable (HTTP ${res.status}).`
        : `The World Bank API rejected the request (HTTP ${res.status}); check the country and indicator codes.`,
      { retryable: transient },
    );
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    // A 200 that isn't JSON is the service having a bad moment — the API
    // intermittently serves an HTML error page under a 200. Treating that as a
    // rejected request told the caller to fix codes that were never wrong.
    throw new ToolError('The World Bank API returned a non-JSON response; try again shortly.', {
      retryable: true,
    });
  }
  if (!Array.isArray(parsed) || parsed.length < 2) {
    const detail = wbErrorMessage(parsed);
    throw new ToolError(
      detail
        ? `The World Bank API rejected the request: ${detail}`
        : 'The World Bank API rejected the request (check the country and indicator codes).',
      { retryable: false },
    );
  }
  const meta = (parsed[0] ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(parsed[1]) ? parsed[1] : [];
  return [meta, rows];
}

export default defineMcpServer({
  tools: [
    tool({
      name: 'search_indicators',
      title: 'World Bank: Find indicator',
      description:
        'Search World Development Indicators by keyword to find an indicator code ' +
        '(e.g. "GDP", "life expectancy", "CO2"). Returns code + name; pass the code ' +
        'to get_indicator. Searches the core WDI source.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        query: z.string().min(1).describe('Keyword(s), e.g. "life expectancy".'),
        limit: z.number().int().min(1).max(25).default(10).describe('Max matches (1–25).'),
      }),
      output: z.object({
        query: z.string(),
        count: z.number(),
        totalMatches: z.number(),
        truncated: z.boolean(),
        indicators: z.array(
          z.object({ id: z.string(), name: z.string(), note: z.string().nullable() }),
        ),
      }),
      async handler(args, ctx) {
        const { query, limit } = args;
        ctx.log('search_indicators', { query, limit });
        const [meta, rows] = await getWb(
          `${BASE_URL}/indicator?format=json&per_page=${CATALOG_PAGE}&source=2`,
          ctx,
        );
        // Matching happens client-side over one page of the catalogue. Say so
        // when that page didn't hold all of it, rather than presenting a search
        // of 2,000 indicators as a search of every indicator.
        const catalogTotal = metaNumber(meta, 'total', rows.length);
        const partial =
          catalogTotal > rows.length
            ? ` (searched ${rows.length} of ${catalogTotal} WDI indicators)`
            : '';
        const q = query.toLowerCase();
        const hits = rows
          .map((r) => r as Record<string, unknown>)
          .filter((r) => {
            const id = typeof r.id === 'string' ? r.id.toLowerCase() : '';
            const name = typeof r.name === 'string' ? r.name.toLowerCase() : '';
            return id.includes(q) || name.includes(q);
          });
        const matches = hits.slice(0, limit).map((r) => ({
          id: typeof r.id === 'string' ? r.id : '',
          name: typeof r.name === 'string' ? r.name : '',
          note:
            typeof r.sourceNote === 'string' && r.sourceNote ? r.sourceNote.slice(0, 200) : null,
        }));
        const truncated = hits.length > matches.length;
        if (matches.length === 0) {
          return {
            text: `No World Bank indicators matching "${query}"${partial}.`,
            structured: { query, count: 0, totalMatches: 0, truncated: false, indicators: [] },
          };
        }
        const of = truncated ? ` of ${hits.length}` : '';
        const lines = matches.map((m) => `  ${m.id} — ${m.name}`).join('\n');
        return {
          text: `${matches.length}${of} indicator(s) for "${query}"${partial}:\n${lines}`,
          structured: {
            query,
            count: matches.length,
            totalMatches: hits.length,
            truncated,
            indicators: matches,
          },
        };
      },
    }),
    tool({
      name: 'get_indicator',
      title: 'World Bank: Get indicator',
      description:
        "Fetch a country's time-series for an indicator code. Country is ISO-2/ISO-3 " +
        '(e.g. "CA", "USA") or "all". Returns {year, value} points, newest first. ' +
        'Common codes: NY.GDP.MKTP.CD (GDP), SP.POP.TOTL (population), ' +
        'FP.CPI.TOTL.ZG (inflation %), SL.UEM.TOTL.ZS (unemployment %).',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        country: z.string().min(2).describe('ISO-2/ISO-3 country code or "all", e.g. "CA".'),
        indicator: z.string().min(1).describe('Indicator code, e.g. "NY.GDP.MKTP.CD".'),
        start: z.number().int().optional().describe('Start year, e.g. 2010. Works on its own.'),
        end: z.number().int().optional().describe('End year, e.g. 2023. Works on its own.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(120)
          .describe('Max data points per call (1–1000, default 120).'),
        page: z
          .number()
          .int()
          .min(1)
          .default(1)
          .describe('Page number — pass a previous result’s nextPage.'),
      }),
      output: z.object({
        country: z.string(),
        indicator: z.string(),
        indicatorName: z.string().nullable(),
        count: z.number(),
        total: z.number(),
        truncated: z.boolean(),
        page: z.number(),
        pages: z.number(),
        nextPage: z.number().nullable(),
        countries: z.array(z.string()),
        observations: z.array(
          z.object({
            year: z.string(),
            value: z.number().nullable(),
            country: z.string().optional(),
          }),
        ),
      }),
      async handler(args, ctx) {
        const { country, indicator, start, end, limit, page } = args;
        ctx.log('get_indicator', { country, indicator, start, end, limit, page });
        const params = new URLSearchParams({
          format: 'json',
          per_page: String(limit),
          page: String(page),
        });
        const range = dateRange(start, end);
        if (range) params.set('date', range);
        const url = `${BASE_URL}/country/${encodeURIComponent(country)}/indicator/${encodeURIComponent(indicator)}?${params}`;
        const [meta, rows] = await getWb(url, ctx);
        const { observations, indicatorName, countries } = toObservations(rows);
        // The API's own `total`/`pages` describe the whole matching set; the
        // rows are just this page of it. Reporting only the page once let
        // `country: "all"` answer with ~2 of 265 entities and call it complete.
        const total = metaNumber(meta, 'total', observations.length);
        const pages = metaNumber(meta, 'pages', 1);
        // Derived from rows consumed rather than `page < pages`, so a missing or
        // stale `pages` can't make a partial result claim to be complete.
        const consumed = (page - 1) * limit + observations.length;
        const truncated = consumed < total;
        const sizing = {
          total,
          truncated,
          page,
          pages,
          nextPage: truncated ? page + 1 : null,
          countries,
        };
        if (observations.length === 0) {
          return {
            text: `No World Bank data for ${indicator} / ${country}${range ? ` in ${range}` : ''}.`,
            structured: {
              country,
              indicator,
              indicatorName: null,
              count: 0,
              ...sizing,
              observations: [],
            },
          };
        }
        // Missing years are previewed as `n/a` rather than filtered out: a null
        // for the current year means "not published yet", which is an answer.
        const lines = observations
          .slice(0, 12)
          .map((o) => `  ${o.country ? `${o.country}, ` : ''}${o.year}: ${o.value ?? 'n/a'}`)
          .join('\n');
        // `countries` is what this PAGE contained, not what the indicator covers —
        // say "on this page" when there is more, so it can't read as the total.
        const scope =
          countries.length > 1
            ? ` across ${countries.length} entities${truncated ? ' on this page' : ''}`
            : '';
        const header = `${indicatorName ?? indicator} — ${country}: ${observations.length} of ${total} point(s)${scope}`;
        const more = truncated
          ? `\n  TRUNCATED: page ${page} of ${pages}. Re-call with page=${page + 1}, ` +
            'or narrow with start/end or a single country.'
          : '';
        return {
          text: `${header}${more}\n${lines}`,
          structured: {
            country,
            indicator,
            indicatorName,
            count: observations.length,
            ...sizing,
            observations,
          },
        };
      },
    }),
  ],
});
