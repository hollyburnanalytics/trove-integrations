import { defineMcpServer, z } from '@ontrove/mcp';
import { getChartData } from './chart.ts';
import { GRAPHER, searchCharts, searchIndicators } from './client.ts';
import { collectMetadata } from './metadata.ts';
import { renderData, renderMetadata } from './render.ts';

/**
 * Our World in Data — a keyless hosted MCP server over OWID's public data APIs.
 * Four read-only surfaces:
 *  - `search_charts` — find a chart slug by keyword (OWID's own search index),
 *  - `search_indicators` — semantic search over the indicator catalogue,
 *  - `get_chart_data` — the numbers behind a chart, filtered by entity + time,
 *  - `get_chart_metadata` — units, definitions, provenance and licensing.
 *
 * No API key. OWID documents these URLs as the supported path for automated
 * workflows, and their robots.txt carries no restriction.
 *
 * **Licensing is a first-class output, not a footnote.** Most data on OWID is
 * third-party (WHO, UN, World Bank, Defra, FAO…) under the original provider's
 * terms, so every result carries the upstream citation, and
 * `get_chart_metadata` reports each source's licence by name. Where OWID is not
 * permitted to redistribute at all, the CSV endpoint 403s and `get_chart_data`
 * surfaces that refusal verbatim rather than as a generic failure.
 *
 * Nothing here writes to the knowledge base — no `trove:ingest` scope, no save
 * tool.
 */

/**
 * `2020`, `2000..2020`, `1990-01-01..2000-12-31`, `latest`, `earliest`.
 *
 * Five and six digit years are deliberate, not slack: OWID's long-run series
 * are indexed in BCE years, and the population chart genuinely starts at
 * `-10000`. A four-digit cap rejects a range the upstream answers happily.
 */
const TIME_POINT = String.raw`(?:latest|earliest|-?\d{1,6}(?:-\d{2}-\d{2})?)`;
const TIME_PATTERN = new RegExp(`^${TIME_POINT}(?:\\.\\.${TIME_POINT})?$`);

const columnSchema = z.object({
  key: z.string(),
  title: z.string(),
  unit: z.string().nullable(),
  indicatorId: z.number().nullable(),
});

const dataOutput = z.object({
  slug: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  url: z.string(),
  timeUnit: z.enum(['year', 'day']),
  columns: z.array(columnSchema),
  entities: z.array(z.string()),
  rows: z.array(
    z.object({
      entity: z.string(),
      code: z.string().nullable(),
      time: z.string(),
      values: z.array(z.union([z.number(), z.string(), z.null()])),
    }),
  ),
  totalRows: z.number(),
  totalRowsBeforeSelection: z.number(),
  truncated: z.boolean(),
  timeRange: z.object({ first: z.string(), last: z.string() }).nullable(),
  citation: z.string().nullable(),
  attribution: z.string().nullable(),
  notes: z.array(z.string()),
});

const sourceSchema = z.object({
  producer: z.string().nullable(),
  license: z.string().nullable(),
  licenseUrl: z.string().nullable(),
  citation: z.string().nullable(),
  url: z.string().nullable(),
  dateAccessed: z.string().nullable(),
});

const metadataOutput = z.object({
  slug: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  url: z.string(),
  citation: z.string().nullable(),
  attribution: z.string().nullable(),
  nonRedistributable: z.boolean(),
  columns: z.array(
    z.object({
      key: z.string(),
      title: z.string(),
      unit: z.string().nullable(),
      timespan: z.string().nullable(),
      lastUpdated: z.string().nullable(),
      nextUpdate: z.string().nullable(),
      description: z.string().nullable(),
      processingNotes: z.string().nullable(),
      indicatorId: z.number().nullable(),
    }),
  ),
  sources: z.array(sourceSchema),
  notes: z.array(z.string()),
});

export default defineMcpServer({
  tools: [
    {
      name: 'search_charts',
      title: 'Our World in Data: Search charts',
      description:
        'Find Our World in Data charts by keyword (e.g. "life expectancy", "cage-free hens", ' +
        '"energy use per person"). Returns each chart\'s slug — pass it to get_chart_data for ' +
        'the numbers, or get_chart_metadata for units, definitions and sources. Optionally ' +
        'restrict to charts covering particular countries.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        query: z.string().min(1).describe('Search keywords, e.g. "child mortality".'),
        limit: z.number().int().min(1).max(25).default(8).describe('Max charts (1–25).'),
        countries: z
          .array(z.string().min(1))
          .max(10)
          .optional()
          .describe('Only charts covering these entities, e.g. ["Canada", "Japan"].'),
        require_all_countries: z
          .boolean()
          .default(false)
          .describe('Require every listed country rather than any of them.'),
      }),
      output: z.object({
        query: z.string(),
        totalHits: z.number(),
        count: z.number(),
        charts: z.array(
          z.object({
            slug: z.string(),
            title: z.string(),
            subtitle: z.string().nullable(),
            variantName: z.string().nullable(),
            url: z.string(),
            entityCount: z.number(),
            tabs: z.array(z.string()),
            updatedAt: z.string().nullable(),
          }),
        ),
      }),
      async handler(args, ctx) {
        const { query, limit, countries, require_all_countries } = args;
        ctx.log('search_charts', { query, limit, countries });
        const body = await searchCharts(ctx, {
          query,
          limit,
          countries,
          requireAllCountries: require_all_countries,
        });
        const charts = (body.results ?? [])
          .filter((hit) => typeof hit.slug === 'string' && hit.slug !== '')
          .map((hit) => ({
            slug: hit.slug ?? '',
            title: hit.title ?? hit.slug ?? '',
            subtitle: hit.subtitle ?? null,
            variantName: hit.variantName === '' ? null : (hit.variantName ?? null),
            url: hit.url ?? `${GRAPHER}/${hit.slug ?? ''}`,
            // The raw hit carries every entity name on the chart — 265 of them
            // for life-expectancy. That is a list nobody reads and everybody
            // pays for, so the count travels and the names stay behind.
            entityCount: hit.availableEntities?.length ?? 0,
            tabs: hit.availableTabs ?? [],
            updatedAt: hit.updatedAt ?? null,
          }));
        const structured = {
          query,
          totalHits: body.nbHits ?? charts.length,
          count: charts.length,
          charts,
        };
        if (charts.length === 0) {
          return { text: `No Our World in Data charts matching "${query}".`, structured };
        }
        const lines = charts
          .map((c) => `  ${c.slug} — ${c.title}${c.subtitle ? ` (${c.subtitle})` : ''}`)
          .join('\n');
        return {
          text: `${String(charts.length)} of ${String(structured.totalHits)} chart(s) for "${query}":\n${lines}`,
          structured,
        };
      },
    },
    {
      name: 'search_indicators',
      title: 'Our World in Data: Search indicators',
      description:
        'Semantic search over Our World in Data’s indicator catalogue — describe what you want ' +
        'in plain language ("share of hens in cages", "how much energy comes from wind") and ' +
        'get matching indicators ranked by meaning, not keyword. Use this when search_charts ' +
        'finds nothing; it matches the underlying variables rather than chart titles.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        query: z.string().min(1).describe('Plain-language description of the data wanted.'),
        limit: z.number().int().min(1).max(25).default(8).describe('Max indicators (1–25).'),
        min_popularity: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('Drop indicators below this popularity score (0–1).'),
      }),
      output: z.object({
        query: z.string(),
        count: z.number(),
        indicators: z.array(
          z.object({
            indicatorId: z.number(),
            title: z.string(),
            unit: z.string().nullable(),
            description: z.string().nullable(),
            catalogPath: z.string().nullable(),
            chartCount: z.number(),
            score: z.number().nullable(),
          }),
        ),
      }),
      async handler(args, ctx) {
        const { query, limit, min_popularity } = args;
        ctx.log('search_indicators', { query, limit, min_popularity });
        const body = await searchIndicators(ctx, { query, limit, minPopularity: min_popularity });
        const indicators = (body.results ?? [])
          .filter((hit) => typeof hit.indicator_id === 'number')
          .map((hit) => ({
            indicatorId: hit.indicator_id ?? 0,
            title: hit.title ?? '',
            unit: hit.metadata?.unit ?? null,
            description: hit.description === '' ? null : (hit.description ?? hit.snippet ?? null),
            catalogPath: hit.catalog_path ?? null,
            chartCount: hit.n_charts ?? hit.metadata?.chart_count ?? 0,
            score: hit.score ?? null,
          }));
        const structured = { query, count: indicators.length, indicators };
        if (indicators.length === 0) {
          return { text: `No Our World in Data indicators matching "${query}".`, structured };
        }
        const lines = indicators
          .map(
            (i) =>
              `  #${String(i.indicatorId)} — ${i.title}${i.unit ? ` (${i.unit})` : ''}${
                i.chartCount > 0 ? ` · ${String(i.chartCount)} chart(s)` : ''
              }`,
          )
          .join('\n');
        return {
          text:
            `${String(indicators.length)} indicator(s) for "${query}":\n${lines}\n` +
            'Indicators are the underlying variables; use search_charts to find a chart slug you can fetch data for.',
          structured,
        };
      },
    },
    {
      name: 'get_chart_data',
      title: 'Our World in Data: Get chart data',
      description:
        'Fetch the numbers behind an Our World in Data chart, by slug (from search_charts). ' +
        'Filter with `countries` (entity names like "United States" or ISO-3 codes like "USA") ' +
        'and `time` ("2020", "2000..2020", "latest"). Returns tidy rows plus units and the ' +
        'citation for the underlying data providers. Charts OWID may not redistribute are ' +
        'refused with the reason.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        slug: z.string().min(1).describe('Chart slug, e.g. "life-expectancy".'),
        countries: z
          .array(z.string().min(1))
          .max(40)
          .default([])
          .describe('Entity names or ISO-3 codes. Omit for the chart’s own default selection.'),
        time: z
          .string()
          .regex(TIME_PATTERN)
          .optional()
          .describe('"2020", "2000..2020", "latest", or "earliest".'),
        // The ceiling is a context budget, not an API limit: rows land in both
        // the structured payload and the text mirror, and 275 rows of a
        // six-column chart already costs ~12k tokens.
        max_rows: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .default(200)
          .describe(
            'Max rows returned (1–2000). Narrow `countries`/`time` in preference to raising this.',
          ),
      }),
      output: dataOutput,
      async handler(args, ctx) {
        const { slug, countries, time, max_rows } = args;
        ctx.log('get_chart_data', { slug, countries, time, max_rows });
        const data = await getChartData(ctx, { slug, countries, time, maxRows: max_rows });
        return { text: renderData(data), structured: data };
      },
    },
    {
      name: 'get_chart_metadata',
      title: 'Our World in Data: Get chart metadata',
      description:
        'What an Our World in Data chart actually measures: per-indicator units, definitions, ' +
        'processing notes, coverage and update schedule, plus full provenance — every upstream ' +
        'producer with its licence — and whether OWID is permitted to redistribute the data. ' +
        'Use before quoting or republishing figures; works even for charts whose data is ' +
        'restricted.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        slug: z.string().min(1).describe('Chart slug, e.g. "life-expectancy".'),
        max_indicators: z
          .number()
          .int()
          .min(1)
          .max(12)
          .default(6)
          .describe('How many of the chart’s indicators to resolve provenance for (1–12).'),
      }),
      output: metadataOutput,
      async handler(args, ctx) {
        const { slug, max_indicators } = args;
        ctx.log('get_chart_metadata', { slug, max_indicators });
        const result = await collectMetadata(ctx, slug, max_indicators);
        return { text: renderMetadata(result), structured: result };
      },
    },
  ],
});
