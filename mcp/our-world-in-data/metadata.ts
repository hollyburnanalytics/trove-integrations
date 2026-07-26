import { ToolError } from '@ontrove/mcp';
import {
  columnIndicatorId,
  fetchChartMetadata,
  fetchIndicatorMetadata,
  GRAPHER,
} from './client.ts';
import type { MetadataView } from './render.ts';

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

type Ctx = Parameters<typeof fetchChartMetadata>[0];

export type ChartMetadataView = MetadataView;

/** One source, deduped across every indicator that cites it. */
type Source = MetadataView['sources'][number];

/** Fetch chart metadata and per-indicator provenance for `slug`. */
export async function collectMetadata(
  ctx: Ctx,
  slug: string,
  maxIndicators: number,
): Promise<ChartMetadataView> {
  const metadata = await fetchChartMetadata(ctx, slug);
  if (!metadata) {
    throw new ToolError(
      `No Our World in Data chart with the slug "${slug}". Use search_charts to find the right slug.`,
      { retryable: false },
    );
  }

  const entries = Object.entries(metadata.columns ?? {});
  const columns = entries.map(([title, column]) => ({
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

  const ids = columns
    .map((column) => column.indicatorId)
    .filter((id): id is number => typeof id === 'number');
  const resolved = ids.slice(0, maxIndicators);
  const { sources, nonRedistributable } = await collectSources(ctx, resolved);

  const notes: string[] = [];
  if (ids.length > resolved.length) {
    notes.push(
      `Provenance resolved for ${String(resolved.length)} of ${String(ids.length)} indicators; raise \`max_indicators\` for the rest.`,
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
): Promise<{ sources: Source[]; nonRedistributable: boolean }> {
  const sources: Source[] = [];
  const seen = new Set<string>();
  let nonRedistributable = false;

  for (const id of indicatorIds) {
    const indicator = await fetchIndicatorMetadata(ctx, id);
    if (!indicator) continue;
    if (indicator.nonRedistributable === true) nonRedistributable = true;
    for (const origin of indicator.origins ?? []) {
      const source = toSource(origin);
      const key = `${source.producer ?? ''}|${source.license ?? ''}|${source.citation ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push(source);
    }
  }
  return { sources, nonRedistributable };
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
