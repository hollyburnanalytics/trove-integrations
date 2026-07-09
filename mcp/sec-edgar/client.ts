import { type ToolContext, ToolError } from '@ontrove/mcp';
import { createEgressClient } from '../lib/egress.ts';

/**
 * Shared SEC EDGAR plumbing for the sec-edgar server modules: the resilient
 * egress client (SEC-required User-Agent, fair-access throttle, cache), JSON
 * and document fetch helpers, URL builders, entity resolution, and small
 * formatting/XML utilities used across the tools.
 */

/**
 * SEC-required descriptive User-Agent (their fair-access policy). SEC blocks
 * non-deliverable contacts — including GitHub `noreply` addresses — with a 403,
 * so this must stay a real, monitored operator inbox.
 */
const CONTACT_EMAIL = 'sec-edgar@ontrove.sh';
const USER_AGENT = `Trove MCP (${CONTACT_EMAIL})`;

/**
 * EDGAR data is highly cacheable (filings never change; the ticker map and
 * fact sets update at most daily), so repeats are served from the in-isolate
 * cache. Oversized bodies (multi-megabyte companyfacts responses and large
 * filing documents) are deliberately never cached. The SEC's fair-access
 * policy allows up to 10 requests/second (throttled) and signals rate-limiting
 * as 429 or as a 403 "Request Rate Threshold Exceeded" page — both retried as
 * transient.
 */
export const edgar = createEgressClient({
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

// --- URL builders -----------------------------------------------------------

export const TICKER_MAP_URL = 'https://www.sec.gov/files/company_tickers_exchange.json';
export const submissionsUrl = (cik: string): string =>
  `https://data.sec.gov/submissions/CIK${cik}.json`;
export const companyFactsUrl = (cik: string): string =>
  `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
export const companyConceptUrl = (cik: string, taxonomy: string, concept: string): string =>
  `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/${taxonomy}/${encodeURIComponent(concept)}.json`;

/** Archives directory for one filing (CIK unpadded, accession without dashes). */
export const filingDirUrl = (cik: string, accession: string): string =>
  `https://www.sec.gov/Archives/edgar/data/${Number.parseInt(cik, 10)}/${accession.replaceAll('-', '')}`;

/** Fetch + parse an EDGAR JSON body, mapping 400/404 to `notFound` (non-retryable). */
export async function edgarJson(
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

/** Fetch a document body (HTML/XML/text), mapping 400/404 to `notFound`. */
export async function edgarDocument(
  ctx: ToolContext,
  url: string,
  notFound: string,
): Promise<string> {
  const { status, body } = await edgar.fetch(ctx, url, { accept: 'text/html, application/xml' });
  if (status === 400 || status === 404) throw new ToolError(notFound, { retryable: false });
  return body;
}

// --- Entity resolution ------------------------------------------------------

export interface Company {
  cik: string;
  name: string;
  ticker?: string;
  exchange?: string;
}

/**
 * Resolve a company identifier to its 10-digit zero-padded CIK. Accepts a bare
 * CIK number, an exact ticker (share-class dots normalized, so "BRK.B" matches
 * EDGAR's "BRK-B"), or — as a fallback — a company-name match against the SEC's
 * ticker/exchange map (exact name first, then prefix, then substring).
 */
export async function resolveCompany(ctx: ToolContext, query: string): Promise<Company | null> {
  const trimmed = query.trim();
  if (/^\d{1,10}$/.test(trimmed)) {
    return { cik: trimmed.padStart(10, '0'), name: '' };
  }
  const map = await edgarJson(ctx, TICKER_MAP_URL, 'The SEC ticker map is unavailable.');
  const rows = Array.isArray(map.data) ? map.data : [];
  const entries: Company[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const [cik, name, ticker, exchange] = row as [unknown, unknown, unknown, unknown];
    if (typeof name !== 'string' || typeof ticker !== 'string') continue;
    entries.push({
      cik: String(cik ?? '').padStart(10, '0'),
      name,
      ticker: ticker.toUpperCase(),
      exchange: typeof exchange === 'string' ? exchange : undefined,
    });
  }

  const target = trimmed.toUpperCase();
  const dashed = target.replaceAll('.', '-');
  for (const entry of entries) {
    if (entry.ticker === target || entry.ticker === dashed) return entry;
  }

  // Name fallback: exact (case-insensitive), then prefix, then substring.
  const lower = trimmed.toLowerCase();
  const byName =
    entries.find((entry) => entry.name.toLowerCase() === lower) ??
    entries.find((entry) => entry.name.toLowerCase().startsWith(lower)) ??
    (lower.length >= 3
      ? entries.find((entry) => entry.name.toLowerCase().includes(lower))
      : undefined);
  return byName ?? null;
}

/**
 * Resolve an ownership filer (an individual insider or entity) to a CIK via
 * EDGAR's filer index. Individuals are conformed as "Last First" (e.g.
 * "Cook Timothy"), and prefix matching applies — the first match wins.
 */
export async function resolveOwner(ctx: ToolContext, query: string): Promise<string | null> {
  const trimmed = query.trim();
  if (/^\d{1,10}$/.test(trimmed)) return trimmed.padStart(10, '0');
  const url =
    'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany' +
    `&company=${encodeURIComponent(trimmed)}&type=4&owner=include&count=10&output=atom`;
  const body = await edgarDocument(ctx, url, 'The EDGAR filer index is unavailable.');
  const cik = xmlValue(body, 'cik');
  return cik === null ? null : cik.padStart(10, '0');
}

export function companyNotFound(query: string): ToolError {
  return new ToolError(
    `No SEC company found for "${query}" (try a ticker like "AAPL", a company name, or a CIK).`,
    { retryable: false },
  );
}

/** Resolve a company or throw the standard not-found error. */
export async function requireCompany(ctx: ToolContext, query: string): Promise<Company> {
  const resolved = await resolveCompany(ctx, query);
  if (!resolved) throw companyNotFound(query);
  return resolved;
}

/**
 * Accession numbers are accepted with or without dashes; EDGAR URLs and the
 * submissions feed use the dashed form ("0000320193-25-000079").
 */
export function normalizeAccession(accession: string): string {
  return accession.includes('-')
    ? accession
    : `${accession.slice(0, 10)}-${accession.slice(10, 12)}-${accession.slice(12)}`;
}

// --- Formatting -------------------------------------------------------------

/** Compact money rendering: 416160000000 → "$416.16B" (or "1.23B CAD"). */
export function fmtMoney(value: number, currency: string): string {
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

// --- Minimal XML extraction (the runtime has no DOMParser) -------------------

/** Every `<tag>…</tag>` inner body in `xml`, namespace-prefix-agnostic. */
export function xmlBlocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'g');
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) {
    out.push(m[1] ?? '');
  }
  return out;
}

/** Decode the numeric + basic named entities SEC XML/HTML uses. */
export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([\da-fA-F]+);/g, (_, hex: string) => {
      const n = Number.parseInt(hex, 16);
      return Number.isFinite(n) && n >= 0 && n <= 0x10_ff_ff ? String.fromCodePoint(n) : '';
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const n = Number.parseInt(dec, 10);
      return Number.isFinite(n) && n >= 0 && n <= 0x10_ff_ff ? String.fromCodePoint(n) : '';
    })
    .replace(/&amp;/g, '&');
}

/**
 * First `<tag>…</tag>` inner text in `xml`. Ownership documents wrap most
 * values in a `<value>` child (with optional `<footnoteId/>` siblings), so
 * when one is present its text wins; otherwise child tags are stripped.
 */
export function xmlValue(xml: string, tag: string): string | null {
  const block = xmlBlocks(xml, tag)[0];
  if (block === undefined) return null;
  const value = xmlBlocks(block, 'value')[0] ?? block;
  const text = decodeXmlEntities(value.replace(/<[^>]*>/g, ' ')).trim();
  return text === '' ? null : text;
}

/** `xmlValue` parsed as a finite number (footnote-only values become null). */
export function xmlNumber(xml: string, tag: string): number | null {
  const text = xmlValue(xml, tag);
  if (text === null) return null;
  const n = Number.parseFloat(text.replaceAll(',', ''));
  return Number.isFinite(n) ? n : null;
}

/** `xmlValue` interpreted as an SEC boolean ("1"/"true" → true). */
export function xmlFlag(xml: string, tag: string): boolean {
  const text = xmlValue(xml, tag);
  return text === '1' || text?.toLowerCase() === 'true';
}
