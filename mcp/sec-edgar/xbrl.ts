import { ToolError } from '@ontrove/mcp';

/**
 * XBRL fact handling for the sec-edgar server: fact normalization, reporting-
 * window classification, statement metric definitions, and the assembly of
 * full financial statements from a data.sec.gov companyfacts response.
 */

// ---------------------------------------------------------------------------
// XBRL facts: parsing, period classification, and fact selection
// ---------------------------------------------------------------------------

/** One reported XBRL fact, normalized from the data.sec.gov shape. */
export interface Fact {
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

export type PeriodKind = 'annual' | 'quarterly' | 'instant' | 'other';

const DAY_MS = 86_400_000;

/**
 * Classify a fact by its reporting window. Durations tolerate 52/53-week
 * fiscal calendars (annual years run 364–371 days, quarters 91–98). Facts with
 * other windows (six- and nine-month year-to-date figures in 10-Qs) are
 * excluded from period matching so YTD numbers never masquerade as quarters.
 */
export function kindOf(fact: Fact): PeriodKind {
  if (fact.start === null) return 'instant';
  const days = (Date.parse(fact.end) - Date.parse(fact.start)) / DAY_MS;
  if (days >= 330 && days <= 400) return 'annual';
  if (days >= 75 && days <= 115) return 'quarterly';
  return 'other';
}

/** Normalize one raw `units` array entry into a {@link Fact} (or null if unusable). */
export function parseFact(raw: unknown): Fact | null {
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
export function pickUnitKey(units: Record<string, unknown>, preferred: string[]): string | null {
  for (const key of preferred) if (Array.isArray(units[key])) return key;
  const first = Object.keys(units).find((key) => Array.isArray(units[key]));
  return first ?? null;
}

/** All normalized facts for one concept in one unit. */
export function factsForUnit(units: Record<string, unknown>, unitKey: string): Fact[] {
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
export const periodKey = (start: string | null, end: string): string => `${start ?? ''}|${end}`;

/**
 * Deduplicate facts that report the same window: the same period appears in
 * many filings (originals, comparatives, amendments); the latest-filed fact
 * wins so restated/amended figures are preferred.
 */
export function latestFiledByPeriod(facts: Fact[]): Map<string, Fact> {
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

export type Statement = 'income' | 'balance' | 'cashFlow';

export interface MetricDef {
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
export const METRICS: MetricDef[] = [
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
export interface StatementPeriod {
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

export interface Financials {
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
export function fiscalStampsTrusted(kind: 'annual' | 'quarterly' | 'instant', fact: Fact): boolean {
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
export function assembleFinancials(
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
