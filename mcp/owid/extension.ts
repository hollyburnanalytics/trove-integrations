import { defineToolkit, tool, z } from '@ontrove/extend/toolkit';
import { dataOutput, getChartData } from './chart.ts';
import { GRAPHER, searchCharts, searchIndicators } from './client.ts';
import { getIndicatorData, indicatorOutput } from './indicator.ts';
import { collectMetadata, metadataOutput } from './metadata.ts';
import { renderData, renderIndicator, renderMetadata } from './render.ts';

/**
 * Our World in Data — a keyless hosted MCP server over OWID's public data APIs.
 * Five read-only surfaces:
 *  - `search_charts` — find a chart slug by keyword (OWID's own search index),
 *  - `search_indicators` — semantic search over the indicator catalogue,
 *  - `get_chart_data` — every column a chart plots, filtered by entity + time,
 *  - `get_indicator_data` — one variable by id, including the many that appear
 *    on no chart and are otherwise unreachable,
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
 * surfaces that refusal verbatim rather than as a generic failure. The indicator
 * data endpoint does NOT apply that gate, so `get_indicator_data` applies it
 * itself rather than becoming the way around it.
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
const TIME_PATTERN = new RegExp(String.raw`^${TIME_POINT}(?:\.\.${TIME_POINT})?$`);

export default defineToolkit({
  id: 'owid',
  name: 'Our World in Data',
  description:
    "Charts, indicators and the data behind them from Our World in Data — with units, definitions, and per-source licensing. No key required. An independent client for OWID's public APIs; not affiliated with or endorsed by Our World in Data.",
  icon: '🌍',
  version: '1.0.0',
  secrets: [],
  egress: ['ourworldindata.org', 'api.ourworldindata.org', 'search.owid.io'],
  scopes: [],
  visibility: 'shared',
  tools: [
    tool({
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
            variantName: z
              .string()
              .nullable()
              .describe('Disambiguator when several charts share a title (e.g. by sex or source).'),
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
          .filter((hit): hit is typeof hit & { slug: string } => Boolean(hit.slug))
          .map((hit) => ({
            slug: hit.slug,
            title: hit.title ?? hit.slug,
            subtitle: hit.subtitle ?? null,
            variantName: hit.variantName === '' ? null : (hit.variantName ?? null),
            url: hit.url ?? `${GRAPHER}/${hit.slug}`,
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
          .map((c) => {
            const variant = c.variantName ? ` [${c.variantName}]` : '';
            const subtitle = c.subtitle ? ` (${c.subtitle})` : '';
            return `  ${c.slug} — ${c.title}${variant}${subtitle}`;
          })
          .join('\n');
        return {
          text: `${String(charts.length)} of ${String(structured.totalHits)} chart(s) for "${query}":\n${lines}`,
          structured,
        };
      },
    }),
    tool({
      name: 'search_indicators',
      title: 'Our World in Data: Search indicators',
      description:
        'Semantic search over Our World in Data’s underlying variables (indicators), ranked by ' +
        'meaning rather than keyword. Use it when search_charts finds nothing, or when you want a ' +
        'specific variable rather than whatever a chart happens to plot — most indicators appear ' +
        'on no chart at all. Pass a returned indicatorId to get_indicator_data for the numbers.',
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
            description: z.string().nullable(),
            catalogPath: z.string().nullable(),
            chartCount: z.number(),
            score: z.number().nullable(),
            parquetUrl: z.string().nullable(),
            parquetColumn: z.string().nullable(),
            sqlTemplate: z.string().nullable(),
          }),
        ),
      }),
      async handler(args, ctx) {
        const { query, limit, min_popularity } = args;
        ctx.log('search_indicators', { query, limit, min_popularity });
        const body = await searchIndicators(ctx, { query, limit, minPopularity: min_popularity });
        const indicators = (body.results ?? [])
          .filter(
            (hit): hit is typeof hit & { indicator_id: number } =>
              typeof hit.indicator_id === 'number',
          )
          .map((hit) => ({
            indicatorId: hit.indicator_id,
            title: hit.title ?? '',
            description: hit.description === '' ? null : (hit.description ?? hit.snippet ?? null),
            catalogPath: hit.catalog_path ?? null,
            chartCount: hit.n_charts ?? hit.metadata?.chart_count ?? 0,
            score: hit.score ?? null,
            // Bulk access, free: the upstream already hands back the Parquet
            // table and a runnable DuckDB query for each indicator.
            parquetUrl: hit.metadata?.parquet_url ?? null,
            parquetColumn: hit.metadata?.column ?? null,
            sqlTemplate: hit.metadata?.run_sql_template ?? null,
          }));
        const structured = { query, count: indicators.length, indicators };
        if (indicators.length === 0) {
          return { text: `No Our World in Data indicators matching "${query}".`, structured };
        }
        const lines = indicators
          .map(
            (i) =>
              `  #${String(i.indicatorId)} — ${i.title}${
                i.chartCount > 0 ? ` · ${String(i.chartCount)} chart(s)` : ''
              }`,
          )
          .join('\n');
        return {
          text:
            `${String(indicators.length)} indicator(s) for "${query}":\n${lines}\n` +
            'Pass an indicatorId to get_indicator_data for the observations, or query a `parquetUrl` directly (DuckDB reads it over HTTP).',
          structured,
        };
      },
    }),
    tool({
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
        slug: z
          .string()
          .min(1)
          .describe(
            'Chart slug from search_charts, e.g. "life-expectancy" — the last path segment of an ourworldindata.org/grapher/ URL. Not an indicator id, not a catalog path.',
          ),
        countries: z
          .array(z.string().min(1))
          .max(40)
          .default([])
          .describe(
            'Entities to return: country names ("United States"), ISO-3 codes ("USA"), or Our World in Data aggregates ("World", "Europe", "High-income countries"). Omit for the chart’s own default selection.',
          ),
        time: z
          .string()
          .regex(TIME_PATTERN)
          .optional()
          .describe(
            'Time filter: "2020", "2000..2020", "2015-03-01..2020-12-31" (daily charts), "latest" or "earliest". Omit to get every time point — hundreds of rows on a long-run series. Out-of-range requests SNAP to the nearest available time rather than returning nothing, so check the time on each row.',
          ),
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
    }),
    tool({
      name: 'get_indicator_data',
      title: 'Our World in Data: Get indicator data',
      description:
        'Fetch the observations for one indicator by numeric id (from search_indicators). Use ' +
        'this for variables that appear on no chart, or when you want a single named variable ' +
        'rather than every column a chart happens to plot. Unlike get_chart_data, `from`/`to` ' +
        'really filter — there is no snapping to the nearest year. Indicators their provider ' +
        'does not permit to be re-shared are refused.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        indicator_id: z
          .number()
          .int()
          .positive()
          .describe('Numeric indicator id from search_indicators, e.g. 1269960.'),
        countries: z
          .array(z.string().min(1))
          .max(40)
          .default([])
          .describe(
            'Entities to return: names ("United States"), ISO-3 codes ("USA"), or Our World in Data aggregates ("World"). Omit for every entity the indicator covers.',
          ),
        from: z.number().int().optional().describe('Earliest year, inclusive.'),
        to: z.number().int().optional().describe('Latest year, inclusive.'),
        max_rows: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .default(200)
          .describe('Max observations returned (1–2000).'),
      }),
      output: indicatorOutput,
      async handler(args, ctx) {
        const { indicator_id, countries, from, to, max_rows } = args;
        ctx.log('get_indicator_data', { indicator_id, countries, from, to, max_rows });
        const result = await getIndicatorData(ctx, {
          indicatorId: indicator_id,
          countries,
          from,
          to,
          maxRows: max_rows,
        });
        return { text: renderIndicator(result), structured: result };
      },
    }),
    tool({
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
    }),
  ],
});
