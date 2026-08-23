/**
 * Turning SEC filings into Trove documents.
 *
 * The sibling of x-accounts' `post-document.mjs` and pocket-casts'
 * `episode-document.mjs`, split along the same seam and for the same reason:
 * nothing here reaches the network or the cursor. It is the filtering and
 * shaping half, which is also the half the tests drive directly.
 */

import { dayToLocalNoonIso, stableId } from '../lib/feeds.ts';
import type { Document, SourceContext } from '../lib/types.js';

/** EDGAR stamps `filingDate` as a calendar day in the filer's local zone. */
export const FILING_TYPES = new Set([
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

const FILING_TIME_ZONE = 'America/New_York';

export type Filing = {
  accessionNumber: string;
  filingDate: string;
  reportDate: string;
  form: string;
  primaryDocument: string;
};

/**
 * Filter filings to target types and optionally by date cursor.
 *
 * @param filings - Everything the submissions endpoint reported.
 * @param afterDate - Keep only filings later than this, when resuming.
 * @returns The filings worth fetching.
 */
export function filterFilings(filings: Filing[], afterDate?: Date): Filing[] {
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
 * The EDGAR archive URL of a filing's primary document.
 *
 * @param cik - The filer's CIK, unpadded as the archive path uses it.
 * @param accessionNumber - The filing's accession number, with dashes.
 * @param primaryDocument - The filename of the filing itself.
 * @returns The document's archive URL.
 */
function buildDocumentUrl(
  cik: number | string,
  accessionNumber: string,
  primaryDocument: string,
): string {
  const accumulatorNoDashes = accessionNumber.replaceAll('-', '');
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${accumulatorNoDashes}/${primaryDocument}`;
}

// --- Per-filing processing ---

/**
 * Turn one filing into a Trove document, or nothing when EDGAR names no HTML
 * primary document for it.
 *
 * @param context - The harness context.
 * @param filing - The filing to emit.
 * @param cik - The filer's CIK, for the archive URL.
 * @param companyName - The filer's name, used as the document's author.
 * @param upperTicker - The configured ticker, uppercased, carried as a tag.
 * @returns The document, when there is one.
 */
export function processFiling(
  context: SourceContext,
  filing: Filing,
  cik: number | string,
  companyName: string,
  upperTicker: string,
): Document | undefined {
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
    // see `fileUrl` below.
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
    fileUrl: documentUrl,
    mimeType: 'text/html',
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
