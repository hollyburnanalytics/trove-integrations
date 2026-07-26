import { ToolError, z } from '@ontrove/mcp';
import {
  type Ctx,
  catalogParquet,
  chartDownloads,
  columnIndicatorId,
  downloadsSchema,
  fetchChartMetadata,
  fetchIndicatorMetadata,
  GRAPHER,
} from './client.ts';
export const sourceSchema = z.object({
  producer: z.string().nullable(),
  license: z.string().nullable(),
  licenseUrl: z.string().nullable(),
  citation: z.string().nullable(),
  url: z.string().nullable(),
  dateAccessed: z.string().nullable(),
});

export const metadataOutput = z.object({
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
      parquetUrl: z
        .string()
        .nullable()
        .describe(
          "Parquet table backing this indicator, queryable in place: SELECT country, year, <parquetColumn> FROM '<parquetUrl>'. Null when Our World in Data does not publish the table (e.g. non-redistributable data).",
        ),
      parquetColumn: z.string().nullable().describe("This indicator's column inside parquetUrl."),
    }),
  ),
  sources: z.array(sourceSchema),
  downloads: downloadsSchema,
  notes: z.array(z.string()),
});

export type MetadataView = z.infer<typeof metadataOutput>;

/**
 * Assembling one `get_chart_metadata` answer: the chart's own record, plus the
 * per-indicator provenance that says who produced each number and under what
 * licence.
 *
 * The provenance half is the reason this tool exists. OWID's terms ask callers
 * to respect the ORIGINAL provider's licence, and that information lives one
 * hop away from the chart — on each indicator's own metadata record, never on
 * the chart itself.
 */

/** One source, deduped across every indicator that cites it. */
type Source = MetadataView['sources'][number];

/** Fetch chart metadata and per-indicator provenance for `slug`. */
export async function collectMetadata(
  ctx: Ctx,
  slug: string,
  maxIndicators: number,
): Promise<MetadataView> {
  const metadata = await fetchChartMetadata(ctx, slug);
  if (!metadata) {
    throw new ToolError(
      `No Our World in Data chart with the slug "${slug}". Use search_charts to find the right slug.`,
      { retryable: false },
    );
  }

  const entries = Object.entries(metadata.columns ?? {});
  const bare = entries.map(([title, column]) => ({
    key: column.shortName ?? title,
    title: column.titleShort ?? title,
    unit: column.unit ?? null,
    timespan: column.timespan ?? null,
    lastUpdated: column.lastUpdated ?? null,
    nextUpdate: column.nextUpdate ?? null,
    description: column.descriptionShort ?? null,
    processingNotes: column.descriptionProcessing ?? null,
    indicatorId: columnIndicatorId(column) ?? null,
  }));

  const ids = bare
    .map((column) => column.indicatorId)
    .filter((id): id is number => typeof id === 'number');
  const resolved = ids.slice(0, maxIndicators);
  const {
    sources,
    nonRedistributable,
    tables,
    resolved: covered,
  } = await collectSources(ctx, resolved);

  // Attach the Parquet table backing each indicator, so a caller can query the
  // whole thing in place rather than pulling rows through a context window.
  const columns = bare.map((column) => {
    const table = column.indicatorId === null ? undefined : tables.get(column.indicatorId);
    return {
      ...column,
      parquetUrl: table?.parquet ?? null,
      parquetColumn: table?.column ?? null,
    };
  });

  const notes: string[] = [];
  const partial = covered < ids.length;
  if (partial) {
    // The redistribution verdict is only as complete as the provenance behind
    // it. Reporting `nonRedistributable: false` after reading 6 of 8
    // indicators states a licence fact that was never checked for the other 2.
    notes.push(
      `Provenance covers ${String(covered)} of ${String(ids.length)} indicators; the licence and redistribution verdict below describe only those. Raise \`max_indicators\` to check the rest.`,
    );
  }
  if (nonRedistributable) {
    notes.push(
      'Our World in Data is not permitted to redistribute this data, so get_chart_data will refuse it. The chart itself remains viewable on their site.',
    );
  }

  const first = entries[0]?.[1];
  return {
    slug,
    title: metadata.chart?.title ?? slug,
    subtitle: metadata.chart?.subtitle ?? null,
    url: metadata.chart?.originalChartUrl ?? `${GRAPHER}/${slug}`,
    citation: first?.citationShort ?? metadata.chart?.citation ?? null,
    attribution: first?.citationLong ?? null,
    nonRedistributable,
    columns,
    sources,
    downloads: chartDownloads(slug),
    notes,
  };
}

/**
 * Resolve each indicator's origins into a deduped source list.
 *
 * A chart stacking six fuels cites the same producer six times; the caller
 * needs the licence once. Dedup is on producer + licence + citation, so two
 * genuinely different datasets from one producer still both appear.
 */
async function collectSources(
  ctx: Ctx,
  indicatorIds: number[],
): Promise<{
  sources: Source[];
  nonRedistributable: boolean;
  tables: Map<number, { parquet: string; column: string | null }>;
  resolved: number;
}> {
  const sources: Source[] = [];
  const seen = new Set<string>();
  const tables = new Map<number, { parquet: string; column: string | null }>();
  let nonRedistributable = false;
  let resolved = 0;

  // A wall-clock ceiling for the WHOLE loop. Each request is individually
  // bounded, but twelve of them in sequence are not — and provenance is an
  // enrichment: better to return what was gathered, and say so, than to spend
  // the caller's whole deadline on the twelfth indicator.
  const deadline = Date.now() + 15_000;
  for (const id of indicatorIds) {
    if (Date.now() > deadline) break;
    const indicator = await fetchIndicatorMetadata(ctx, id).catch(() => undefined);
    if (!indicator) continue;
    resolved++;
    const restricted = indicator.nonRedistributable === true;
    if (restricted) nonRedistributable = true;
    // Only advertise a Parquet URL for data OWID actually publishes. It does
    // not push non-redistributable tables to the catalog — that URL 404s — and
    // offering one would read as a way around a licence the CSV endpoint
    // enforces on purpose.
    const table = restricted ? undefined : catalogParquet(indicator.catalogPath);
    if (table) tables.set(id, { parquet: table.url, column: table.column });
    addSources(indicator.origins ?? [], sources, seen);
  }
  return { sources, nonRedistributable, tables, resolved };
}

/** Append each origin not already represented, deduped on producer|licence|citation. */
function addSources(origins: Origin[], sources: Source[], seen: Set<string>): void {
  for (const origin of origins) {
    const source = toSource(origin);
    const key = `${source.producer ?? ''}|${source.license ?? ''}|${source.citation ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(source);
  }
}

type Origin = NonNullable<
  NonNullable<Awaited<ReturnType<typeof fetchIndicatorMetadata>>>['origins']
>[number];

/** Flatten one upstream origin record into the shape this tool reports. */
function toSource(origin: Origin): Source {
  return {
    producer: origin.producer ?? null,
    license: origin.license?.name ?? null,
    licenseUrl: origin.license?.url ?? null,
    citation: origin.citationFull ?? null,
    url: origin.urlMain ?? null,
    dateAccessed: origin.dateAccessed ?? null,
  };
}
