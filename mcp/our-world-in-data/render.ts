import type { ChartData } from './chart.ts';

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

  const units = data.columns.map((c) => `${c.title}${c.unit ? ` (${c.unit})` : ''}`).join(' · ');
  if (units !== '') lines.push(units);

  if (data.rows.length > 0) {
    const header = [data.timeUnit === 'day' ? 'day' : 'year', ...data.columns.map((c) => c.key)];
    lines.push('', `entity, ${header.join(', ')}`);
    for (const row of data.rows.slice(0, MAX_TEXT_ROWS)) {
      lines.push(`  ${row.entity}, ${row.time}, ${row.values.map(cell).join(', ')}`);
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

  for (const note of data.notes) lines.push(`Note: ${note}`);

  // Attribution is not decoration: OWID's terms ask that the ORIGINAL data
  // providers be credited, and citationLong is the string that names them all.
  if (data.attribution) lines.push('', `Source: ${clip(data.attribution, 600)}`);
  else if (data.citation) lines.push('', `Source: ${data.citation} — via Our World in Data`);
  lines.push(`Chart: ${data.url}`);
  return lines.join('\n');
}

/** The metadata tool's structured result, as rendered here. */
export interface MetadataView {
  slug: string;
  title: string;
  subtitle: string | null;
  url: string;
  citation: string | null;
  attribution: string | null;
  nonRedistributable: boolean;
  columns: Array<{
    key: string;
    title: string;
    unit: string | null;
    timespan: string | null;
    lastUpdated: string | null;
    nextUpdate: string | null;
    description: string | null;
    processingNotes: string | null;
    indicatorId: number | null;
  }>;
  sources: Array<{
    producer: string | null;
    license: string | null;
    licenseUrl: string | null;
    citation: string | null;
    url: string | null;
    dateAccessed: string | null;
  }>;
  notes: string[];
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

/** Render chart metadata, leading with what it measures and ending with licensing. */
export function renderMetadata(view: MetadataView): string {
  const lines: string[] = [view.subtitle ? `${view.title} — ${view.subtitle}` : view.title];

  if (view.columns.length > 0) {
    lines.push('', `Measures (${String(view.columns.length)}):`);
    for (const column of view.columns) lines.push(...renderColumn(column));
  }

  if (view.sources.length > 0) lines.push(...renderSources(view.sources));

  if (view.nonRedistributable) {
    lines.push('', '⚠ This data is marked non-redistributable by its provider.');
  }
  for (const note of view.notes) lines.push(`Note: ${note}`);
  if (view.attribution) lines.push('', `Citation: ${clip(view.attribution, 600)}`);
  lines.push(`Chart: ${view.url}`);
  return lines.join('\n');
}
