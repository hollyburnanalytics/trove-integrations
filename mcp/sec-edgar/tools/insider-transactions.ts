import { type ToolContext, type ToolDefinition, ToolError, z } from '@ontrove/mcp';
import { edgarDocument, filingDirUrl, fmtMoney, requireCompany, resolveOwner } from '../client.ts';
import { listFilingDocuments } from '../documents.ts';
import {
  type InsiderSummary,
  type InsiderTransaction,
  type OwnershipFiling,
  parseOwnershipXml,
  summarizeOpenMarket,
} from '../ownership.ts';
import { type RecentFiling, recentFilings } from '../submissions.ts';

/**
 * `insider_transactions` — decoded Form 3/4/5 activity by company or by
 * person (see `ownership.ts` for the parsing and summary rules).
 */

/** Fetch and parse one ownership filing's XML (primary doc, XSL prefix stripped). */
async function fetchOwnership(
  ctx: ToolContext,
  cik: string,
  filing: RecentFiling,
): Promise<OwnershipFiling | null> {
  let name = filing.primaryDocument?.split('/').pop() ?? null;
  if (!name?.endsWith('.xml')) {
    const entries = await listFilingDocuments(ctx, cik, filing.accession);
    name = entries.find((entry) => entry.extension === 'xml')?.name ?? null;
  }
  if (!name) return null;
  const xml = await edgarDocument(
    ctx,
    `${filingDirUrl(cik, filing.accession)}/${name}`,
    `Ownership document missing for ${filing.accession}.`,
  );
  return parseOwnershipXml(xml);
}

/** "+30,104 shares @ $255.30 ($7.69M)" one-liner for a transaction. */
function renderTransaction(txn: InsiderTransaction): string {
  const sign = txn.acquiredDisposed === 'D' ? '-' : '+';
  const shares = txn.shares === null ? '?' : `${sign}${txn.shares.toLocaleString('en-US')}`;
  const price = txn.pricePerShare === null ? '' : ` @ $${txn.pricePerShare.toFixed(2)}`;
  const value = txn.value === null || txn.value === 0 ? '' : ` (${fmtMoney(txn.value, 'USD')})`;
  const label = txn.codeDescription ?? txn.code ?? '?';
  return `${label}: ${shares}${txn.derivative ? ' (derivative)' : ''}${price}${value}`;
}

/** One decoded ownership filing as returned in the `filings` array. */
interface FilingRow {
  form: string;
  filedDate: string;
  accession: string;
  issuer: string | null;
  issuerTicker: string | null;
  owners: string[];
  officerTitle: string | null;
  isDirector: boolean;
  isOfficer: boolean;
  isTenPercentOwner: boolean;
  periodOfReport: string | null;
  planned10b5One: boolean;
  transactions: InsiderTransaction[];
}

/** Render one filing block: a header line plus its indented transaction list. */
function formatFilingRow(row: FilingRow, byOwner: boolean): string {
  const role = row.officerTitle ?? (row.isDirector ? 'Director' : null);
  // By-owner reads list the issuer per filing; by-company reads the insider.
  const head = byOwner
    ? `${row.issuer ?? '?'}${row.issuerTicker ? ` (${row.issuerTicker})` : ''}`
    : `${row.owners.join(' / ') || '?'}${role ? ` (${role})` : ''}`;
  const txns =
    row.transactions.length > 0
      ? row.transactions.map((t) => `    ${renderTransaction(t)}`).join('\n')
      : '    (no transactions — holdings-only report)';
  const plan = row.planned10b5One ? ' [10b5-1 plan]' : '';
  return `  ${row.filedDate} ${row.form} — ${head}${plan}\n${txns}`;
}

/** One-line open-market buy/sell recap with net share direction. */
function formatOpenMarketSummary(summary: InsiderSummary): string {
  const net =
    summary.netShares === 0
      ? 'net flat'
      : summary.netShares > 0
        ? `net +${summary.netShares.toLocaleString('en-US')} shares bought`
        : `net ${summary.netShares.toLocaleString('en-US')} shares sold`;
  return (
    `Open-market summary across these filings: ${summary.openMarketPurchases.transactions} ` +
    `buy(s) (${fmtMoney(summary.openMarketPurchases.value, 'USD')}), ` +
    `${summary.openMarketSales.transactions} sale(s) ` +
    `(${fmtMoney(summary.openMarketSales.value, 'USD')}) — ${net}.`
  );
}

/**
 * Resolve which CIK's filing feed to walk. The owner's own CIK indexes their
 * Form 4s too, so it is the subject when given (optionally filtered to one
 * issuer); otherwise the issuer company is the subject.
 */
async function resolveSubject(
  ctx: ToolContext,
  company: string | undefined,
  owner: string | undefined,
): Promise<{ subjectCik: string; issuerFilter: string | null }> {
  if (owner) {
    const ownerCik = await resolveOwner(ctx, owner);
    if (!ownerCik) {
      throw new ToolError(
        `No SEC filer found for owner "${owner}". Individuals are indexed as ` +
          '"Last First" (e.g. "Cook Timothy"); a CIK also works.',
        { retryable: false },
      );
    }
    const issuerFilter = company ? (await requireCompany(ctx, company)).cik : null;
    return { subjectCik: ownerCik, issuerFilter };
  }
  return { subjectCik: (await requireCompany(ctx, company as string)).cik, issuerFilter: null };
}

const transactionShape = z.object({
  security: z.string().nullable(),
  date: z.string().nullable(),
  code: z.string().nullable(),
  codeDescription: z.string().nullable(),
  acquiredDisposed: z.string().nullable(),
  shares: z.number().nullable(),
  pricePerShare: z.number().nullable(),
  value: z.number().nullable(),
  sharesOwnedAfter: z.number().nullable(),
  ownership: z.string().nullable(),
  derivative: z.boolean(),
  underlyingSecurity: z.string().nullable(),
  exercisePrice: z.number().nullable(),
});

export const insiderTransactions: ToolDefinition = {
  name: 'insider_transactions',
  title: 'EDGAR: Insider transactions (Forms 3/4/5)',
  description:
    'Insider (officer/director/10% owner) trading activity decoded from SEC ownership ' +
    'filings — by COMPANY ("who is trading Apple stock?") or by PERSON via `owner` ' +
    '("what has Tim Cook traded, across all companies?"; individuals are indexed as ' +
    '"Last First", e.g. "Cook Timothy"). Returns who traded, their role, transaction ' +
    'codes decoded to plain English (open-market purchase/sale, option exercise, ' +
    'grant, tax withholding, gift, …), shares, prices, and post-transaction holdings, ' +
    'plus an open-market buy/sell summary with net shares. Direction comes from the ' +
    'acquired/disposed code, and only true open-market trades (codes P/S) count ' +
    'toward the buy/sell summary — grants and option exercises never masquerade as ' +
    'conviction trades.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    company: z
      .string()
      .optional()
      .describe('The issuer: ticker, company name, or CIK. Omit when using `owner`.'),
    owner: z
      .string()
      .optional()
      .describe(
        'The insider as "Last First" (e.g. "Cook Timothy") or their CIK — returns ' +
          'their filings across all companies. Combine with `company` to filter to ' +
          'one issuer.',
      ),
    forms: z
      .string()
      .default('4,4/A')
      .describe('Ownership form types to include, e.g. "4", "4,4/A", or "3,4,5".'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(25)
      .default(10)
      .describe('How many most-recent ownership filings to decode (1–25).'),
  }),
  output: z.object({
    subject: z.string(),
    cik: z.string(),
    count: z.number(),
    filings: z.array(
      z.object({
        form: z.string(),
        filedDate: z.string(),
        accession: z.string(),
        issuer: z.string().nullable(),
        issuerTicker: z.string().nullable(),
        owners: z.array(z.string()),
        officerTitle: z.string().nullable(),
        isDirector: z.boolean(),
        isOfficer: z.boolean(),
        isTenPercentOwner: z.boolean(),
        periodOfReport: z.string().nullable(),
        planned10b5One: z.boolean(),
        transactions: z.array(transactionShape),
      }),
    ),
    summary: z.object({
      openMarketPurchases: z.object({
        transactions: z.number(),
        shares: z.number(),
        value: z.number(),
      }),
      openMarketSales: z.object({
        transactions: z.number(),
        shares: z.number(),
        value: z.number(),
      }),
      netShares: z.number(),
    }),
  }),
  async handler(args, ctx) {
    const { company, owner, forms, limit } = args;
    ctx.log('insider_transactions', { company, owner, forms, limit });
    if (!company && !owner) {
      throw new ToolError(
        'Pass `company` (an issuer) and/or `owner` (an insider, as "Last First" or CIK).',
        { retryable: false },
      );
    }

    const { subjectCik, issuerFilter } = await resolveSubject(ctx, company, owner);

    const wanted = new Set(
      forms
        .split(',')
        .map((f: string) => f.trim().toUpperCase())
        .filter(Boolean),
    );
    const { name, filings: all } = await recentFilings(ctx, subjectCik);
    const subject = name || owner || (company as string);
    const targets = all.filter((f) => wanted.has(f.form.toUpperCase())).slice(0, limit);

    // Deliberately sequential: the shared egress client already throttles to
    // the SEC's fair-access rate, so parallel fetches would only queue there.
    const parsed: { filing: RecentFiling; ownership: OwnershipFiling }[] = [];
    for (const filing of targets) {
      const ownership = await fetchOwnership(ctx, subjectCik, filing);
      if (ownership && (issuerFilter === null || ownership.issuerCik === issuerFilter)) {
        parsed.push({ filing, ownership });
      }
    }
    if (parsed.length === 0) {
      return {
        text: `No recent ${forms} filings for ${subject} (CIK ${subjectCik})${issuerFilter ? ' matching that company' : ''}.`,
        structured: {
          subject,
          cik: subjectCik,
          count: 0,
          filings: [],
          summary: summarizeOpenMarket([]),
        },
      };
    }
    const summary = summarizeOpenMarket(parsed.map((p) => p.ownership));

    const filingRows: FilingRow[] = parsed.map(({ filing, ownership }) => ({
      form: filing.form,
      filedDate: filing.filedDate,
      accession: filing.accession,
      issuer: ownership.issuer,
      issuerTicker: ownership.issuerTicker,
      owners: ownership.owners,
      officerTitle: ownership.officerTitle,
      isDirector: ownership.isDirector,
      isOfficer: ownership.isOfficer,
      isTenPercentOwner: ownership.isTenPercentOwner,
      periodOfReport: ownership.periodOfReport,
      planned10b5One: ownership.planned10b5One,
      transactions: ownership.transactions,
    }));

    const lines = filingRows.map((row) => formatFilingRow(row, Boolean(owner))).join('\n');
    const summaryLine = formatOpenMarketSummary(summary);
    return {
      text: `${subject} (CIK ${subjectCik}) — ${filingRows.length} ownership filing(s):\n${lines}\n${summaryLine}`,
      structured: {
        subject,
        cik: subjectCik,
        count: filingRows.length,
        filings: filingRows,
        summary,
      },
    };
  },
};
