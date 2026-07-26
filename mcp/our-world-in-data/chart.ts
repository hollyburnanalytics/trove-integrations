import { ToolError, z } from '@ontrove/mcp';
import {
  type ChartColumn,
  type ChartMetadata,
  type Ctx,
  chartDownloads,
  columnIndicatorId,
  downloadsSchema,
  fetchChartCsv,
  fetchChartMetadata,
  GRAPHER,
} from './client.ts';
import { type CsvRow, type CsvTable, parseChartCsv } from './csv.ts';
import { chartEntities, diagnoseMissing, selectEntities, unmatchedRequests } from './entities.ts';
import { noteTimeSnap, timeRange } from './time.ts';

/**
 * Assembling one `get_chart_data` answer: fetch, join to metadata, and — when
 * the result is empty — work out *why* before handing back nothing.
 */

/**
 * The tool's output contract, declared once beside the code that produces it.
 *
 * Derived, not restated: a hand-written interface alongside this schema drifts
 * the moment a field is added to one and not the other, and the drift is
 * silent — the extra field is simply stripped from `structured` at runtime.
 */
export const columnSchema = z.object({
  key: z
    .string()
    .describe(
      'Stable column key. Join these columns to get_chart_metadata columns on this key, never on position — the two tools order them independently.',
    ),
  title: z.string(),
  unit: z.string().nullable(),
  indicatorId: z.number().nullable(),
});

export const dataOutput = z.object({
  slug: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  url: z.string(),
  timeUnit: z
    .enum(['year', 'day'])
    .describe(
      '"year" — `rows[].time` is a year, which may be NEGATIVE for BCE on long-run series (e.g. "-10000"). "day" — `rows[].time` is YYYY-MM-DD.',
    ),
  columns: z.array(columnSchema),
  entities: z.array(z.string()),
  rows: z.array(
    z.object({
      entity: z.string(),
      code: z.string().nullable(),
      time: z.string(),
      values: z
        .array(z.union([z.number(), z.string(), z.null()]))
        .describe(
          'One value per entry in `columns`, in the same order. null = no observation (not zero); a string means a categorical/ordinal indicator.',
        ),
    }),
  ),
  totalRows: z.number().describe('Rows matching the request, before `max_rows` truncation.'),
  totalRowsBeforeSelection: z
    .number()
    .describe(
      'Rows the upstream returned before this server enforced `countries`. A large gap is normal — it means the chart ignored the entity selection and this server applied it, not that data is missing.',
    ),
  truncated: z.boolean(),
  timeRange: z.object({ first: z.string(), last: z.string() }).nullable(),
  citation: z.string().nullable(),
  attribution: z.string().nullable(),
  downloads: downloadsSchema,
  notes: z.array(z.string()),
});

export type DataColumn = z.infer<typeof columnSchema>;
export type ChartData = z.infer<typeof dataOutput>;

/**
 * The citations for the columns actually returned, deduped and in column order.
 *
 * Taking the FIRST column's citation and printing it as "Source:" for the whole
 * table is wrong the moment a chart stacks indicators from different producers
 * — and OWID charts routinely do. `child-mortality-vs-health-expenditure` draws
 * on UN IGME, WHO/World Bank and HYDE at once; crediting only UN IGME would put
 * three other organisations' numbers under one wrong name, which is exactly the
 * failure the licensing work here exists to prevent.
 */
function citations(
  columns: DataColumn[],
  metadata: ChartMetadata | undefined,
  pick: (column: ChartColumn) => string | null | undefined,
): string[] {
  const byShortName = new Map<string, ChartColumn>();
  for (const column of Object.values(metadata?.columns ?? {})) {
    if (typeof column.shortName === 'string') byShortName.set(column.shortName, column);
  }
  const seen = new Set<string>();
  for (const column of columns) {
    const value = pick(byShortName.get(column.key) ?? {});
    if (typeof value === 'string' && value !== '') seen.add(value);
  }
  return [...seen];
}

/** Join CSV header keys to metadata columns via `shortName`, falling back to position. */
function joinColumns(keys: string[], metadata: ChartMetadata | undefined): DataColumn[] {
  const columns = Object.values(metadata?.columns ?? {});
  const byShortName = new Map<string, ChartColumn>();
  for (const column of columns) {
    // A duplicated shortName cannot identify a column; drop both so the join
    // falls through to position rather than labelling a column wrongly.
    const name = column.shortName;
    if (typeof name !== 'string' || name === '') continue;
    if (byShortName.has(name)) byShortName.set(name, {});
    else byShortName.set(name, column);
  }
  return keys.map((key, index) => {
    const matched = byShortName.get(key) ?? (keys.length === columns.length ? columns[index] : {});
    const column = matched ?? {};
    return {
      key,
      title: column.titleShort ?? column.titleLong ?? key,
      unit: column.unit ?? null,
      indicatorId: columnIndicatorId(column) ?? null,
    };
  });
}

/** Fetch and parse a chart CSV, mapping every refusal to a caller-shaped error. */
async function loadTable(
  ctx: Ctx,
  slug: string,
  countries: string[],
  time: string | undefined,
): Promise<CsvTable> {
  const csv = await fetchChartCsv(ctx, slug, { entities: countries, time });
  if (csv.kind === 'notFound') {
    throw new ToolError(
      `No Our World in Data chart with the slug "${slug}". Use search_charts to find the right slug.`,
      { retryable: false },
    );
  }
  if (csv.kind === 'restricted') {
    throw new ToolError(
      `${csv.reason} You can still read its metadata with get_chart_metadata, and view it at ${GRAPHER}/${slug}.`,
      { retryable: false },
    );
  }
  const table = parseChartCsv(csv.csv);
  if (!table) {
    throw new ToolError(
      `Our World in Data returned data for "${slug}" in an unrecognised format; try again shortly.`,
      { retryable: true },
    );
  }
  return table;
}

/**
 * Re-ask for the data using the spellings grapher actually accepts.
 *
 * Correcting the caller beats scolding them. The entity list gives the
 * canonical name for any token that differs only in case ("jpn" → "Japan"),
 * and one more request then returns the country they asked for instead of a
 * note explaining why they cannot have it. Costs nothing on the happy path:
 * this runs only when something is already missing, and it runs at most once.
 */
async function repairSelection(
  ctx: Ctx,
  options: {
    slug: string;
    countries: string[];
    missing: string[];
    metadata: ChartMetadata | undefined;
    time: string | undefined;
    notes: string[];
  },
): Promise<CsvTable | undefined> {
  const { slug, countries, missing, metadata, time, notes } = options;
  const entities = await chartEntities(ctx, metadata).catch(() => undefined);
  if (!entities) return undefined;

  const corrections = new Map<string, string>();
  for (const name of missing) {
    const canonical = entities.canonical.get(name.toLowerCase());
    if (canonical !== undefined && canonical !== name) corrections.set(name, canonical);
  }
  if (corrections.size === 0) return undefined;

  const corrected = countries.map((country) => corrections.get(country) ?? country);
  ctx.log('owid retrying with canonical entity names', { slug, corrections: [...corrections] });
  const table = await loadTable(ctx, slug, corrected, time).catch(() => undefined);
  if (!table) return undefined;

  // Only claim a correction worked if it actually produced rows. A zero-row
  // retry still yields a table, and announcing `read "jpn" as "Japan"` next to
  // a note saying Japan has no data reads as two contradictory answers.
  const landed = new Set(
    table.rows.flatMap((row) => (row.code === null ? [row.entity] : [row.entity, row.code])),
  );
  const applied = [...corrections].filter(([, to]) => landed.has(to));
  if (applied.length > 0) {
    notes.push(
      `Our World in Data’s entity names are case-sensitive; read ${applied
        .map(([from, to]) => `"${from}" as "${to}"`)
        .join(', ')}.`,
    );
  }
  return table;
}

/**
 * Narrow the table to the requested entities, repairing the request first if
 * grapher's case-sensitivity swallowed any of them, and explaining whatever is
 * still missing afterwards.
 */
async function resolveRows(
  ctx: Ctx,
  options: {
    slug: string;
    table: CsvTable;
    countries: string[];
    metadata: ChartMetadata | undefined;
    time: string | undefined;
    notes: string[];
  },
): Promise<{ table: CsvTable; rows: CsvRow[] }> {
  const { slug, countries, metadata, time, notes } = options;
  let table = options.table;
  let rows = selectEntities(table.rows, countries);

  if (countries.length === 0) {
    if (rows.length === 0) notes.push('This chart returned no rows for the requested time range.');
    return { table, rows };
  }

  // Grapher's entity selector is CASE-SENSITIVE — `JPN` works, `jpn` returns
  // nothing at all — so a plausible spelling silently costs the caller a whole
  // country while the others still return 200 and the result looks complete.
  const missing = unmatchedRequests(rows, countries);
  if (missing.length === 0) return { table, rows };

  const repaired = await repairSelection(ctx, { slug, countries, missing, metadata, time, notes });
  if (repaired) {
    table = repaired;
    rows = selectEntities(table.rows, countries);
  }
  const stillMissing = unmatchedRequests(rows, countries);
  if (stillMissing.length > 0) {
    await diagnoseMissing(ctx, metadata, stillMissing, notes).catch(() => {
      notes.push(`No data returned for: ${stillMissing.map((m) => `"${m}"`).join(', ')}.`);
    });
  }
  return { table, rows };
}

/** Fetch, parse, and shape one chart's data. */
export async function getChartData(
  ctx: Ctx,
  options: { slug: string; countries: string[]; time?: string; maxRows: number },
): Promise<ChartData> {
  const { slug, time, maxRows } = options;
  // Normalise once, at the boundary: a whitespace-only entry would otherwise
  // be sent as an empty selector token and then match no row on the way back.
  const countries = options.countries.map((c) => c.trim()).filter((c) => c !== '');

  let table = await loadTable(ctx, slug, countries, time);

  // Best-effort: units, titles and citations improve the answer but must never
  // be the reason a caller gets no data.
  const metadata = await fetchChartMetadata(ctx, slug).catch(() => undefined);
  const notes: string[] = [];
  const resolved = await resolveRows(ctx, { slug, table, countries, metadata, time, notes });
  table = resolved.table;
  const selected = resolved.rows;
  noteTimeSnap(selected, table.timeUnit, time, notes);

  const truncated = selected.length > maxRows;
  if (truncated) {
    notes.push(
      `Showing the first ${String(maxRows)} of ${String(selected.length)} rows. Narrow \`countries\`/\`time\` to see fewer — or, for the whole dataset, download \`downloads.csv\` rather than paging it through the context window.`,
    );
  }
  // Truncate AFTER selecting: capping first would drop the requested entity
  // whenever the upstream leads with the other 200.
  const rows = truncated ? selected.slice(0, maxRows) : selected;
  const columns = joinColumns(table.columns, metadata);

  // Coverage is described from the SELECTION, not the page of it that fits.
  // OWID's CSV is entity-major and oldest-first, so a 200-row cap on two
  // countries cuts mid-way through the second: reporting the visible slice's
  // last year as the chart's coverage claimed life-expectancy ends in 2018.
  const entities = [...new Set(selected.map((r) => r.entity))];
  const shown = new Set(rows.map((r) => r.entity));
  const dropped = entities.filter((entity) => !shown.has(entity));
  if (dropped.length > 0) {
    notes.push(
      `Truncation cut these entities out of the rows entirely: ${dropped.join(', ')}. Request them directly in \`countries\`, or use \`downloads.csv\`.`,
    );
  }

  const short = citations(columns, metadata, (c) => c.citationShort);
  const long = citations(columns, metadata, (c) => c.citationLong);

  return {
    slug,
    title: metadata?.chart?.title ?? slug,
    subtitle: metadata?.chart?.subtitle ?? null,
    url: `${GRAPHER}/${slug}`,
    timeUnit: table.timeUnit,
    columns,
    entities,
    rows,
    // Rows matching the request — which is what `truncated` and the truncation
    // note count against. The upstream total is reported separately; conflating
    // the two would claim 197 rows for a chart that returned one country.
    totalRows: selected.length,
    truncated,
    totalRowsBeforeSelection: table.rows.length,
    timeRange: timeRange(selected),
    citation: short.length > 0 ? short.join('; ') : (metadata?.chart?.citation ?? null),
    attribution: long.length > 0 ? long.join('\n\n') : null,
    downloads: chartDownloads(slug),
    notes,
  };
}
