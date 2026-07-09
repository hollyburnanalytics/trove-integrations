import { defineMcpServer, type ToolContext, ToolError, z } from '@ontrove/mcp';
import {
  type Company,
  companyConceptUrl,
  companyFactsUrl,
  companyNotFound,
  edgarDocument,
  edgarJson,
  filingDirUrl,
  fmtMoney,
  resolveCompany,
  submissionsUrl,
} from './client.ts';
import {
  type FilingEntry,
  fetchFilingText,
  findInText,
  isReadable,
  listFilingDocuments,
  pickPrimaryDocument,
} from './documents.ts';
import {
  type InsiderTransaction,
  type OwnershipFiling,
  parseOwnershipXml,
  summarizeOpenMarket,
} from './ownership.ts';
import { aggregateHoldings, parseCoverPage, parseInfoTable } from './thirteenf.ts';
import {
  assembleFinancials,
  factsForUnit,
  fiscalStampsTrusted,
  kindOf,
  latestFiledByPeriod,
  METRICS,
  pickUnitKey,
  type Statement,
  type StatementPeriod,
} from './xbrl.ts';

/**
 * SEC EDGAR — a no-auth hosted MCP server over the public SEC EDGAR + XBRL
 * APIs. Eight read-only surfaces, each mapped to a unit of analyst intent:
 *
 *  - `get_financials` — structured financial statements from XBRL facts;
 *  - `get_xbrl_concept` — one XBRL concept across every reported period;
 *  - `get_filing_document` — read a filing's text (paginated, searchable);
 *  - `insider_transactions` — decoded Form 3/4/5 insider activity;
 *  - `get_fund_holdings` — a 13F institutional manager's portfolio;
 *  - `get_company` — the SEC's registrant profile;
 *  - `search_filings` — full-text search across all filings;
 *  - `company_filings` — one company's filing history, filtered.
 *
 * Everything is deterministic parsing of the SEC's structured data (JSON APIs
 * and fixed XML schemas) — no fuzzy scraping. Facts are matched by fiscal
 * window regardless of which form reported them, so foreign private issuers
 * whose numbers arrive in 6-K furnishings are covered too.
 */

// ---------------------------------------------------------------------------
// Submissions helpers (shared by several tools)
// ---------------------------------------------------------------------------

interface RecentFiling {
  form: string;
  filedDate: string;
  accession: string;
  primaryDocument: string | null;
  description: string | null;
  items: string | null;
  reportDate: string | null;
}

/** Fetch + flatten the parallel-array `filings.recent` block for a company. */
async function recentFilings(
  ctx: ToolContext,
  cik: string,
): Promise<{ name: string; filings: RecentFiling[] }> {
  const body = await edgarJson(
    ctx,
    submissionsUrl(cik),
    `SEC EDGAR has no filings record for CIK ${cik}.`,
  );
  const name = typeof body.name === 'string' ? body.name : '';
  const recent = ((body.filings ?? {}) as Record<string, unknown>).recent as
    | Record<string, unknown>
    | undefined;
  const column = (key: string): unknown[] => (Array.isArray(recent?.[key]) ? recent[key] : []);
  const str = (row: unknown): string | null => (typeof row === 'string' && row ? row : null);
  const forms = column('form');
  const dates = column('filingDate');
  const accessions = column('accessionNumber');
  const docs = column('primaryDocument');
  const descriptions = column('primaryDocDescription');
  const items = column('items');
  const reportDates = column('reportDate');
  const filings = forms.map((form, i) => ({
    form: typeof form === 'string' ? form : '?',
    filedDate: str(dates[i]) ?? '?',
    accession: str(accessions[i]) ?? '',
    primaryDocument: str(docs[i]),
    description: str(descriptions[i]),
    items: str(items[i]),
    reportDate: str(reportDates[i]),
  }));
  return { name, filings };
}

/** Resolve a company or throw the standard not-found error. */
async function requireCompany(ctx: ToolContext, query: string): Promise<Company> {
  const resolved = await resolveCompany(ctx, query);
  if (!resolved) throw companyNotFound(query);
  return resolved;
}

/** 8-K item codes → plain-English event labels (fixed SEC definitions). */
const ITEM_LABELS: Record<string, string> = {
  '1.01': 'Material agreement',
  '1.02': 'Termination of material agreement',
  '1.03': 'Bankruptcy or receivership',
  '1.05': 'Material cybersecurity incident',
  '2.01': 'Acquisition or disposition of assets',
  '2.02': 'Results of operations (earnings)',
  '2.03': 'New direct financial obligation',
  '2.04': 'Triggering event on financial obligation',
  '2.05': 'Exit or disposal costs',
  '2.06': 'Material impairments',
  '3.01': 'Delisting or listing-rule noncompliance',
  '3.02': 'Unregistered equity sales',
  '3.03': 'Modification to security-holder rights',
  '4.01': 'Change of auditor',
  '4.02': 'Non-reliance on prior financials (restatement)',
  '5.01': 'Change in control',
  '5.02': 'Officer/director departure, election, or compensation',
  '5.03': 'Charter/bylaw amendment or fiscal-year change',
  '5.07': 'Shareholder vote results',
  '5.08': 'Shareholder director nominations',
  '7.01': 'Regulation FD disclosure',
  '8.01': 'Other events',
  '9.01': 'Financial statements and exhibits',
};

/** "2.02,9.01" → "2.02 Results of operations (earnings); 9.01 …". */
function decodeItems(items: string | null): string | null {
  if (!items) return null;
  const parts = items
    .split(',')
    .map((code) => code.trim())
    .filter(Boolean)
    .map((code) => (ITEM_LABELS[code] ? `${code} ${ITEM_LABELS[code]}` : code));
  return parts.length > 0 ? parts.join('; ') : null;
}

// ---------------------------------------------------------------------------
// get_financials presentation
// ---------------------------------------------------------------------------

/** One compact text block per period for the human-readable summary. */
function renderPeriod(period: StatementPeriod, currency: string): string {
  const v = period.values;
  const money = (key: string): string | null => {
    const value = v[key];
    return value === null || value === undefined ? null : fmtMoney(value, currency);
  };
  const line = (parts: (string | null)[]): string | null => {
    const kept = parts.filter((part): part is string => part !== null);
    return kept.length > 0 ? `  ${kept.join(' · ')}` : null;
  };
  const identity =
    period.identityOk === null
      ? null
      : period.identityOk
        ? 'A=L+E ✓'
        : `A≠L+E (Δ ${fmtMoney(period.identityDelta ?? 0, currency)})`;
  const lines = [
    `${period.label} (ending ${period.end}; ${period.form} filed ${period.filed}):`,
    line([
      money('revenue') && `Revenue ${money('revenue')}`,
      money('operatingIncome') && `Op income ${money('operatingIncome')}`,
      money('netIncome') && `Net income ${money('netIncome')}`,
      v.epsDiluted !== null && v.epsDiluted !== undefined
        ? `Diluted EPS ${v.epsDiluted.toFixed(2)}`
        : null,
    ]),
    line([
      money('totalAssets') && `Assets ${money('totalAssets')}`,
      money('totalLiabilities') && `Liabilities ${money('totalLiabilities')}`,
      money('stockholdersEquity') && `Equity ${money('stockholdersEquity')}`,
      identity,
    ]),
    line([
      money('operatingCashFlow') && `Operating CF ${money('operatingCashFlow')}`,
      money('capitalExpenditures') && `CapEx ${money('capitalExpenditures')}`,
      money('freeCashFlow') && `FCF ${money('freeCashFlow')}`,
    ]),
  ];
  return lines.filter((l): l is string => l !== null).join('\n');
}

const moneyValue = z.number().nullable();

const statementPeriodShape = z.object({
  label: z.string(),
  start: z.string(),
  end: z.string(),
  fiscalYear: z.number().nullable(),
  fiscalPeriod: z.string().nullable(),
  form: z.string(),
  filed: z.string(),
  accession: z.string(),
  incomeStatement: z.object({
    revenue: moneyValue,
    costOfRevenue: moneyValue,
    grossProfit: moneyValue,
    researchAndDevelopment: moneyValue,
    sellingGeneralAndAdministrative: moneyValue,
    operatingIncome: moneyValue,
    incomeTaxExpense: moneyValue,
    netIncome: moneyValue,
    epsBasic: moneyValue,
    epsDiluted: moneyValue,
  }),
  balanceSheet: z.object({
    cashAndEquivalents: moneyValue,
    currentAssets: moneyValue,
    totalAssets: moneyValue,
    currentLiabilities: moneyValue,
    longTermDebt: moneyValue,
    totalLiabilities: moneyValue,
    stockholdersEquity: moneyValue,
    liabilitiesAndEquity: moneyValue,
  }),
  cashFlow: z.object({
    operatingCashFlow: moneyValue,
    investingCashFlow: moneyValue,
    financingCashFlow: moneyValue,
    capitalExpenditures: moneyValue,
    dividendsPaid: moneyValue,
    freeCashFlow: moneyValue,
  }),
  identityOk: z.boolean().nullable(),
  identityDelta: z.number().nullable(),
});

/** Regroup a period's flat metric values into the three statement objects. */
function shapePeriod(period: StatementPeriod): z.infer<typeof statementPeriodShape> {
  const pick = (statement: Statement): Record<string, number | null> => {
    const out: Record<string, number | null> = {};
    for (const def of METRICS) {
      if (def.statement === statement) out[def.key] = period.values[def.key] ?? null;
    }
    return out;
  };
  return {
    label: period.label,
    start: period.start,
    end: period.end,
    fiscalYear: period.fiscalYear,
    fiscalPeriod: period.fiscalPeriod,
    form: period.form,
    filed: period.filed,
    accession: period.accession,
    incomeStatement: pick('income') as z.infer<typeof statementPeriodShape>['incomeStatement'],
    balanceSheet: pick('balance') as z.infer<typeof statementPeriodShape>['balanceSheet'],
    cashFlow: {
      ...pick('cashFlow'),
      freeCashFlow: period.values.freeCashFlow ?? null,
    } as z.infer<typeof statementPeriodShape>['cashFlow'],
    identityOk: period.identityOk,
    identityDelta: period.identityDelta,
  };
}

const conceptFactShape = z.object({
  start: z.string().nullable(),
  end: z.string(),
  value: z.number(),
  fiscalYear: z.number().nullable(),
  fiscalPeriod: z.string().nullable(),
  form: z.string(),
  filed: z.string(),
  accession: z.string(),
  frame: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// search_filings parsing
// ---------------------------------------------------------------------------

/** One row of full-text search output. */
interface SearchFiling {
  company: string;
  form: string;
  filedDate: string;
  accession: string;
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
    const src = (hit._source ?? {}) as Record<string, unknown>;
    const accession = typeof hit._id === 'string' ? (hit._id.split(':')[0] ?? '') : '';
    if (accession && seen.has(accession)) continue;
    seen.add(accession);
    const names = Array.isArray(src.display_names) ? src.display_names : [];
    filings.push({
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
      accession,
    });
  }
  return filings;
}

// ---------------------------------------------------------------------------
// insider_transactions helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

export default defineMcpServer({
  tools: [
    {
      name: 'get_financials',
      title: 'EDGAR: Company financials (XBRL)',
      description:
        'Structured financial statements for a public company, straight from its SEC XBRL ' +
        'facts: income statement, balance sheet, and cash flow with several comparative ' +
        'periods in one call. Use annual for fiscal years or quarterly for reported ' +
        'quarters (fiscal Q4 income figures are usually only reported inside the annual ' +
        'totals; quarters furnished on 6-K by foreign private issuers are included). ' +
        "Values are as-reported in the company's filing currency, preferring the " +
        'latest amendment/restatement, and each period carries an assets = liabilities + ' +
        'equity sanity check. For one metric across all of history, use get_xbrl_concept.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        company: z.string().min(1).describe('Ticker ("AAPL", "BRK.B"), company name, or CIK.'),
        period: z
          .enum(['annual', 'quarterly'])
          .default('annual')
          .describe('Fiscal years (annual) or reported fiscal quarters (quarterly).'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(12)
          .default(4)
          .describe('How many most-recent periods to return (1–12).'),
      }),
      output: z.object({
        company: z.string(),
        cik: z.string(),
        taxonomy: z.string(),
        currency: z.string(),
        periodType: z.string(),
        count: z.number(),
        periods: z.array(statementPeriodShape),
      }),
      async handler(args, ctx) {
        const { company, period, limit } = args;
        ctx.log('get_financials', { company, period, limit });
        const resolved = await requireCompany(ctx, company);
        const body = await edgarJson(
          ctx,
          companyFactsUrl(resolved.cik),
          `SEC EDGAR has no XBRL company facts for "${company}" (CIK ${resolved.cik}).`,
        );
        const name = typeof body.entityName === 'string' ? body.entityName : resolved.name;
        const financials = assembleFinancials(body, period, limit);

        if (financials.periods.length === 0) {
          return {
            text:
              `${name} (CIK ${resolved.cik}) has XBRL facts but no ${period} net-income ` +
              'periods to anchor statements on. Try the other period type.',
            structured: {
              company: name,
              cik: resolved.cik,
              taxonomy: financials.taxonomy,
              currency: financials.currency,
              periodType: period,
              count: 0,
              periods: [],
            },
          };
        }

        const blocks = financials.periods
          .map((p) => renderPeriod(p, financials.currency))
          .join('\n');
        return {
          text:
            `${name} (CIK ${resolved.cik}) — ${period} financials, ${financials.currency} ` +
            '(as reported; latest amendments preferred):\n' +
            blocks +
            '\n(Full line items in the structured output.)',
          structured: {
            company: name,
            cik: resolved.cik,
            taxonomy: financials.taxonomy,
            currency: financials.currency,
            periodType: period,
            count: financials.periods.length,
            periods: financials.periods.map(shapePeriod),
          },
        };
      },
    },
    {
      name: 'get_xbrl_concept',
      title: 'EDGAR: One XBRL concept over time',
      description:
        'Every value a company has reported for a single XBRL concept (exact tag, e.g. ' +
        '"NetIncomeLoss", "Revenues", "Assets", "PaymentsToAcquirePropertyPlantAndEquipment"), ' +
        "across all years and quarters — ideal for one metric's full history or a metric " +
        "get_financials doesn't cover. Duplicate reports of the same period are deduped " +
        'to the latest filing (amendments win). Use get_financials first when you need ' +
        'whole statements.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        company: z.string().min(1).describe('Ticker ("AAPL", "BRK.B"), company name, or CIK.'),
        concept: z
          .string()
          .min(1)
          .regex(/^[A-Za-z][A-Za-z0-9]*$/)
          .describe('Exact XBRL tag in CamelCase, e.g. "NetIncomeLoss".'),
        taxonomy: z
          .enum(['us-gaap', 'ifrs-full', 'dei', 'srt'])
          .default('us-gaap')
          .describe('Concept taxonomy; "us-gaap" for almost all US filers.'),
        period: z
          .enum(['annual', 'quarterly', 'all'])
          .default('all')
          .describe('Restrict to annual or quarterly windows, or return everything.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe('How many most-recent facts to return (1–100).'),
      }),
      output: z.object({
        company: z.string(),
        cik: z.string(),
        concept: z.string(),
        taxonomy: z.string(),
        label: z.string().nullable(),
        description: z.string().nullable(),
        unit: z.string(),
        total: z.number(),
        count: z.number(),
        facts: z.array(conceptFactShape),
      }),
      async handler(args, ctx) {
        const { company, concept, taxonomy, period, limit } = args;
        ctx.log('get_xbrl_concept', { company, concept, taxonomy, period });
        const resolved = await requireCompany(ctx, company);
        const body = await edgarJson(
          ctx,
          companyConceptUrl(resolved.cik, taxonomy, concept),
          `No "${taxonomy}:${concept}" facts for CIK ${resolved.cik}. XBRL tags are ` +
            'exact and case-sensitive (e.g. "NetIncomeLoss", not "netIncomeLoss"); ' +
            'the company may also simply not report this concept.',
        );
        const name = typeof body.entityName === 'string' ? body.entityName : resolved.name;
        const units = (body.units ?? {}) as Record<string, unknown>;
        const unitKey = pickUnitKey(units, ['USD', 'USD/shares', 'shares']);
        if (!unitKey) {
          throw new ToolError(`"${concept}" exists but has no reported values.`, {
            retryable: false,
          });
        }
        const deduped = [...latestFiledByPeriod(factsForUnit(units, unitKey)).values()].filter(
          (fact) => period === 'all' || kindOf(fact) === period,
        );
        deduped.sort((a, b) => (a.end < b.end ? 1 : a.end > b.end ? -1 : 0));
        const facts = deduped.slice(0, limit);

        const label = typeof body.label === 'string' ? body.label : null;
        const money = unitKey === 'USD' || /^[A-Z]{3}$/.test(unitKey);
        const lines = facts
          .map((fact) => {
            const window = fact.start ? `${fact.start} → ${fact.end}` : `as of ${fact.end}`;
            const factKind = kindOf(fact);
            // fy/fp describe the FILING; only trust them for facts filed near
            // their window end (comparatives inherit the later filing's stamps).
            const trusted =
              fact.fiscalYear !== null &&
              fact.fiscalPeriod !== null &&
              fiscalStampsTrusted(factKind === 'annual' ? 'annual' : 'quarterly', fact);
            const fiscal = trusted
              ? fact.fiscalPeriod === 'FY'
                ? ` (FY${fact.fiscalYear}, ${fact.form})`
                : ` (${fact.fiscalPeriod} FY${fact.fiscalYear}, ${fact.form})`
              : ` (${fact.form})`;
            const value = money ? fmtMoney(fact.value, unitKey) : String(fact.value);
            return `  ${window}${fiscal}: ${value}`;
          })
          .join('\n');
        return {
          text:
            `${name} — ${label ?? concept} [${taxonomy}:${concept}], ${unitKey}:\n` +
            (lines || '  (no facts matched the period filter)'),
          structured: {
            company: name,
            cik: resolved.cik,
            concept,
            taxonomy,
            label,
            description: typeof body.description === 'string' ? body.description : null,
            unit: unitKey,
            total: deduped.length,
            count: facts.length,
            facts,
          },
        };
      },
    },
    {
      name: 'get_filing_document',
      title: 'EDGAR: Read a filing',
      description:
        'Read the text of an SEC filing (10-K, 10-Q, 8-K, proxy, S-1, …) given its ' +
        'accession number — from search_filings or company_filings. Returns clean plain ' +
        'text with character-offset pagination (follow nextOffset for more), the list of ' +
        'documents/exhibits in the filing (pass `document` to read a specific one), and ' +
        'an optional literal `find` that returns each match with surrounding context and ' +
        'its offset, so you can jump straight to a passage (e.g. find "risk factors" or ' +
        '"climate"). For financial NUMBERS prefer get_financials/get_xbrl_concept.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        company: z.string().min(1).describe('Ticker, company name, or CIK of the filer.'),
        accession: z
          .string()
          .regex(/^\d{10}-?\d{2}-?\d{6}$/)
          .describe('Accession number, e.g. "0000320193-25-000079".'),
        document: z
          .string()
          .optional()
          .describe('A specific document/exhibit filename from the documents list.'),
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe('Character offset to start from; pass the returned nextOffset.'),
        maxChars: z
          .number()
          .int()
          .min(500)
          .max(100_000)
          .default(20_000)
          .describe('Max characters of text to return (default 20000).'),
        find: z
          .string()
          .optional()
          .describe('Literal text to locate (case-insensitive); returns matches + offsets.'),
      }),
      output: z.object({
        company: z.string(),
        cik: z.string(),
        accession: z.string(),
        document: z.string(),
        documents: z.array(
          z.object({ name: z.string(), size: z.number().nullable(), extension: z.string() }),
        ),
        totalChars: z.number(),
        offset: z.number(),
        nextOffset: z.number().nullable(),
        content: z.string(),
        matches: z.array(z.object({ offset: z.number(), context: z.string() })),
      }),
      async handler(args, ctx) {
        const { company, document, offset, maxChars, find } = args;
        const accession = /-/.test(args.accession)
          ? args.accession
          : `${args.accession.slice(0, 10)}-${args.accession.slice(10, 12)}-${args.accession.slice(12)}`;
        ctx.log('get_filing_document', { company, accession, document, find });
        const resolved = await requireCompany(ctx, company);
        const entries = await listFilingDocuments(ctx, resolved.cik, accession);

        let entry: FilingEntry | null;
        if (document) {
          entry = entries.find((e) => e.name === document) ?? null;
          if (!entry) {
            const names = entries.map((e) => e.name).join(', ');
            throw new ToolError(`No document "${document}" in ${accession}. Available: ${names}`, {
              retryable: false,
            });
          }
        } else {
          const { filings } = await recentFilings(ctx, resolved.cik);
          const declared = filings.find((f) => f.accession === accession)?.primaryDocument;
          entry = pickPrimaryDocument(entries, declared);
        }
        if (!entry) {
          throw new ToolError(`Filing ${accession} has no readable primary document.`, {
            retryable: false,
          });
        }
        if (!isReadable(entry)) {
          throw new ToolError(
            `"${entry.name}" is a ${entry.extension.toUpperCase()} file, which cannot be ` +
              'rendered as text here. Pick an .htm/.txt/.xml document from the documents list.',
            { retryable: false },
          );
        }

        const text = await fetchFilingText(ctx, resolved.cik, accession, entry);
        const matches = find ? findInText(text, find) : [];
        const content = text.slice(offset, offset + maxChars);
        const nextOffset = offset + content.length < text.length ? offset + content.length : null;
        const documents = entries.map(({ name, size, extension }) => ({ name, size, extension }));

        const matchText =
          find === undefined
            ? ''
            : matches.length > 0
              ? `\n${matches.length} match(es) for "${find}":\n${matches
                  .map((m) => `  [offset ${m.offset}] ${m.context}`)
                  .join('\n')}\n`
              : `\nNo matches for "${find}".\n`;
        const moreText =
          nextOffset === null ? '' : `\n(more — call again with offset=${nextOffset})`;
        return {
          text:
            `${entry.name} in ${accession} (${resolved.name || company}) — ` +
            `${text.length.toLocaleString('en-US')} chars total, showing ${offset}–${offset + content.length}:` +
            `${matchText}\n${content}${moreText}`,
          structured: {
            company: resolved.name || company,
            cik: resolved.cik,
            accession,
            document: entry.name,
            documents,
            totalChars: text.length,
            offset,
            nextOffset,
            content,
            matches,
          },
        };
      },
    },
    {
      name: 'insider_transactions',
      title: 'EDGAR: Insider transactions (Forms 3/4/5)',
      description:
        'Insider (officer/director/10% owner) trading activity decoded from SEC ownership ' +
        'filings: who traded, their role, transaction codes decoded to plain English ' +
        '(open-market purchase/sale, option exercise, grant, tax withholding, gift, …), ' +
        'shares, prices, and post-transaction holdings, plus an open-market buy/sell ' +
        'summary with net shares. Direction comes from the acquired/disposed code, and ' +
        'only true open-market trades (codes P/S) count toward the buy/sell summary — ' +
        'grants and option exercises never masquerade as conviction trades.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        company: z.string().min(1).describe('Ticker, company name, or CIK.'),
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
        company: z.string(),
        cik: z.string(),
        count: z.number(),
        filings: z.array(
          z.object({
            form: z.string(),
            filedDate: z.string(),
            accession: z.string(),
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
        const { company, forms, limit } = args;
        ctx.log('insider_transactions', { company, forms, limit });
        const resolved = await requireCompany(ctx, company);
        const wanted = new Set(
          forms
            .split(',')
            .map((f: string) => f.trim().toUpperCase())
            .filter(Boolean),
        );
        const { name, filings: all } = await recentFilings(ctx, resolved.cik);
        const targets = all.filter((f) => wanted.has(f.form.toUpperCase())).slice(0, limit);
        if (targets.length === 0) {
          return {
            text: `No recent ${forms} filings for ${name || company} (CIK ${resolved.cik}).`,
            structured: {
              company: name || company,
              cik: resolved.cik,
              count: 0,
              filings: [],
              summary: summarizeOpenMarket([]),
            },
          };
        }

        const parsed: { filing: RecentFiling; ownership: OwnershipFiling }[] = [];
        for (const filing of targets) {
          const ownership = await fetchOwnership(ctx, resolved.cik, filing);
          if (ownership) parsed.push({ filing, ownership });
        }
        const summary = summarizeOpenMarket(parsed.map((p) => p.ownership));

        const filingRows = parsed.map(({ filing, ownership }) => ({
          form: filing.form,
          filedDate: filing.filedDate,
          accession: filing.accession,
          owners: ownership.owners,
          officerTitle: ownership.officerTitle,
          isDirector: ownership.isDirector,
          isOfficer: ownership.isOfficer,
          isTenPercentOwner: ownership.isTenPercentOwner,
          periodOfReport: ownership.periodOfReport,
          planned10b5One: ownership.planned10b5One,
          transactions: ownership.transactions,
        }));

        const lines = filingRows
          .map((row) => {
            const role = row.officerTitle ?? (row.isDirector ? 'Director' : null);
            const who = `${row.owners.join(' / ') || '?'}${role ? ` (${role})` : ''}`;
            const txns =
              row.transactions.length > 0
                ? row.transactions.map((t) => `    ${renderTransaction(t)}`).join('\n')
                : '    (no transactions — holdings-only report)';
            const plan = row.planned10b5One ? ' [10b5-1 plan]' : '';
            return `  ${row.filedDate} ${row.form} — ${who}${plan}\n${txns}`;
          })
          .join('\n');
        const net =
          summary.netShares === 0
            ? 'net flat'
            : summary.netShares > 0
              ? `net +${summary.netShares.toLocaleString('en-US')} shares bought`
              : `net ${summary.netShares.toLocaleString('en-US')} shares sold`;
        const summaryLine =
          `Open-market summary across these filings: ${summary.openMarketPurchases.transactions} ` +
          `buy(s) (${fmtMoney(summary.openMarketPurchases.value, 'USD')}), ` +
          `${summary.openMarketSales.transactions} sale(s) ` +
          `(${fmtMoney(summary.openMarketSales.value, 'USD')}) — ${net}.`;
        return {
          text: `${name || company} (CIK ${resolved.cik}) — ${filingRows.length} ownership filing(s):\n${lines}\n${summaryLine}`,
          structured: {
            company: name || company,
            cik: resolved.cik,
            count: filingRows.length,
            filings: filingRows,
            summary,
          },
        };
      },
    },
    {
      name: 'get_fund_holdings',
      title: 'EDGAR: 13F fund holdings',
      description:
        "An institutional manager's portfolio from its latest 13F-HR filing (or a " +
        'specific one by accession): top holdings by market value with shares, put/call ' +
        'flags, and portfolio percentages. Works for hedge funds and asset managers ' +
        '(e.g. "Berkshire Hathaway", "BlackRock") — 13Fs exist only for managers with ' +
        '$100M+ in US-listed equities, and report long US equity positions quarterly ' +
        '(45-day lag), not shorts or most bonds. Values are normalized to whole dollars.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        company: z.string().min(1).describe('Fund manager name, ticker, or CIK.'),
        accession: z
          .string()
          .regex(/^\d{10}-?\d{2}-?\d{6}$/)
          .optional()
          .describe('A specific 13F filing accession (defaults to the most recent 13F-HR).'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(25)
          .describe('How many top holdings to return (1–200).'),
      }),
      output: z.object({
        company: z.string(),
        cik: z.string(),
        form: z.string(),
        accession: z.string(),
        periodOfReport: z.string().nullable(),
        amendmentType: z.string().nullable(),
        valueUnits: z.string(),
        totalValue: z.number(),
        totalCheckOk: z.boolean().nullable(),
        positions: z.number(),
        count: z.number(),
        holdings: z.array(
          z.object({
            issuer: z.string().nullable(),
            titleOfClass: z.string().nullable(),
            cusip: z.string().nullable(),
            value: z.number(),
            shares: z.number().nullable(),
            sharesType: z.string().nullable(),
            putCall: z.string().nullable(),
            percent: z.number(),
          }),
        ),
      }),
      async handler(args, ctx) {
        const { company, limit } = args;
        ctx.log('get_fund_holdings', { company, accession: args.accession, limit });
        const resolved = await requireCompany(ctx, company);
        const { name, filings } = await recentFilings(ctx, resolved.cik);

        let accession = args.accession;
        let form = '13F-HR';
        if (accession) {
          if (!accession.includes('-')) {
            accession = `${accession.slice(0, 10)}-${accession.slice(10, 12)}-${accession.slice(12)}`;
          }
          form = filings.find((f) => f.accession === accession)?.form ?? '13F';
        } else {
          const hr = filings.find((f) => f.form === '13F-HR' || f.form === '13F-HR/A');
          if (!hr) {
            const nt = filings.find((f) => f.form.startsWith('13F-NT'));
            throw new ToolError(
              nt
                ? `${name || company} files 13F-NT notices — its holdings are reported by ` +
                    'another manager, so there is no information table here.'
                : `No 13F-HR filings found for ${name || company} (CIK ${resolved.cik}). ` +
                    'Only institutional managers with $100M+ in US equities file 13Fs.',
              { retryable: false },
            );
          }
          accession = hr.accession;
          form = hr.form;
        }

        // The information table is the non-primary XML attachment; identify it
        // by content, tolerating namespace prefixes.
        const entries = await listFilingDocuments(ctx, resolved.cik, accession);
        const xmlEntries = entries.filter((entry) => entry.extension === 'xml');
        let coverXml = '';
        let tableXml = '';
        for (const entry of xmlEntries) {
          const body = await edgarDocument(
            ctx,
            `${filingDirUrl(resolved.cik, accession)}/${entry.name}`,
            `Document ${entry.name} missing from ${accession}.`,
          );
          if (/<(?:\w+:)?infoTable[\s>]/.test(body)) tableXml = body;
          else if (/<(?:\w+:)?edgarSubmission[\s>]/.test(body)) coverXml = body;
        }
        if (!tableXml) {
          throw new ToolError(
            `Filing ${accession} has no 13F information table (13F-NT notices and some ` +
              'amendments carry none).',
            { retryable: false },
          );
        }

        const cover = parseCoverPage(coverXml);
        const table = parseInfoTable(tableXml, cover.periodOfReport);
        const aggregated = aggregateHoldings(table.holdings);
        const totalValue = aggregated.reduce((sum, h) => sum + h.value, 0);
        const declaredTotal =
          cover.tableValueTotal === null
            ? null
            : cover.tableValueTotal * (table.valueUnits === 'thousands' ? 1000 : 1);
        const totalCheckOk =
          declaredTotal === null || totalValue === 0
            ? null
            : Math.abs(totalValue - declaredTotal) <= Math.abs(declaredTotal) * 0.01;
        const top = aggregated.slice(0, limit).map((h) => ({
          issuer: h.issuer,
          titleOfClass: h.titleOfClass,
          cusip: h.cusip,
          value: h.value,
          shares: h.shares,
          sharesType: h.sharesType,
          putCall: h.putCall,
          percent: totalValue > 0 ? Math.round((h.value / totalValue) * 10_000) / 100 : 0,
        }));

        const manager = cover.manager ?? name ?? company;
        const lines = top
          .map((h, i) => {
            const flag = h.putCall ? ` [${h.putCall}]` : '';
            const shares = h.shares === null ? '' : ` · ${h.shares.toLocaleString('en-US')} sh`;
            return `  ${i + 1}. ${h.issuer ?? '?'}${flag} — ${fmtMoney(h.value, 'USD')} (${h.percent}%)${shares}`;
          })
          .join('\n');
        const amendment = cover.amendmentType ? ` (${cover.amendmentType} amendment)` : '';
        const check = totalCheckOk === false ? ' ⚠ sum differs from the declared total' : '';
        return {
          text:
            `${manager} — ${form}${amendment} for period ending ${cover.periodOfReport ?? '?'}: ` +
            `${aggregated.length} position(s), ${fmtMoney(totalValue, 'USD')} total${check}.\n` +
            `Top ${top.length}:\n${lines}`,
          structured: {
            company: manager,
            cik: resolved.cik,
            form,
            accession,
            periodOfReport: cover.periodOfReport,
            amendmentType: cover.amendmentType,
            valueUnits: table.valueUnits,
            totalValue,
            totalCheckOk,
            positions: aggregated.length,
            count: top.length,
            holdings: top,
          },
        };
      },
    },
    {
      name: 'get_company',
      title: 'EDGAR: Company profile',
      description:
        "The SEC's registrant profile for a company: legal name, CIK, tickers and " +
        'exchanges, SIC industry classification, entity type and filer category, state ' +
        'of incorporation, fiscal-year end, website/phone, and former names. Useful to ' +
        'confirm you have the right entity before pulling financials or filings.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        company: z.string().min(1).describe('Ticker, company name, or CIK.'),
      }),
      output: z.object({
        company: z.string(),
        cik: z.string(),
        tickers: z.array(z.string()),
        exchanges: z.array(z.string()),
        sic: z.string().nullable(),
        sicDescription: z.string().nullable(),
        entityType: z.string().nullable(),
        category: z.string().nullable(),
        stateOfIncorporation: z.string().nullable(),
        fiscalYearEnd: z.string().nullable(),
        website: z.string().nullable(),
        phone: z.string().nullable(),
        formerNames: z.array(z.object({ name: z.string(), from: z.string(), to: z.string() })),
      }),
      async handler(args, ctx) {
        ctx.log('get_company', { company: args.company });
        const resolved = await requireCompany(ctx, args.company);
        const body = await edgarJson(
          ctx,
          submissionsUrl(resolved.cik),
          `SEC EDGAR has no record for CIK ${resolved.cik}.`,
        );
        const str = (key: string): string | null =>
          typeof body[key] === 'string' && body[key] ? (body[key] as string) : null;
        const strings = (key: string): string[] =>
          Array.isArray(body[key])
            ? (body[key] as unknown[]).filter((v) => typeof v === 'string')
            : [];
        const formerNames = (Array.isArray(body.formerNames) ? body.formerNames : [])
          .map((raw) => {
            const item = raw as { name?: unknown; from?: unknown; to?: unknown };
            if (typeof item.name !== 'string') return null;
            return {
              name: item.name,
              from: typeof item.from === 'string' ? item.from.slice(0, 10) : '',
              to: typeof item.to === 'string' ? item.to.slice(0, 10) : '',
            };
          })
          .filter((item): item is { name: string; from: string; to: string } => item !== null);
        // fiscalYearEnd arrives as "MMDD" — render as MM-DD.
        const fye = str('fiscalYearEnd');
        const fiscalYearEnd =
          fye && /^\d{4}$/.test(fye) ? `${fye.slice(0, 2)}-${fye.slice(2)}` : fye;
        const name = str('name') ?? resolved.name;
        const tickers = strings('tickers');
        const exchanges = strings('exchanges');

        const parts = [
          `${name} (CIK ${resolved.cik})`,
          tickers.length > 0
            ? `Listed: ${tickers.map((t, i) => `${t}${exchanges[i] ? ` (${exchanges[i]})` : ''}`).join(', ')}`
            : 'No listed tickers',
          str('sicDescription') ? `Industry: ${str('sicDescription')} (SIC ${str('sic')})` : null,
          str('entityType') ? `Entity type: ${str('entityType')}` : null,
          str('category') ? `Filer category: ${str('category')}` : null,
          str('stateOfIncorporation') ? `Incorporated: ${str('stateOfIncorporation')}` : null,
          fiscalYearEnd ? `Fiscal year ends: ${fiscalYearEnd}` : null,
          str('website') ? `Website: ${str('website')}` : null,
          formerNames.length > 0
            ? `Former names: ${formerNames.map((f) => `${f.name} (${f.from} → ${f.to})`).join('; ')}`
            : null,
        ].filter((part): part is string => part !== null);

        return {
          text: parts.join('\n'),
          structured: {
            company: name,
            cik: resolved.cik,
            tickers,
            exchanges,
            sic: str('sic'),
            sicDescription: str('sicDescription'),
            entityType: str('entityType'),
            category: str('category'),
            stateOfIncorporation: str('stateOfIncorporation'),
            fiscalYearEnd,
            website: str('website'),
            phone: str('phone'),
            formerNames,
          },
        };
      },
    },
    {
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
        company: z
          .string()
          .optional()
          .describe('Restrict to one filer: ticker, company name, or CIK.'),
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
        const params = new URLSearchParams({ q: query });
        if (cik) params.set('ciks', cik);
        if (forms) params.set('forms', forms);
        if (startDate || endDate) {
          // EDGAR's full-text search uses dateRange=custom with either bound
          // optional; previously a lone startDate/endDate was silently dropped.
          params.set('dateRange', 'custom');
          if (startDate) params.set('startdt', startDate);
          if (endDate) params.set('enddt', endDate);
        }
        if (from > 0) params.set('from', String(from));
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
    },
    {
      name: 'company_filings',
      title: 'EDGAR: Company filings',
      description:
        'List a company\'s recent SEC filings by ticker (e.g. "AAPL"), company name, or ' +
        'CIK, filterable by form type(s) (e.g. "10-K" or "10-K,10-Q,8-K") and filing-date ' +
        'range. Returns form type, filing date, accession number, primary document, and — ' +
        'for 8-Ks — the material-event item codes decoded to plain English (2.02 earnings, ' +
        '5.02 officer changes, …). Filter by forms to skip the Form 4/144 noise that ' +
        "dominates most companies' feeds. Read any filing with get_filing_document.",
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
        const { name, filings: all } = await recentFilings(ctx, resolved.cik);
        const displayName = name || resolved.name;
        const wanted = forms
          ? new Set(
              forms
                .split(',')
                .map((f: string) => f.trim().toUpperCase())
                .filter(Boolean),
            )
          : null;
        const matching = all.filter(
          (f) =>
            (!wanted || wanted.has(f.form.toUpperCase())) &&
            (!startDate || f.filedDate >= startDate) &&
            (!endDate || f.filedDate <= endDate),
        );
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
            text: `No recent filings${filterNote} for ${displayName} (CIK ${resolved.cik}).`,
            structured: {
              company: displayName,
              cik: resolved.cik,
              matched: 0,
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
        return {
          text:
            `${displayName} (CIK ${resolved.cik}) — ${filings.length} of ${matching.length} ` +
            `matching filing(s):\n${lines}`,
          structured: {
            company: displayName,
            cik: resolved.cik,
            matched: matching.length,
            count: filings.length,
            filings,
          },
        };
      },
    },
  ],
});
