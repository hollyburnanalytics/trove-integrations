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
 * (`file_url`), not flattened here. The platform retains it — so the filing is
 * readable in the app — and its HTML pass turns the markup into Markdown, which
 * keeps the headings and tables a local text-scrape destroys. That also costs
 * one fewer EDGAR request per filing, which matters against an API that answers
 * a generic client with 403.
 *
 * Config: tickers[] — array of stock ticker symbols (e.g., SHOP, SNOW, OKTA).
 */

import { dayToLocalNoonIso, fetchPage, stableId } from '../../lib/feeds.mjs';
import { advanceDateWatermark, readDateWatermark } from '../../lib/watermark.mjs';

const FILING_TYPES = new Set([
  '10-K',
  '10-K/A',
  '10-Q',
  '10-Q/A',
  '20-F',
  '20-F/A',
  'S-1',
  'S-1/A',
  'F-1',
  'F-1/A',
]);

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
const FILING_TIME_ZONE = 'America/New_York';
const DELAY_MS = 200;

// --- Helpers ---

// Both go through the shared fetch rather than calling `fetch` directly: it
// carries the SSRF guard, the response-size cap, the request timeout and the
// redirect handling. That mattered less when this source only ran on the
// user's own Mac; running in the cloud it fetches on everyone's behalf.

async function fetchJson(url) {
  return JSON.parse(await fetchPage(url, { headers: SEC_HEADERS }));
}

/**
 * Fetch the SEC ticker→CIK mapping and build a lookup by uppercase ticker.
 */
export async function loadTickerMap() {
  const data = await fetchJson('https://www.sec.gov/files/company_tickers.json');
  const map = {};
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
 */
export async function fetchFilings(cik) {
  const paddedCik = String(cik).padStart(10, '0');
  const data = await fetchJson(`https://data.sec.gov/submissions/CIK${paddedCik}.json`);
  const recent = data.filings?.recent;
  if (!recent?.accessionNumber) return { name: data.name, filings: [] };

  const count = recent.accessionNumber.length;
  const filings = [];
  for (let index = 0; index < count; index++) {
    filings.push({
      accessionNumber: recent.accessionNumber[index],
      filingDate: recent.filingDate[index],
      reportDate: recent.reportDate?.[index] || '',
      form: recent.form[index],
      primaryDocument: recent.primaryDocument?.[index] || '',
    });
  }
  return { name: data.name, filings };
}

/**
 * Filter filings to target types and optionally by date cursor.
 */
export function filterFilings(filings, afterDate) {
  return filings.filter((filing) => {
    if (!FILING_TYPES.has(filing.form)) return false;
    if (afterDate) {
      const filed = new Date(filing.filingDate);
      if (!Number.isNaN(filed.getTime()) && filed <= afterDate) return false;
    }
    return true;
  });
}

/** The EDGAR archive URL of a filing's primary document. */
function buildDocumentUrl(cik, accessionNumber, primaryDocument) {
  const accumulatorNoDashes = accessionNumber.replaceAll('-', '');
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${accumulatorNoDashes}/${primaryDocument}`;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// --- Per-filing processing ---

function processFiling(context, filing, cik, companyName, upperTicker) {
  if (!filing.primaryDocument?.endsWith('.htm')) {
    context.log.warn(`No HTML primary document for ${filing.form} ${filing.accessionNumber}`);
    return;
  }
  const documentUrl = buildDocumentUrl(cik, filing.accessionNumber, filing.primaryDocument);

  const dateLabel = filing.reportDate || filing.filingDate;
  const period = filing.reportDate || 'N/A';
  const header = `${companyName} ${filing.form}\nFiled: ${filing.filingDate}\nPeriod: ${period}`;
  return {
    id: stableId('sec', filing.accessionNumber),
    title: `${companyName} ${filing.form} (${dateLabel})`,
    // The header only. The filing itself is the body, extracted server-side —
    // see `file_url` below.
    text: header,
    // Hand over the filing rather than a flattened copy of it.
    //
    // This adapter used to fetch each filing and reduce it to plain text here.
    // That put extraction in the wrong place: it threw away the headings and
    // tables the platform's HTML pass turns into Markdown, it capped every
    // document at 100,000 characters (a 10-K stops mid-Part-II), it kept no
    // retrievable copy of the filing, and it spent one EDGAR request per filing
    // on work the server would do anyway — against an API that answers a
    // generic client with 403.
    file_url: documentUrl,
    mime_type: 'text/html',
    url: documentUrl,
    author: companyName,
    // EDGAR reports a bare filing day (`YYYY-MM-DD`) on Eastern time. Anchor it
    // to noon there: left bare it parses as midnight UTC, which renders as the
    // *previous* day across North America.
    date: dayToLocalNoonIso(filing.filingDate, FILING_TIME_ZONE),
    tags: [filing.form, upperTicker],
  };
}

// --- Ticker resolution ---

async function resolveTicker(context, upperTicker, cachedTickers, tickerMapReference) {
  if (cachedTickers[upperTicker]) {
    return cachedTickers[upperTicker];
  }
  if (!tickerMapReference.map) {
    context.log.info('Loading SEC ticker map...');
    tickerMapReference.map = await loadTickerMap();
  }
  return tickerMapReference.map[upperTicker] || undefined;
}

// --- Per-ticker sync ---

async function syncTicker(
  context,
  upperTicker,
  lastDate,
  cachedTickers,
  tickerMapReference,
  state,
) {
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
        `Failed to fetch ${filing.form} ${filing.accessionNumber}: ${error.message}`,
      );
    }
    if (DELAY_MS > 0) await delay(DELAY_MS);
  }
}

/**
 * Resolve the newest filing date (ms epoch) across this run, falling back to
 * the previous cursor date when nothing new was collected.
 */
function newestTime(rawDates, lastDate) {
  if (rawDates.length > 0) return Math.max(...rawDates);
  return lastDate ? lastDate.getTime() : 0;
}

// --- Main sync ---

export async function sync(context) {
  const tickers = context.config?.tickers || [];
  if (tickers.length === 0) {
    context.log.warn('No tickers configured');
    return { documents: [], cursor: undefined, stats: { fetched: 0 } };
  }

  const lastDate = readDateWatermark(context.cursor);
  const cachedTickers = {};
  const tickerMapReference = { map: undefined };
  const state = {
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
      context.log.warn(`Failed to process ${upperTicker}: ${error.message}`);
    }
  }

  // Held when a ticker or an individual filing failed: advancing on the
  // healthy items' dates would permanently skip the failed ones.
  const maxTime = newestTime(state.rawDates, lastDate);
  const cursor = advanceDateWatermark({
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
}
