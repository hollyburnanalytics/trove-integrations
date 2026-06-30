/**
 * FRED Economic Data — a hosted MCP server over the St. Louis Fed's FRED API
 * (api.stlouisfed.org). Two read-only surfaces:
 *  - `search_series` — find economic time-series by keyword, and
 *  - `get_observations` — fetch the data points for a series id.
 *
 * FRED requires a free API key, redeemed at call time from the vault via
 * `ctx.requireSecret('FRED_API_KEY')` (never bundled or logged) and passed as
 * the `api_key` query param. Set it with `trove secret set fred FRED_API_KEY <key>`.
 */
import type { ToolContext } from '@ontrove/mcp';
import { defineMcpServer, ToolError, z } from '@ontrove/mcp';

/** Base host for the FRED API. */
const BASE_URL = 'https://api.stlouisfed.org/fred';

/**
 * GET a FRED endpoint and parse JSON, surfacing FRED's own error message.
 * The key is read via `ctx.requireSecret` and appended as the `api_key` query
 * param; `file_type=json` is forced. FRED's per-status semantics are preserved
 * via `errorMap` (400 → surface `error_message` non-retryable; 401/403 → check
 * key, non-retryable; everything else falls back to the SDK default mapping).
 */
async function getJson(
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

/** Parse a FRED observation value ("." means missing) to a number or null. */
function parseValue(value: unknown): number | null {
  if (typeof value !== 'string' || value === '.') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export default defineMcpServer({
  tools: [
    {
      name: 'search_series',
      title: 'FRED: Search series',
      description:
        'Find FRED economic time-series by keyword (e.g. "unemployment rate", ' +
        '"CPI", "30-year mortgage"). Returns each series id, title, units, ' +
        'frequency, and coverage — pass the id to get_observations for the data.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        text: z.string().min(1).describe('Search keywords, e.g. "unemployment rate".'),
        limit: z.number().int().min(1).max(25).default(10).describe('Max series (1–25).'),
      }),
      output: z.object({
        text: z.string(),
        count: z.number(),
        series: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            units: z.string().nullable(),
            frequency: z.string().nullable(),
            observationStart: z.string().nullable(),
            observationEnd: z.string().nullable(),
          }),
        ),
      }),
      async handler(args, ctx) {
        const { text, limit } = args;
        ctx.log('search_series', { text, limit });
        const params = new URLSearchParams({ search_text: text, limit: String(limit) });
        const body = await getJson('/series/search', params, ctx);
        const raw = Array.isArray(body.seriess) ? body.seriess : [];
        const series = raw.map((s) => {
          const o = s as Record<string, unknown>;
          return {
            id: typeof o.id === 'string' ? o.id : '',
            title: typeof o.title === 'string' ? o.title : '',
            units: typeof o.units === 'string' ? o.units : null,
            frequency: typeof o.frequency === 'string' ? o.frequency : null,
            observationStart: typeof o.observation_start === 'string' ? o.observation_start : null,
            observationEnd: typeof o.observation_end === 'string' ? o.observation_end : null,
          };
        });
        if (series.length === 0) {
          return {
            text: `No FRED series matching "${text}".`,
            structured: { text, count: 0, series: [] },
          };
        }
        const lines = series
          .map(
            (s) => `  ${s.id} — ${s.title}${s.units ? ` (${s.units}, ${s.frequency ?? '?'})` : ''}`,
          )
          .join('\n');
        return {
          text: `${series.length} FRED series for "${text}":\n${lines}`,
          structured: { text, count: series.length, series },
        };
      },
    },
    {
      name: 'get_observations',
      title: 'FRED: Get observations',
      description:
        'Fetch the data points (date, value) for a FRED series id (e.g. "UNRATE", ' +
        '"CPIAUCSL", "MORTGAGE30US"). Optionally bound by date range; newest-first ' +
        'by default. Use search_series to find an id.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        series_id: z.string().min(1).describe('FRED series id, e.g. "UNRATE".'),
        start: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('Start date YYYY-MM-DD.'),
        end: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('End date YYYY-MM-DD.'),
        limit: z.number().int().min(1).max(100).default(24).describe('Max data points (1–100).'),
        sort: z
          .enum(['asc', 'desc'])
          .default('desc')
          .describe('Date order: desc (newest first) or asc.'),
      }),
      output: z.object({
        seriesId: z.string(),
        count: z.number(),
        observations: z.array(z.object({ date: z.string(), value: z.number().nullable() })),
      }),
      async handler(args, ctx) {
        const { series_id, start, end, limit, sort } = args;
        ctx.log('get_observations', { series_id, start, end, limit, sort });
        const params = new URLSearchParams({
          series_id,
          limit: String(limit),
          sort_order: sort,
        });
        if (start) params.set('observation_start', start);
        if (end) params.set('observation_end', end);
        const body = await getJson('/series/observations', params, ctx);
        const raw = Array.isArray(body.observations) ? body.observations : [];
        const observations = raw.map((o) => {
          const rec = o as Record<string, unknown>;
          return {
            date: typeof rec.date === 'string' ? rec.date : '',
            value: parseValue(rec.value),
          };
        });
        if (observations.length === 0) {
          return {
            text: `No observations for FRED series "${series_id}".`,
            structured: { seriesId: series_id, count: 0, observations: [] },
          };
        }
        const lines = observations
          .slice(0, 12)
          .map((o) => `  ${o.date}: ${o.value ?? 'n/a'}`)
          .join('\n');
        return {
          text: `${observations.length} observation(s) for ${series_id}:\n${lines}${observations.length > 12 ? '\n  …' : ''}`,
          structured: { seriesId: series_id, count: observations.length, observations },
        };
      },
    },
  ],
});
