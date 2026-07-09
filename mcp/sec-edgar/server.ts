import { defineMcpServer, type ToolContext, ToolError, z } from '@ontrove/mcp';
import { createEgressClient } from '../lib/egress.ts';

/**
 * SEC EDGAR — a no-auth hosted MCP server over the public SEC EDGAR + XBRL APIs.
 *
 * Four read-only surfaces, each mapped to a unit of analyst intent:
 *  - `get_financials` — structured financial statements (income statement,
 *    balance sheet, cash flow) straight from a company's XBRL facts, with
 *    comparative periods and an accounting-identity sanity check;
 *  - `get_xbrl_concept` — one XBRL concept (e.g. `NetIncomeLoss`) across every
 *    period the company has ever reported, for trend analysis;
 *  - `search_filings` — full-text search across filings (efts.sec.gov),
 *    optionally scoped to one company, deduped and paginated;
 *  - `company_filings` — a company's recent filings, filterable by form type
 *    and date range.
 *
 * Numbers come from the XBRL "company facts" data (data.sec.gov), which is the
 * same structured data behind the filings themselves — no HTML scraping. Facts
 * are matched by fiscal period regardless of which form reported them, so
 * foreign private issuers whose quarterly numbers arrive in 6-K furnishings
 * (rather than 10-Qs) are covered too.
 *
 * Egress is resilient: an in-isolate cache collapses repeat lookups (filings
 * are immutable; the fact sets change at most daily), requests are throttled
 * under the SEC's fair-access rate, and failures retry with backoff.
 */

/**
 * SEC-required descriptive User-Agent (their fair-access policy). SEC blocks
 * non-deliverable contacts — including GitHub `noreply` addresses — with a 403,
 * so this must stay a real, monitored operator inbox.
 */
const CONTACT_EMAIL = 'sec-edgar@ontrove.sh';
const USER_AGENT = `Trove MCP (${CONTACT_EMAIL})`;

const TICKER_MAP_URL = 'https://www.sec.gov/files/company_tickers.json';
const submissionsUrl = (cik: string): string => `https://data.sec.gov/submissions/CIK${cik}.json`;
const companyFactsUrl = (cik: string): string =>
  `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
const companyConceptUrl = (cik: string, taxonomy: string, concept: string): string =>
  `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/${taxonomy}/${encodeURIComponent(concept)}.json`;

// ---------------------------------------------------------------------------
// Egress: shared in-isolate cache + throttle + retry/backoff (mcp/lib/egress)
// ---------------------------------------------------------------------------

/**
 * EDGAR data is highly cacheable (filings never change; the ticker map and
 * fact sets update at most daily), so repeats are served from the in-isolate
 * cache. Oversized bodies (the multi-megabyte companyfacts responses) are
 * deliberately never cached. The SEC's fair-access policy allows up to 10
 * requests/second (throttled) and signals rate-limiting as 429 or as a 403
 * "Request Rate Threshold Exceeded" page — both retried as transient.
 */
const edgar = createEgressClient({
  service: 'SEC EDGAR',
  headers: { accept: 'application/json', 'user-agent': USER_AGENT },
  throttleMs: 120,
  rateLimitStatuses: [403, 429],
  backoffBaseMs: 100,
  cache: {
    ttlMs: 15 * 60_000,
    maxEntries: 64,
    maxEntryBytes: 2 * 1024 * 1024,
    maxTotalBytes: 12 * 1024 * 1024,
  },
});

/** Fetch + parse an EDGAR JSON body, mapping 400/404 to `notFound` (non-retryable). */
async function edgarJson(
  ctx: ToolContext,
  url: string,
  notFound: string,
): Promise<Record<string, unknown>> {
  const { status, body } = await edgar.fetch(ctx, url);
  if (status === 400 || status === 404) throw new ToolError(notFound, { retryable: false });
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>;
  } catch {
    // fall through to the malformed-data error
  }
  throw new ToolError('SEC EDGAR returned malformed data; try again shortly.', {
    retryable: true,
  });
}

// ---------------------------------------------------------------------------
// Entity resolution (ticker / CIK / company name → zero-padded CIK)
// ---------------------------------------------------------------------------

interface Company {
  cik: string;
  name: string;
}

/**
 * Resolve a company identifier to its 10-digit zero-padded CIK. Accepts a bare
 * CIK number, an exact ticker (share-class dots normalized, so "BRK.B" matches
 * EDGAR's "BRK-B"), or — as a fallback — a company-name match against the SEC's
 * ticker map (exact name first, then prefix, then substring).
 */
async function resolveCompany(ctx: ToolContext, query: string): Promise<Company | null> {
  const trimmed = query.trim();
  if (/^\d{1,10}$/.test(trimmed)) {
    return { cik: trimmed.padStart(10, '0'), name: '' };
  }
  const map = await edgarJson(ctx, TICKER_MAP_URL, 'The SEC ticker map is unavailable.');
  const entries: { cik: string; ticker: string; title: string }[] = [];
  for (const value of Object.values(map)) {
    const o = value as { cik_str?: unknown; ticker?: unknown; title?: unknown };
    if (typeof o.ticker !== 'string' || typeof o.title !== 'string') continue;
    entries.push({
      cik: String(o.cik_str ?? '').padStart(10, '0'),
      ticker: o.ticker.toUpperCase(),
      title: o.title,
    });
  }

  const target = trimmed.toUpperCase();
  const dashed = target.replace(/\./g, '-');
  for (const e of entries) {
    if (e.ticker === target || e.ticker === dashed) return { cik: e.cik, name: e.title };
  }

  // Name fallback: exact (case-insensitive), then prefix, then substring.
  const lower = trimmed.toLowerCase();
  const byName =
    entries.find((e) => e.title.toLowerCase() === lower) ??
    entries.find((e) => e.title.toLowerCase().startsWith(lower)) ??
    (lower.length >= 3 ? entries.find((e) => e.title.toLowerCase().includes(lower)) : undefined);
  return byName ? { cik: byName.cik, name: byName.title } : null;
}

function companyNotFound(query: string): ToolError {
  return new ToolError(
    `No SEC company found for "${query}" (try a ticker like "AAPL", a company name, or a CIK).`,
    { retryable: false },
  );
}

// ---------------------------------------------------------------------------
// XBRL facts: parsing, period classification, and fact selection
// ---------------------------------------------------------------------------

/** One reported XBRL fact, normalized from the data.sec.gov shape. */
interface Fact {
  start: string | null;
  end: string;
  value: number;
  fiscalYear: number | null;
  fiscalPeriod: string | null;
  form: string;
  filed: string;
  accession: string;
  frame: string | null;
}

type PeriodKind = 'annual' | 'quarterly' | 'instant' | 'other';

const DAY_MS = 86_400_000;

/**
 * Classify a fact by its reporting window. Durations tolerate 52/53-week
 * fiscal calendars (annual years run 364–371 days, quarters 91–98). Facts with
 * other windows (six- and nine-month year-to-date figures in 10-Qs) are
 * excluded from period matching so YTD numbers never masquerade as quarters.
 */
function kindOf(fact: Fact): PeriodKind {
  if (fact.start === null) return 'instant';
  const days = (Date.parse(fact.end) - Date.parse(fact.start)) / DAY_MS;
  if (days >= 330 && days <= 400) return 'annual';
  if (days >= 75 && days <= 115) return 'quarterly';
  return 'other';
}

/** Normalize one raw `units` array entry into a {@link Fact} (or null if unusable). */
function parseFact(raw: unknown): Fact | null {
  const o = raw as Record<string, unknown>;
  if (typeof o?.end !== 'string' || typeof o.val !== 'number' || typeof o.filed !== 'string') {
    return null;
  }
  return {
    start: typeof o.start === 'string' ? o.start : null,
    end: o.end,
    value: o.val,
    fiscalYear: typeof o.fy === 'number' ? o.fy : null,
    fiscalPeriod: typeof o.fp === 'string' ? o.fp : null,
    form: typeof o.form === 'string' ? o.form : '?',
    filed: o.filed,
    accession: typeof o.accn === 'string' ? o.accn : '',
    frame: typeof o.frame === 'string' ? o.frame : null,
  };
}

/**
 * Pick the reporting unit for a concept's `units` map: the preferred keys in
 * order (e.g. `["USD"]` or `["USD/shares"]`), else the first unit present.
 */
function pickUnitKey(units: Record<string, unknown>, preferred: string[]): string | null {
  for (const key of preferred) if (Array.isArray(units[key])) return key;
  const first = Object.keys(units).find((key) => Array.isArray(units[key]));
  return first ?? null;
}

/** All normalized facts for one concept in one unit. */
function factsForUnit(units: Record<string, unknown>, unitKey: string): Fact[] {
  const raw = units[unitKey];
  if (!Array.isArray(raw)) return [];
  const facts: Fact[] = [];
  for (const entry of raw) {
    const fact = parseFact(entry);
    if (fact) facts.push(fact);
  }
  return facts;
}

/** The identity of a fact's reporting window (instants have no start). */
const periodKey = (start: string | null, end: string): string => `${start ?? ''}|${end}`;

/**
 * Deduplicate facts that report the same window: the same period appears in
 * many filings (originals, comparatives, amendments); the latest-filed fact
 * wins so restated/amended figures are preferred.
 */
function latestFiledByPeriod(facts: Fact[]): Map<string, Fact> {
  const byPeriod = new Map<string, Fact>();
  for (const fact of facts) {
    const key = periodKey(fact.start, fact.end);
    const existing = byPeriod.get(key);
    if (!existing || fact.filed > existing.filed) byPeriod.set(key, fact);
  }
  return byPeriod;
}

// ---------------------------------------------------------------------------
// get_financials: statement definitions and assembly
// ---------------------------------------------------------------------------

type Statement = 'income' | 'balance' | 'cashFlow';

interface MetricDef {
  /** Output key, e.g. "revenue". */
  key: string;
  /** Human label for the text rendering. */
  label: string;
  statement: Statement;
  /** 'money' facts use the company currency; 'perShare' use `<currency>/shares`. */
  unit: 'money' | 'perShare';
  /** US-GAAP tags to try, in preference order (concepts drift across years). */
  gaap: string[];
  /** IFRS tags for foreign filers reporting under ifrs-full. */
  ifrs: string[];
}

/**
 * The statement line items `get_financials` extracts, each with tag fallbacks:
 * companies switch concepts across taxonomy versions (e.g. `Revenues` →
 * `RevenueFromContractWithCustomerExcludingAssessedTax` after ASC 606), so
 * each line tries its tags in order per period.
 */
const METRICS: MetricDef[] = [
  {
    key: 'revenue',
    label: 'Revenue',
    statement: 'income',
    unit: 'money',
    gaap: [
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'Revenues',
      'SalesRevenueNet',
      'RevenueFromContractWithCustomerIncludingAssessedTax',
      'SalesRevenueGoodsNet',
    ],
    ifrs: ['Revenue', 'RevenueFromContractsWithCustomers'],
  },
  {
    key: 'costOfRevenue',
    label: 'Cost of revenue',
    statement: 'income',
    unit: 'money',
    gaap: ['CostOfRevenue', 'CostOfGoodsAndServicesSold', 'CostOfGoodsSold'],
    ifrs: ['CostOfSales'],
  },
  {
    key: 'grossProfit',
    label: 'Gross profit',
    statement: 'income',
    unit: 'money',
    gaap: ['GrossProfit'],
    ifrs: ['GrossProfit'],
  },
  {
    key: 'researchAndDevelopment',
    label: 'R&D expense',
    statement: 'income',
    unit: 'money',
    gaap: ['ResearchAndDevelopmentExpense'],
    ifrs: ['ResearchAndDevelopmentExpense'],
  },
  {
    key: 'sellingGeneralAndAdministrative',
    label: 'SG&A expense',
    statement: 'income',
    unit: 'money',
    gaap: ['SellingGeneralAndAdministrativeExpense', 'GeneralAndAdministrativeExpense'],
    ifrs: ['SellingGeneralAndAdministrativeExpense'],
  },
  {
    key: 'operatingIncome',
    label: 'Operating income',
    statement: 'income',
    unit: 'money',
    gaap: ['OperatingIncomeLoss'],
    ifrs: ['ProfitLossFromOperatingActivities'],
  },
  {
    key: 'incomeTaxExpense',
    label: 'Income tax expense',
    statement: 'income',
    unit: 'money',
    gaap: ['IncomeTaxExpenseBenefit'],
    ifrs: ['IncomeTaxExpenseContinuingOperations'],
  },
  {
    key: 'netIncome',
    label: 'Net income',
    statement: 'income',
    unit: 'money',
    gaap: ['NetIncomeLoss', 'ProfitLoss'],
    ifrs: ['ProfitLoss', 'ProfitLossAttributableToOwnersOfParent'],
  },
  {
    key: 'epsBasic',
    label: 'EPS (basic)',
    statement: 'income',
    unit: 'perShare',
    gaap: ['EarningsPerShareBasic'],
    ifrs: ['BasicEarningsLossPerShare'],
  },
  {
    key: 'epsDiluted',
    label: 'EPS (diluted)',
    statement: 'income',
    unit: 'perShare',
    gaap: ['EarningsPerShareDiluted'],
    ifrs: ['DilutedEarningsLossPerShare'],
  },
  {
    key: 'cashAndEquivalents',
    label: 'Cash & equivalents',
    statement: 'balance',
    unit: 'money',
    gaap: ['CashAndCashEquivalentsAtCarryingValue'],
    ifrs: ['CashAndCashEquivalents'],
  },
  {
    key: 'currentAssets',
    label: 'Current assets',
    statement: 'balance',
    unit: 'money',
    gaap: ['AssetsCurrent'],
    ifrs: ['CurrentAssets'],
  },
  {
    key: 'totalAssets',
    label: 'Total assets',
    statement: 'balance',
    unit: 'money',
    gaap: ['Assets'],
    ifrs: ['Assets'],
  },
  {
    key: 'currentLiabilities',
    label: 'Current liabilities',
    statement: 'balance',
    unit: 'money',
    gaap: ['LiabilitiesCurrent'],
    ifrs: ['CurrentLiabilities'],
  },
  {
    key: 'longTermDebt',
    label: 'Long-term debt',
    statement: 'balance',
    unit: 'money',
    gaap: ['LongTermDebtNoncurrent', 'LongTermDebt'],
    ifrs: ['NoncurrentPortionOfNoncurrentBorrowings', 'Borrowings'],
  },
  {
    key: 'totalLiabilities',
    label: 'Total liabilities',
    statement: 'balance',
    unit: 'money',
    gaap: ['Liabilities'],
    ifrs: ['Liabilities'],
  },
  {
    key: 'stockholdersEquity',
    label: 'Stockholders’ equity',
    statement: 'balance',
    unit: 'money',
    gaap: [
      'StockholdersEquity',
      'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest',
    ],
    ifrs: ['Equity', 'EquityAttributableToOwnersOfParent'],
  },
  {
    key: 'liabilitiesAndEquity',
    label: 'Liabilities + equity',
    statement: 'balance',
    unit: 'money',
    gaap: ['LiabilitiesAndStockholdersEquity'],
    ifrs: ['EquityAndLiabilities'],
  },
  {
    key: 'operatingCashFlow',
    label: 'Operating cash flow',
    statement: 'cashFlow',
    unit: 'money',
    gaap: [
      'NetCashProvidedByUsedInOperatingActivities',
      'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations',
    ],
    ifrs: ['CashFlowsFromUsedInOperatingActivities'],
  },
  {
    key: 'investingCashFlow',
    label: 'Investing cash flow',
    statement: 'cashFlow',
    unit: 'money',
    gaap: [
      'NetCashProvidedByUsedInInvestingActivities',
      'NetCashProvidedByUsedInInvestingActivitiesContinuingOperations',
    ],
    ifrs: ['CashFlowsFromUsedInInvestingActivities'],
  },
  {
    key: 'financingCashFlow',
    label: 'Financing cash flow',
    statement: 'cashFlow',
    unit: 'money',
    gaap: [
      'NetCashProvidedByUsedInFinancingActivities',
      'NetCashProvidedByUsedInFinancingActivitiesContinuingOperations',
    ],
    ifrs: ['CashFlowsFromUsedInFinancingActivities'],
  },
  {
    key: 'capitalExpenditures',
    label: 'Capital expenditures',
    statement: 'cashFlow',
    unit: 'money',
    gaap: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'],
    ifrs: ['PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities'],
  },
  {
    key: 'dividendsPaid',
    label: 'Dividends paid',
    statement: 'cashFlow',
    unit: 'money',
    gaap: ['PaymentsOfDividends', 'PaymentsOfDividendsCommonStock'],
    ifrs: ['DividendsPaidClassifiedAsFinancingActivities'],
  },
];

/** The concepts that anchor period discovery (every filer reports net income). */
const ANCHOR = METRICS.find((m) => m.key === 'netIncome') as MetricDef;

/** One assembled reporting period. */
interface StatementPeriod {
  /** e.g. "FY2025" or "Q2 FY2026", falling back to the window end date. */
  label: string;
  start: string;
  end: string;
  fiscalYear: number | null;
  fiscalPeriod: string | null;
  /** The filing that first reported this period (its own 10-K/10-Q/6-K/20-F). */
  form: string;
  filed: string;
  accession: string;
  /** metric key → reported value (null when the company doesn't report it). */
  values: Record<string, number | null>;
  /** Assets = liabilities + equity, within rounding. Null when unavailable. */
  identityOk: boolean | null;
  identityDelta: number | null;
}

interface Financials {
  taxonomy: 'us-gaap' | 'ifrs-full';
  currency: string;
  periods: StatementPeriod[];
}

/** The concept map for one taxonomy inside a companyfacts response. */
type TaxonomyFacts = Record<string, { units?: Record<string, unknown> } | undefined>;

type Taxonomy = Financials['taxonomy'];

/** Tags for a metric in the given taxonomy. */
const tagsFor = (def: MetricDef, taxonomy: Taxonomy): string[] =>
  taxonomy === 'us-gaap' ? def.gaap : def.ifrs;

/** Unit-key preference for a metric given the company currency. */
const unitPreference = (def: MetricDef, currency: string): string[] =>
  def.unit === 'perShare' ? [`${currency}/shares`] : [currency];

/**
 * Merge a metric's facts across its fallback tags: an earlier (preferred) tag
 * wins a period outright; within one tag the latest-filed fact wins.
 */
function metricFactsByPeriod(
  taxFacts: TaxonomyFacts,
  def: MetricDef,
  taxonomy: Taxonomy,
  currency: string,
): Map<string, Fact> {
  const byPeriod = new Map<string, Fact>();
  const claimed = new Map<string, number>();
  tagsFor(def, taxonomy).forEach((tag, rank) => {
    const units = taxFacts[tag]?.units;
    if (!units) return;
    const unitKey = pickUnitKey(units, unitPreference(def, currency));
    if (!unitKey) return;
    for (const [key, fact] of latestFiledByPeriod(factsForUnit(units, unitKey))) {
      if ((claimed.get(key) ?? Number.POSITIVE_INFINITY) < rank) continue;
      byPeriod.set(key, fact);
      claimed.set(key, rank);
    }
  });
  return byPeriod;
}

/**
 * Whether a fact's fiscal-year/period stamps describe its own window. The
 * stamps are relative to the FILING, so a comparative re-reported a year later
 * carries the later filing's fy/fp — only facts filed shortly after their
 * window end (an original report or its amendment window) are trusted.
 */
function fiscalStampsTrusted(kind: 'annual' | 'quarterly' | 'instant', fact: Fact): boolean {
  const gapDays = (Date.parse(fact.filed) - Date.parse(fact.end)) / DAY_MS;
  return gapDays <= (kind === 'annual' ? 365 : 180);
}

/** Human period label from the original filing's fiscal-year/period stamps. */
function periodLabel(kind: 'annual' | 'quarterly', fact: Fact): string {
  if (fact.fiscalYear !== null && fact.fiscalPeriod !== null && fiscalStampsTrusted(kind, fact)) {
    return kind === 'annual' ? `FY${fact.fiscalYear}` : `${fact.fiscalPeriod} FY${fact.fiscalYear}`;
  }
  return `${kind === 'annual' ? 'FY' : 'Q'} ending ${fact.end}`;
}

/**
 * Discover the reporting periods to present, anchored on net income (the one
 * line every filer reports every period). For each window, the earliest filing
 * that reported it supplies the fiscal labels (fy/fp are stamped relative to
 * the filing, so only the original filing labels the period correctly).
 */
function discoverPeriods(
  taxFacts: TaxonomyFacts,
  taxonomy: Taxonomy,
  kind: 'annual' | 'quarterly',
  limit: number,
  currency: string,
): Omit<StatementPeriod, 'values' | 'identityOk' | 'identityDelta'>[] {
  const windows = new Map<string, Fact>();
  for (const tag of tagsFor(ANCHOR, taxonomy)) {
    const units = taxFacts[tag]?.units;
    if (!units) continue;
    const unitKey = pickUnitKey(units, [currency]);
    if (!unitKey) continue;
    for (const fact of factsForUnit(units, unitKey)) {
      if (kindOf(fact) !== kind) continue;
      const key = periodKey(fact.start, fact.end);
      const existing = windows.get(key);
      // Earliest filed = the filing where this window was the current period.
      if (!existing || fact.filed < existing.filed) windows.set(key, fact);
    }
  }
  return [...windows.values()]
    .filter((fact) => {
      // Some filers report trailing-twelve-month figures inside quarterly
      // reports (a year-long window ending at a quarter end). Those are not
      // fiscal years: drop annual-length windows whose own filing stamps them
      // as a quarter.
      if (kind !== 'annual') return true;
      return !(
        fiscalStampsTrusted(kind, fact) &&
        fact.fiscalPeriod !== null &&
        fact.fiscalPeriod !== 'FY'
      );
    })
    .sort((a, b) => (a.end < b.end ? 1 : a.end > b.end ? -1 : 0))
    .slice(0, limit)
    .map((fact) => {
      const trusted = fiscalStampsTrusted(kind, fact);
      return {
        label: periodLabel(kind, fact),
        start: fact.start ?? fact.end,
        end: fact.end,
        fiscalYear: trusted ? fact.fiscalYear : null,
        fiscalPeriod: trusted ? fact.fiscalPeriod : null,
        form: fact.form,
        filed: fact.filed,
        accession: fact.accession,
      };
    });
}

/**
 * The reporting currency: the unit the anchor concept reports MOST facts in
 * (USD on ties). Foreign filers often carry a handful of convenience-USD facts
 * beside a full local-currency history; blindly preferring USD would hide
 * almost all of their periods.
 */
function detectCurrency(taxFacts: TaxonomyFacts, taxonomy: Taxonomy): string {
  const counts = new Map<string, number>();
  for (const tag of tagsFor(ANCHOR, taxonomy)) {
    const units = taxFacts[tag]?.units;
    if (!units) continue;
    for (const [key, facts] of Object.entries(units)) {
      if (!Array.isArray(facts)) continue;
      const bare = key.split('/')[0] ?? key;
      counts.set(bare, (counts.get(bare) ?? 0) + facts.length);
    }
  }
  let best = 'USD';
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount || (count === bestCount && key === 'USD')) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

/** Look up one metric's value for one period (duration windows match exactly;
 * balance-sheet instants match the window's end date). */
function valueFor(
  facts: Map<string, Fact>,
  def: MetricDef,
  period: { start: string; end: string },
): number | null {
  const key =
    def.statement === 'balance' ? periodKey(null, period.end) : periodKey(period.start, period.end);
  return facts.get(key)?.value ?? null;
}

/**
 * Check the accounting identity assets = liabilities + equity for one period,
 * preferring the reported `LiabilitiesAndStockholdersEquity` total, falling
 * back to summing the two sides. Tolerates 0.5% for rounding-in-thousands.
 */
function checkIdentity(values: Record<string, number | null>): {
  identityOk: boolean | null;
  identityDelta: number | null;
} {
  const assets = values.totalAssets;
  if (assets === null || assets === undefined) return { identityOk: null, identityDelta: null };
  const combined =
    values.liabilitiesAndEquity ??
    (values.totalLiabilities !== null &&
    values.totalLiabilities !== undefined &&
    values.stockholdersEquity !== null &&
    values.stockholdersEquity !== undefined
      ? values.totalLiabilities + values.stockholdersEquity
      : null);
  if (combined === null) return { identityOk: null, identityDelta: null };
  const delta = assets - combined;
  return {
    identityOk: Math.abs(delta) <= Math.max(Math.abs(assets) * 0.005, 2),
    identityDelta: delta,
  };
}

/** Assemble the full statements from a companyfacts response. */
function assembleFinancials(
  factsBody: Record<string, unknown>,
  kind: 'annual' | 'quarterly',
  limit: number,
): Financials {
  const allFacts = (factsBody.facts ?? {}) as Record<string, unknown>;
  const taxonomy: Financials['taxonomy'] = allFacts['us-gaap']
    ? 'us-gaap'
    : allFacts['ifrs-full']
      ? 'ifrs-full'
      : 'us-gaap';
  if (!allFacts[taxonomy]) {
    throw new ToolError(
      'This filer has no US-GAAP or IFRS company facts (funds and trusts often report none).',
      { retryable: false },
    );
  }
  const taxFacts = allFacts[taxonomy] as TaxonomyFacts;

  const currency = detectCurrency(taxFacts, taxonomy);
  const bare = discoverPeriods(taxFacts, taxonomy, kind, limit, currency);

  const metricFacts = new Map<string, Map<string, Fact>>();
  for (const def of METRICS) {
    metricFacts.set(def.key, metricFactsByPeriod(taxFacts, def, taxonomy, currency));
  }

  const periods: StatementPeriod[] = bare.map((period) => {
    const values: Record<string, number | null> = {};
    for (const def of METRICS) {
      values[def.key] = valueFor(metricFacts.get(def.key) as Map<string, Fact>, def, period);
    }
    const ocf = values.operatingCashFlow;
    const capex = values.capitalExpenditures;
    values.freeCashFlow =
      ocf !== null && ocf !== undefined && capex !== null && capex !== undefined
        ? ocf - capex
        : null;
    // Many filers (Amazon, Alphabet, Meta, Netflix) present no gross-profit
    // subtotal; derive it when both components are reported.
    if (
      values.grossProfit === null &&
      values.revenue !== null &&
      values.revenue !== undefined &&
      values.costOfRevenue !== null &&
      values.costOfRevenue !== undefined
    ) {
      values.grossProfit = values.revenue - values.costOfRevenue;
    }
    return { ...period, values, ...checkIdentity(values) };
  });

  return { taxonomy, currency, periods };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Compact money rendering: 416160000000 → "$416.16B" (or "1.23B CAD"). */
function fmtMoney(value: number, currency: string): string {
  const abs = Math.abs(value);
  const scaled =
    abs >= 1e12
      ? `${(abs / 1e12).toFixed(2)}T`
      : abs >= 1e9
        ? `${(abs / 1e9).toFixed(2)}B`
        : abs >= 1e6
          ? `${(abs / 1e6).toFixed(2)}M`
          : abs >= 1e4
            ? `${(abs / 1e3).toFixed(1)}K`
            : abs.toFixed(2);
  const signed = value < 0 ? `-${scaled}` : scaled;
  return currency === 'USD' ? `$${signed}` : `${signed} ${currency}`;
}

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

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

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
        'equity sanity check.',
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
        const resolved = await resolveCompany(ctx, company);
        if (!resolved) throw companyNotFound(company);
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
        const resolved = await resolveCompany(ctx, company);
        if (!resolved) throw companyNotFound(company);
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
            const kind = kindOf(fact);
            // fy/fp describe the FILING; only trust them for facts filed near
            // their window end (comparatives inherit the later filing's stamps).
            const trusted =
              fact.fiscalYear !== null &&
              fact.fiscalPeriod !== null &&
              fiscalStampsTrusted(kind === 'annual' ? 'annual' : 'quarterly', fact);
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
      name: 'search_filings',
      title: 'EDGAR: Search filings',
      description:
        'Full-text search across SEC filings (2001–present). Optionally scope to one ' +
        'company (ticker/name/CIK), restrict by form type(s) (e.g. "10-K", "8-K", ' +
        '"10-K,10-Q") and a date range, and page with `from`. Matches filings that ' +
        'merely mention the terms — scope by company for precision. Returns company, ' +
        'form, filing date, and accession number per hit, deduped by filing.',
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
          const resolved = await resolveCompany(ctx, company);
          if (!resolved) throw companyNotFound(company);
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
        'range. Returns form type, filing date, accession number, and primary document. ' +
        "Filter by forms to skip the Form 4/144 noise that dominates most companies' feeds.",
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
          }),
        ),
      }),
      async handler(args, ctx) {
        const { company, forms, startDate, endDate, limit } = args;
        ctx.log('company_filings', { company, forms, limit });
        const resolved = await resolveCompany(ctx, company);
        if (!resolved) throw companyNotFound(company);
        const body = await edgarJson(
          ctx,
          submissionsUrl(resolved.cik),
          `SEC EDGAR has no filings record for CIK ${resolved.cik}.`,
        );
        const name = typeof body.name === 'string' ? body.name : resolved.name;
        const recent = ((body.filings ?? {}) as Record<string, unknown>).recent as
          | Record<string, unknown>
          | undefined;
        const formList = Array.isArray(recent?.form) ? recent.form : [];
        const dates = Array.isArray(recent?.filingDate) ? recent.filingDate : [];
        const accs = Array.isArray(recent?.accessionNumber) ? recent.accessionNumber : [];
        const docs = Array.isArray(recent?.primaryDocument) ? recent.primaryDocument : [];
        const descs = Array.isArray(recent?.primaryDocDescription)
          ? recent.primaryDocDescription
          : [];
        const wanted = forms
          ? new Set(
              forms
                .split(',')
                .map((f: string) => f.trim().toUpperCase())
                .filter(Boolean),
            )
          : null;
        const all = formList.map((f, i) => ({
          form: typeof f === 'string' ? f : '?',
          filedDate: typeof dates[i] === 'string' ? (dates[i] as string) : '?',
          accession: typeof accs[i] === 'string' ? (accs[i] as string) : '',
          primaryDocument: typeof docs[i] === 'string' ? (docs[i] as string) : null,
          description: typeof descs[i] === 'string' && descs[i] ? (descs[i] as string) : null,
        }));
        const matching = all.filter(
          (f) =>
            (!wanted || wanted.has(f.form.toUpperCase())) &&
            (!startDate || f.filedDate >= startDate) &&
            (!endDate || f.filedDate <= endDate),
        );
        const filings = matching.slice(0, limit);
        if (filings.length === 0) {
          const filterNote = wanted || startDate || endDate ? ' matching those filters' : '';
          return {
            text: `No recent filings${filterNote} for ${name} (CIK ${resolved.cik}).`,
            structured: { company: name, cik: resolved.cik, matched: 0, count: 0, filings: [] },
          };
        }
        const lines = filings
          .map((f) => `  ${f.filedDate} ${f.form}${f.description ? ` — ${f.description}` : ''}`)
          .join('\n');
        return {
          text:
            `${name} (CIK ${resolved.cik}) — ${filings.length} of ${matching.length} ` +
            `matching filing(s):\n${lines}`,
          structured: {
            company: name,
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
