import { ToolError } from '@ontrove/mcp';
import {
  type ChartColumn,
  type ChartMetadata,
  columnIndicatorId,
  fetchChartCsv,
  fetchChartMetadata,
  GRAPHER,
} from './client.ts';
import { type CsvRow, type CsvTable, parseChartCsv } from './csv.ts';
import { chartEntities, diagnoseMissing, selectEntities, unmatchedRequests } from './entities.ts';

/**
 * Assembling one `get_chart_data` answer: fetch, join to metadata, and — when
 * the result is empty — work out *why* before handing back nothing.
 */

type Ctx = Parameters<typeof fetchChartCsv>[0];

/** A value column, joined from the CSV header to its metadata record. */
export interface DataColumn {
  key: string;
  title: string;
  unit: string | null;
  indicatorId: number | null;
}

export interface ChartData {
  slug: string;
  title: string;
  subtitle: string | null;
  url: string;
  timeUnit: 'year' | 'day';
  columns: DataColumn[];
  entities: string[];
  rows: CsvRow[];
  totalRows: number;
  /** Rows the upstream returned before this server applied `countries`. */
  totalRowsBeforeSelection: number;
  truncated: boolean;
  timeRange: { first: string; last: string } | null;
  citation: string | null;
  attribution: string | null;
  notes: string[];
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

/** The `[first, last]` time values present in the rows, in sorted order. */
function timeRange(rows: CsvRow[]): { first: string; last: string } | null {
  const first = rows[0]?.time;
  if (first === undefined) return null;
  let low = first;
  let high = first;
  for (const row of rows) {
    if (earlier(row.time, low)) low = row.time;
    if (earlier(high, row.time)) high = row.time;
  }
  return { first: low, last: high };
}

/**
 * Is `a` an earlier time than `b`?
 *
 * Years are compared as numbers, not text. OWID charts reach back past year
 * zero — population series start at -10000 — and lexically "-10000" sorts
 * after "1750", which would report a range running backwards.  `YYYY-MM-DD`
 * days are fixed-width, so string order is already chronological.
 */
function earlier(a: string, b: string): boolean {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na < nb;
  return a < b;
}

/** The inclusive numeric bounds a `time` argument asks for, when it states any. */
function requestedBounds(time: string | undefined): { from: number; to: number } | undefined {
  if (!time) return undefined;
  const range = /^(-?\d+)\.\.(-?\d+)$/.exec(time);
  if (range?.[1] !== undefined && range[2] !== undefined) {
    return { from: Number(range[1]), to: Number(range[2]) };
  }
  return /^-?\d+$/.test(time) ? { from: Number(time), to: Number(time) } : undefined;
}

/**
 * Note when the data came back from outside the window that was asked for.
 *
 * Grapher does not treat `time` as a filter that can return nothing: asked for
 * `1800..1810` on a series starting in 1831, it answers with 1831. Silently
 * relabelling that as the requested decade would be the worst outcome here —
 * a wrong year attached to a real number.
 */
function noteTimeSnap(
  rows: CsvRow[],
  timeUnit: 'year' | 'day',
  time: string | undefined,
  notes: string[],
): void {
  const bounds = requestedBounds(time);
  if (!bounds || rows.length === 0) return;
  // A year is the whole cell, NOT its first four characters: OWID's long-run
  // series carry BCE years like "-10000", and slicing those to "-100" would
  // put every prehistoric row outside its own requested range.
  const years = rows
    .map((row) => (timeUnit === 'year' ? Number(row.time) : Number(row.time.slice(0, 4))))
    .filter((year) => Number.isFinite(year));
  if (years.some((year) => year >= bounds.from && year <= bounds.to)) return;
  notes.push(
    `No data exists in the requested range ${String(bounds.from)}–${String(bounds.to)}; Our World in Data returned the nearest available time instead. Check the dates on each row.`,
  );
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
  const entities = await chartEntities(ctx, metadata);
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

  notes.push(
    `Our World in Data’s entity names are case-sensitive; read ${[...corrections]
      .map(([from, to]) => `"${from}" as "${to}"`)
      .join(', ')}.`,
  );
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
  if (stillMissing.length > 0) await diagnoseMissing(ctx, metadata, stillMissing, notes);
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
      `Showing the first ${String(maxRows)} of ${String(selected.length)} rows. Narrow \`countries\` or \`time\`, or raise \`max_rows\`, to see the rest.`,
    );
  }
  // Truncate AFTER selecting: capping first would drop the requested entity
  // whenever the upstream leads with the other 200.
  const rows = truncated ? selected.slice(0, maxRows) : selected;
  const firstColumn = Object.values(metadata?.columns ?? {})[0];

  return {
    slug,
    title: metadata?.chart?.title ?? slug,
    subtitle: metadata?.chart?.subtitle ?? null,
    url: `${GRAPHER}/${slug}`,
    timeUnit: table.timeUnit,
    columns: joinColumns(table.columns, metadata),
    entities: [...new Set(rows.map((r) => r.entity))],
    rows,
    // Rows matching the request — which is what `truncated` and the truncation
    // note count against. The upstream total is reported separately; conflating
    // the two would claim 197 rows for a chart that returned one country.
    totalRows: selected.length,
    truncated,
    totalRowsBeforeSelection: table.rows.length,
    timeRange: timeRange(rows),
    citation: firstColumn?.citationShort ?? metadata?.chart?.citation ?? null,
    attribution: firstColumn?.citationLong ?? null,
    notes,
  };
}
