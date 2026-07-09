import { type ToolDefinition, z } from '@ontrove/mcp';
import { requireCompany } from '../client.ts';
import {
  decodeItems,
  type RecentFiling,
  recentFilings,
  withArchivedFilings,
} from '../submissions.ts';

/**
 * `company_filings` — one company's filing history, filtered, reaching into
 * the older-history archives on demand (see `submissions.ts`).
 */

export const companyFilings: ToolDefinition = {
  name: 'company_filings',
  title: 'EDGAR: Company filings',
  description:
    'List a company\'s SEC filings by ticker (e.g. "AAPL"), company name, or CIK, ' +
    'filterable by form type(s) (e.g. "10-K" or "10-K,10-Q,8-K") and filing-date ' +
    'range — full history back to 1994 (older archives are fetched on demand when ' +
    'your filters need them). Returns form type, filing date, accession number, ' +
    'primary document, and — for 8-Ks — the material-event item codes decoded to ' +
    'plain English (2.02 earnings, 5.02 officer changes, …). Filter by forms to skip ' +
    "the Form 4/144 noise that dominates most companies' feeds. Read any filing " +
    'with get_filing_document.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    company: z.string().min(1).describe('Ticker, company name, or CIK, e.g. "AAPL".'),
    forms: z
      .string()
      .optional()
      .describe('Only these comma-separated form types, e.g. "10-K,10-Q".'),
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
    limit: z.number().int().min(1).max(100).default(15).describe('Max filings (1–100).'),
  }),
  output: z.object({
    company: z.string(),
    cik: z.string(),
    matched: z.number(),
    historyComplete: z.boolean(),
    count: z.number(),
    filings: z.array(
      z.object({
        form: z.string(),
        filedDate: z.string(),
        accession: z.string(),
        primaryDocument: z.string().nullable(),
        description: z.string().nullable(),
        items: z.string().nullable(),
      }),
    ),
  }),
  async handler(args, ctx) {
    const { company, forms, startDate, endDate, limit } = args;
    ctx.log('company_filings', { company, forms, limit });
    const resolved = await requireCompany(ctx, company);
    const { name, filings: all, archives } = await recentFilings(ctx, resolved.cik);
    const displayName = name || resolved.name;
    const wanted = forms
      ? new Set(
          forms
            .split(',')
            .map((f: string) => f.trim().toUpperCase())
            .filter(Boolean),
        )
      : null;
    const isMatch = (f: RecentFiling): boolean =>
      (!wanted || wanted.has(f.form.toUpperCase())) &&
      (!startDate || f.filedDate >= startDate) &&
      (!endDate || f.filedDate <= endDate);
    const { pool, historyComplete } = await withArchivedFilings(
      ctx,
      all,
      archives,
      isMatch,
      limit,
      startDate,
      endDate,
    );
    const matching = pool
      .filter(isMatch)
      .sort((a, b) => (a.filedDate < b.filedDate ? 1 : a.filedDate > b.filedDate ? -1 : 0));
    const filings = matching.slice(0, limit).map((f) => ({
      form: f.form,
      filedDate: f.filedDate,
      accession: f.accession,
      primaryDocument: f.primaryDocument,
      description: f.description,
      items: f.items,
    }));
    if (filings.length === 0) {
      const filterNote = wanted || startDate || endDate ? ' matching those filters' : '';
      return {
        text: `No filings${filterNote} for ${displayName} (CIK ${resolved.cik}).`,
        structured: {
          company: displayName,
          cik: resolved.cik,
          matched: 0,
          historyComplete,
          count: 0,
          filings: [],
        },
      };
    }
    const lines = filings
      .map((f) => {
        const detail = decodeItems(f.items) ?? f.description;
        return `  ${f.filedDate} ${f.form}${detail ? ` — ${detail}` : ''}`;
      })
      .join('\n');
    const matchedLabel = historyComplete ? `${matching.length}` : `${matching.length}+`;
    return {
      text:
        `${displayName} (CIK ${resolved.cik}) — ${filings.length} of ${matchedLabel} ` +
        `matching filing(s):\n${lines}`,
      structured: {
        company: displayName,
        cik: resolved.cik,
        matched: matching.length,
        historyComplete,
        count: filings.length,
        filings,
      },
    };
  },
};
