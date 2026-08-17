/**
 * The SEC company directory — EDGAR's own ticker registry (trove docs/39).
 *
 * The `tickers` field holds symbols, and a symbol is a memory test: people know
 * "Shopify", not that it files as `SHOP`. This turns the field into a search by
 * company name.
 *
 * **Deliberately the same registry the adapter resolves against.** `sec-filings`
 * maps ticker → CIK through `company_tickers.json` before it can fetch
 * anything, so offering a company from any *other* list would eventually offer
 * one the adapter cannot resolve — a subscription that looks fine and collects
 * nothing. Reading the same file makes "you can pick it" and "we can sync it"
 * the same statement. It is also why nothing here is hard-coded: the registry
 * is EDGAR's, and companies list, delist and rename without asking us.
 *
 * Auth is declared, not held. EDGAR refuses a generic User-Agent — it wants an
 * identifying one with a contact — and identity is the seam's to supply, the
 * same way a credential is (D2a). This repository is public.
 *
 * @module
 */

/** EDGAR's ticker → CIK registry: every company with a listed symbol. */
const REGISTRY_URL = 'https://www.sec.gov/files/company_tickers.json';

/** The seam attaches EDGAR's required identifying User-Agent. */
export const auth = 'sec-edgar';

/**
 * Rows from the registry payload, which is an object keyed by row number
 * rather than an array.
 *
 * @param {unknown} [payload] - The parsed `company_tickers.json`.
 * @returns {Array<{ticker: string, name: string}>}
 */
export function parseRegistry(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const out = [];
  for (const row of Object.values(payload)) {
    if (!row || typeof row !== 'object') continue;
    const ticker = typeof row.ticker === 'string' ? row.ticker.trim().toUpperCase() : '';
    const name = typeof row.title === 'string' ? row.title.trim() : '';
    if (ticker && name) out.push({ ticker, name });
  }
  return out;
}

/**
 * Rank matches so the obvious answer is first.
 *
 * An exact symbol beats a symbol prefix, which beats a company-name match. Without
 * this, searching "shop" buries SHOP under every company with "shop" in its
 * name, and the one thing the person certainly meant is off the bottom.
 *
 * @param {{ticker: string, name: string}} row
 * @param {string} term - Lower-cased search term.
 * @returns {number} Rank, lower is better; Infinity means no match.
 */
export function matchRank(row, term) {
  const ticker = row.ticker.toLowerCase();
  const name = row.name.toLowerCase();
  if (ticker === term) return 0;
  if (ticker.startsWith(term)) return 1;
  if (name.toLowerCase().startsWith(term)) return 2;
  if (name.includes(term)) return 3;
  return Number.POSITIVE_INFINITY;
}

/**
 * Answer a directory query over the registry.
 *
 * An empty query returns nothing rather than a featured set: ten thousand
 * companies in registry order is not a browse, and EDGAR publishes no notion of
 * a notable one. This field is searched, not browsed.
 *
 * @param {import('../types.d.ts').DirectoryQuery} input
 * @param {import('../types.d.ts').DirectoryContext} context - The directory context (signing fetch + log).
 * @returns {Promise<import('../types.d.ts').DirectoryEntry[]>} Company entries whose value is the ticker.
 */
export async function query(input, context) {
  const term = (input.query ?? '').trim().toLowerCase();
  if (term === '') return [];

  const response = await context.fetch(REGISTRY_URL);
  if (!response.ok) {
    throw new Error(`SEC returned ${String(response.status)} for its company registry`);
  }

  const rows = parseRegistry(await response.json());
  return rows
    .map((row) => ({ row, rank: matchRank(row, term) }))
    .filter((match) => Number.isFinite(match.rank))
    .toSorted((a, b) => a.rank - b.rank || a.row.ticker.localeCompare(b.row.ticker))
    .slice(0, input.limit)
    .map(({ row }) => ({ value: row.ticker, title: row.name, subtitle: row.ticker }));
}
