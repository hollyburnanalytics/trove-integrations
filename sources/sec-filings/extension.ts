/**
 * SEC Filings source
 *
 * Fetches 10-K, 10-Q, 20-F, S-1, and F-1 filings from SEC EDGAR for tracked
 * companies. No API key needed — EDGAR is free and public.
 *
 * Discovery: Resolve ticker → CIK via company_tickers.json, then fetch the
 * submissions endpoint for each company's recent filings. The submissions
 * payload names each filing's primary document directly, so no extra index
 * lookup is needed.
 *
 * Content: the filing itself is handed to the server as an HTML artifact
 * (`fileUrl`), not flattened here. The platform retains it — so the filing is
 * readable in the app — and its HTML pass turns the markup into Markdown, which
 * keeps the headings and tables a local text-scrape destroys. That also costs
 * one fewer EDGAR request per filing, which matters against an API that answers
 * a generic client with 403.
 *
 * Config: tickers[] — array of stock ticker symbols (e.g., SHOP, SNOW, OKTA).
 */

import {
  advanceDateCursor,
  defineSource,
  readDateCursor,
  stringList,
} from '@ontrove/extend/source';
import { fetchPage } from '../lib/feeds.mjs';
import { FILING_TYPES, type Filing, filterFilings, processFiling } from './filing-document.ts';

/**
 * EDGAR refuses a generic bot User-Agent outright — a request carrying one
 * comes back 403 "Request Rate Threshold Exceeded" on the very first call,
 * whatever the actual rate. Their published policy asks for an identifying
 * organisation and a contact address, and supplying one is the difference
 * between this source working and not.
 */
const SEC_HEADERS = {
  'User-Agent': 'Hollyburn Analytics Inc. bots@hollyburnanalytics.com',
  Accept: 'application/json, text/html, */*',
};

/** EDGAR timestamps filings on Eastern time — filing days are local days. */
const DELAY_MS = 200;

/**
 * The EDGAR payloads this source reads, and the state it threads through a run.
 *
 * `RecentFilings` is EDGAR's parallel-array encoding: one array per column, all
 * the same length, indexed together. Every column is optional because only
 * `accessionNumber` is guarded before the zip — the rest are read defensively so
 * a column EDGAR stops sending costs the affected field, not the whole round.
 */
type TickerFileEntry = { ticker: string; cik_str: number; title: string };
type TickerEntry = { cik: number; name: string };
type RecentFilings = {
  accessionNumber?: string[];
  filingDate?: string[];
  reportDate?: string[];
  form?: string[];
  primaryDocument?: string[];
};
type Submissions = { name?: string; filings?: { recent?: RecentFilings } };
type SyncState = {
  documents: import('../lib/types.js').Document[];
  rawDates: number[];
  updatedTickerMap: Record<string, TickerEntry>;
  skipped: number;
  anyFailed: boolean;
};

// --- Helpers ---

// Both go through the shared fetch rather than calling `fetch` directly: it
// carries the SSRF guard, the response-size cap, the request timeout and the
// redirect handling. That mattered less when this source only ran on the
// user's own Mac; running in the cloud it fetches on everyone's behalf.

/**
 * Fetch a JSON payload from EDGAR.
 *
 * @param url - The endpoint to read.
 * @returns The parsed body, as the caller declares it.
 */
async function fetchJson<T>(url: string): Promise<T> {
  return JSON.parse(await fetchPage(url, { headers: SEC_HEADERS }));
}

/**
 * Fetch the SEC ticker→CIK mapping and build a lookup by uppercase ticker.
 *
 * @returns Every listed ticker's CIK and company name.
 */
export async function loadTickerMap(): Promise<Record<string, TickerEntry>> {
  const data: Record<string, TickerFileEntry> = await fetchJson(
    'https://www.sec.gov/files/company_tickers.json',
  );
  const map: Record<string, TickerEntry> = {};
  for (const entry of Object.values(data)) {
    map[entry.ticker.toUpperCase()] = {
      cik: entry.cik_str,
      name: entry.title,
    };
  }
  return map;
}

/**
 * Fetch a company's recent filings from the EDGAR submissions API.
 * The API returns parallel arrays — zip them into an array of objects.
 * `primaryDocument` is the actual filing document (not an exhibit), so we
 * carry it through rather than guessing from the archive index.
 *
 * @param cik - The company's CIK, padded here to EDGAR's ten digits.
 * @returns The company's
 *   registered name and its recent filings, zipped out of EDGAR's parallel arrays.
 */
export async function fetchFilings(
  cik: number | string,
): Promise<{ name: string | undefined; filings: Filing[] }> {
  const paddedCik = String(cik).padStart(10, '0');
  const data: Submissions = await fetchJson(
    `https://data.sec.gov/submissions/CIK${paddedCik}.json`,
  );
  const recent = data.filings?.recent;
  if (!recent?.accessionNumber) return { name: data.name, filings: [] };

  const count = recent.accessionNumber.length;
  const filings: Filing[] = [];
  for (let index = 0; index < count; index++) {
    filings.push({
      accessionNumber: recent.accessionNumber[index] ?? '',
      filingDate: recent.filingDate?.[index] ?? '',
      reportDate: recent.reportDate?.[index] || '',
      form: recent.form?.[index] ?? '',
      primaryDocument: recent.primaryDocument?.[index] || '',
    });
  }
  return { name: data.name, filings };
}

/**
 * Resolve a ticker to its CIK and company name, loading EDGAR's ticker file
 * once per run and only when the cache misses.
 *
 * @param context - The harness context.
 * @param upperTicker - The ticker, uppercased.
 * @param cachedTickers - Tickers resolved on a previous run.
 * @param tickerMapReference - The
 *   run's lazily-loaded ticker file, shared across tickers.
 * @returns The entry, or nothing for an unknown ticker.
 */
async function resolveTicker(
  context: import('../lib/types.js').SourceContext,
  upperTicker: string,
  cachedTickers: Record<string, TickerEntry>,
  tickerMapReference: { map: Record<string, TickerEntry> | undefined },
): Promise<TickerEntry | undefined> {
  const alreadyResolved = cachedTickers[upperTicker];
  if (alreadyResolved) {
    return alreadyResolved;
  }
  if (!tickerMapReference.map) {
    context.log.info('Loading SEC ticker map...');
    tickerMapReference.map = await loadTickerMap();
  }
  return tickerMapReference.map[upperTicker] || undefined;
}

// --- Per-ticker sync ---

/**
 * Sync one ticker: resolve it, fetch its filings, and push what is new onto the
 * run's shared state.
 *
 * @param context - The harness context.
 * @param upperTicker - The ticker, uppercased.
 * @param lastDate - The previous run's cursor, when resuming.
 * @param cachedTickers - Tickers resolved on a previous run.
 * @param tickerMapReference - The
 *   run's lazily-loaded ticker file.
 * @param state - Accumulated across every ticker in the round.
 * @returns Resolves when this ticker is done.
 */
async function syncTicker(
  context: import('../lib/types.js').SourceContext,
  upperTicker: string,
  lastDate: Date | undefined,
  cachedTickers: Record<string, TickerEntry>,
  tickerMapReference: { map: Record<string, TickerEntry> | undefined },
  state: SyncState,
): Promise<void> {
  const resolved = await resolveTicker(context, upperTicker, cachedTickers, tickerMapReference);
  if (!resolved) {
    context.log.warn(`Unknown ticker: ${upperTicker}`);
    return;
  }
  const { cik } = resolved;
  let companyName = resolved.name;

  context.log.info(`Fetching filings for ${upperTicker} (CIK ${cik})...`);
  const { name, filings } = await fetchFilings(cik);
  if (name) companyName = name;
  state.updatedTickerMap[upperTicker] = { cik, name: companyName };

  const filtered = filterFilings(filings, lastDate);
  const totalForType = filings.filter((filing) => FILING_TYPES.has(filing.form)).length;
  state.skipped += totalForType - filtered.length;

  context.log.info(`${upperTicker}: ${filtered.length} new filings`);

  for (const filing of filtered) {
    try {
      const document = processFiling(context, filing, cik, companyName, upperTicker);
      if (document) {
        state.documents.push(document);
        const dateMs = new Date(filing.filingDate).getTime();
        if (!Number.isNaN(dateMs)) state.rawDates.push(dateMs);
        context.progress(state.documents.length, `${state.documents.length} filings processed`);
      }
    } catch (error) {
      state.anyFailed = true;
      context.log.warn(
        `Failed to fetch ${filing.form} ${filing.accessionNumber}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (DELAY_MS > 0) await delay(DELAY_MS);
  }
}

/**
 * Resolve the newest filing date (ms epoch) across this run, falling back to
 * the previous cursor date when nothing new was collected.
 *
 * @param rawDates - Filing dates collected this round, in epoch ms.
 * @param lastDate - The incoming cursor.
 * @returns The newest time known, or 0 when there is none.
 */
function newestTime(rawDates: number[], lastDate: Date | undefined): number {
  if (rawDates.length > 0) return Math.max(...rawDates);
  return lastDate ? lastDate.getTime() : 0;
}

// --- Main sync ---

/**
 * Pause, to pace requests against EDGAR's rate policy.
 *
 * @param ms - How long to wait.
 * @returns Resolves once the time has passed.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export default defineSource({
  id: 'sec-filings',
  name: 'SEC Filings',
  description: '10-K, 10-Q, 20-F, S-1, and F-1 filings for tracked companies via SEC EDGAR',
  icon: '🏛️',
  version: '0.1.0',
  author: 'Hollyburn Analytics Inc.',
  kind: 'scheduled-sync',
  transport: 'api',
  cursor: 'date',
  ingest: 'append',
  runsIn: 'cloud',
  schedule: 'daily',
  status: 'implemented',
  needsBrowser: false,
  egress: ['www.sec.gov', 'data.sec.gov'],
  historyReach: {
    kind: 'window',
    note: "EDGAR's submissions endpoint returns only a company's recent filings — roughly the last thousand. Older filings live in separate archives this source does not read.",
  },
  egressNote:
    "The ticker→CIK map and each filing's EDGAR archive document are on www.sec.gov; the company submissions index is on data.sec.gov.",
  config: {
    tickers: {
      label: 'Company Tickers',
      type: 'text[]',
      default: [],
      pattern: '^[A-Za-z][A-Za-z.-]{0,9}$',
      hint: 'a ticker symbol such as SHOP or BRK-B, not a company name — search by name in the picker and it fills the symbol in',
      directory: {
        provider: 'companies',
        mode: 'search',
        placeholder: 'Search companies by name',
      },
    },
  },
  fanOut: 'tickers',
  available: true,
  async sync(context) {
    const tickers = stringList(context.config?.tickers);
    if (tickers.length === 0) {
      context.log.warn('No tickers configured');
      return { documents: [], cursor: undefined, stats: { fetched: 0 } };
    }

    const lastDate = readDateCursor(context.cursor);
    const cachedTickers: Record<string, TickerEntry> = {};
    const tickerMapReference: { map: Record<string, TickerEntry> | undefined } = { map: undefined };
    const state: SyncState = {
      documents: [],
      rawDates: [],
      updatedTickerMap: { ...cachedTickers },
      skipped: 0,
      anyFailed: false,
    };

    for (const ticker of tickers) {
      const upperTicker = ticker.toUpperCase();
      try {
        await syncTicker(context, upperTicker, lastDate, cachedTickers, tickerMapReference, state);
      } catch (error) {
        state.anyFailed = true;
        context.log.warn(
          `Failed to process ${upperTicker}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // Held when a ticker or an individual filing failed: advancing on the
    // healthy items' dates would permanently skip the failed ones.
    const maxTime = newestTime(state.rawDates, lastDate);
    const cursor = advanceDateCursor({
      previous: context.cursor || undefined,
      maxIso: maxTime > 0 ? new Date(maxTime).toISOString() : undefined,
      anyFailed: state.anyFailed,
    });

    const seenNote = state.skipped > 0 ? ` (${state.skipped} already seen)` : '';
    context.log.info(`Collected ${state.documents.length} filings${seenNote}`);

    return {
      documents: state.documents,
      cursor,
      stats: { fetched: state.documents.length, skipped: state.skipped },
    };
  },
});
