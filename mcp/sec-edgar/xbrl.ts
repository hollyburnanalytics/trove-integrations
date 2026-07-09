import { ToolError } from '@ontrove/mcp';
import {
  type Fact,
  factsForUnit,
  fiscalStampsTrusted,
  kindOf,
  latestFiledByPeriod,
  periodKey,
  pickUnitKey,
} from './facts.ts';
import {
  ANCHOR,
  METRICS,
  type MetricDef,
  type Taxonomy,
  tagsFor,
  unitPreference,
} from './metrics.ts';

/**
 * Statement assembly for the sec-edgar server: discovering reporting periods,
 * detecting the reporting taxonomy and currency, and assembling full financial
 * statements from a data.sec.gov companyfacts response. The raw-fact layer it
 * builds on lives in `facts.ts`; the statement line-item table in `metrics.ts`.
 */

// ---------------------------------------------------------------------------
// get_financials: statement assembly
// ---------------------------------------------------------------------------

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
 * Sanity-check an annual fiscal-year stamp against the window it labels. For
 * windows ending July–December the fiscal year IS the end year; for windows
 * ending January–June (retail-style fiscal calendars) either the end year or
 * the prior year is conventional. Some filings carry a wrong stamp on their
 * OWN period (observed: a 40-F for the year ending 2023-12-31 stamped fy 2022)
 * — such stamps are corrected (month ≥ 7) or dropped rather than echoed.
 */
function annualFiscalYear(fact: Fact): number | null {
  if (fact.fiscalYear === null) return null;
  const endYear = Number.parseInt(fact.end.slice(0, 4), 10);
  const endMonth = Number.parseInt(fact.end.slice(5, 7), 10);
  if (endMonth >= 7) return endYear;
  return fact.fiscalYear === endYear || fact.fiscalYear === endYear - 1 ? fact.fiscalYear : null;
}

/** Human period label from the original filing's fiscal-year/period stamps. */
function periodLabel(kind: 'annual' | 'quarterly', fact: Fact): string {
  if (fact.fiscalYear !== null && fact.fiscalPeriod !== null && fiscalStampsTrusted(kind, fact)) {
    if (kind === 'annual') {
      const fy = annualFiscalYear(fact);
      return fy === null ? `FY ending ${fact.end}` : `FY${fy}`;
    }
    return `${fact.fiscalPeriod} FY${fact.fiscalYear}`;
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
      const fiscalYear = !trusted
        ? null
        : kind === 'annual'
          ? annualFiscalYear(fact)
          : fact.fiscalYear;
      return {
        label: periodLabel(kind, fact),
        start: fact.start ?? fact.end,
        end: fact.end,
        fiscalYear,
        fiscalPeriod: trusted && fiscalYear !== null ? fact.fiscalPeriod : null,
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

/** The latest `end` date across every fact in one concept's units map ('' if none). */
function latestEndInUnits(units: Record<string, unknown>): string {
  let latest = '';
  for (const facts of Object.values(units)) {
    if (!Array.isArray(facts)) continue;
    for (const fact of facts) {
      const end = (fact as { end?: unknown }).end;
      if (typeof end === 'string' && end > latest) latest = end;
    }
  }
  return latest;
}

/** The most recent anchor-fact period end within one taxonomy bucket ('' if none). */
function latestAnchorEnd(taxFacts: TaxonomyFacts, taxonomy: Taxonomy): string {
  let latest = '';
  for (const tag of tagsFor(ANCHOR, taxonomy)) {
    const units = taxFacts[tag]?.units;
    if (!units) continue;
    const end = latestEndInUnits(units);
    if (end > latest) latest = end;
  }
  return latest;
}

/**
 * Pick the reporting taxonomy by RECENCY of its facts, never by a static
 * priority: filers that switched standards (commonly US GAAP → IFRS) keep
 * their stale pre-switch bucket in companyfacts forever, and a priority pick
 * would silently serve decade-old numbers as current.
 */
function pickTaxonomy(allFacts: Record<string, unknown>): Financials['taxonomy'] {
  const candidates: Financials['taxonomy'][] = ['us-gaap', 'ifrs-full'];
  let best: Financials['taxonomy'] = 'us-gaap';
  let bestEnd = '';
  for (const taxonomy of candidates) {
    if (!allFacts[taxonomy]) continue;
    const end = latestAnchorEnd(allFacts[taxonomy] as TaxonomyFacts, taxonomy);
    if (end > bestEnd) {
      best = taxonomy;
      bestEnd = end;
    }
  }
  return best;
}

/** Assemble the full statements from a companyfacts response. */
export function assembleFinancials(
  factsBody: Record<string, unknown>,
  kind: 'annual' | 'quarterly',
  limit: number,
): Financials {
  const allFacts = (factsBody.facts ?? {}) as Record<string, unknown>;
  const taxonomy = pickTaxonomy(allFacts);
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
    // Some filers (Shopify, Cameco) tag no total-liabilities line; derive it
    // from the reported combined total minus equity.
    if (
      values.totalLiabilities === null &&
      values.liabilitiesAndEquity !== null &&
      values.liabilitiesAndEquity !== undefined &&
      values.stockholdersEquity !== null &&
      values.stockholdersEquity !== undefined
    ) {
      values.totalLiabilities = values.liabilitiesAndEquity - values.stockholdersEquity;
    }
    return { ...period, values, ...checkIdentity(values) };
  });

  return { taxonomy, currency, periods };
}
