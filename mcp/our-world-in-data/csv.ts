/**
 * CSV parsing for the Our World in Data chart endpoint.
 *
 * OWID serves chart data as RFC 4180 CSV. The shape is *nearly* fixed —
 * `entity, code, <time>, <value…>` — but three details move, and each one has
 * a wrong-looking-but-plausible failure mode if assumed away:
 *
 *  - the **time column is `year` OR `day`** (daily series such as
 *    `covid-cases` use `day` with `YYYY-MM-DD` values);
 *  - the **`code` column is absent** whenever no returned row has an entity
 *    code — including the zero-row response, whose header is the bare
 *    `Entity,Year,<value>`; and
 *  - header **case follows `useColumnShortNames`**: lowercase (`entity`) when
 *    it is on, title case (`Entity`) when it is off — and that applies to the
 *    fixed columns too, not just the value columns.
 *
 * So columns are located by name, case-insensitively, and never by position.
 */

/** One parsed data row: the entity, its code (when present), and one value per column. */
export interface CsvRow {
  entity: string;
  code: string | null;
  /** The `year` (as a string) or the `day` (`YYYY-MM-DD`), verbatim from the CSV. */
  time: string;
  /** Value per value-column key, in the column order of {@link CsvTable.columns}. */
  values: Array<number | string | null>;
}

/** A parsed OWID chart CSV. */
export interface CsvTable {
  /** Which time column the CSV carried. */
  timeUnit: 'year' | 'day';
  /** The value-column keys, in CSV order (short names when requested). */
  columns: string[];
  rows: CsvRow[];
}

/**
 * Split CSV text into rows of fields (RFC 4180: `""` escapes a quote, quoted
 * fields may contain commas and newlines).
 *
 * The unquoted fast path is not premature: a filtered chart CSV is routinely
 * tens of kilobytes and an unfiltered one reaches megabytes, and OWID quotes a
 * field only when an entity name contains a comma — so the scan-per-character
 * branch is the rare case, not the common one.
 */
export function parseCsv(text: string): string[][] {
  // A BOM would otherwise ride along inside the first header cell, so `entity`
  // silently stops matching and every column looks missing.
  const input = text.charCodeAt(0) === 0xfe_ff ? text.slice(1) : text;
  if (input === '') return [];
  if (!input.includes('"')) {
    return input
      .split('\n')
      .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
      .filter((line) => line !== '')
      .map((line) => line.split(','));
  }
  return parseQuotedCsv(input);
}

/** Scanner state for {@link parseQuotedCsv}. */
interface ScanState {
  rows: string[][];
  row: string[];
  field: string;
  quoted: boolean;
  /** Whether any field has been started on the current row. */
  dirty: boolean;
}

function endField(state: ScanState): void {
  state.row.push(state.field);
  state.field = '';
  state.dirty = true;
}

function endRow(state: ScanState): void {
  endField(state);
  // A blank line is structure, not a record with one empty field.
  if (state.row.length > 1 || state.row[0] !== '') state.rows.push(state.row);
  state.row = [];
  state.dirty = false;
}

/** Consume one character outside a quoted field. */
function scanPlain(state: ScanState, ch: string): void {
  if (ch === '"') state.quoted = true;
  else if (ch === ',') endField(state);
  else if (ch === '\n') endRow(state);
  else if (ch !== '\r') state.field += ch;
}

/**
 * Consume one character inside a quoted field. Returns how many EXTRA
 * characters were taken (1 for the second half of an escaped `""`).
 */
function scanQuoted(state: ScanState, ch: string, next: string): number {
  if (ch !== '"') {
    state.field += ch;
    return 0;
  }
  if (next === '"') {
    state.field += '"';
    return 1;
  }
  state.quoted = false;
  return 0;
}

/** The full RFC 4180 scanner, used only when the body actually contains quotes. */
function parseQuotedCsv(input: string): string[][] {
  const state: ScanState = { rows: [], row: [], field: '', quoted: false, dirty: false };
  for (let i = 0; i < input.length; i++) {
    const ch = input.charAt(i);
    if (state.quoted) i += scanQuoted(state, ch, input.charAt(i + 1));
    else scanPlain(state, ch);
  }
  if (state.dirty || state.field !== '') endRow(state);
  return state.rows;
}

/** Index of the first header equal to one of `names`, case-insensitively; -1 if absent. */
function headerIndex(header: string[], names: string[]): number {
  return header.findIndex((h) => names.includes(h.trim().toLowerCase()));
}

/**
 * Parse a numeric cell. OWID leaves a missing observation as an empty cell, and
 * carries genuinely non-numeric indicators (categorical/ordinal series) as
 * text — so a cell that will not parse is kept as its string rather than
 * being coerced to a misleading `0` or silently dropped.
 */
function parseCell(raw: string): number | string | null {
  const value = raw.trim();
  if (value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

/**
 * Shape an OWID chart CSV into typed rows.
 *
 * Returns `undefined` when the body is not an OWID chart CSV at all (no header,
 * or no recognisable time column) — the caller reports that as an upstream
 * problem rather than as an empty result, which would read as "no data".
 */
export function parseChartCsv(text: string): CsvTable | undefined {
  const raw = parseCsv(text);
  const header = raw[0];
  if (!header || header.length === 0) return undefined;
  const layout = readLayout(header);
  if (!layout) return undefined;
  return {
    timeUnit: layout.timeUnit,
    columns: layout.valueIndexes.map((i) => header[i]?.trim() ?? ''),
    rows: buildRows(raw, header.length, layout),
  };
}

/** Where each meaningful column sits in the header. */
interface Layout {
  entityIndex: number;
  codeIndex: number;
  timeIndex: number;
  timeUnit: 'year' | 'day';
  valueIndexes: number[];
}

/** Locate the fixed and value columns, or `undefined` if this is not a chart CSV. */
function readLayout(header: string[]): Layout | undefined {
  const entityIndex = headerIndex(header, ['entity']);
  const codeIndex = headerIndex(header, ['code']);
  const yearIndex = headerIndex(header, ['year']);
  const timeIndex = yearIndex === -1 ? headerIndex(header, ['day']) : yearIndex;
  if (entityIndex === -1 || timeIndex === -1) return undefined;
  const fixed = new Set([entityIndex, codeIndex, timeIndex]);
  return {
    entityIndex,
    codeIndex,
    timeIndex,
    timeUnit: yearIndex === -1 ? 'day' : 'year',
    valueIndexes: header.map((_, i) => i).filter((i) => !fixed.has(i)),
  };
}

function buildRows(raw: string[][], width: number, layout: Layout): CsvRow[] {
  const rows: CsvRow[] = [];
  for (const cells of raw.slice(1)) {
    // A short row is a truncated line, not a row of nulls: emitting it would
    // invent missing observations that the upstream never reported.
    if (cells.length !== width) continue;
    const code = layout.codeIndex === -1 ? '' : (cells[layout.codeIndex]?.trim() ?? '');
    rows.push({
      entity: cells[layout.entityIndex]?.trim() ?? '',
      code: code === '' ? null : code,
      time: cells[layout.timeIndex]?.trim() ?? '',
      values: layout.valueIndexes.map((i) => parseCell(cells[i] ?? '')),
    });
  }
  return rows;
}
