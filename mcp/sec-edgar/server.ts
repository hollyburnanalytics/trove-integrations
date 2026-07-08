import { defineMcpServer, type ToolContext, ToolError, z } from '@ontrove/mcp';
import { type GetJsonOptions, getJson } from '../lib/http.ts';

/**
 * SEC EDGAR — a no-auth hosted MCP server over the public SEC EDGAR APIs.
 * Two read-only surfaces:
 *  - `search_filings` — full-text search across filings (efts.sec.gov), and
 *  - `company_filings` — a company's recent filings, by ticker or CIK.
 *
 * No API key, but the SEC requires a descriptive User-Agent on every request —
 * sent on each call. Hosts: efts (full-text), www.sec.gov (ticker map),
 * data.sec.gov (submissions).
 */

/**
 * SEC-required descriptive User-Agent (their fair-access policy). SEC blocks
 * non-deliverable contacts — including GitHub `noreply` addresses — with a 403,
 * so this must stay a real, monitored operator inbox.
 */
const CONTACT_EMAIL = 'sec-edgar@ontrove.sh';
const USER_AGENT = `Trove MCP (${CONTACT_EMAIL})`;

/**
 * Shared options for every EDGAR request: send the SEC-required UA explicitly
 * (SEC 403s without a real contact UA, so we never rely on the default), and
 * map a 404 to "no record" (non-retryable); other non-2xx and malformed JSON
 * fall back to the SDK's default retryable mapping.
 */
const EDGAR_OPTIONS: GetJsonOptions = {
  service: 'SEC EDGAR',
  headers: { 'user-agent': USER_AGENT },
  errorMap: (res) =>
    res.status === 404
      ? new ToolError('SEC EDGAR has no record for that identifier.', { retryable: false })
      : undefined,
};

/** Resolve a ticker (or already-numeric CIK) to a 10-digit zero-padded CIK. */
async function resolveCik(
  query: string,
  ctx: Pick<ToolContext, 'fetchJson'>,
): Promise<{ cik: string; name: string } | null> {
  const trimmed = query.trim();
  if (/^\d{1,10}$/.test(trimmed)) {
    return { cik: trimmed.padStart(10, '0'), name: '' };
  }
  const map = await getJson('https://www.sec.gov/files/company_tickers.json', ctx, EDGAR_OPTIONS);
  const target = trimmed.toUpperCase();
  for (const value of Object.values(map)) {
    const o = value as { cik_str?: unknown; ticker?: unknown; title?: unknown };
    if (typeof o.ticker === 'string' && o.ticker.toUpperCase() === target) {
      return {
        cik: String(o.cik_str ?? '').padStart(10, '0'),
        name: typeof o.title === 'string' ? o.title : '',
      };
    }
  }
  return null;
}

export default defineMcpServer({
  tools: [
    {
      name: 'search_filings',
      title: 'EDGAR: Search filings',
      description:
        'Full-text search across SEC filings (2001–present). Optionally restrict by ' +
        'form type(s) (e.g. "10-K", "8-K", "10-K,10-Q") and a date range. Returns the ' +
        'company, form, filing date, and accession number for each hit.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        query: z.string().min(1).describe('Search text, e.g. "climate risk" or a company name.'),
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
      }),
      output: z.object({
        query: z.string(),
        total: z.number(),
        count: z.number(),
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
        const { query, forms, startDate, endDate } = args;
        ctx.log('search_filings', { query, forms });
        const params = new URLSearchParams({ q: query });
        if (forms) params.set('forms', forms);
        if (startDate || endDate) {
          // EDGAR's full-text search uses dateRange=custom with either bound
          // optional; previously a lone startDate/endDate was silently dropped.
          params.set('dateRange', 'custom');
          if (startDate) params.set('startdt', startDate);
          if (endDate) params.set('enddt', endDate);
        }
        const body = await getJson(
          `https://efts.sec.gov/LATEST/search-index?${params}`,
          ctx,
          EDGAR_OPTIONS,
        );
        const hits = (body.hits ?? {}) as Record<string, unknown>;
        const rawHits = Array.isArray(hits.hits) ? hits.hits : [];
        const total = (() => {
          const t = (hits.total ?? {}) as { value?: unknown };
          return typeof t.value === 'number' ? t.value : rawHits.length;
        })();
        const filings = rawHits.map((h) => {
          const hit = h as { _id?: unknown; _source?: unknown };
          const src = (hit._source ?? {}) as Record<string, unknown>;
          const names = Array.isArray(src.display_names) ? src.display_names : [];
          return {
            company: typeof names[0] === 'string' ? names[0] : '?',
            // `form` is the filing form (e.g. 10-K); `file_type` is the exhibit
            // type (e.g. EX-21.1). Prefer the form, fall back to the exhibit.
            form:
              typeof src.form === 'string'
                ? src.form
                : typeof src.file_type === 'string'
                  ? src.file_type
                  : '?',
            filedDate: typeof src.file_date === 'string' ? src.file_date : '?',
            accession: typeof hit._id === 'string' ? (hit._id.split(':')[0] ?? '') : '',
          };
        });
        if (filings.length === 0) {
          return {
            text: `No EDGAR filings matching "${query}".`,
            structured: { query, total: 0, count: 0, filings: [] },
          };
        }
        const lines = filings
          .map((f) => `  ${f.filedDate} ${f.form} — ${f.company} [${f.accession}]`)
          .join('\n');
        return {
          text: `${filings.length} of ${total} filing(s) for "${query}":\n${lines}`,
          structured: { query, total, count: filings.length, filings },
        };
      },
    },
    {
      name: 'company_filings',
      title: 'EDGAR: Company filings',
      description:
        'List a company\'s most recent SEC filings by ticker (e.g. "AAPL") or CIK. ' +
        'Returns form type, filing date, accession number, and primary document.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        company: z.string().min(1).describe('Ticker symbol or CIK, e.g. "AAPL" or "320193".'),
        limit: z.number().int().min(1).max(40).default(15).describe('Max filings (1–40).'),
      }),
      output: z.object({
        company: z.string(),
        cik: z.string(),
        count: z.number(),
        filings: z.array(
          z.object({
            form: z.string(),
            filedDate: z.string(),
            accession: z.string(),
            primaryDocument: z.string().nullable(),
            description: z.string().nullable(),
          }),
        ),
      }),
      async handler(args, ctx) {
        const { company, limit } = args;
        ctx.log('company_filings', { company, limit });
        const resolved = await resolveCik(company, ctx);
        if (!resolved) {
          throw new ToolError(`No SEC company found for "${company}" (try a ticker or CIK).`, {
            retryable: false,
          });
        }
        const body = await getJson(
          `https://data.sec.gov/submissions/CIK${resolved.cik}.json`,
          ctx,
          EDGAR_OPTIONS,
        );
        const name = typeof body.name === 'string' ? body.name : resolved.name;
        const recent = ((body.filings ?? {}) as Record<string, unknown>).recent as
          | Record<string, unknown>
          | undefined;
        const forms = Array.isArray(recent?.form) ? recent.form : [];
        const dates = Array.isArray(recent?.filingDate) ? recent.filingDate : [];
        const accs = Array.isArray(recent?.accessionNumber) ? recent.accessionNumber : [];
        const docs = Array.isArray(recent?.primaryDocument) ? recent.primaryDocument : [];
        const descs = Array.isArray(recent?.primaryDocDescription)
          ? recent.primaryDocDescription
          : [];
        const filings = forms.slice(0, limit).map((f, i) => ({
          form: typeof f === 'string' ? f : '?',
          filedDate: typeof dates[i] === 'string' ? (dates[i] as string) : '?',
          accession: typeof accs[i] === 'string' ? (accs[i] as string) : '',
          primaryDocument: typeof docs[i] === 'string' ? (docs[i] as string) : null,
          description: typeof descs[i] === 'string' && descs[i] ? (descs[i] as string) : null,
        }));
        if (filings.length === 0) {
          return {
            text: `No recent filings for ${name} (CIK ${resolved.cik}).`,
            structured: { company: name, cik: resolved.cik, count: 0, filings: [] },
          };
        }
        const lines = filings
          .map((f) => `  ${f.filedDate} ${f.form}${f.description ? ` — ${f.description}` : ''}`)
          .join('\n');
        return {
          text: `${name} (CIK ${resolved.cik}) — ${filings.length} recent filing(s):\n${lines}`,
          structured: { company: name, cik: resolved.cik, count: filings.length, filings },
        };
      },
    },
  ],
});
