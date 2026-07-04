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
 * Content: Fetch the primary HTML document for each filing and extract readable
 * text via node-html-parser.
 *
 * Config: tickers[] — array of stock ticker symbols (e.g., SHOP, SNOW, OKTA).
 */

import { parse } from 'node-html-parser';
import { safeDate, stableId } from '../../lib/feeds.mjs';
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

const SEC_HEADERS = {
  'User-Agent': 'TroveBot/0.1 (+https://github.com/hollyburnanalytics/trove-integrations)',
  Accept: 'application/json, text/html, */*',
};

const DELAY_MS = 200;
const MAX_TEXT_LENGTH = 100_000;
const MIN_TEXT_LENGTH = 100;

// --- Helpers ---

async function fetchJson(url) {
  const response = await fetch(url, { headers: SEC_HEADERS });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
  return response.json();
}

async function fetchHtml(url) {
  const response = await fetch(url, { headers: SEC_HEADERS });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
  return response.text();
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

/**
 * Extract readable text from an SEC filing HTML document.
 * Strips scripts, styles, and tables, then pulls paragraph/heading text.
 * Truncates to MAX_TEXT_LENGTH to keep documents manageable.
 */
export function extractFilingText(html) {
  const root = parse(html);

  // Remove noise elements
  for (const selector of ['script', 'style', 'noscript', 'meta', 'link']) {
    for (const element of root.querySelectorAll(selector)) element.remove();
  }

  const parts = [];
  for (const element of root.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, td, th, span, div')) {
    const text = element.textContent.trim();
    // Skip very short fragments and common boilerplate
    if (!text || text.length < 3) continue;
    // Skip if this element has child elements we'll visit separately
    if (
      element.tagName !== 'SPAN' &&
      element.querySelectorAll('p, h1, h2, h3, h4, h5, h6').length > 0
    ) {
      continue;
    }
    parts.push(text);
  }

  // Collapse excessive whitespace
  const fullText = parts
    .join('\n\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();

  if (fullText.length > MAX_TEXT_LENGTH) {
    return `${fullText.slice(0, MAX_TEXT_LENGTH)}\n\n[Truncated]`;
  }
  return fullText;
}

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

async function processFiling(context, filing, cik, companyName, upperTicker) {
  if (!filing.primaryDocument?.endsWith('.htm')) {
    context.log.warn(`No HTML primary document for ${filing.form} ${filing.accessionNumber}`);
    return;
  }
  const documentUrl = buildDocumentUrl(cik, filing.accessionNumber, filing.primaryDocument);
  const html = await fetchHtml(documentUrl);
  const text = extractFilingText(html);

  if (text.length < MIN_TEXT_LENGTH) {
    context.log.warn(`Skipping ${filing.form} ${filing.accessionNumber}: too little text`);
    return;
  }

  const dateLabel = filing.reportDate || filing.filingDate;
  const period = filing.reportDate || 'N/A';
  const header = `${companyName} ${filing.form}\nFiled: ${filing.filingDate}\nPeriod: ${period}`;
  return {
    id: stableId('sec', filing.accessionNumber),
    title: `${companyName} ${filing.form} (${dateLabel})`,
    text: `${header}\n\n${text}`,
    url: documentUrl,
    author: companyName,
    date: safeDate(filing.filingDate) || new Date().toISOString(),
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
      const document = await processFiling(context, filing, cik, companyName, upperTicker);
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
