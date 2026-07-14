import { ToolError } from '@ontrove/mcp';

/**
 * Compose an arXiv `search_query` from the structured search params (or a raw
 * expression), including date-range normalization to arXiv's YYYYMMDD form and
 * the sort-key mapping. See the field-scoping and date-window feedback points.
 */

// ---------------------------------------------------------------------------
// Search query building (feedback pts 3, 4)
// ---------------------------------------------------------------------------

export const SORT_BY = {
  relevance: 'relevance',
  lastUpdated: 'lastUpdatedDate',
  submitted: 'submittedDate',
} as const;

function invalidDate(input: string): ToolError {
  return new ToolError(`Could not parse the date "${input}". Use YYYY, YYYY-MM, or YYYY-MM-DD.`, {
    retryable: false,
  });
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Normalize a date input ("2026", "2026-03", "20260315") to arXiv's YYYYMMDD. */
function toArxivDate(input: string, end: boolean): string {
  const digits = input.replace(/[^0-9]/g, '');
  if (![4, 6, 8].includes(digits.length)) throw invalidDate(input);

  const year = Number.parseInt(digits.slice(0, 4), 10);
  const month = digits.length >= 6 ? Number.parseInt(digits.slice(4, 6), 10) : end ? 12 : 1;
  const day =
    digits.length === 8
      ? Number.parseInt(digits.slice(6, 8), 10)
      : end
        ? daysInMonth(year, month)
        : 1;
  const maxDay = daysInMonth(year, month);

  if (year < 1 || month < 1 || month > 12 || day < 1 || day > maxDay) {
    throw invalidDate(input);
  }

  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}${mm}${dd}`;
}

export interface SearchInput {
  query?: string;
  title?: string;
  abstract?: string;
  author?: string;
  category?: string;
  fromDate?: string;
  toDate?: string;
  advanced?: string;
}

/**
 * arXiv's own query grammar, as it appears in a `query` that was meant to be one:
 * a field prefix (`ti:`, `abs:`, `au:`, `cat:`, `all:`, …) or a boolean operator.
 */
const ARXIV_GRAMMAR = /(^|\s|\()(ti|abs|au|cat|all|co|jr|rn|id):|\s(AND|OR|ANDNOT)\s/;

/** Compose an arXiv `search_query` from the structured params (or a raw expression). */
export function buildSearchQuery(input: SearchInput): string {
  // Power users can pass arXiv's native grammar (ti:, abs:, AND/OR/ANDNOT).
  // Spaces become `+` so operators like " AND " read as the literal `+AND+`.
  if (input.advanced?.trim()) return input.advanced.trim().replace(/\s+/g, '+');

  // A `query` that is ALREADY arXiv grammar is treated as one.
  //
  // `query` wraps its input in `all:` and percent-encodes it, so a caller who
  // reasonably types `ti:Kafka` — the syntax arXiv itself documents — sends
  // `all:ti%3AKafka`, and arXiv answers 400. The tool then said only "arXiv
  // rejected the search query", which is true, unhelpful, and blames the wrong
  // party: the caller wrote a perfectly good arXiv query and we mangled it.
  //
  // Two people fell into this on the same afternoon, which makes it the tool's
  // fault rather than theirs. Recognise the grammar and do what they meant.
  if (input.query && ARXIV_GRAMMAR.test(input.query)) {
    return input.query.trim().replace(/\s+/g, '+');
  }

  const enc = (v: string): string => encodeURIComponent(v);
  const parts: string[] = [];
  if (input.query) parts.push(`all:${enc(input.query)}`);
  if (input.title) parts.push(`ti:${enc(input.title)}`);
  if (input.abstract) parts.push(`abs:${enc(input.abstract)}`);
  if (input.author) parts.push(`au:${enc(input.author)}`);
  if (input.category) parts.push(`cat:${enc(input.category)}`);
  if (input.fromDate || input.toDate) {
    const lo = input.fromDate ? toArxivDate(input.fromDate, false) : '19910101';
    const hi = input.toDate ? toArxivDate(input.toDate, true) : '20991231';
    parts.push(`submittedDate:[${lo}+TO+${hi}]`);
  }
  if (parts.length === 0) {
    throw new ToolError(
      'Provide at least one of: query, title, abstract, author, category, from_date/to_date, or advanced.',
      { retryable: false },
    );
  }
  return parts.join('+AND+');
}
