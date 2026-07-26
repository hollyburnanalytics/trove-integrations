import { ToolError, z } from '@ontrove/mcp';
import { createEgressClient } from '../lib/egress.ts';

/**
 * Shared Our World in Data plumbing: the egress client, the four upstream
 * endpoints, their (deliberately lenient) wire schemas, and the entity-selector
 * encoding that the whole toolkit depends on being right.
 *
 * Four hosts, one organisation:
 *  - `ourworldindata.org/grapher/{slug}.csv|.metadata.json` — chart data + metadata
 *  - `ourworldindata.org/api/search` — chart search
 *  - `api.ourworldindata.org/v1/indicators/{id}.metadata.json` — per-indicator
 *    provenance: upstream producers, their licences, and `nonRedistributable`
 *  - `search.owid.io/indicators` — semantic (embedding) indicator search
 *
 * All keyless and public; OWID documents the CSV/JSON URLs as the supported
 * path for "automated workflows, computational notebooks, or custom
 * applications".
 */

const SITE = 'https://ourworldindata.org';
const GRAPHER = `${SITE}/grapher`;
const SEARCH = `${SITE}/api/search`;
const INDICATORS = 'https://api.ourworldindata.org/v1/indicators';
const SEMANTIC = 'https://search.owid.io/indicators';

/**
 * Refuse to parse a chart body past this size.
 *
 * `csvType=full` on a large chart is megabytes (co2-by-source is ~1.4 MB), and
 * every tool here asks for `filtered` precisely to avoid that. A body this big
 * therefore means the filter did not bite — and parsing it would spend the
 * caller's time and context producing a table nobody can read. Refusing says
 * which knob to turn instead.
 */
const MAX_CSV_BYTES = 4 * 1024 * 1024;

/**
 * OWID is behind a CDN and publishes no rate limit; this is politeness, not a
 * documented ceiling. The in-isolate cache matters more than the throttle: a
 * `get_chart_data` call fetches the CSV *and* the metadata, and a follow-up
 * `get_chart_metadata` on the same chart then costs nothing.
 *
 * `bodyStatuses: [403]` is load-bearing. OWID answers a request for a chart it
 * is not licensed to redistribute with a 403 whose body says exactly that, and
 * that sentence is the single most useful thing the tool can tell a caller.
 */
const owid = createEgressClient({
  service: 'Our World in Data',
  headers: { 'user-agent': 'Trove MCP (our-world-in-data@ontrove.sh)' },
  throttleMs: 250,
  bodyStatuses: [403],
  cache: { ttlMs: 10 * 60_000, maxEntries: 64, maxEntryBytes: 1024 * 1024 },
});

type Ctx = Parameters<typeof owid.fetch>[0];

/** OWID's JSON error envelope, e.g. `{"status":404,"error":"Not found"}`. */
const errorWire = z.object({ status: z.number().nullish(), error: z.string().nullish() });

/** The `error` sentence from an OWID JSON error body, if it carries one. */
function upstreamReason(body: string): string | undefined {
  try {
    const parsed = errorWire.safeParse(JSON.parse(body));
    const reason = parsed.success ? parsed.data.error : undefined;
    return typeof reason === 'string' && reason !== '' ? reason : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Encode entity names for grapher's `country` parameter.
 *
 * **This is the sharpest edge in the whole API.** Grapher splits the value on
 * `~` — but when the value contains no `~` at all it falls back to splitting on
 * `+`/space, so a single multi-word entity is torn into words that match
 * nothing. The failure is silent: `country=United States` returns HTTP 200 with
 * a header row and no data, indistinguishable from "this chart has no figures
 * for you".
 *
 * A leading `~` is always emitted, so even one entity keeps a `~` in the value
 * and takes the intended path. That is OWID's own convention in chart
 * permalinks (`~OWID_WRL`), not a trick.
 */
export function encodeEntities(entities: string[]): string {
  const cleaned = entities.map((e) => e.trim()).filter((e) => e !== '');
  return `~${cleaned.join('~')}`;
}

/**
 * Serialise query parameters with spaces as `%20` rather than `+`.
 *
 * `URLSearchParams` emits form encoding, where a space becomes `+` — and `+` is
 * the very character grapher treats as an entity separator. It does decode
 * `~Canada~United+States` correctly today, but writing `United+States` into a
 * parameter whose parser splits on `+` is a coincidence to depend on, not a
 * contract. `%20` cannot be mistaken for a separator by any parser.
 *
 * Safe by construction: a literal `+` inside a value is already `%2B` by this
 * point, so every remaining `+` is an encoded space.
 */
function queryString(params: URLSearchParams): string {
  return params.toString().replaceAll('+', '%20');
}

// --- chart data --------------------------------------------------------------

/** A chart CSV, or the reason OWID declined to serve it. */
export type ChartCsv =
  | { kind: 'ok'; csv: string }
  | { kind: 'notFound' }
  | { kind: 'restricted'; reason: string };

/**
 * Fetch a chart's data as CSV.
 *
 * Always `csvType=filtered` and always `useColumnShortNames=true`: the former
 * because the default (`full`) is the whole indicator for every entity and
 * every year, the latter because short names are the exact join key back to the
 * metadata's `shortName` — the human-readable headers are the chart's display
 * labels and do *not* match any metadata field.
 *
 * `tab=chart` is the third non-obvious one. `filtered` means "what the chart is
 * currently showing", and for a chart whose default view is the world MAP that
 * is every country — the `country` selection is simply not part of a map's
 * state. Asking `covid-cases` for `World` without a tab returns 395 rows for
 * 250 countries; with `tab=chart` it returns 14 rows for World. Charts that
 * already default to a line view are unaffected.
 */
export async function fetchChartCsv(
  ctx: Ctx,
  slug: string,
  options: { entities?: string[]; time?: string },
): Promise<ChartCsv> {
  const params = new URLSearchParams({
    csvType: 'filtered',
    useColumnShortNames: 'true',
    tab: 'chart',
  });
  if (options.entities && options.entities.length > 0) {
    params.set('country', encodeEntities(options.entities));
  }
  if (options.time) params.set('time', options.time);

  const url = `${GRAPHER}/${encodeURIComponent(slug)}.csv?${queryString(params)}`;
  const { status, body } = await owid.fetch(ctx, url, { accept: 'text/csv' });

  if (status === 404) return { kind: 'notFound' };
  if (status === 403) {
    return {
      kind: 'restricted',
      reason:
        upstreamReason(body) ??
        'Our World in Data does not permit this chart’s data to be downloaded.',
    };
  }
  if (status === 400) {
    throw new ToolError(
      `Our World in Data rejected the request for "${slug}" (check the time range format).`,
      { retryable: false },
    );
  }
  if (body.length > MAX_CSV_BYTES) {
    throw new ToolError(
      `The data for "${slug}" is too large to read in one call (${String(Math.round(body.length / 1024))} KB). Narrow it with \`countries\` and/or \`time\`.`,
      { retryable: false },
    );
  }
  return { kind: 'ok', csv: body };
}

// --- chart metadata ----------------------------------------------------------

const columnWire = z.object({
  titleShort: z.string().nullish(),
  titleLong: z.string().nullish(),
  descriptionShort: z.string().nullish(),
  descriptionProcessing: z.string().nullish(),
  shortName: z.string().nullish(),
  unit: z.string().nullish(),
  shortUnit: z.string().nullish(),
  timespan: z.string().nullish(),
  lastUpdated: z.string().nullish(),
  nextUpdate: z.string().nullish(),
  owidVariableId: z.number().nullish(),
  citationShort: z.string().nullish(),
  citationLong: z.string().nullish(),
  fullMetadata: z.string().nullish(),
  type: z.string().nullish(),
});

const chartMetadataWire = z.object({
  chart: z
    .object({
      title: z.string().nullish(),
      subtitle: z.string().nullish(),
      citation: z.string().nullish(),
      originalChartUrl: z.string().nullish(),
      selection: z.array(z.string()).nullish(),
    })
    .nullish(),
  columns: z.record(z.string(), columnWire).nullish(),
  dateDownloaded: z.string().nullish(),
});

export type ChartMetadata = z.infer<typeof chartMetadataWire>;
export type ChartColumn = z.infer<typeof columnWire>;

/**
 * Fetch a chart's metadata. Returns `undefined` only when the slug is genuinely
 * unknown (404).
 *
 * A 403 is NOT "no such chart": OWID serves metadata for charts whose *data*
 * it may not redistribute, so a refusal here means something else entirely
 * (a bot block, say) and must not be reported to the caller as a bad slug.
 */
export async function fetchChartMetadata(
  ctx: Ctx,
  slug: string,
): Promise<ChartMetadata | undefined> {
  const url = `${GRAPHER}/${encodeURIComponent(slug)}.metadata.json`;
  const { status, body } = await owid.fetch(ctx, url, { accept: 'application/json' });
  if (status === 404) return undefined;
  if (status === 403 || status === 400) {
    throw new ToolError(
      `Our World in Data refused the metadata request for "${slug}" (HTTP ${String(status)})${
        upstreamReason(body) ? `: ${upstreamReason(body)}` : '.'
      }`,
      { retryable: false },
    );
  }
  return parseJson(chartMetadataWire, body, 'chart metadata');
}

// --- indicator metadata (provenance + licensing) -----------------------------

const licenseWire = z.object({ name: z.string().nullish(), url: z.string().nullish() });

const indicatorMetadataWire = z.object({
  id: z.number().nullish(),
  name: z.string().nullish(),
  unit: z.string().nullish(),
  catalogPath: z.string().nullish(),
  datasetName: z.string().nullish(),
  descriptionShort: z.string().nullish(),
  updatePeriodDays: z.number().nullish(),
  /**
   * OWID's own machine-readable redistribution gate. When true the CSV endpoint
   * 403s — they enforce the upstream provider's terms server-side rather than
   * leaving it to callers.
   */
  nonRedistributable: z.boolean().nullish(),
  license: licenseWire.nullish(),
  origins: z
    .array(
      z.object({
        producer: z.string().nullish(),
        citationFull: z.string().nullish(),
        urlMain: z.string().nullish(),
        dateAccessed: z.string().nullish(),
        license: licenseWire.nullish(),
      }),
    )
    .nullish(),
  dimensions: z
    .object({
      entities: z
        .object({
          values: z
            .array(
              z.object({
                id: z.number().nullish(),
                name: z.string().nullish(),
                code: z.string().nullish(),
              }),
            )
            .nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

export type IndicatorMetadata = z.infer<typeof indicatorMetadataWire>;

/**
 * Fetch one indicator's full metadata by numeric id.
 *
 * This is the provenance record: every upstream producer, each with its own
 * licence name and URL, plus `nonRedistributable`. It is also the only place
 * the chart's full entity list appears, which is what turns an empty result
 * into a useful "did you mean" instead of a shrug.
 */
export async function fetchIndicatorMetadata(
  ctx: Ctx,
  indicatorId: number,
): Promise<IndicatorMetadata | undefined> {
  const url = `${INDICATORS}/${String(indicatorId)}.metadata.json`;
  const { status, body } = await owid.fetch(ctx, url, { accept: 'application/json' });
  if (status !== 200) return undefined;
  try {
    return parseJson(indicatorMetadataWire, body, 'indicator metadata');
  } catch {
    // Provenance is an enrichment on every path that uses it; a malformed
    // record must not take down the answer the caller actually asked for.
    return undefined;
  }
}

/** The numeric indicator id behind a chart column, from its `fullMetadata` URL or id field. */
export function columnIndicatorId(column: ChartColumn): number | undefined {
  if (typeof column.owidVariableId === 'number') return column.owidVariableId;
  const match = /\/indicators\/(\d+)\.metadata\.json/.exec(column.fullMetadata ?? '');
  const id = match?.[1];
  return id === undefined ? undefined : Number(id);
}

// --- search ------------------------------------------------------------------

const searchChartsWire = z.object({
  query: z.string().nullish(),
  nbHits: z.number().nullish(),
  page: z.number().nullish(),
  nbPages: z.number().nullish(),
  hitsPerPage: z.number().nullish(),
  results: z
    .array(
      z.object({
        title: z.string().nullish(),
        slug: z.string().nullish(),
        subtitle: z.string().nullish(),
        variantName: z.string().nullish(),
        type: z.string().nullish(),
        availableEntities: z.array(z.string()).nullish(),
        availableTabs: z.array(z.string()).nullish(),
        publishedAt: z.string().nullish(),
        updatedAt: z.string().nullish(),
        url: z.string().nullish(),
      }),
    )
    .nullish(),
});

export type ChartSearchResponse = z.infer<typeof searchChartsWire>;

/** Search OWID's chart collection by keyword, optionally requiring entities. */
export async function searchCharts(
  ctx: Ctx,
  options: { query: string; limit: number; countries?: string[]; requireAllCountries?: boolean },
): Promise<ChartSearchResponse> {
  const params = new URLSearchParams({
    q: options.query,
    type: 'charts',
    hitsPerPage: String(options.limit),
  });
  if (options.countries && options.countries.length > 0) {
    params.set('countries', options.countries.join('~'));
    if (options.requireAllCountries) params.set('requireAllCountries', 'true');
  }
  const { status, body } = await owid.fetch(ctx, `${SEARCH}?${queryString(params)}`, {
    accept: 'application/json',
  });
  if (status !== 200) {
    throw new ToolError(
      `Our World in Data search rejected the query${status === 400 ? ' (bad parameters)' : ''}.`,
      { retryable: false },
    );
  }
  return parseJson(searchChartsWire, body, 'search results');
}

const semanticSearchWire = z.object({
  query: z.string().nullish(),
  total_results: z.number().nullish(),
  results: z
    .array(
      z.object({
        title: z.string().nullish(),
        indicator_id: z.number().nullish(),
        snippet: z.string().nullish(),
        description: z.string().nullish(),
        score: z.number().nullish(),
        popularity: z.number().nullish(),
        n_charts: z.number().nullish(),
        catalog_path: z.string().nullish(),
        metadata: z
          .object({ unit: z.string().nullish(), chart_count: z.number().nullish() })
          .nullish(),
      }),
    )
    .nullish(),
});

export type IndicatorSearchResponse = z.infer<typeof semanticSearchWire>;

/** Semantic (embedding) search over OWID's indicator catalogue. */
export async function searchIndicators(
  ctx: Ctx,
  options: { query: string; limit: number; minPopularity?: number },
): Promise<IndicatorSearchResponse> {
  const params = new URLSearchParams({ q: options.query, limit: String(options.limit) });
  if (options.minPopularity !== undefined) {
    params.set('min_popularity', String(options.minPopularity));
  }
  const { status, body } = await owid.fetch(ctx, `${SEMANTIC}?${queryString(params)}`, {
    accept: 'application/json',
  });
  // FastAPI answers a bad parameter with 422, which the egress client does not
  // pass through — so only 400 can arrive here as a status.
  if (status !== 200) {
    throw new ToolError('Our World in Data indicator search rejected the query.', {
      retryable: false,
    });
  }
  return parseJson(semanticSearchWire, body, 'indicator search results');
}

/** Parse + validate a JSON body, mapping both failures to one retryable error. */
function parseJson<S extends z.ZodTypeAny>(schema: S, body: string, what: string): z.infer<S> {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new ToolError(`Our World in Data returned malformed ${what}; try again shortly.`, {
      retryable: true,
    });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ToolError(`Our World in Data returned unexpected ${what}; try again shortly.`, {
      retryable: true,
    });
  }
  return parsed.data as z.infer<S>;
}

export { GRAPHER, SITE };
