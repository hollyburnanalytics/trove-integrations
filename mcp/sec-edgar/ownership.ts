import { xmlBlocks, xmlFlag, xmlNumber, xmlValue } from './client.ts';

/**
 * Form 3/4/5 ownership-document parsing. The SEC's ownership XML schema has
 * been stable since 2003, so this is deterministic structured parsing — no
 * heuristics. Direction (buy vs. sell) always comes from the
 * `transactionAcquiredDisposedCode` (A/D), never from the transaction-code
 * letter; only open-market trades (codes P and S) count toward the buy/sell
 * summary, so grants, option exercises, gifts, and tax withholding never
 * masquerade as conviction trades.
 */

/** SEC Form 4 transaction codes → plain-English meaning. */
export const TRANSACTION_CODES: Record<string, string> = {
  P: 'Open-market purchase',
  S: 'Open-market sale',
  A: 'Grant or award',
  M: 'Option exercise',
  F: 'Tax withholding (shares surrendered)',
  G: 'Gift',
  X: 'Option exercise (in-the-money)',
  D: 'Disposition to issuer',
  C: 'Conversion of derivative',
  E: 'Expiration of short position',
  H: 'Expiration of long position',
  I: 'Discretionary transaction',
  O: 'Exercise of out-of-the-money derivative',
  U: 'Disposition (tender of shares)',
  W: 'Acquisition or disposition by will',
  Z: 'Deposit into/withdrawal from voting trust',
  J: 'Other (see footnotes)',
  K: 'Equity swap transaction',
  L: 'Small acquisition',
};

export interface InsiderTransaction {
  security: string | null;
  date: string | null;
  code: string | null;
  codeDescription: string | null;
  /** "A" (acquired) or "D" (disposed) — the authoritative direction. */
  acquiredDisposed: string | null;
  shares: number | null;
  pricePerShare: number | null;
  /** shares × price, when both are reported. */
  value: number | null;
  sharesOwnedAfter: number | null;
  /** "D" direct or "I" indirect ownership. */
  ownership: string | null;
  /** True for derivative-table rows (options, RSUs, warrants). */
  derivative: boolean;
  underlyingSecurity: string | null;
  exercisePrice: number | null;
}

export interface OwnershipFiling {
  owners: string[];
  officerTitle: string | null;
  isDirector: boolean;
  isOfficer: boolean;
  isTenPercentOwner: boolean;
  issuer: string | null;
  issuerTicker: string | null;
  issuerCik: string | null;
  periodOfReport: string | null;
  /** The document's 10b5-1 trading-plan checkbox (Form 4 amendments of 2023+). */
  planned10b5One: boolean;
  transactions: InsiderTransaction[];
}

function parseTransaction(block: string, derivative: boolean): InsiderTransaction {
  const code = xmlValue(block, 'transactionCode');
  const shares = xmlNumber(block, 'transactionShares');
  const price = xmlNumber(block, 'transactionPricePerShare');
  return {
    security: xmlValue(block, 'securityTitle'),
    date: xmlValue(block, 'transactionDate'),
    code,
    codeDescription: code === null ? null : (TRANSACTION_CODES[code] ?? null),
    acquiredDisposed: xmlValue(block, 'transactionAcquiredDisposedCode'),
    shares,
    pricePerShare: price,
    value: shares !== null && price !== null ? shares * price : null,
    sharesOwnedAfter: xmlNumber(block, 'sharesOwnedFollowingTransaction'),
    ownership: xmlValue(block, 'directOrIndirectOwnership'),
    derivative,
    underlyingSecurity: derivative ? xmlValue(block, 'underlyingSecurityTitle') : null,
    exercisePrice: derivative ? xmlNumber(block, 'conversionOrExercisePrice') : null,
  };
}

/** Parse one ownership document (Form 3/4/5 XML) into a normalized filing. */
export function parseOwnershipXml(xml: string): OwnershipFiling {
  const ownerBlocks = xmlBlocks(xml, 'reportingOwner');
  const owners: string[] = [];
  let officerTitle: string | null = null;
  let isDirector = false;
  let isOfficer = false;
  let isTenPercentOwner = false;
  for (const block of ownerBlocks) {
    const name = xmlValue(block, 'rptOwnerName');
    if (name) owners.push(name);
    officerTitle ??= xmlValue(block, 'officerTitle');
    isDirector ||= xmlFlag(block, 'isDirector');
    isOfficer ||= xmlFlag(block, 'isOfficer');
    isTenPercentOwner ||= xmlFlag(block, 'isTenPercentOwner');
  }

  const transactions = [
    ...xmlBlocks(xml, 'nonDerivativeTransaction').map((b) => parseTransaction(b, false)),
    ...xmlBlocks(xml, 'derivativeTransaction').map((b) => parseTransaction(b, true)),
  ];

  const issuerCik = xmlValue(xml, 'issuerCik');
  return {
    owners,
    officerTitle,
    isDirector,
    isOfficer,
    isTenPercentOwner,
    issuer: xmlValue(xml, 'issuerName'),
    issuerTicker: xmlValue(xml, 'issuerTradingSymbol'),
    issuerCik: issuerCik === null ? null : issuerCik.padStart(10, '0'),
    periodOfReport: xmlValue(xml, 'periodOfReport'),
    planned10b5One: xmlFlag(xml, 'aff10b5One'),
    transactions,
  };
}

export interface InsiderSummary {
  openMarketPurchases: { transactions: number; shares: number; value: number };
  openMarketSales: { transactions: number; shares: number; value: number };
  /** Open-market purchase shares minus sale shares (P/S codes only). */
  netShares: number;
}

/**
 * Aggregate open-market activity across filings. Only non-derivative P
 * (purchase) and S (sale) rows count — the conventional definition of insider
 * buying/selling conviction.
 */
export function summarizeOpenMarket(filings: OwnershipFiling[]): InsiderSummary {
  const buys = { transactions: 0, shares: 0, value: 0 };
  const sells = { transactions: 0, shares: 0, value: 0 };
  for (const filing of filings) {
    for (const txn of filing.transactions) {
      if (txn.derivative || txn.shares === null) continue;
      const bucket = txn.code === 'P' ? buys : txn.code === 'S' ? sells : null;
      if (!bucket) continue;
      bucket.transactions += 1;
      bucket.shares += txn.shares;
      bucket.value += txn.value ?? 0;
    }
  }
  return {
    openMarketPurchases: buys,
    openMarketSales: sells,
    netShares: buys.shares - sells.shares,
  };
}
