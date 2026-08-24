import { ToolError, z } from '@ontrove/extend/toolkit';
import { type Ctx, catalogParquet, fetchIndicatorData, fetchIndicatorMetadata } from './client.ts';
import type { CsvRow } from './csv.ts';
import { selectEntities, unmatchedRequests } from './entities.ts';
import { timeRange } from './time.ts';

/**
 * Reading one indicator directly, by id.
 *
 * Every other data path here is keyed by CHART slug, which leaves a real dead
 * end: `search_indicators` finds variables, thousands of which appear on no
 * chart at all, and until this existed a caller could locate exactly the right
 * indicator and then have no way to read it. The free-range-hens series is a
 * concrete case — it exists, it is what most people actually mean when they ask
 * about free-range eggs, and no slug reaches it.
 */

export const indicatorOutput = z.object({
  indicatorId: z.number(),
  title: z.string(),
  unit: z.string().nullable(),
  description: z.string().nullable(),
  datasetName: z.string().nullable(),
  timespan: z.string().nullable(),
  entities: z.array(z.string()),
  rows: z.array(
    z.object({
      entity: z.string(),
      code: z.string().nullable(),
      time: z.string().describe('The year. May be negative for BCE on long-run series.'),
      value: z.union([z.number(), z.string(), z.null()]),
    }),
  ),
  totalRows: z.number().describe('Observations matching the request, before `max_rows`.'),
  truncated: z.boolean(),
  timeRange: z.object({ first: z.string(), last: z.string() }).nullable(),
  citation: z.string().nullable(),
  attribution: z.string().nullable(),
  parquetUrl: z
    .string()
    .nullable()
    .describe('Parquet table holding this indicator, queryable in place with DuckDB.'),
  parquetColumn: z.string().nullable(),
  notes: z.array(z.string()),
});

export type IndicatorResult = z.infer<typeof indicatorOutput>;

/**
 * Fetch and shape one indicator's observations.
 *
 * The redistribution check is not optional politeness. OWID enforces its
 * providers' terms on the chart CSV (403) and by omitting the table from the
 * catalog (404) — but the indicator data endpoint serves restricted series
 * anyway. Reading it and handing the numbers over would make this toolkit the
 * one way around a licence its own other tools respect, so the flag is checked
 * here and the same refusal is raised.
 */
export async function getIndicatorData(
  ctx: Ctx,
  options: {
    indicatorId: number;
    countries: string[];
    from?: number;
    to?: number;
    maxRows: number;
  },
): Promise<IndicatorResult> {
  const { indicatorId, maxRows } = options;
  const countries = options.countries.map((c) => c.trim()).filter((c) => c !== '');

  const metadata = await fetchIndicatorMetadata(ctx, indicatorId);
  if (!metadata) {
    throw new ToolError(
      `No Our World in Data indicator with id ${String(indicatorId)}. Use search_indicators to find one.`,
      { retryable: false },
    );
  }
  if (metadata.nonRedistributable === true) {
    throw new ToolError(
      `Indicator ${String(indicatorId)} ("${metadata.name ?? 'untitled'}") is marked non-redistributable by its provider, so Our World in Data does not permit its data to be re-shared. Its metadata and licence are still readable, and the chart remains viewable on their site.`,
      { retryable: false },
    );
  }

  const data = await fetchIndicatorData(ctx, indicatorId);
  if (!data) {
    throw new ToolError(
      `Our World in Data returned no data for indicator ${String(indicatorId)}; try again shortly.`,
      { retryable: true },
    );
  }

  const all = buildRows(data, entityIndex(metadata));
  const withinTime = all.filter((row) => inRange(row.time, options.from, options.to));
  const selected = selectEntities(withinTime, countries);
  const notes = explain({ all, withinTime, selected, countries, timespan: metadata.timespan });

  const truncated = selected.length > maxRows;
  if (truncated) {
    notes.push(
      `Showing the first ${String(maxRows)} of ${String(selected.length)} observations. Narrow \`countries\`/\`from\`/\`to\`, or query \`parquetUrl\` directly for the whole series.`,
    );
  }
  const rows = truncated ? selected.slice(0, maxRows) : selected;
  const table = catalogParquet(metadata.catalogPath);

  return {
    indicatorId,
    title: metadata.name ?? `Indicator ${String(indicatorId)}`,
    unit: metadata.unit ?? null,
    description: metadata.descriptionShort ?? null,
    datasetName: metadata.datasetName ?? null,
    timespan: metadata.timespan ?? null,
    entities: [...new Set(selected.map((r) => r.entity))],
    rows: rows.map((row) => ({
      entity: row.entity,
      code: row.code,
      time: row.time,
      value: row.values[0] ?? null,
    })),
    totalRows: selected.length,
    truncated,
    timeRange: timeRange(selected),
    citation: citationFor(metadata),
    attribution: metadata.origins?.[0]?.citationFull ?? null,
    parquetUrl: table?.url ?? null,
    parquetColumn: table?.column ?? null,
    notes,
  };
}

/** Say what came back short, and why — before the caller has to guess. */
function explain(state: {
  all: CsvRow[];
  withinTime: CsvRow[];
  selected: CsvRow[];
  countries: string[];
  timespan: string | null | undefined;
}): string[] {
  const notes: string[] = [];
  if (state.countries.length > 0) {
    const missing = unmatchedRequests(state.selected, state.countries);
    if (missing.length > 0) {
      notes.push(
        `No observations for: ${missing.map((m) => `"${m}"`).join(', ')}. Names are Our World in Data's own ("United States", "World") or ISO-3 codes ("USA"); matching here is case-insensitive.`,
      );
    }
  }
  if (state.withinTime.length === 0 && state.all.length > 0) {
    notes.push(
      `This indicator has no observations in the requested years. It covers ${state.timespan ?? 'a different period'}.`,
    );
  }
  return notes;
}

type Metadata = NonNullable<Awaited<ReturnType<typeof fetchIndicatorMetadata>>>;
type Data = NonNullable<Awaited<ReturnType<typeof fetchIndicatorData>>>;

/** Numeric entity id → its name and code. */
function entityIndex(metadata: Metadata): Map<number, { name: string; code: string | null }> {
  const index = new Map<number, { name: string; code: string | null }>();
  for (const value of metadata.dimensions?.entities?.values ?? []) {
    if (typeof value.id !== 'number' || typeof value.name !== 'string') continue;
    index.set(value.id, { name: value.name, code: value.code ?? null });
  }
  return index;
}

/**
 * Zip the three parallel arrays into rows.
 *
 * `values[i]`, `years[i]` and `entities[i]` describe one observation between
 * them; an index present in one and missing from another is a truncated
 * payload, and emitting it would invent an observation.
 */
function buildRows(
  data: Data,
  entities: Map<number, { name: string; code: string | null }>,
): CsvRow[] {
  const values = data.values ?? [];
  const years = data.years ?? [];
  const ids = data.entities ?? [];
  const rows: CsvRow[] = [];
  for (const [index, value] of values.entries()) {
    const year = years[index];
    const id = ids[index];
    if (year === undefined || id === undefined) continue;
    const entity = entities.get(id);
    if (!entity) continue;
    rows.push({ entity: entity.name, code: entity.code, time: String(year), values: [value] });
  }
  return rows;
}

/**
 * Is this year inside the requested window?
 *
 * Unlike the chart endpoint, this filter is applied here and really does
 * filter: there is no snapping to the nearest available year, so an empty
 * result means the indicator genuinely has nothing in that window.
 */
function inRange(time: string, from: number | undefined, to: number | undefined): boolean {
  const year = Number(time);
  if (!Number.isFinite(year)) return true;
  if (from !== undefined && year < from) return false;
  return to === undefined || year <= to;
}

/** Producers, deduped, in the form the rest of the toolkit cites them. */
function citationFor(metadata: Metadata): string | null {
  const producers = [
    ...new Set(
      (metadata.origins ?? [])
        .map((origin) => origin.producer)
        .filter((producer): producer is string => typeof producer === 'string' && producer !== ''),
    ),
  ];
  if (producers.length === 0) return null;
  return `${producers.join('; ')} – processed by Our World in Data`;
}
