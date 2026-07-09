import { type ToolDefinition, z } from '@ontrove/mcp';
import { edgarJson, requireCompany } from '../client.ts';

/**
 * `search_filings` — EDGAR full-text search (efts.sec.gov), deduped to one
 * row per filing.
 */

/** One row of full-text search output. */
interface SearchFiling {
  company: string;
  form: string;
  filedDate: string;
  accession: string;
}

/** Turn one efts hit's `_source` into a search-filing row. */
function toSearchFiling(src: Record<string, unknown>, accession: string): SearchFiling {
  const names = Array.isArray(src.display_names) ? src.display_names : [];
  // `form` is the filing form (e.g. 10-K); `file_type` is the exhibit
  // type (e.g. EX-21.1). Prefer the form, fall back to the exhibit.
  let form = '?';
  if (typeof src.form === 'string') form = src.form;
  else if (typeof src.file_type === 'string') form = src.file_type;
  return {
    company: typeof names[0] === 'string' ? names[0] : '?',
    form,
    filedDate: typeof src.file_date === 'string' ? src.file_date : '?',
    accession,
  };
}

/**
 * Parse efts.sec.gov search hits into filings. One filing exposes many
 * matching documents (the filing itself plus exhibits), so hits are deduped
 * to one row per accession number.
 */
function parseSearchHits(rawHits: unknown[]): SearchFiling[] {
  const seen = new Set<string>();
  const filings: SearchFiling[] = [];
  for (const h of rawHits) {
    const hit = h as { _id?: unknown; _source?: unknown };
    const accession = typeof hit._id === 'string' ? (hit._id.split(':')[0] ?? '') : '';
    if (accession && seen.has(accession)) continue;
    seen.add(accession);
    filings.push(toSearchFiling((hit._source ?? {}) as Record<string, unknown>, accession));
  }
  return filings;
}

/** Build the efts.sec.gov query string from resolved search arguments. */
function buildSearchParams(opts: {
  query: string;
  cik: string | null;
  forms?: string;
  startDate?: string;
  endDate?: string;
  from: number;
}): URLSearchParams {
  const params = new URLSearchParams({ q: opts.query });
  if (opts.cik) params.set('ciks', opts.cik);
  if (opts.forms) params.set('forms', opts.forms);
  if (opts.startDate || opts.endDate) {
    // EDGAR's full-text search uses dateRange=custom with either bound
    // optional; previously a lone startDate/endDate was silently dropped.
    params.set('dateRange', 'custom');
    if (opts.startDate) params.set('startdt', opts.startDate);
    if (opts.endDate) params.set('enddt', opts.endDate);
  }
  if (opts.from > 0) params.set('from', String(opts.from));
  return params;
}

export const searchFilings: ToolDefinition = {
  name: 'search_filings',
  title: 'EDGAR: Search filings',
  description:
    'Full-text search across SEC filings (2001–present). Optionally scope to one ' +
    'company (ticker/name/CIK), restrict by form type(s) (e.g. "10-K", "8-K", ' +
    '"10-K,10-Q") and a date range, and page with `from`. Matches filings that ' +
    'merely mention the terms — scope by company for precision. Returns company, ' +
    'form, filing date, and accession number per hit, deduped by filing. Read any ' +
    'result with get_filing_document.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    query: z.string().min(1).describe('Search text, e.g. "climate risk" or "supply chain".'),
    company: z.string().optional().describe('Restrict to one filer: ticker, company name, or CIK.'),
    forms: z.string().optional().describe('Comma-separated form types, e.g. "10-K,10-Q".'),
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('Earliest filing date YYYY-MM-DD.'),
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('Latest filing date YYYY-MM-DD.'),
    from: z
      .number()
      .int()
      .min(0)
      .max(9_990)
      .default(0)
      .describe('Result offset for pagination; pass the returned nextFrom.'),
  }),
  output: z.object({
    query: z.string(),
    cik: z.string().nullable(),
    total: z.number(),
    count: z.number(),
    from: z.number(),
    nextFrom: z.number().nullable(),
    filings: z.array(
      z.object({
        company: z.string(),
        form: z.string(),
        filedDate: z.string(),
        accession: z.string(),
      }),
    ),
  }),
  async handler(args, ctx) {
    const { query, company, forms, startDate, endDate, from } = args;
    ctx.log('search_filings', { query, company, forms, from });
    let cik: string | null = null;
    if (company) {
      const resolved = await requireCompany(ctx, company);
      cik = resolved.cik;
    }
    const params = buildSearchParams({ query, cik, forms, startDate, endDate, from });
    const body = await edgarJson(
      ctx,
      `https://efts.sec.gov/LATEST/search-index?${params}`,
      'SEC EDGAR full-text search rejected that query.',
    );
    const hits = (body.hits ?? {}) as Record<string, unknown>;
    const rawHits = Array.isArray(hits.hits) ? hits.hits : [];
    const totalRaw = ((hits.total ?? {}) as { value?: unknown }).value;
    const total = typeof totalRaw === 'number' ? totalRaw : rawHits.length;
    const filings = parseSearchHits(rawHits);
    const consumed = from + rawHits.length;
    const nextFrom = rawHits.length > 0 && consumed < Math.min(total, 10_000) ? consumed : null;
    if (filings.length === 0) {
      return {
        text: `No EDGAR filings matching "${query}".`,
        structured: { query, cik, total: 0, count: 0, from, nextFrom: null, filings: [] },
      };
    }
    const lines = filings
      .map((f) => `  ${f.filedDate} ${f.form} — ${f.company} [${f.accession}]`)
      .join('\n');
    const more = nextFrom !== null ? `\n(more — call again with from=${nextFrom})` : '';
    return {
      text: `${filings.length} of ${total} filing(s) for "${query}":\n${lines}${more}`,
      structured: { query, cik, total, count: filings.length, from, nextFrom, filings },
    };
  },
};
