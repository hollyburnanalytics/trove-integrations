/**
 * FRED Economic Data — a hosted MCP server over the St. Louis Fed's FRED API
 * (api.stlouisfed.org). Two read-only surfaces:
 *  - `search_series` — find economic time-series by keyword, and
 *  - `get_observations` — fetch the data points for up to five series ids.
 *
 * FRED requires a free API key, redeemed at call time from the vault via
 * `ctx.requireSecret('FRED_API_KEY')` (never bundled or logged) and passed as
 * the `api_key` query param. Set it with `trove secret set fred FRED_API_KEY <key>`.
 *
 * Two design rules run through both tools, both learned from FRED returning a
 * confidently wrong-looking answer over HTTP 200:
 *
 *  - **Never drop data silently.** `limit` clips the range with no signal, so
 *    every result reports `availableInRange` next to `returned` and says
 *    "TRUNCATED" in the prose when they differ.
 *  - **Transform upstream, not in context.** `units` (nine transforms) and
 *    `frequency`/`aggregation_method` (server-side downsampling) are free at
 *    FRED and cost logarithms-by-language-model here, so both are forwarded.
 */
import { defineMcpServer, ToolError, z } from '@ontrove/mcp';
import { runObservations } from './observations.ts';
import { runSearch } from './search.ts';

/** Max data points a single call may return across all requested series. */
const TOTAL_POINT_CAP = 2000;

/** The FRED series-search orderings worth exposing. */
const ORDER_BY = ['search_rank', 'popularity', 'observation_start', 'last_updated'] as const;

/** FRED's nine `units` transforms. */
const UNITS = ['lin', 'chg', 'ch1', 'pch', 'pc1', 'pca', 'cch', 'cca', 'log'] as const;

/** Target frequencies FRED can aggregate a series down to. */
const FREQUENCIES = ['d', 'w', 'bw', 'm', 'q', 'sa', 'a'] as const;

const seriesSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  units: z.string().nullable(),
  frequency: z.string().nullable(),
  frequencyShort: z.string().nullable(),
  seasonalAdjustment: z.string().nullable(),
  observationStart: z.string().nullable(),
  observationEnd: z.string().nullable(),
  lastUpdated: z.string().nullable(),
  popularity: z.number().nullable(),
});

export default defineMcpServer({
  egress: ['api.stlouisfed.org'],
  tools: [
    {
      name: 'search_series',
      title: 'FRED: Search series',
      description:
        'Find FRED economic time-series by keyword (e.g. "unemployment rate", ' +
        '"CPI", "30-year mortgage"). Keywords, not questions. Returns each series ' +
        'id, title, units, frequency, seasonal adjustment, popularity and coverage — ' +
        'pass the id to get_observations. Many FRED series come in seasonally ' +
        'adjusted and not-seasonally-adjusted variants with identical titles ' +
        '(CPIAUCSL vs CPIAUCNS): check seasonalAdjustment before choosing, or pass ' +
        'the filter. For a broad concept ("inflation", "housing"), orderBy: ' +
        '"popularity" surfaces the headline series that literal ranking buries.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        text: z.string().min(1).describe('Search keywords, e.g. "unemployment rate".'),
        limit: z.number().int().min(1).max(25).default(10).describe('Max series (1–25).'),
        orderBy: z
          .enum(ORDER_BY)
          .default('search_rank')
          .describe(
            'Ranking: search_rank (FRED relevance, default) or popularity ' +
              '(best for broad concepts). Also observation_start, last_updated.',
          ),
        seasonalAdjustment: z
          .enum(['SA', 'NSA'])
          .optional()
          .describe('Keep only seasonally adjusted (SA, incl. SAAR) or not (NSA).'),
        frequency: z
          .enum(['D', 'W', 'BW', 'M', 'Q', 'SA', 'A'])
          .optional()
          .describe('Keep only series at this native frequency.'),
      }),
      output: z.object({
        text: z.string(),
        orderBy: z.string(),
        retriedAs: z.string().nullable(),
        count: z.number(),
        totalMatches: z.number(),
        series: z.array(seriesSchema),
      }),
      async handler(args, ctx) {
        ctx.log('search_series', args);
        return runSearch(args, ctx);
      },
    },
    {
      name: 'get_observations',
      title: 'FRED: Get observations',
      description:
        'Fetch the data points for 1–5 FRED series ids (e.g. ["UNRATE"], ' +
        '["CPIAUCSL","DGS10"]). Each result carries the series title, units, ' +
        'frequency and seasonal adjustment, so the numbers can be labelled without ' +
        'a second call, plus availableInRange/truncated/nextOffset so a clipped ' +
        'range is never mistaken for a complete one. Use `units` for FRED-side ' +
        'transforms (pc1 = % change from year ago, cca = continuously compounded ' +
        'annual rate…) and `frequency` + `aggregation_method` to downsample a long ' +
        'daily series server-side instead of paginating it.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        series_ids: z
          .array(z.string().min(1))
          .min(1)
          .max(5)
          .describe('FRED series ids, e.g. ["UNRATE"] or ["CPIAUCSL","CPIAUCNS"].'),
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
        units: z
          .enum(UNITS)
          .default('lin')
          .describe(
            'FRED-side transform: lin (levels, default), chg, ch1, pch, pc1 ' +
              '(% change from year ago), pca, cch, cca, log.',
          ),
        frequency: z
          .enum(FREQUENCIES)
          .optional()
          .describe(
            'Aggregate to a lower frequency server-side (d, w, bw, m, q, sa, a). ' +
              'Cannot upsample — a monthly series cannot become daily.',
          ),
        aggregation_method: z
          .enum(['avg', 'sum', 'eop'])
          .default('avg')
          .describe('How to aggregate when frequency is set: avg, sum, or eop.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(24)
          .describe('Max data points per series (1–1000).'),
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe('Skip this many points — pass a previous result’s nextOffset.'),
        sort: z
          .enum(['asc', 'desc'])
          .default('desc')
          .describe('Date order: desc (newest first) or asc.'),
        format: z
          .enum(['pairs', 'columnar'])
          .default('pairs')
          .describe(
            'pairs = [{date,value}] (default); columnar = parallel dates[] and ' +
              'values[] arrays, ~40% smaller for long series.',
          ),
      }),
      output: z.object({
        seriesCount: z.number(),
        unitsTransform: z.string(),
        format: z.string(),
        series: z.array(
          z.object({
            id: z.string(),
            title: z.string().nullable(),
            units: z.string().nullable(),
            unitsTransform: z.string(),
            unitsTransformLabel: z.string(),
            frequency: z.string().nullable(),
            seasonalAdjustment: z.string().nullable(),
            lastUpdated: z.string().nullable(),
            coverageStart: z.string().nullable(),
            coverageEnd: z.string().nullable(),
            returned: z.number(),
            availableInRange: z.number().nullable(),
            truncated: z.boolean(),
            nextOffset: z.number().nullable(),
            observations: z
              .array(z.object({ date: z.string(), value: z.number().nullable() }))
              .optional(),
            dates: z.array(z.string()).optional(),
            values: z.array(z.number().nullable()).optional(),
            note: z.string().nullable(),
          }),
        ),
      }),
      async handler(args, ctx) {
        ctx.log('get_observations', args);
        // The SDK's ToolDefinition defaults its schema generic, so `args` reaches
        // the handler untyped; the Zod schema above is what actually validated it.
        const requested = args.series_ids as string[];
        const ids = [...new Set(requested.map((id) => id.trim()).filter(Boolean))];
        if (ids.length === 0) {
          throw new ToolError('series_ids contained no usable series id.', { retryable: false });
        }
        // Refuse an oversized pull outright rather than clamping it quietly —
        // a silently shrunk limit is the same failure mode as a clipped range.
        if (ids.length * args.limit > TOTAL_POINT_CAP) {
          throw new ToolError(
            `${ids.length} series × limit ${args.limit} exceeds the ${TOTAL_POINT_CAP}-point ` +
              `cap for one call. Lower limit to ${Math.floor(TOTAL_POINT_CAP / ids.length)} or ` +
              'below, aggregate with frequency, or request fewer series.',
            { retryable: false },
          );
        }
        return runObservations(
          {
            seriesIds: ids,
            start: args.start,
            end: args.end,
            units: args.units,
            frequency: args.frequency,
            aggregationMethod: args.aggregation_method,
            limit: args.limit,
            offset: args.offset,
            sort: args.sort,
            format: args.format,
          },
          ctx,
        );
      },
    },
  ],
});
