import type { ChartData } from './chart.ts';
import type { IndicatorResult } from './indicator.ts';
import type { MetadataView } from './metadata.ts';

/**
 * Model-visible rendering for the two heavyweight tools.
 *
 * The structured payload is the machine contract; this is what the model reads.
 * Two rules shape it: numbers are never reformatted (a rounded figure that
 * disagrees with `structured` is worse than a long one), and the licensing
 * line is always present, because most of what OWID serves belongs to somebody
 * else and the citation is the condition of using it.
 */

/**
 * How many data rows are spelled out in the model-visible text.
 *
 * The structured payload still carries every row the caller asked for; this
 * bounds only the prose mirror. Printing all of them twice is what turns a
 * legitimate `max_rows` into a context bomb — 275 rows of a six-column chart
 * already costs ~12k tokens across both halves.
 */
const MAX_TEXT_ROWS = 60;

/** Truncate for a one-line summary without cutting mid-word where avoidable. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A cell as it should read to a model: numbers verbatim, gaps explicit. */
function cell(value: number | string | null): string {
  return value === null ? 'n/a' : String(value);
}

/** Render chart data as a compact fixed-column table. */
export function renderData(data: ChartData): string {
  const lines: string[] = [];
  const heading = data.subtitle ? `${data.title} — ${data.subtitle}` : data.title;
  lines.push(clip(heading, 200));

  // Caveats FIRST. A note like "these rows are outside the range you asked
  // for" changes how the whole table must be read; printed under sixty rows of
  // numbers it arrives after the reader has already drawn a conclusion.
  for (const note of data.notes) lines.push(`⚠ ${note}`);

  if (data.rows.length > 0) {
    // Each column carries its own unit. The alternative — a units line above a
    // header of bare short names — asks the reader to zip two lists by index,
    // and getting that wrong attaches the wrong unit to a real number.
    const header = [
      data.timeUnit === 'day' ? 'day' : 'year',
      ...data.columns.map((c) => `${c.title}${c.unit ? ` [${c.unit}]` : ''}`),
    ];
    // Pipe-separated: entity names and indicator titles both contain commas.
    lines.push('', `entity | ${header.join(' | ')}`);
    for (const row of data.rows.slice(0, MAX_TEXT_ROWS)) {
      lines.push(`  ${row.entity} | ${row.time} | ${row.values.map(cell).join(' | ')}`);
    }
    if (data.rows.length > MAX_TEXT_ROWS) {
      lines.push(
        `  … ${String(data.rows.length - MAX_TEXT_ROWS)} more row(s) — all ${String(data.rows.length)} are in this tool's structured output.`,
      );
    }
    const shown = String(data.rows.length);
    const total = data.truncated ? ` of ${String(data.totalRows)}` : '';
    lines.push('', `${shown}${total} row(s) across ${String(data.entities.length)} entities.`);
  } else {
    lines.push('', 'No rows returned.');
  }

  // Attribution is not decoration: OWID's terms ask that the ORIGINAL data
  // providers be credited, and citationLong is the string that names them all.
  if (data.attribution) lines.push('', `Source: ${clip(data.attribution, 1200)}`);
  else if (data.citation) lines.push('', `Source: ${data.citation} — via Our World in Data`);
  lines.push(`Chart: ${data.url}`);
  lines.push(`Full dataset (all entities and years, CSV): ${data.downloads.csv}`);
  return lines.join('\n');
}

/**
 * Render one indicator's observations.
 *
 * Narrower than a chart table — a single variable, so one value column and the
 * unit stated once in the heading rather than repeated per row.
 */
export function renderIndicator(result: IndicatorResult): string {
  const lines: string[] = [`${result.title}${result.unit ? ` — ${result.unit}` : ''}`];
  if (result.description) lines.push(clip(result.description, 300));
  const facts = [
    `indicator #${String(result.indicatorId)}`,
    result.datasetName ? `dataset: ${result.datasetName}` : '',
    result.timespan ? `covers ${result.timespan}` : '',
  ].filter((f) => f !== '');
  lines.push(facts.join(' · '));

  for (const note of result.notes) lines.push(`⚠ ${note}`);

  lines.push(...indicatorTable(result));

  if (result.attribution) lines.push('', `Source: ${clip(result.attribution, 600)}`);
  else if (result.citation) lines.push('', `Source: ${result.citation}`);
  if (result.parquetUrl) {
    lines.push(
      `Whole series as Parquet (DuckDB reads it in place): ${result.parquetUrl}${result.parquetColumn ? ` · column ${result.parquetColumn}` : ''}`,
    );
  }
  return lines.join('\n');
}

/** The observation table for one indicator, or a plain statement that there is none. */
function indicatorTable(result: IndicatorResult): string[] {
  if (result.rows.length === 0) return ['', 'No observations returned.'];
  const lines = ['', `entity | year | value${result.unit ? ` [${result.unit}]` : ''}`];
  for (const row of result.rows.slice(0, MAX_TEXT_ROWS)) {
    lines.push(`  ${row.entity} | ${row.time} | ${cell(row.value)}`);
  }
  if (result.rows.length > MAX_TEXT_ROWS) {
    lines.push(
      `  … ${String(result.rows.length - MAX_TEXT_ROWS)} more — all ${String(result.rows.length)} are in this tool's structured output.`,
    );
  }
  lines.push(
    '',
    `${String(result.rows.length)}${result.truncated ? ` of ${String(result.totalRows)}` : ''} observation(s) across ${String(result.entities.length)} entities.`,
  );
  return lines;
}

/** One indicator's block: what it measures, in what units, over what period. */
function renderColumn(column: MetadataView['columns'][number]): string[] {
  const lines = [`• ${column.title}${column.unit ? ` — ${column.unit}` : ''}`];
  if (column.description) lines.push(`    ${clip(column.description, 300)}`);
  const facts = [
    column.timespan ? `covers ${column.timespan}` : '',
    column.lastUpdated ? `updated ${column.lastUpdated}` : '',
    column.nextUpdate ? `next ${column.nextUpdate}` : '',
    column.indicatorId === null ? '' : `indicator #${String(column.indicatorId)}`,
  ].filter((f) => f !== '');
  if (facts.length > 0) lines.push(`    ${facts.join(' · ')}`);
  if (column.processingNotes) {
    lines.push(`    Processing: ${clip(column.processingNotes.replaceAll('\n', ' '), 300)}`);
  }
  return lines;
}

/**
 * The provenance block: who produced each number, and under what licence.
 *
 * The closing sentence is the one thing a caller must not miss. OWID's own
 * terms put it plainly — most of the data is somebody else's, and their licence
 * governs, not OWID's CC BY.
 */
function renderSources(sources: MetadataView['sources']): string[] {
  const lines = ['', `Data sources (${String(sources.length)}):`];
  for (const source of sources) {
    lines.push(
      `• ${source.producer ?? 'Unknown producer'} — ${source.license ?? 'licence not stated'}`,
    );
    if (source.citation) lines.push(`    ${clip(source.citation, 300)}`);
    const links = [source.url, source.licenseUrl].filter((link): link is string => Boolean(link));
    if (links.length > 0) lines.push(`    ${links.join(' · ')}`);
  }
  lines.push(
    '',
    'Most Our World in Data figures are third-party: check each producer’s licence above before republishing, and cite both the producer and OWID.',
  );
  return lines;
}

/**
 * Where to get the data itself.
 *
 * The point of naming these is that a caller wanting the whole dataset should
 * fetch or query it directly rather than asking this server to page thousands
 * of rows through a context window. DuckDB reads the Parquet over HTTP without
 * downloading it: `SELECT country, year, <column> FROM '<parquet url>'`.
 */
function renderDownloads(view: MetadataView): string[] {
  const lines = ['Get the data:', `  Full CSV (all entities and years): ${view.downloads.csv}`];
  const tables = new Map<string, string[]>();
  for (const column of view.columns) {
    if (!column.parquetUrl) continue;
    const columns = tables.get(column.parquetUrl) ?? [];
    if (column.parquetColumn) columns.push(column.parquetColumn);
    tables.set(column.parquetUrl, columns);
  }
  for (const [url, columns] of tables) {
    lines.push(`  Parquet (DuckDB-queryable in place): ${url}`);
    if (columns.length > 0) lines.push(`    columns: ${columns.join(', ')}`);
  }
  lines.push(`  CSV + metadata + README, zipped: ${view.downloads.zip}`);
  lines.push(`  Chart: ${view.url}`);
  return lines;
}

/** Render chart metadata, leading with what it measures and ending with licensing. */
export function renderMetadata(view: MetadataView): string {
  const lines: string[] = [view.subtitle ? `${view.title} — ${view.subtitle}` : view.title];

  // Whether the data can be fetched at all decides what the caller does next,
  // so it goes above the provenance rather than below it.
  if (view.nonRedistributable) {
    lines.push(
      '⚠ Marked non-redistributable by its provider: get_chart_data will refuse this chart. The chart itself stays viewable on Our World in Data.',
    );
  }
  for (const note of view.notes) lines.push(`⚠ ${note}`);

  if (view.columns.length > 0) {
    lines.push('', `Measures (${String(view.columns.length)}):`);
    for (const column of view.columns) lines.push(...renderColumn(column));
  }

  if (view.sources.length > 0) lines.push(...renderSources(view.sources));

  if (view.attribution) lines.push('', `Citation: ${clip(view.attribution, 1200)}`);
  lines.push('', ...renderDownloads(view));
  return lines.join('\n');
}
