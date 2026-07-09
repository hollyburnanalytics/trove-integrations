import { xmlBlocks, xmlNumber, xmlValue } from './client.ts';

/**
 * 13F holdings parsing. The information table is a stable SEC XML schema —
 * deterministic structured parsing, no heuristics — with ONE data quirk that
 * needs care: the SEC switched the `<value>` column from thousands of dollars
 * to whole dollars for periods ending 2023+, but the unit is a property of the
 * individual filing (late and amended filings keep both units alive in every
 * period), so a date cutoff mis-scales real filings. Units are instead
 * detected per filing from implied share prices: if most equity holdings imply
 * a sub-$1 share price, the values are in thousands (no real portfolio is
 * mostly penny-priced).
 */

export interface Holding {
  issuer: string | null;
  titleOfClass: string | null;
  cusip: string | null;
  /** Market value in whole dollars (normalized; see `valueUnits`). */
  value: number;
  shares: number | null;
  /** "SH" (shares) or "PRN" (principal amount, for debt). */
  sharesType: string | null;
  /** "Put" or "Call" when the row is an option position, else null. */
  putCall: string | null;
  investmentDiscretion: string | null;
  votingSole: number | null;
  votingShared: number | null;
  votingNone: number | null;
}

export interface InfoTable {
  holdings: Holding[];
  /** How the raw `<value>` column was interpreted. */
  valueUnits: 'dollars' | 'thousands';
}

function parseRow(block: string): Holding | null {
  const value = xmlNumber(block, 'value');
  if (value === null) return null;
  return {
    issuer: xmlValue(block, 'nameOfIssuer'),
    titleOfClass: xmlValue(block, 'titleOfClass'),
    cusip: xmlValue(block, 'cusip'),
    value,
    shares: xmlNumber(block, 'sshPrnamt'),
    sharesType: xmlValue(block, 'sshPrnamtType'),
    putCall: xmlValue(block, 'putCall'),
    investmentDiscretion: xmlValue(block, 'investmentDiscretion'),
    votingSole: xmlNumber(block, 'Sole'),
    votingShared: xmlNumber(block, 'Shared'),
    votingNone: xmlNumber(block, 'None'),
  };
}

/**
 * Detect whether a filing's `<value>` column is in whole dollars or thousands:
 * across plain-equity rows (shares, not options), a majority implying a share
 * price under $1 is decisive for thousands. Filings with no priceable equity
 * rows fall back to the SEC's schema-cutover date.
 */
function detectValueUnits(
  holdings: Holding[],
  periodOfReport: string | null,
): InfoTable['valueUnits'] {
  let priceable = 0;
  let subDollar = 0;
  for (const h of holdings) {
    if (h.sharesType !== 'SH' || h.putCall !== null) continue;
    if (h.shares === null || h.shares <= 0 || h.value <= 0) continue;
    priceable += 1;
    if (h.value / h.shares < 1) subDollar += 1;
  }
  if (priceable > 0) return subDollar / priceable >= 0.5 ? 'thousands' : 'dollars';
  return periodOfReport !== null && periodOfReport < '2023-01-01' ? 'thousands' : 'dollars';
}

/**
 * Parse a 13F information-table XML into normalized holdings with values in
 * whole dollars.
 */
export function parseInfoTable(xml: string, periodOfReport: string | null): InfoTable {
  const holdings: Holding[] = [];
  for (const block of xmlBlocks(xml, 'infoTable')) {
    const row = parseRow(block);
    if (row) holdings.push(row);
  }
  const valueUnits = detectValueUnits(holdings, periodOfReport);
  if (valueUnits === 'thousands') {
    for (const h of holdings) h.value *= 1000;
  }
  return { holdings, valueUnits };
}

/** Fold a duplicate row's totals into an accumulator, null-summing each field. */
function mergeHolding(existing: Holding, h: Holding): void {
  existing.value += h.value;
  if (h.shares !== null) existing.shares = (existing.shares ?? 0) + h.shares;
  if (h.votingSole !== null) existing.votingSole = (existing.votingSole ?? 0) + h.votingSole;
  if (h.votingShared !== null)
    existing.votingShared = (existing.votingShared ?? 0) + h.votingShared;
  if (h.votingNone !== null) existing.votingNone = (existing.votingNone ?? 0) + h.votingNone;
}

/**
 * Aggregate duplicate rows. The key is (CUSIP, put/call) — never CUSIP alone,
 * or option positions would merge into the underlying equity.
 */
export function aggregateHoldings(holdings: Holding[]): Holding[] {
  const byKey = new Map<string, Holding>();
  for (const h of holdings) {
    const key = `${h.cusip ?? h.issuer ?? '?'}|${h.putCall ?? ''}`;
    const existing = byKey.get(key);
    if (existing) mergeHolding(existing, h);
    else byKey.set(key, { ...h });
  }
  return [...byKey.values()].sort((a, b) => b.value - a.value);
}

export interface CoverPage {
  manager: string | null;
  periodOfReport: string | null;
  reportType: string | null;
  amendmentType: string | null;
  /** The manager's own declared total, in the filing's raw value units. */
  tableValueTotal: number | null;
}

/** Convert the primary doc's `MM-DD-YYYY` period to ISO `YYYY-MM-DD`. */
function isoPeriod(raw: string | null): string | null {
  if (raw === null) return null;
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(raw);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : raw;
}

/** Parse the 13F primary document (cover + summary page). */
export function parseCoverPage(xml: string): CoverPage {
  // The summaryPage is entirely absent on 13F-NT notices — tolerate that.
  const summary = xmlBlocks(xml, 'summaryPage')[0] ?? '';
  const managerBlock = xmlBlocks(xml, 'filingManager')[0] ?? '';
  return {
    manager: managerBlock === '' ? null : xmlValue(managerBlock, 'name'),
    periodOfReport: isoPeriod(xmlValue(xml, 'periodOfReport')),
    reportType: xmlValue(xml, 'reportType'),
    amendmentType: xmlValue(xml, 'amendmentType'),
    tableValueTotal: summary === '' ? null : xmlNumber(summary, 'tableValueTotal'),
  };
}
